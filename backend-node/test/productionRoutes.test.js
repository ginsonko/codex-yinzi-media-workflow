const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { setupRouter } = require('../src/routes');
const repo = require('../src/services/productionRepository');
const aiConfigService = require('../src/services/aiConfigService');
const videoService = require('../src/services/videoService');
const { createFallbackDirectorDocument } = require('../src/services/productionDirector');

let db;
let server;
let baseUrl;
let originUrl;
let storageDir;
let observedCatalogConfigId;
const historicalDirs = [];
const log = { info() {}, warn() {}, error() {} };
let cfg;
// This fixture represents a healthy credential-scoped channel.  The real
// nsp products are currently excluded from automatic routing, so the test
// must declare its mocked channel availability explicitly.
const healthyShortCapability = {
  provider_contract: 'aizzz-video-v1',
  duration_mode: 'free', duration_min: 5, duration_max: 15,
  auto_duration_min: 5, auto_duration_max: 15,
  max_images: 9, max_videos: 0, max_audios: 3, max_total_references: 12,
  resolution: '480p', quality_tier: 'fast', automatic_eligible: true,
  route_profiles: ['short_image_guided'],
  roles: { image: ['reference'], video: [], audio: ['reference'] },
};
const videoCatalogFixture = {
  pricing_version: 'http-routing-fixture',
  fetched_at: '2026-08-09T00:00:00.000Z',
  video: [
    {
      model: 'cc-seedance2.0 480p-fast-nsp',
      endpoint_types: ['openai-video'],
      groups: ['特价视频分组(即梦)'],
      prices: [{ group: '特价视频分组(即梦)', billing_unit: 'per_second', effective_price: 0.4656 }],
      capabilities: healthyShortCapability,
      credential_verified: true, availability_scope: 'credential', scope_verified: true,
    },
    {
      model: 'cc-seedance2.0 480p-nsp',
      endpoint_types: ['openai-video'],
      groups: ['特价视频分组(即梦)'],
      prices: [{ group: '特价视频分组(即梦)', billing_unit: 'per_second', effective_price: 0.5148 }],
      capabilities: { ...healthyShortCapability, quality_tier: 'balanced' },
      credential_verified: true, availability_scope: 'credential', scope_verified: true,
    },
  ],
};

function migrateQuietly() {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = originalLog; console.warn = originalWarn; }
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body == null || typeof options.body === 'string'
      ? options.body
      : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'production-routes-storage-'));
  cfg = { storage: { local_path: storageDir, base_url: 'http://localhost/static' } };
  db = new Database(':memory:');
  observedCatalogConfigId = null;
  migrateQuietly();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (id, title, created_at, updated_at) VALUES (1, ?, ?, ?)').run('星尘花园', now, now);
  db.prepare('INSERT INTO episodes (id, drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, 1, ?, ?, ?)').run('第一集', now, now);
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/static', express.static(storageDir));
  app.use('/api', setupRouter(cfg, db, log, {
    production: { media: { fetchVideoCatalog: async (run) => {
      observedCatalogConfigId = run?.policy?.video_config_id ?? null;
      return videoCatalogFixture;
    } } },
  }));
  server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  originUrl = `http://127.0.0.1:${server.address().port}`;
  baseUrl = `${originUrl}/api`;
});

afterEach(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
  fs.rmSync(storageDir, { recursive: true, force: true });
  while (historicalDirs.length) fs.rmSync(historicalDirs.pop(), { recursive: true, force: true });
});

