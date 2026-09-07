const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const repo = require('../src/services/productionRepository');
const { createProductionService } = require('../src/services/productionService');
const { createProductionMediaService } = require('../src/services/productionMediaService');

let db;
const cfg = { storage: { local_path: './data/storage', base_url: 'http://localhost/static' } };
const log = { info() {}, warn() {}, error() {} };

function migrateQuietly() {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = originalLog; console.warn = originalWarn; }
}

function makeRun(key, options = {}) {
  return repo.createRun(db, {
    drama_id: 1,
    episode_id: 1,
    idempotency_key: key,
    review_owner: options.review_owner || 'human',
    input: { story: '林夏在星尘温室完成一次连续拍摄。' },
    policy: {
      video_model: 'mg-seedance2.0 -480p mini',
      aspect_ratio: '16:9',
      ...options.policy,
    },
    budget: {
      max_video_attempts: 10,
      max_video_seconds: 60,
      max_video_attempts_per_shot: 3,
      max_shots: options.max_shots || 6,
    },
  }).run;
}

function addShot(run, number, status = 'approved', extra = {}) {
  return repo.createArtifact(db, {
    run_id: run.id,
    stage: 'storyboard_plan',
    scope_type: 'shot',
    scope_id: String(number),
    title: extra.title || `镜头 ${number}`,
    content: {
      number,
      duration: 5,
      action: `角色完成镜头 ${number} 的动作`,
      visual: `镜头 ${number} 的独立中景构图`,
      video_prompt: `角色在镜头 ${number} 内完成动作并稳定结束`,
      transition_mode: Number(number) === 1 ? 'opening' : 'hard_cut',
      included: true,
      ...extra,
    },
    status,
  });
}

function currentShotArtifact(runId, shotId) {
  return repo.listArtifacts(db, runId, {
    stage: 'storyboard_plan',
    scope_type: 'shot',
    scope_id: String(shotId),
    current: true,
    page_size: 10,
  }).items[0] || null;
}

function placeRun(run, stage, scopeId) {
  return repo.updateRun(db, run.id, {
    current_stage: stage,
    current_scope_type: scopeId == null ? null : 'shot',
    current_scope_id: scopeId == null ? null : String(scopeId),
    status: 'running',
    waiting_reason: null,
    runtime: {
      ...(run.runtime || {}),
      shot_pipeline: { mode: 'sequential', current_shot_id: scopeId == null ? null : String(scopeId) },
    },
  });
}