describe('production HTTP routes', () => {
  it('keeps Yinzi capability contracts advisory by default and freezes automatic-route intent', async () => {
    const groupConfig = aiConfigService.createConfig(db, log, {
      service_type: 'video', provider: 'yinzi', api_protocol: 'yinzi', name: 'Yinzi group route',
      base_url: 'https://api.yinziapi.top/v1', api_key: 'group-test-key',
      model: ['manual-unknown-video'], default_model: 'manual-unknown-video',
      endpoint: '/videos', query_endpoint: '/videos/{taskId}', is_default: true,
      settings: JSON.stringify({ routing_mode: 'group' }),
    });
    const smartConfig = aiConfigService.createConfig(db, log, {
      service_type: 'video', provider: 'yinzi', api_protocol: 'yinzi', name: 'Yinzi smart route',
      base_url: 'https://api.yinziapi.top/v1', api_key: 'smart-test-key',
      model: ['seedance-2.5-720p'], default_model: 'seedance-2.5-720p',
      endpoint: '/videos', query_endpoint: '/videos/{taskId}',
      settings: JSON.stringify({ routing_mode: 'smart', smart_routing_enabled: true }),
    });
    const originalProcessor = videoService.processVideoGeneration;
    videoService.processVideoGeneration = async () => {};
    try {
      const manual = await request('/videos', {
        method: 'POST',
        body: {
          drama_id: 1, video_config_id: groupConfig.id,
          model: 'manual-unknown-video', prompt: 'manual advisory request', duration: 5,
          reference_image_urls: Array.from({ length: 12 }, (_, index) => `https://media.test/${index}.png`),
        },
      });
      assert.equal(manual.status, 201);
      const manualRow = db.prepare(
        'SELECT contract_validation_mode, provider_config_snapshot_json FROM video_generations WHERE id = ?'
      ).get(manual.body.data.id);
      const manualSnapshot = JSON.parse(manualRow.provider_config_snapshot_json);
      assert.equal(manualRow.contract_validation_mode, 'advisory');
      assert.equal(manualSnapshot.requested_model_explicit, true);
      assert.equal(manualSnapshot.automatic_route, false);

      const automatic = await request('/videos', {
        method: 'POST',
        body: {
          drama_id: 1, video_config_id: smartConfig.id,
          model: 'seedance-2.5-720p', prompt: 'automatic smart-route request', duration: 5,
          routing_receipt: { automatic: true, smart_routing_candidate: true },
        },
      });
      assert.equal(automatic.status, 201);
      const automaticRow = db.prepare(
        'SELECT contract_validation_mode, provider_config_snapshot_json FROM video_generations WHERE id = ?'
      ).get(automatic.body.data.id);
      const automaticSnapshot = JSON.parse(automaticRow.provider_config_snapshot_json);
      assert.equal(automaticRow.contract_validation_mode, 'advisory');
      assert.equal(automaticSnapshot.smart_routing, true);
      assert.equal(automaticSnapshot.automatic_route, true);
      assert.equal(automaticSnapshot.smart_routing_candidate, true);
      assert.equal(automaticSnapshot.capability_model, 'seedance-2.5-720p');
      assert.equal(automaticSnapshot.capability_snapshot.max_images, 30);
      // Seedance 2.5's current Yinzi capability contract supports up to
      // ten reference videos.  This route remains advisory (it never gates
      // a manual request), but the frozen snapshot must preserve the real
      // capability instead of the historical zero-value fallback.
      assert.equal(automaticSnapshot.capability_snapshot.max_videos, 10);

      const strict = await request('/videos', {
        method: 'POST',
        body: {
          drama_id: 1, video_config_id: smartConfig.id,
          model: 'seedance-2.5-720p', prompt: 'explicit strict request', duration: 5,
          contract_validation_mode: 'strict',
        },
      });
      assert.equal(strict.status, 201);
      const strictRow = db.prepare(
        'SELECT contract_validation_mode, provider_config_snapshot_json FROM video_generations WHERE id = ?'
      ).get(strict.body.data.id);
      const strictSnapshot = JSON.parse(strictRow.provider_config_snapshot_json);
      assert.equal(strictRow.contract_validation_mode, 'strict');
      assert.equal(strictSnapshot.automatic_route, false);
      assert.equal(strictSnapshot.requested_model_explicit, true);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      videoService.processVideoGeneration = originalProcessor;
    }
  });

  it('exposes the graph and preserves idempotent run creation semantics', async () => {
    const graph = await request('/production-graph');
    assert.equal(graph.status, 200);
    assert.equal(graph.body.data.stages[0].key, 'story_input');
    assert.equal(graph.body.data.stages.at(-1).key, 'final_edit');

    const payload = {
      drama_id: 1,
      episode_id: 1,
      idempotency_key: 'route-run',
      review_owner: 'human',
      input: { story: '宇航员林夏在星尘温室寻找最后一颗发光种子。' },
    };
    const created = await request('/production-runs', { method: 'POST', body: payload });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.reused, false);
    assert.equal(created.body.data.summary.run.current_stage, 'story_input');

    const reused = await request('/production-runs', { method: 'POST', body: payload });
    assert.equal(reused.status, 200);
    assert.equal(reused.body.data.reused, true);
    assert.equal(reused.body.data.run.id, created.body.data.run.id);

    const missing = await request('/production-runs/missing');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'NOT_FOUND');
  });

  it('keeps detach/local/provider cancellation endpoints semantically distinct', async () => {
    const run = repo.createRun(db, {
      drama_id: 1, episode_id: 1, idempotency_key: 'route-cancel-semantics',
      review_owner: 'human', input: { story: '取消语义测试' },
      budget: { max_video_seconds: 60, max_video_attempts: 10 },
    }).run;
    const reserved = repo.reserveAction(db, {
      run_id: run.id, action_key: 'route-local-reserved', stage: 'shot_video',
      scope_type: 'shot', scope_id: '1', kind: 'video_generate', attempt: 1,
      request: { model: 'manual-video' }, reserved_video_seconds: 5,
    }).action;
    const detached = await request(`/production-runs/${run.id}/detach`, {
      method: 'POST', body: { reason: '查看历史' },
    });
    assert.equal(detached.status, 200);
    assert.equal(detached.body.data.status, 'detached_view');
    assert.equal(repo.getAction(db, reserved.id).status, 'reserved');
    const local = await request(`/production-runs/${run.id}/cancel-local`, {
      method: 'POST', body: { action_id: reserved.id, reason: '取消尚未外发的请求' },
    });
    assert.equal(local.status, 200);
    assert.equal(local.body.data.status, 'cancelled_local');
    assert.equal(repo.getAction(db, reserved.id).status, 'cancelled');

    const accepted = repo.reserveAction(db, {
      run_id: run.id, action_key: 'route-provider-waiting', stage: 'shot_video',
      scope_type: 'shot', scope_id: '2', kind: 'video_generate', attempt: 1,
      request: { model: 'manual-video' }, reserved_video_seconds: 5,
    }).action;
    repo.updateAction(db, accepted.id, {
      status: 'waiting', task_id: 'route-provider-task', generation_id: 77,
      provider_id: 'route-provider-task',
    });
    const provider = await request(`/production-runs/${run.id}/cancel-provider`, {
      method: 'POST', body: { action_id: accepted.id, reason: '供应商任务过久' },
    });
    assert.equal(provider.status, 200);
    assert.equal(provider.body.data.status, 'cancel_requested_provider_unknown');
    assert.equal(repo.getAction(db, accepted.id).status, 'waiting');
    assert.equal(repo.getAction(db, accepted.id).result.cancel_requested_provider_unknown, true);
  });

  it('rejects changing a run aspect ratio after creation with an actionable conflict', async () => {
    const run = repo.createRun(db, {
      drama_id: 1,
      episode_id: 1,
      idempotency_key: 'route-frozen-aspect',
      review_owner: 'human',
      input: { story: '林夏穿过竖屏月面温室。' },
      policy: { aspect_ratio: '9:16' },
    }).run;
    const result = await request(`/production-runs/${run.id}`, {
      method: 'PATCH',
      body: {
        policy: { ...run.policy, aspect_ratio: '16:9' },
        expected_version: run.version,
      },
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'PRODUCTION_ASPECT_RATIO_LOCKED');
    assert.equal(result.body.error.details.frozen_aspect_ratio, '9:16');
    assert.equal(repo.getRun(db, run.id).policy.aspect_ratio, '9:16');
  });

  it('clears a persisted intervention through the explicit same-owner recovery control', async () => {
    let run = repo.createRun(db, {
      drama_id: 1, episode_id: 1, idempotency_key: 'route-resolve-intervention',
      review_owner: 'auto_accept', input: { story: '测试故事' },
    }).run;
    run = repo.updateRun(db, run.id, {
      status: 'waiting_review', waiting_reason: 'automation_limit_reached',
      runtime: { autonomy: { intervention: {
        object_key: 'script:run:', stage: 'script', reason: 'automation_limit_reached',
      } } },
    });
    const result = await request(`/production-runs/${run.id}`, {
      method: 'PATCH',
      body: { review_owner: 'auto_accept', resolve_intervention: true, expected_version: run.version },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.run.status, 'running');
    assert.equal(result.body.data.run.review_owner, 'auto_accept');
    assert.equal(result.body.data.run.runtime.autonomy.intervention, undefined);
  });

  it('clears a persisted automatic intervention when the run is resumed', async () => {
    let run = repo.createRun(db, {
      drama_id: 1, episode_id: 1, idempotency_key: 'route-resume-intervention',
      review_owner: 'auto_accept', input: { story: '测试故事' },
    }).run;
    run = repo.updateRun(db, run.id, {
      status: 'waiting_review', waiting_reason: 'automation_limit_reached',
      error_code: 'AUTOMATION_LIMIT_REACHED', error_message: '等待人工处理',
      runtime: { autonomy: {
        objects: {
          'script:run:': {
            stage: 'script', scope_type: 'run', scope_id: '',
            consecutive_generation_failures: 3, escalated: true,
          },
        },
        intervention: {
          object_key: 'script:run:', stage: 'script', scope_type: 'run', scope_id: '',
          reason: 'automation_limit_reached',
        },
      } },
    });
    const result = await request(`/production-runs/${run.id}/resume`, {
      method: 'POST', body: { expected_version: run.version },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.run.status, 'running');
    assert.equal(result.body.data.run.waiting_reason, null);
    assert.equal(result.body.data.run.error_code, null);
    assert.equal(result.body.data.run.runtime.autonomy.intervention, undefined);
    assert.equal(result.body.data.run.runtime.autonomy.objects['script:run:'], undefined);
  });

  it('exposes atomic shot operations and routes legacy storyboard exclude and restore through them', async () => {
    let run = repo.createRun(db, {
      drama_id: 1,
      episode_id: 1,
      idempotency_key: 'route-shot-operations',
      review_owner: 'human',
      input: { story: '林夏完成两个连续镜头。' },
      policy: { video_model: 'cc-seedance2.0 480p-fast-nsp' },
      budget: { max_shots: 6, max_video_attempts: 10, max_video_seconds: 60 },
    }).run;
    const makeShot = (number, title) => repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_plan',
      scope_type: 'shot',
      scope_id: String(number),
      title,
      content: {
        number,
        title,
        duration: 5,
        action: `${title}动作完整结束`,
        visual: `${title}独立构图`,
        video_prompt: `${title}按时间顺序完成动作`,
        transition_mode: Number(number) === 1 ? 'opening' : 'hard_cut',
        included: true,
      },
      status: 'approved',
    });
    const first = makeShot(1, '镜头一');
    makeShot(2, '镜头二');
    run = repo.updateRun(db, run.id, {
      current_stage: 'storyboard_plan', current_scope_type: 'shot', current_scope_id: '1', status: 'running',
      runtime: { shot_pipeline: { mode: 'sequential', current_shot_id: '1' } },
    });
    const content = (title) => ({
      title,
      duration: 5,
      action: `${title}动作完整结束`,
      visual: `${title}独立构图`,
      video_prompt: `${title}按时间顺序完成动作并稳定结束`,
      transition_mode: title.includes('开场') ? 'opening' : 'hard_cut',
    });

    const revised = await request(`/production-runs/${run.id}/shots/1/revise`, {
      method: 'POST',
      body: { expected_version: run.version, instruction: '把动作变得更明确', content: content('开场修订') },
    });
    assert.equal(revised.status, 200);
    assert.equal(revised.body.data.operation, 'revise');

    const split = await request(`/production-runs/${run.id}/shots/1/split`, {
      method: 'POST',
      body: {
        instruction: '把角色反应拆成下一镜头',
        content: { current_shot: content('开场前半'), next_shot: content('角色反应') },
      },
    });
    assert.equal(split.status, 200);
    assert.equal(split.body.data.inserted_shot.scope_id, '1.5');

    const pickup = await request(`/production-runs/${run.id}/shots/pickup`, {
      method: 'POST',
      body: { after_shot_id: '1.5', instruction: '补拍道具特写', content: content('道具特写') },
    });
    assert.equal(pickup.status, 200);
    assert.equal(pickup.body.data.shot.scope_id, '1.75');

    const skipped = await request(`/production-runs/${run.id}/shots/1/skip`, {
      method: 'POST', body: { reason: '本轮不采用开场镜头' },
    });
    assert.equal(skipped.status, 200);
    assert.equal(skipped.body.data.operation, 'skip');
    assert.equal(skipped.body.data.focus_shot_id, '1.5');
    assert.equal(skipped.body.data.summary.run.current_scope_id, '1.5');

    const skippedArtifact = repo.listArtifacts(db, run.id, {
      stage: 'storyboard_plan', scope_type: 'shot', scope_id: '1', current: true,
    }).items[0];
    const restored = await request(`/production-artifacts/${skippedArtifact.id}/restore`, {
      method: 'POST', body: { reason: '旧入口也应恢复镜头' },
    });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.data.operation, 'restore');
    assert.equal(restored.body.data.summary.run.current_scope_id, '1');

    const excludedAgain = await request(`/production-artifacts/${first.id}/exclude`, {
      method: 'POST', body: { reason: '旧入口也应跳过当前镜头' },
    });
    assert.equal(excludedAgain.status, 200);
    assert.equal(excludedAgain.body.data.operation, 'skip');
  });

  it('exposes capability-aware video routing and atomically saves a shot override', async () => {
    const videoConfig = aiConfigService.createConfig(db, log, {
      service_type: 'video', provider: 'yinzi', name: 'Legacy run video Key',
      base_url: 'https://api.yinziapi.top/v1', api_key: 'test-video-key',
      model: ['cc-seedance2.0 480p-fast-nsp'],
      default_model: 'cc-seedance2.0 480p-fast-nsp', is_default: true,
    });
    let run = repo.createRun(db, {
      drama_id: 1,
      episode_id: 1,
      idempotency_key: 'video-routing-http-run',
      review_owner: 'human',
      input: { story: '林夏看向月面城市。' },
      policy: {
        // Simulate a run created before any video config was available. The
        // editor may resolve the current default as context, but this null must
        // remain persisted so a read-only lookup cannot rewrite dispatch state.
        video_config_id: null,
        video_routing_mode: 'auto',
        video_group: '特价视频分组(即梦)',
        video_quality: 'balanced',
        director_mode: 'off',
      },
      budget: { max_video_attempts: 10, max_video_seconds: 60 },
    }).run;
    const storyboard = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_plan',
      scope_type: 'shot',
      scope_id: '1',
      title: '城市反应镜头',
      content: {
        included: true,
        number: 1,
        duration: 5,
        action: '林夏看向月面城市。',
        visual: '稳定中近景。',
        video_prompt: '保持稳定中近景五秒。',
        previs_mode: 'skip',
        transition_mode: 'hard_cut',
      },
      status: 'approved',
    });
    run = repo.updateRun(db, run.id, {
      current_stage: 'storyboard_plan', current_scope_type: 'shot', current_scope_id: '1', status: 'waiting_review',
    });

    const routing = await request(`/production-runs/${run.id}/video-routing?shot_id=1`);
    assert.equal(routing.status, 200);
    assert.equal(routing.body.data.project.config_id, videoConfig.id);
    assert.equal(repo.getRun(db, run.id).policy.video_config_id, null);
    assert.equal(observedCatalogConfigId, videoConfig.id);
    assert.equal(routing.body.data.effective_route.model, 'cc-seedance2.0 480p-fast-nsp');
    assert.equal(routing.body.data.catalog.options.length, 2);
    assert.equal(routing.body.data.catalog.options.every((item) => item.selectable), true);

    const stale = await request(`/production-runs/${run.id}/video-routing`, {
      method: 'PATCH',
      body: { scope: 'shot', shot_id: '1', mode: 'fixed', model: 'cc-seedance2.0 480p-nsp', expected_version: run.version - 1 },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'VERSION_CONFLICT');

    const switched = await request(`/production-runs/${run.id}/video-routing`, {
      method: 'PATCH',
      body: {
        scope: 'shot', shot_id: '1', config_id: videoConfig.id,
        mode: 'fixed', model: 'cc-seedance2.0 480p-nsp', expected_version: run.version,
      },
    });
    assert.equal(switched.status, 200);
    assert.equal(switched.body.data.effects.paid_submission, false);
    assert.equal(switched.body.data.effects.reference_bundle_refreshed, false);
    assert.equal(switched.body.data.summary.run.policy.video_config_id, videoConfig.id);
    assert.equal(switched.body.data.summary.run.policy.video_model_overrides['1'], 'cc-seedance2.0 480p-nsp');
    assert.deepEqual(switched.body.data.summary.run.usage, run.usage);

    const rejectedRevision = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_plan',
      scope_type: 'shot',
      scope_id: '1',
      title: 'Rejected city reaction revision',
      parent_artifact_id: storyboard.id,
      content: { ...storyboard.content, visual: 'Composition still needs revision.' },
    });
    repo.reviewArtifact(db, rejectedRevision.id, {
      reviewer_type: 'human', decision: 'rejected', reason: 'Revise the composition.',
    });
    const rejectedRun = repo.getRun(db, run.id);
    const rejectedRouting = await request(`/production-runs/${run.id}/video-routing?shot_id=1`);
    assert.equal(rejectedRouting.status, 200);
    assert.equal(rejectedRouting.body.data.shot_status, 'rejected');
    assert.equal(rejectedRouting.body.data.route_edit_deferred, true);

    const deferredSave = await request(`/production-runs/${run.id}/video-routing`, {
      method: 'PATCH',
      body: {
        scope: 'shot', shot_id: '1', mode: 'inherit', previs_mode: 'skip',
        expected_version: rejectedRun.version,
      },
    });
    assert.equal(deferredSave.status, 200);
    assert.equal(deferredSave.body.data.effects.route_edit_deferred, true);
    assert.equal(deferredSave.body.data.effects.reference_bundle_refreshed, false);
    assert.deepEqual(deferredSave.body.data.summary.run.usage, run.usage);
  });

  it('writes a revised director plan through HTTP and replaces the stale capture token', async () => {
    const run = repo.createRun(db, {
      drama_id: 1,
      episode_id: 1,
      idempotency_key: 'director-route-run',
      review_owner: 'human',
      input: { story: '宇航员林夏穿过星尘温室。' },
      budget: { max_director_revisions: 3, max_video_attempts: 10, max_video_seconds: 60 },
    }).run;
    const shot = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_plan',
      scope_type: 'shot',
      scope_id: '1',
      title: '镜头一',
      content: {
        included: true,
        number: 1,
        duration: 5,
        visual: '林夏走进透明穹顶温室',
        action: '林夏走向中央培养台',
        camera_movement: '低机位缓慢推进',
      },
      status: 'approved',
    });
    const document = createFallbackDirectorDocument(shot.content);
    const planV1 = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'director_plan',
      scope_type: 'shot',
      scope_id: '1',
      title: '镜头一导演台方案',
      content: { included: true, source_artifact_id: shot.id, document },
      status: 'approved',
      depends_on: [shot.id],
    });
    repo.updateRun(db, run.id, { current_stage: 'director_preview', status: 'running' });

    const firstCapture = await request(`/production-runs/${run.id}/advance`, { method: 'POST', body: {} });
    assert.equal(firstCapture.status, 200);
    assert.equal(firstCapture.body.data.state, 'client_action');
    const staleAction = firstCapture.body.data.client_action;

    const revisedDocument = structuredClone(document);
    revisedDocument.timeline.keyframes = revisedDocument.timeline.keyframes.map((frame) => (
      frame.object_id === revisedDocument.active_camera_id && frame.time === 0
        ? { ...frame, position: [7.5, 3.4, 9] }
        : frame
    ));
    const revised = await request(`/production-artifacts/${planV1.id}`, {
      method: 'PATCH',
      body: { content: { ...planV1.content, document: revisedDocument, manually_adjusted: true } },
    });
    assert.equal(revised.status, 200);
    assert.equal(revised.body.data.revision, 2);
    assert.deepEqual(repo.listUpstreamArtifactIds(db, revised.body.data.id), [shot.id]);

    const approved = await request(`/production-artifacts/${revised.body.data.id}/review`, {
      method: 'POST',
      body: { decision: 'approved', reason: '用户在 3D 导演台完成精调并确认' },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.data.artifact.status, 'approved');
    assert.equal(repo.getArtifact(db, planV1.id).status, 'superseded');

    const replacementCapture = await request(`/production-runs/${run.id}/advance`, { method: 'POST', body: {} });
    assert.equal(replacementCapture.status, 200);
    assert.equal(replacementCapture.body.data.state, 'client_action');
    assert.notEqual(replacementCapture.body.data.client_action.action_id, staleAction.action_id);
    assert.notEqual(replacementCapture.body.data.client_action.token, staleAction.token);
    assert.equal(repo.getAction(db, staleAction.action_id).status, 'cancelled');

    const shotV2 = repo.editArtifact(db, shot.id, { content: { ...shot.content, action: '林夏跑向中央培养台' } });
    repo.reviewArtifact(db, shotV2.id, { reviewer_type: 'human', decision: 'approved', reason: '调整走位' });
    assert.equal(repo.getArtifact(db, revised.body.data.id).status, 'invalidated');
  });

  it('materializes approved historical media lazily without leaking local paths', async () => {
    const sourceRun = repo.createRun(db, {
      drama_id: 1,
      episode_id: 1,
      idempotency_key: 'reusable-media-source',
      input: { story: '源任务' },
    }).run;
    const historicalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'production-routes-historical-'));
    historicalDirs.push(historicalRoot);
    const historicalBytes = Buffer.from('historical-director-preview');
    const historicalPath = path.join(historicalRoot, 'references', 'reusable-preview.webm');
    fs.mkdirSync(path.dirname(historicalPath), { recursive: true });
    fs.writeFileSync(historicalPath, historicalBytes);
    const digest = crypto.createHash('sha256').update(historicalBytes).digest('hex');
    const sourceArtifact = repo.createArtifact(db, {
      run_id: sourceRun.id,
      stage: 'director_preview',
      scope_type: 'shot',
      scope_id: '1',
      title: '已批准的导演台参考视频',
      status: 'approved',
      media_path: 'references/reusable-preview.webm',
      mime_type: 'video/webm',
      content_hash: digest,
      content: {
        included: true,
        validation: {
          absolute_path: historicalPath,
          storage_root: historicalRoot,
          sha256: digest,
        },
      },
    });
    const targetRun = repo.createRun(db, {
      drama_id: 1,
      episode_id: 1,
      idempotency_key: 'reusable-media-target',
      input: { story: '目标任务' },
    }).run;

    const result = await request(`/production-runs/${targetRun.id}/reusable-media?media_type=video&limit=20`);
    assert.equal(result.status, 200);
    assert.equal(result.body.data.items.length, 1);
    assert.equal(result.body.data.items[0].media_path, 'references/reusable-preview.webm');
    assert.equal(result.body.data.items[0].run_id, sourceRun.id);
    assert.equal(result.body.data.items[0].stage, 'director_preview');
    assert.equal(result.body.data.items[0].available, true);
    assert.equal(result.body.data.items[0].ready, false);
    assert.equal(result.body.data.items[0].media_url, null);
    assert.equal('content' in result.body.data.items[0], false);
    assert.equal('content_hash' in result.body.data.items[0], false);
    assert.equal(JSON.stringify(result.body).includes(historicalRoot), false);

    const materialized = await request(
      `/production-runs/${targetRun.id}/reusable-media/${sourceArtifact.id}/materialize`,
      { method: 'POST' },
    );
    assert.equal(materialized.status, 200);
    assert.equal(materialized.body.data.original_media_path, 'references/reusable-preview.webm');
    assert.match(materialized.body.data.media_path, /^reusable\/[a-f0-9]{64}\/[a-f0-9]{64}\.webm$/);
    assert.equal(JSON.stringify(materialized.body).includes(historicalRoot), false);

    const preview = await fetch(`${originUrl}${materialized.body.data.media_url}`);
    assert.equal(preview.status, 200);
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), historicalBytes);

    const repeated = await request(
      `/production-runs/${targetRun.id}/reusable-media/${sourceArtifact.id}/materialize`,
      { method: 'POST' },
    );
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.data.media_path, materialized.body.data.media_path);

    const missing = await request('/production-runs/missing/reusable-media');
    assert.equal(missing.status, 404);
  });

  it('lists approved production media safely and requires explicit cross-project materialization', async () => {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO dramas (id, title, created_at, updated_at) VALUES (2, ?, ?, ?)').run('另一项目', now, now);
    db.prepare('INSERT INTO episodes (id, drama_id, episode_number, title, created_at, updated_at) VALUES (2, 2, 1, ?, ?, ?)').run('另一集', now, now);
    const sourceRun = repo.createRun(db, {
      drama_id: 1, episode_id: 1, idempotency_key: 'cross-drama-source', input: { story: '源项目' },
    }).run;
    const targetRun = repo.createRun(db, {
      drama_id: 2, episode_id: 2, idempotency_key: 'cross-drama-target', input: { story: '目标项目' },
    }).run;
    const mediaPath = path.join(storageDir, 'images', 'source.png');
    fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
    fs.writeFileSync(mediaPath, Buffer.from('source-image'));
    const artifact = repo.createArtifact(db, {
      run_id: sourceRun.id, stage: 'asset_images', scope_type: 'character', scope_id: 'hero',
      title: '源角色', status: 'approved', media_path: 'images/source.png', mime_type: 'image/png',
      content: {
        included: true,
        visual_prompt: '不应出现在公开列表中的提示词',
        validation: { absolute_path: mediaPath, storage_root: storageDir },
      },
    });

    const listed = await request('/production-media?media_type=image&page_size=10');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.data.items.length, 1);
    assert.equal(listed.body.data.items[0].drama_title, '星尘花园');
    assert.equal(listed.body.data.items[0].ready, true);
    assert.equal(listed.body.data.items[0].media_url, '/static/images/source.png');
    assert.equal('content' in listed.body.data.items[0], false);
    assert.equal('content_hash' in listed.body.data.items[0], false);
    assert.equal(JSON.stringify(listed.body).includes(storageDir), false);
    assert.equal(JSON.stringify(listed.body).includes('不应出现在公开列表中的提示词'), false);

    const rejected = await request(
      `/production-runs/${targetRun.id}/reusable-media/${artifact.id}/materialize`,
      { method: 'POST' },
    );
    assert.equal(rejected.status, 400);

    const allowed = await request(
      `/production-runs/${targetRun.id}/reusable-media/${artifact.id}/materialize`,
      { method: 'POST', body: { allow_cross_project: true } },
    );
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.data.cross_project, true);
    assert.equal(allowed.body.data.source_drama_id, 1);
    assert.equal(allowed.body.data.target_drama_id, 2);
  });
});