function productionService() {
  return createProductionService(db, cfg, log, {
    generateText: async () => { throw new Error('unexpected text generation'); },
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  migrateQuietly();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (id, title, created_at, updated_at) VALUES (1, ?, ?, ?)')
    .run('星尘花园', now, now);
  db.prepare('INSERT INTO episodes (id, drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, 1, ?, ?, ?)')
    .run('第一集', now, now);
});

afterEach(() => db.close());

describe('production shot operations', () => {
  it('cancels an unsubmitted reservation, releases its budget, and advances atomically', async () => {
    let run = makeRun('skip-reserved');
    addShot(run, 1);
    addShot(run, 2);
    run = placeRun(run, 'reference_bundle', 1);
    const action = repo.reserveAction(db, {
      run_id: run.id,
      action_key: 'shot-1-reserved',
      stage: 'shot_video',
      scope_type: 'shot',
      scope_id: '1',
      kind: 'video_generate',
      reserved_video_seconds: 5,
      request: { source_artifact_id: 1 },
    }).action;
    assert.equal(repo.getRun(db, run.id).usage.video_attempts_reserved, 1);

    const result = await productionService().skipShot(run.id, '1', {
      expected_version: repo.getRun(db, run.id).version,
      reason: '这个镜头不再需要',
    });

    const updatedRun = repo.getRun(db, run.id);
    assert.equal(result.focus_shot_id, '2');
    assert.equal(updatedRun.current_stage, 'storyboard_plan');
    assert.equal(updatedRun.current_scope_id, '2');
    assert.equal(repo.getAction(db, action.id).status, 'cancelled');
    assert.equal(repo.getAction(db, action.id).result.detached_from_sequence, true);
    assert.equal(updatedRun.usage.video_attempts_reserved, 0);
    assert.equal(updatedRun.usage.video_seconds_reserved, 0);
  });

  it('detaches submitted, processing, and download-retry actions without cancelling or duplicating them', async () => {
    for (const state of ['submitted', 'waiting', 'download_retry']) {
      let run = makeRun(`skip-${state}`);
      const shot = addShot(run, 1);
      addShot(run, 2);
      run = placeRun(run, 'shot_video', 1);
      let action = repo.reserveAction(db, {
        run_id: run.id,
        action_key: `shot-1-${state}`,
        stage: 'shot_video',
        scope_type: 'shot',
        scope_id: '1',
        kind: 'video_generate',
        reserved_video_seconds: 5,
        request: { source_artifact_id: shot.id, bundle_artifact_id: 900 },
      }).action;
      action = repo.updateAction(db, action.id, { status: 'submitted' });
      if (state !== 'submitted') {
        action = repo.updateAction(db, action.id, {
          status: 'waiting', generation_id: state === 'download_retry' ? 72 : 71,
          result: state === 'download_retry' ? { delivery_state: 'download_failed' } : {},
        });
      }

      const beforeCount = repo.listActions(db, run.id, { page_size: 20 }).items.length;
      await productionService().skipShot(run.id, '1', { reason: `skip ${state}` });
      const after = repo.getAction(db, action.id);

      assert.equal(after.status, state === 'submitted' ? 'submitted' : 'waiting');
      assert.equal(after.result.detached_from_sequence, true);
      assert.equal(after.result.workflow_blocking, false);
      assert.equal(repo.listActions(db, run.id, { page_size: 20 }).items.length, beforeCount);
      assert.equal(repo.getRun(db, run.id).current_scope_id, '2');
    }
  });

  it('invalidates a review draft and preserves an approved skipped video as reusable archive media', async () => {
    let draftRun = makeRun('skip-review-draft');
    const draftShot = addShot(draftRun, 1);
    addShot(draftRun, 2);
    draftRun = placeRun(draftRun, 'shot_video', 1);
    const draftVideo = repo.createArtifact(db, {
      run_id: draftRun.id,
      stage: 'shot_video',
      scope_type: 'shot',
      scope_id: '1',
      title: '待审核视频',
      content: { source_artifact_id: draftShot.id, included: true },
      status: 'draft',
      media_path: 'videos/review.mp4',
      depends_on: [draftShot.id],
    });
    await productionService().skipShot(draftRun.id, '1', { reason: '待审核时跳过' });
    assert.equal(repo.getArtifact(db, draftVideo.id).status, 'invalidated');

    let approvedRun = makeRun('skip-approved-video');
    const approvedShot = addShot(approvedRun, 1);
    addShot(approvedRun, 2);
    approvedRun = placeRun(approvedRun, 'shot_video', 1);
    const approvedVideo = repo.createArtifact(db, {
      run_id: approvedRun.id,
      stage: 'shot_video',
      scope_type: 'shot',
      scope_id: '1',
      title: '已通过视频',
      content: { source_artifact_id: approvedShot.id, included: true },
      status: 'approved',
      media_path: 'videos/approved.mp4',
      mime_type: 'video/mp4',
      depends_on: [approvedShot.id],
    });
    await productionService().skipShot(approvedRun.id, '1', { reason: '成片中不采用' });
    const currentVideo = repo.listArtifacts(db, approvedRun.id, {
      stage: 'shot_video', scope_type: 'shot', scope_id: '1', current: true,
    }).items[0];
    assert.equal(repo.getArtifact(db, approvedVideo.id).status, 'superseded');
    assert.equal(currentVideo.status, 'approved');
    assert.equal(currentVideo.content.included, false);
    assert.equal(currentVideo.content.archive_only, true);
    assert.equal(currentVideo.media_path, 'videos/approved.mp4');
  });

  it('rewinds a completed sequence to the next dependent shot instead of staying in final edit', async () => {
    let run = makeRun('skip-after-completion');
    const shot1 = addShot(run, 1);
    const shot2 = addShot(run, 2);
    repo.addDependency(db, shot2.id, shot1.id);
    repo.createArtifact(db, {
      run_id: run.id,
      stage: 'shot_video',
      scope_type: 'shot',
      scope_id: '1',
      title: '镜头 1 视频',
      content: { source_artifact_id: shot1.id, included: true },
      status: 'approved',
      media_path: 'videos/shot1.mp4',
      depends_on: [shot1.id],
    });
    repo.createArtifact(db, {
      run_id: run.id,
      stage: 'shot_video',
      scope_type: 'shot',
      scope_id: '2',
      title: '镜头 2 视频',
      content: { source_artifact_id: shot2.id, included: true },
      status: 'approved',
      media_path: 'videos/shot2.mp4',
      depends_on: [shot2.id],
    });
    run = repo.updateRun(db, run.id, {
      current_stage: 'final_edit',
      current_scope_type: null,
      current_scope_id: null,
      status: 'completed',
      completed_at: new Date().toISOString(),
    });

    const result = await productionService().skipShot(run.id, '1', { reason: '成片后删去开场镜头' });
    const updated = repo.getRun(db, run.id);
    const currentShot2 = currentShotArtifact(run.id, '2');

    assert.equal(result.focus_shot_id, '2');
    assert.equal(updated.current_stage, 'storyboard_plan');
    assert.equal(updated.current_scope_id, '2');
    assert.equal(updated.status, 'running');
    assert.equal(currentShot2.status, 'invalidated');
  });

  it('restores only a new storyboard draft and never revives invalidated descendants', async () => {
    let run = makeRun('restore-shot');
    const shot = addShot(run, 1);
    addShot(run, 2);
    run = placeRun(run, 'storyboard_images', 1);
    const frame = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_images',
      scope_type: 'shot',
      scope_id: '1',
      title: '旧分镜图',
      content: { source_artifact_id: shot.id, included: true },
      status: 'approved',
      media_path: 'images/old.png',
      depends_on: [shot.id],
    });
    await productionService().skipShot(run.id, '1', { reason: '先跳过' });
    const restored = await productionService().restoreShot(run.id, '1', { reason: '需要补回来' });

    const currentPlan = repo.listArtifacts(db, run.id, {
      stage: 'storyboard_plan', scope_type: 'shot', scope_id: '1', current: true,
    }).items[0];
    assert.equal(restored.shot.id, currentPlan.id);
    assert.equal(currentPlan.status, 'draft');
    assert.equal(currentPlan.content.included, true);
    assert.equal(repo.getArtifact(db, frame.id).status, 'invalidated');
    assert.equal(repo.listArtifacts(db, run.id, {
      stage: 'storyboard_images', scope_type: 'shot', scope_id: '1', current: true,
    }).items.some((item) => item.status === 'approved' && item.content?.included !== false), false);
  });

  it('inserts split and pickup drafts in numeric order and enforces max_shots', async () => {
    let run = makeRun('split-pickup', { max_shots: 4 });
    addShot(run, 1);
    addShot(run, 2);
    run = placeRun(run, 'storyboard_plan', 1);
    const service = productionService();
    const shotContent = (label) => ({
      title: label,
      duration: 5,
      action: `${label}动作完整结束`,
      visual: `${label}独立构图`,
      video_prompt: `${label}按时间顺序完成动作`,
      transition_mode: label.includes('前半') ? 'opening' : 'hard_cut',
    });
    const split = await service.splitShot(run.id, '1', {
      instruction: '把未展示的反应拆成下一镜头',
      content: { current_shot: shotContent('前半镜头'), next_shot: shotContent('反应镜头') },
    });
    assert.equal(split.inserted_shot.scope_id, '1.5');
    const pickup = await service.pickupShot(run.id, {
      after_shot_id: '1.5',
      instruction: '补一个道具特写',
      content: shotContent('道具特写'),
    });
    assert.equal(pickup.shot.scope_id, '1.75');
    const order = repo.listArtifacts(db, run.id, {
      stage: 'storyboard_plan', current: true, page_size: 20,
    }).items.sort((a, b) => Number(a.content.number) - Number(b.content.number))
      .map((item) => item.scope_id);
    assert.deepEqual(order, ['1', '1.5', '1.75', '2']);
    await assert.rejects(
      () => service.pickupShot(run.id, {
        after_shot_id: '1.75', instruction: '再补一镜', content: shotContent('额外镜头'),
      }),
      (error) => error.code === 'SHOT_COUNT_BUDGET',
    );
  });

  it('advances to a newly inserted draft instead of skipping to the next approved rough shot', () => {
    let run = makeRun('transition-inserted-draft');
    const shot1 = addShot(run, 1);
    addShot(run, 1.5, 'draft', { title: '待确认补拍镜头' });
    addShot(run, 2);
    repo.createArtifact(db, {
      run_id: run.id,
      stage: 'shot_video',
      scope_type: 'shot',
      scope_id: '1',
      title: '镜头 1 视频',
      content: { source_artifact_id: shot1.id, included: true },
      status: 'approved',
      media_path: 'videos/shot1.mp4',
      depends_on: [shot1.id],
    });
    run = placeRun(run, 'shot_video', 1);

    const transitioned = productionService().transition(run.id, {
      expected_version: repo.getRun(db, run.id).version,
      next_stage_strategy: 'auto_generate',
    });
    assert.equal(transitioned.run.current_stage, 'storyboard_plan');
    assert.equal(transitioned.run.current_scope_id, '1.5');
  });

  it('archives a video that finishes during a skip without reclaiming the run cursor', async () => {
    let run = makeRun('skip-during-poll');
    const shot = addShot(run, 1);
    run = placeRun(run, 'shot_video', 1);
    const action = repo.reserveAction(db, {
      run_id: run.id,
      action_key: 'shot-1-active-video',
      stage: 'shot_video',
      scope_type: 'shot',
      scope_id: '1',
      kind: 'video_generate',
      reserved_video_seconds: 5,
      request: {
        source_artifact_id: shot.id,
        bundle_artifact_id: 44,
        model: 'mg-seedance2.0 -480p mini',
        routing_receipt: { model: 'mg-seedance2.0 -480p mini', duration: 5 },
      },
    }).action;
    repo.updateAction(db, action.id, {
      status: 'waiting', generation_id: 77,
      result: { source_artifact_id: shot.id, bundle_artifact_id: 44 },
    });
    const service = productionService();
    const media = createProductionMediaService(db, cfg, log, {
      async getVideo() {
        await service.skipShot(run.id, '1', { reason: '轮询期间用户跳过' });
        return {
          id: 77,
          status: 'completed',
          local_path: 'videos/detached.mp4',
          video_url: 'https://cdn.example.test/detached.mp4',
        };
      },
    });

    const result = await media.ensureShotVideos(run);
    const finalRun = repo.getRun(db, run.id);
    const finalAction = repo.getAction(db, action.id);
    const archived = repo.listArtifacts(db, run.id, {
      stage: 'shot_video', scope_type: 'shot', scope_id: '1', current: true,
    }).items[0];

    assert.equal(result.reason, 'detached_video_archived');
    assert.equal(finalRun.current_stage, 'final_edit');
    assert.equal(finalRun.current_scope_id, null);
    assert.equal(finalRun.waiting_reason, 'no_included_shots');
    assert.equal(finalAction.status, 'completed');
    assert.equal(finalAction.result.detached_from_sequence, true);
    assert.equal(archived.status, 'approved');
    assert.equal(archived.content.included, false);
    assert.equal(archived.media_path, 'videos/detached.mp4');
  });
});
