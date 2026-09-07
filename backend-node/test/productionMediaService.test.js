const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const repo = require('../src/services/productionRepository');
const {
  createProductionMediaService,
  assertVideoDispatchContract,
  isAmbiguousImageGenerationFailure,
  buildProviderPrompt,
  buildProviderPromptPackage,
  normalizeAutoLinkName,
  PROVIDER_PROMPT_MAX_CHARS,
  canReuseModelCatalogSnapshot,
  discoveryFromStoredSnapshot,
  discoverVideoCatalogForConfig,
  compareReferenceBundleBinding,
  referenceBundleComparison,
} = require('../src/services/productionMediaService');
const {
  routingMaterialSignature,
  routingBindingSignature,
} = require('../src/services/productionVideoRouter');
const { getYinziVideoCapability } = require('../src/services/yinziVideoCapabilities');
const { createFallbackDirectorDocument } = require('../src/services/productionDirector');
const { normalizeVideoRetryPlan } = require('../src/services/productionTextStages');
const aiConfigService = require('../src/services/aiConfigService');
const promptRegistry = require('../src/services/productionPromptRegistry');

let db;
const cfg = { storage: { local_path: './data/storage', base_url: 'http://localhost/static' } };
const log = { info() {}, warn() {}, error() {} };

describe('reference bundle binding comparison', () => {
  const route = {
    profile: 'short_image_guided',
    model: 'seedance-2.5-720p',
    planned_duration: 30,
    provider_duration: 30,
    duration: 30,
    resolution: '720p',
    requires_director_preview: false,
    uses_reference_video: false,
    previs_mode: 'skip',
    director_mode: 'off',
    transition_mode: 'opening',
    requires_strict_first_frame: false,
    group: '特价视频分组(即梦)',
    video_config_id: 7,
    video_config_fingerprint: 'config-a',
    provider_protocol_snapshot: { contract: 'aizzz-video-v1', create_path: '/videos' },
    catalog_version: 'price-v1',
    catalog_fetched_at: '2026-08-31T00:00:00.000Z',
    contract_warnings: [],
  };

  it('does not mark a signed approved bundle stale when only catalog evidence changes', () => {
    const first = { ...route, routing_binding_signature: routingBindingSignature(route) };
    const refreshed = {
      ...route,
      catalog_version: 'price-v2',
      catalog_fetched_at: '2026-09-01T00:00:00.000Z',
      contract_warnings: ['catalog_refresh_notice'],
      routing_binding_signature: routingBindingSignature(route),
    };
    const bundle = {
      id: 1,
      status: 'approved',
      content: {
        source_artifact_id: 10,
        images: [], videos: [], audios: [],
        transition_mode: 'opening',
        reference_video_budget: { enforced: false },
        autolink_receipt: null,
        routing_receipt: first,
        routing_binding_signature: first.routing_binding_signature,
      },
    };
    const desired = {
      route: refreshed,
      content: {
        source_artifact_id: 10,
        images: [], videos: [], audios: [],
        transition_mode: 'opening',
        routing_binding_signature: refreshed.routing_binding_signature,
        routing_receipt: refreshed,
        reference_video_budget: { enforced: false },
        autolink_receipt: null,
      },
      dependencyIds: [10],
    };
    const result = referenceBundleComparison(bundle, desired);
    assert.equal(result.matches, true);
    assert.deepEqual(result.changed, []);
  });

  it('uses stable fields for legacy bundles and ignores absent/volatile fields', () => {
    const legacyReceipt = { ...route };
    delete legacyReceipt.routing_binding_signature;
    const legacyBundle = {
      id: 2,
      status: 'draft',
      content: {
        source_artifact_id: 10,
        images: [], videos: [], audios: [],
        transition_mode: 'opening',
        routing_receipt: legacyReceipt,
        routing_material_signature: 'old-material-signature',
        reference_video_budget: { enforced: false },
        autolink_receipt: null,
      },
    };
    const desired = {
      route: {
        ...route,
        catalog_version: 'price-v99',
        catalog_fetched_at: '2099-01-01T00:00:00.000Z',
      },
      content: {
        source_artifact_id: 10,
        images: [], videos: [], audios: [],
        transition_mode: 'opening',
        reference_video_budget: { enforced: false },
        autolink_receipt: null,
      },
      dependencyIds: [],
    };
    const result = referenceBundleComparison(legacyBundle, desired);
    assert.equal(result.matches, true);
    assert.equal(result.binding.legacy, true);
  });

  it('reports the actual binding field when the model changes', () => {
    const saved = { ...route, routing_binding_signature: routingBindingSignature(route) };
    const desiredRoute = { ...route, model: 'seedance-2.0-720p', routing_binding_signature: routingBindingSignature({ ...route, model: 'seedance-2.0-720p' }) };
    const result = compareReferenceBundleBinding({ content: { routing_receipt: saved, routing_binding_signature: saved.routing_binding_signature } }, { route: desiredRoute });
    assert.equal(result.matches, false);
    assert.equal(result.changed.some((item) => item.field === 'model'), true);
  });
});

describe('production model catalog snapshot fallback', () => {
  it('reuses only a saved credential snapshot after a transient models failure', () => {
    const config = {
      model_catalog_snapshot: {
        version: 1,
        source_url: 'https://api.yinziapi.top/v1/models',
        availability_scope: 'credential',
        scope_verified: true,
        fetched_at: '2026-08-19T00:00:00.000Z',
        models: [{ model: 'seedance-2.5-720p', endpoint_types: ['openai-video'] }],
      },
    };
    assert.equal(canReuseModelCatalogSnapshot({ code: 'MODEL_DISCOVERY_HTTP_ERROR', status: 503 }), true);
    assert.equal(canReuseModelCatalogSnapshot({ code: 'MODEL_DISCOVERY_HTTP_ERROR', status: 400 }), false);
    assert.equal(canReuseModelCatalogSnapshot({ code: 'MODEL_DISCOVERY_ENDPOINT_NOT_FOUND', status: 404 }), false);
    assert.equal(canReuseModelCatalogSnapshot({ code: 'MODEL_DISCOVERY_AUTH_FAILED' }), false);
    const result = discoveryFromStoredSnapshot(config, Object.assign(new Error('模型目录返回 HTTP 503'), {
      code: 'MODEL_DISCOVERY_HTTP_ERROR',
    }));
    assert.equal(result.discovery_outcome, 'snapshot_reused');
    assert.equal(result.stale_snapshot, true);
    assert.deepEqual(result.models.map((item) => item.model), ['seedance-2.5-720p']);
    assert.match(result.warnings[0], /保存的目录快照/);
  });

  it('does not fabricate a catalog when no snapshot exists', () => {
    assert.throws(
      () => discoveryFromStoredSnapshot({}, Object.assign(new Error('unauthorized'), {
        code: 'MODEL_DISCOVERY_AUTH_FAILED',
      })),
      /unauthorized/
    );
  });

  it('keeps the production picker usable when live models is temporarily unavailable', async () => {
    const config = {
      provider: 'yinzi',
      service_type: 'video',
      base_url: 'https://snapshot-route.example/v1',
      api_key: 'snapshot-key',
      settings: { routing_mode: 'smart' },
      model_catalog_snapshot: {
        version: 1,
        source_url: 'https://snapshot-route.example/v1/models',
        availability_scope: 'credential',
        scope_verified: true,
        fetched_at: '2026-08-19T00:00:00.000Z',
        models: [{ model: 'seedance-2.5-720p', endpoint_types: ['openai-video'] }],
      },
    };
    const fetchImpl = async (url) => {
      if (url.endsWith('/models')) return { ok: false, status: 503 };
      if (url.endsWith('/model-capabilities')) return { ok: false, status: 500 };
      if (url === 'https://yinziapi.top/api/pricing') return {
        ok: true, status: 200, async json() { return { success: true, pricing_version: 'snapshot-price-v1', data: [{
          model_name: 'seedance-2.5-720p', supported_endpoint_types: ['openai-video'], enable_groups: ['video'],
          group_pricing: { video: { group: 'video', billing_unit: 'per_second', effective_model_price: 0.672 } },
        }] }; },
      };
      throw new Error(`unexpected URL ${url}`);
    };
    const catalog = await discoverVideoCatalogForConfig(null, config, null, fetchImpl);
    assert.equal(catalog.discovery_outcome, 'snapshot_reused');
    assert.equal(catalog.stale_snapshot, true);
    assert.equal(catalog.video[0].model, 'seedance-2.5-720p');
    assert.equal(catalog.video[0].credential_verified, true);
    assert.match(catalog.warnings.join('\n'), /保存的目录快照/);
  });

});

function migrateQuietly() {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = originalLog; console.warn = originalWarn; }
}

function makeRun(idempotencyKey = 'media-run', policy = {}) {
  return repo.createRun(db, {
    drama_id: 1,
    episode_id: 1,
    idempotency_key: idempotencyKey,
    review_owner: 'human',
    input: { story: '星尘花园' },
    policy: {
      image_model: 'gpt-image-2',
      video_model: 'mg-seedance2.0 -480p mini',
      aspect_ratio: '16:9',
      ...policy,
    },
    budget: {
      max_video_attempts: 10,
      max_video_seconds: 60,
      max_video_attempts_per_shot: 4,
      max_shots: 5,
      max_image_revisions: 3,
    },
  }).run;
}

function addApproved(run, stage, scopeType, scopeId, title, content, dependencies = []) {
  return repo.createArtifact(db, {
    run_id: run.id,
    stage,
    scope_type: scopeType,
    scope_id: scopeId,
    title,
    content: { included: true, ...content },
    status: 'approved',
    depends_on: dependencies,
  });
}

function imageReceipt(path = 'images/test.png') {
  return {
    relative_path: path,
    absolute_path: `C:/storage/${path}`,
    bytes: 120000,
    sha256: 'a'.repeat(64),
    width: 1536,
    height: 1024,
    format: 'png',
    nonblank: true,
  };
}

function videoReceipt(path = 'videos/test.mp4', signature = 'mp4') {
  return {
    relative_path: path,
    absolute_path: `C:/storage/${path}`,
    bytes: 900000,
    sha256: 'b'.repeat(64),
    signature,
    duration: 5,
    width: 854,
    height: 480,
    video_codec: 'h264',
    audio_codec: 'aac',
    nonblank: true,
  };
}

function routedCatalog() {
  const group = '特价视频分组(即梦)';
  const item = (model, effectivePrice) => ({
    model,
    endpoint_types: ['openai-video'],
    groups: [group],
    prices: [{ group, billing_unit: 'per_second', effective_price: effectivePrice }],
  });
  return {
    pricing_version: 'media-route-fixture-v1',
    fetched_at: '2026-08-07T00:00:00.000Z',
    video: [
      item('cc-seedance2.0 480p-fast-nsp', 0.4656),
      item('mg-seedance2.0 -480p mini', 0.2004),
    ],
  };
}

function customVideoCatalog(model) {
  return {
    pricing_version: 'custom-video-fixture-v1',
    fetched_at: '2026-08-09T00:00:00.000Z',
    video: [{
      model,
      endpoint_types: ['openai-video'],
      groups: ['特价视频分组(即梦)'],
      prices: [{ group: '特价视频分组(即梦)', billing_unit: 'per_second', effective_price: 0.1 }],
    }],
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  migrateQuietly();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (id, title, created_at, updated_at) VALUES (1, ?, ?, ?)').run('星尘花园', now, now);
  db.prepare('INSERT INTO episodes (id, drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, 1, ?, ?, ?)').run('第一集', now, now);
});

afterEach(() => db.close());

describe('production media executor', () => {
  it('uses an uploaded subject image as the real image2 reference for image-to-video identity sheets', async () => {
    let run = makeRun('image-to-video-uploaded-subject', {
      template_id: 'image-to-video',
      image_concurrency: 1,
      asset_image_model: 'gpt-image-2',
    });
    const source = addApproved(run, 'asset_text', 'character', 'character-1', '猫娘', {
      name: '猫娘',
      description: '棕色长发、猫耳和猫尾，浅色上衣，铃铛项圈',
      visual_prompt: '同一角色四视图设定板',
      authority: 'uploaded_asset',
      source_artifact_id: 182,
      must_preserve_identity: true,
    });
    const uploaded = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'asset_images',
      scope_type: 'character',
      scope_id: 'character-1',
      title: '用户上传猫娘.png',
      content: {
        imported: true,
        authority: 'uploaded_asset',
        usage_role: 'primary_subject_reference',
        sha256: 'c'.repeat(64),
        included: true,
      },
      media_path: 'imports/session/catgirl.png',
      mime_type: 'image/png',
      content_hash: 'c'.repeat(64),
      status: 'approved',
    });
    let request;
    const service = createProductionMediaService(db, cfg, log, {
      createImage: async (value) => {
        request = value;
        return { id: 901, task_id: 'image2-identity-sheet-901' };
      },
      getImage: async () => ({ id: 901, task_id: 'image2-identity-sheet-901', status: 'processing' }),
    });

    const result = await service.ensureImageStage(repo.getRun(db, run.id), 'asset_images');
    assert.equal(result.state, 'waiting_task');
    assert.equal(request.frame_type, 'character_reference_sheet');
    assert.deepEqual(request.reference_images, [uploaded.media_path]);
    assert.deepEqual(request.reference_artifact_ids, [uploaded.id]);
    assert.deepEqual(request.reference_roles, ['primary_subject_reference']);
    assert.deepEqual(request.reference_sources, ['uploaded_authority']);
    assert.deepEqual(request.reference_hashes, ['c'.repeat(64)]);
    assert.equal(request.reference_transport_types[0], 'storage_path');
    assert.equal(request.reference_provenance[0].artifact_id, uploaded.id);
    assert.match(request.prompt, /用户上传的唯一主体身份权威/);
    assert.match(request.prompt, /恰好四视图设定板/);
    assert.match(request.negative_prompt, /inconsistent identity/);
    assert.equal(repo.listActions(db, run.id, { page_size: 20 }).items.filter((item) => item.kind === 'image_generate').length, 1);
    assert.equal(Number(source.id) > 0, true);
  });

  it('recovers a legacy imported subject reference when authority fields are absent', async () => {
    const run = makeRun('legacy-uploaded-authority', {
      template_id: 'image-to-video', image_concurrency: 1, asset_image_model: 'gpt-image-2',
    });
    const uploaded = repo.createArtifact(db, {
      run_id: run.id, stage: 'asset_images', scope_type: 'character', scope_id: 'character-1',
      title: '历史导入主体图', content: {
        imported: true, usage_role: 'primary_subject_reference', included: true,
      }, media_path: 'imports/legacy/catgirl.png', mime_type: 'image/png',
      content_hash: 'e'.repeat(64), status: 'approved',
    });
    const source = addApproved(run, 'asset_text', 'character', 'character-1', '猫娘', {
      name: '猫娘', description: '历史导入的猫娘主体', visual_prompt: '四视图身份设定板',
      source_artifact_id: uploaded.id,
    });
    let request;
    const service = createProductionMediaService(db, cfg, log, {
      createImage: async (value) => {
        request = value;
        return { id: 903, task_id: 'legacy-image-task-903' };
      },
      getImage: async () => ({ id: 903, task_id: 'legacy-image-task-903', status: 'processing' }),
    });
    const result = await service.ensureImageStage(repo.getRun(db, run.id), 'asset_images');
    assert.equal(result.state, 'waiting_task');
    assert.deepEqual(request.reference_images, [uploaded.media_path]);
    assert.deepEqual(request.reference_artifact_ids, [uploaded.id]);
    assert.deepEqual(request.reference_sources, ['uploaded_authority']);
    assert.equal(request.reference_provenance[0].artifact_id, uploaded.id);
    assert.match(request.prompt, /用户上传的唯一主体身份权威/);
    assert.equal(Number(source.content.source_artifact_id), Number(uploaded.id));
  });

  it('keeps uploaded authority images as direct reusable assets for non image-to-video templates', async () => {
    const run = makeRun('reuse-uploaded-subject', { template_id: 'travel-memory', image_concurrency: 1 });
    addApproved(run, 'asset_text', 'character', 'character-1', '旅行者', {
      name: '旅行者', description: '用户提供的旅行照片主体', visual_prompt: '角色设定板',
    });
    repo.createArtifact(db, {
      run_id: run.id, stage: 'asset_images', scope_type: 'character', scope_id: 'character-1',
      title: '旅行者原图', media_path: 'imports/session/traveler.png', mime_type: 'image/png',
      content_hash: 'd'.repeat(64), status: 'approved',
      content: { imported: true, authority: 'uploaded_asset', included: true },
    });
    let creates = 0;
    const service = createProductionMediaService(db, cfg, log, {
      createImage: async () => { creates += 1; return { id: 902, task_id: 'should-not-run' }; },
    });
    const result = await service.ensureImageStage(repo.getRun(db, run.id), 'asset_images');
    assert.equal(result.state, 'stage_ready');
    assert.equal(creates, 0);
  });

  it('reuses explicit imported clips and creates only the missing shot action', async () => {
    const run = makeRun('direct-clip-gap', {
      video_routing_mode: 'fixed',
      video_model: 'manual-video',
      video_group: '特价视频分组(即梦)',
      director_mode: 'off',
      execution_plan: {
        schema_version: 1,
        template_id: 'travel-memory',
        shots: [
          { number: 1, id: 'shot-1', source: 'imported_clip', status: 'approved' },
          { number: 2, id: 'shot-2', source: 'generate', status: 'pending' },
          { number: 3, id: 'shot-3', source: 'imported_clip', status: 'approved' },
        ],
      },
    });
    for (const number of [1, 2, 3]) {
      const shot = addApproved(run, 'storyboard_plan', 'shot', String(number), `镜头 ${number}`, {
        number,
        duration: 5,
        action: `动作 ${number}`,
        visual: `画面 ${number}`,
        video_prompt: `Generate shot ${number}.`,
        transition_mode: number === 1 ? 'opening' : 'hard_cut',
        character_names: [],
        prop_names: [],
      });
      const frame = addApproved(run, 'storyboard_images', 'shot', String(number), `镜头 ${number} 分镜图`, {
        source_artifact_id: shot.id,
      }, [shot.id]);
      db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?')
        .run(`images/direct-clip-${number}.png`, frame.id);
    }
    for (const number of [1, 3]) {
      repo.createArtifact(db, {
        run_id: run.id,
        stage: 'shot_video',
        scope_type: 'shot',
        scope_id: String(number),
        title: `已上传镜头 ${number}`,
        media_path: `imports/direct-clip-${number}.mp4`,
        mime_type: 'video/mp4',
        content: {
          imported: true,
          direct_clip_candidate: true,
          included: true,
          source_relative_path: `shot-${String(number).padStart(2, '0')}.mp4`,
        },
        status: 'approved',
      });
    }

    let creates = 0;
    const service = createProductionMediaService(db, cfg, log, {
      fetchVideoCatalog: async () => customVideoCatalog('manual-video'),
      createVideo: async () => {
        creates += 1;
        return { id: 991, task_id: 'direct-clip-gap-task', model: 'manual-video' };
      },
      getVideo: async () => ({ id: 991, task_id: 'direct-clip-gap-task', status: 'processing' }),
    });

    let result = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      result = await service.ensureShotVideos(repo.getRun(db, run.id));
      if (result.state === 'waiting_provider') break;
      const bundle = repo.listArtifacts(db, run.id, {
        stage: 'reference_bundle', current: true, scope_type: 'shot', scope_id: '2', page_size: 10,
      }).items[0];
      assert.ok(bundle, `missing reference bundle after ${result.reason}`);
      if (bundle.status !== 'approved') repo.reviewArtifact(db, bundle.id, {
        reviewer_type: 'human', decision: 'approved', reason: '本地集成验收批准参考包',
      });
    }
    assert.equal(result.state, 'waiting_provider');
    assert.equal(result.shot.scope_id, '2');
    assert.equal(creates, 1);
    assert.equal(
      repo.listActions(db, run.id, { page_size: 200 }).items.filter((item) => item.kind === 'video_generate').length,
      1,
    );
    assert.equal(
      repo.listArtifacts(db, run.id, { stage: 'shot_video', current: true, status: 'approved', page_size: 20 }).items
        .filter((item) => item.content?.imported === true).length,
      2,
    );
  });

  it('requires configured, bundle, request, and persisted generation model identities to agree', () => {
    const run = {
      policy: {
        video_routing_mode: 'fixed',
        video_model: 'model-b',
        video_model_overrides: { 5: 'model-b' },
      },
    };
    const shot = { scope_id: '5' };
    const route = {
      model: 'model-b', duration: 5, planned_duration: 5,
      profile: 'short_image_guided', uses_reference_video: false,
      requires_director_preview: false, director_mode: 'auto', transition_mode: 'hard_cut',
      requires_strict_first_frame: false,
      limits: { images: 4, videos: 0, audios: 1 },
      roles: { image: ['reference'], video: [], audio: ['reference'] },
    };
    route.material_signature = routingMaterialSignature(route);
    const bundle = {
      id: 50,
      status: 'approved',
      content: {
        routing_receipt: { ...route },
        routing_material_signature: route.material_signature,
      },
    };
    const request = {
      model: 'model-b',
      bundle_artifact_id: 50,
      routing_receipt: { ...route },
      routing_material_signature: route.material_signature,
    };
    const receipt = assertVideoDispatchContract({
      run, shot, route, bundle, request, persistedModel: 'model-b',
    });
    assert.equal(receipt.consistent, true);
    assert.equal(receipt.dispatched_model, 'model-b');
    assert.throws(
      () => assertVideoDispatchContract({
        run, shot, route, bundle, request: { ...request, model: 'model-a' }, persistedModel: 'model-b',
      }),
      (error) => error.code === 'VIDEO_DISPATCH_CONTRACT_MISMATCH'
    );
  });

  it('stops a stale route snapshot when the model changes during final catalog validation', async () => {
    let run = makeRun('dispatch-route-race');
    run = repo.updateRun(db, run.id, {
      policy: {
        ...run.policy,
        video_routing_mode: 'fixed',
        video_group: '特价视频分组(即梦)',
        video_model: 'mg-seedance2.0 -480p mini',
      },
    });
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', 'Route race shot', {
      number: 1,
      duration: 5,
      action: '角色抬头后静止',
      visual: '固定中近景',
      video_prompt: 'Complete one stable reaction and hold.',
      transition_mode: 'opening',
      character_names: [],
      prop_names: [],
    });
    const frame = addApproved(run, 'storyboard_images', 'shot', '1', 'Route race frame', {
      source_artifact_id: shot.id,
    }, [shot.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?')
      .run('images/route-race.png', frame.id);

    let fetchCalls = 0;
    let creates = 0;
    const service = createProductionMediaService(db, cfg, log, {
      fetchVideoCatalog: async () => {
        fetchCalls += 1;
        if (fetchCalls === 3) {
          const current = repo.getRun(db, run.id);
          repo.updateRun(db, run.id, {
            policy: {
              ...current.policy,
              video_model_overrides: { ...(current.policy.video_model_overrides || {}), 1: 'cc-seedance2.0 480p-fast-nsp' },
            },
          });
        }
        return routedCatalog();
      },
      createVideo: async () => {
        creates += 1;
        return { id: 900, task_id: 'must-not-submit', model: 'mg-seedance2.0 -480p mini' };
      },
    });
    const bundled = await service.ensureReferenceBundles(repo.getRun(db, run.id));
    repo.reviewArtifact(db, bundled.artifact.id, {
      reviewer_type: 'human', decision: 'approved', reason: 'approve route A bundle',
    });

    const beforeUsage = repo.getRun(db, run.id).usage;
    const result = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(result.state, 'waiting_review');
    assert.equal(result.reason, 'video_dispatch_state_changed');
    assert.equal(creates, 0);
    assert.deepEqual(repo.getRun(db, run.id).usage, beforeUsage);
    assert.equal(
      repo.listActions(db, run.id, { page_size: 200 }).items.filter((item) => item.kind === 'video_generate').length,
      0
    );
    assert.equal(repo.getRun(db, run.id).policy.video_model_overrides['1'], 'cc-seedance2.0 480p-fast-nsp');
  });

  it('keeps a switched route authoritative when an old in-flight generation finishes later', async () => {
    let run = makeRun('in-flight-route-switch');
    run = repo.updateRun(db, run.id, {
      policy: {
        ...run.policy,
        video_routing_mode: 'fixed',
        video_group: '特价视频分组(即梦)',
        video_model: 'mg-seedance2.0 -480p mini',
      },
    });
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', 'Late provider result', {
      number: 1, duration: 5, action: '角色转身后停住', visual: '固定中景',
      video_prompt: 'Turn once and hold the final pose.', transition_mode: 'opening',
      character_names: [], prop_names: [],
    });
    const frame = addApproved(run, 'storyboard_images', 'shot', '1', 'Late result frame', {
      source_artifact_id: shot.id,
    }, [shot.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?')
      .run('images/late-result.png', frame.id);

    let generationStatus = 'processing';
    let creates = 0;
    const service = createProductionMediaService(db, cfg, log, {
      fetchVideoCatalog: async () => routedCatalog(),
      createVideo: async (request) => {
        creates += 1;
        return { id: 901, task_id: 'old-model-task', model: request.model };
      },
      getVideo: async () => ({
        id: 901, task_id: 'old-model-task', status: generationStatus,
        model: 'mg-seedance2.0 -480p mini', local_path: 'videos/old-model.mp4',
      }),
      validateVideo: async () => videoReceipt('videos/old-model.mp4'),
    });
    const firstBundle = await service.ensureReferenceBundles(repo.getRun(db, run.id));
    repo.reviewArtifact(db, firstBundle.artifact.id, {
      reviewer_type: 'human', decision: 'approved', reason: 'approve model A bundle',
    });
    const submitted = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(submitted.state, 'waiting_provider');
    assert.equal(submitted.action.request.model, 'mg-seedance2.0 -480p mini');

    const beforeSwitch = repo.getRun(db, run.id);
    repo.updateRun(db, run.id, {
      policy: {
        ...beforeSwitch.policy,
        video_model_overrides: { ...(beforeSwitch.policy.video_model_overrides || {}), 1: 'cc-seedance2.0 480p-fast-nsp' },
      },
      current_stage: 'reference_bundle', current_scope_type: 'shot', current_scope_id: '1',
      status: 'waiting_review', waiting_reason: 'video_route_changed',
    });
    const switchedBundle = await service.ensureReferenceBundleForShot(beforeSwitch, shot);
    assert.equal(switchedBundle.state, 'refreshed');
    assert.equal(switchedBundle.artifact.content.routing_receipt.model, 'cc-seedance2.0 480p-fast-nsp');
    repo.reviewArtifact(db, switchedBundle.artifact.id, {
      reviewer_type: 'human', decision: 'approved', reason: 'approve model B bundle',
    });

    const waiting = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(waiting.reason, 'superseded_video_waiting');
    assert.equal(repo.getRun(db, run.id).status, 'waiting_provider');
    generationStatus = 'completed';
    const stale = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(stale.state, 'progressed');
    assert.equal(stale.reason, 'superseded_video_converged');
    assert.equal(repo.getAction(db, submitted.action.id).result.superseded_by_route_change, true);
    assert.equal(repo.getAction(db, submitted.action.id).status, 'completed');
    const bundles = repo.listArtifacts(db, run.id, {
      stage: 'reference_bundle', scope_id: '1', page_size: 20,
    }).items;
    assert.equal(bundles.length, 2);
    assert.equal(bundles[0].content.routing_receipt.model, 'cc-seedance2.0 480p-fast-nsp');
    assert.equal(creates, 1);
    assert.equal(repo.listArtifacts(db, run.id, {
      stage: 'shot_video', scope_id: '1', current: true, page_size: 10,
    }).items.length, 0);
    const replacement = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(replacement.state, 'waiting_provider');
    assert.equal(replacement.action.request.model, 'cc-seedance2.0 480p-fast-nsp');
    assert.equal(creates, 2);
  });

  it('AutoLink normalizes names and never fills reference capacity with unrelated assets', () => {
    const run = makeRun('shot-named-autolink');
    const definitions = [
      ['scene', 'scene-cyber', '赛博　街区'],
      ['character', 'hero', 'Silver Ｇirl'],
      ['character', 'dog', '犬妖'],
      ['prop', 'sword', '桃木·剑'],
      ['prop', 'seal', '符箓'],
      ['character', 'bystander', '无关路人'],
    ].map(([scopeType, scopeId, name]) => addApproved(run, 'asset_text', scopeType, scopeId, name, {
      name, description: `${name} asset`, visual_prompt: `${name} reference sheet`,
    }));
    const images = definitions.filter((item) => item.scope_id !== 'dog').map((definition) => {
      const image = addApproved(run, 'asset_images', definition.scope_type, definition.scope_id, `${definition.title} image`, {
        source_artifact_id: definition.id,
      }, [definition.id]);
      db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?')
        .run(`images/${definition.scope_id}.png`, image.id);
      return image;
    });
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', 'Named assets only', {
      number: 1,
      scene_name: '赛博-街区',
      character_names: ['silver-girl', '犬妖', 'silver girl'],
      prop_names: ['桃木 剑', '符箓', '不存在'],
    });
    const service = createProductionMediaService(db, cfg, log);

    const linked = service.buildImageReferenceAutoLink(run, shot, 2, {
      providerImageLimit: 4,
      mandatoryImageCount: 2,
    });
    assert.equal(normalizeAutoLinkName(' Ａ· B '), 'ab');
    assert.deepEqual(linked.references.map((item) => item.path), ['images/scene-cyber.png', 'images/hero.png']);
    assert.doesNotMatch(JSON.stringify(linked), /bystander|无关路人/);
    assert.deepEqual(linked.references.map((item) => item.label), ['场景 · 赛博　街区', '角色 · Silver Ｇirl']);
    assert.deepEqual(linked.receipt.items.map((item) => item.status), [
      'matched',
      'matched',
      'missing_approved_image',
      'omitted_by_capacity',
      'omitted_by_capacity',
      'missing_asset_definition',
    ]);
    assert.deepEqual(linked.receipt.capacity, {
      provider_image_limit: 4,
      mandatory_image_count: 2,
      asset_slot_limit: 2,
      selected_asset_images: 2,
    });
    assert.equal(linked.receipt.summary.matched_count, 2);
    assert.equal(linked.receipt.summary.warning_count, 4);
    assert.deepEqual(linked.dependencyIds, [definitions[0].id, definitions[1].id, images[0].id, images[1].id].sort((a, b) => a - b));
  });

  it('AutoLink reports normalized-name collisions instead of guessing', () => {
    const run = makeRun('ambiguous-shot-autolink');
    const first = addApproved(run, 'asset_text', 'prop', 'prop-a', 'A-B', {
      name: 'A-B', description: 'first prop', visual_prompt: 'first sheet',
    });
    const second = addApproved(run, 'asset_text', 'prop', 'prop-b', 'Ａ B', {
      name: 'Ａ B', description: 'second prop', visual_prompt: 'second sheet',
    });
    for (const definition of [first, second]) {
      const image = addApproved(run, 'asset_images', 'prop', definition.scope_id, `${definition.title} image`, {
        source_artifact_id: definition.id,
      }, [definition.id]);
      db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?')
        .run(`images/${definition.scope_id}.png`, image.id);
    }
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', 'Collision', {
      number: 1, prop_names: ['a_b'],
    });
    const linked = createProductionMediaService(db, cfg, log).buildImageReferenceAutoLink(run, shot, 4);
    assert.deepEqual(linked.references, []);
    assert.equal(linked.receipt.items[0].status, 'ambiguous_asset_definition');
    assert.deepEqual(linked.receipt.items[0].candidate_definition_artifact_ids, [first.id, second.id]);
  });

  it('AutoLink resolves storyboard references by stable scope IDs before names', () => {
    const run = makeRun('stable-id-autolink');
    const character = addApproved(run, 'asset_text', 'character', 'character-1', '猫娘 A', {
      name: '猫娘 A', description: '角色 A', visual_prompt: '角色 A', execution_asset_id: 'asset-cat-a', included: true,
    });
    const scene = addApproved(run, 'asset_text', 'scene', 'scene-1', '花园', {
      name: '花园', description: '场景', visual_prompt: '花园', included: true,
    });
    const characterImage = addApproved(run, 'asset_images', 'character', 'character-1', '角色 A 图', { source_artifact_id: character.id }, [character.id]);
    const sceneImage = addApproved(run, 'asset_images', 'scene', 'scene-1', '花园图', { source_artifact_id: scene.id }, [scene.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?').run('images/character-a.png', characterImage.id);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?').run('images/garden.png', sceneImage.id);
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', '稳定 ID 镜头', {
      character_ids: ['character-1'], scene_id: 'scene-1', character_names: ['完全不同的名字'], scene_name: '错误名字', prop_names: [], included: true,
    });
    const linked = createProductionMediaService(db, cfg, log).buildImageReferenceAutoLink(repo.getRun(db, run.id), shot, 4);
    assert.deepEqual(linked.references.map((item) => item.artifact_id).sort((a, b) => a - b), [sceneImage.id, characterImage.id].sort((a, b) => a - b));
    assert.ok(linked.receipt.items.filter((item) => item.requested_id).every((item) => item.match_basis === 'stable_id'));
  });

  it('rejects unusable retry-planner output instead of falling back to raw prose', () => {
    assert.throws(() => normalizeVideoRetryPlan('not json', log));
    assert.throws(() => normalizeVideoRetryPlan(JSON.stringify({
      failure_memory: [], provider_prompt: 'short',
    }), log), /empty or unusable/);
    assert.throws(() => normalizeVideoRetryPlan(JSON.stringify({
      failure_memory: [],
      provider_prompt: 'A sufficiently detailed chronological provider prompt that is longer than forty characters.',
    }), log), /structured failure memory/);
  });

  it('keeps failed retry-planner history immutable and reserves a fresh action after authorization', async () => {
    const run = makeRun('planner-action-retry', { director_mode: 'off' });
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', 'Retry planner shot', {
      number: 1,
      duration: 5,
      route_profile: 'short_image_guided',
      action: 'The subject closes the hatch and stops.',
      visual: 'Stable medium shot in the approved room.',
      video_prompt: 'Hold the same room and subject identity while the hatch closes completely.',
      boundary_prompt: 'Opening shot with one complete action.',
      cut_in: 'The hatch is open.',
      continuity_in: 'The room and subject match the approved frame.',
      continuity_out: 'The hatch is fully closed and the subject is still.',
      cut_out: 'Cut after the action has stopped.',
      character_names: [],
      scene_name: '',
      prop_names: [],
    });
    const frame = addApproved(run, 'storyboard_images', 'shot', '1', 'Retry planner frame', {
      source_artifact_id: shot.id,
    }, [shot.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?')
      .run('images/retry-planner-frame.png', frame.id);
    const rejected = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'shot_video',
      scope_type: 'shot',
      scope_id: '1',
      title: 'Rejected retry planner source',
      content: { source_artifact_id: shot.id, included: true },
      status: 'draft',
      media_path: 'videos/retry-planner-rejected.mp4',
      mime_type: 'video/mp4',
      depends_on: [shot.id],
    });
    repo.reviewArtifact(db, rejected.id, {
      reviewer_type: 'human',
      decision: 'rejected',
      reason: 'The hatch remained open and an extra subject appeared.',
    });

    let plannerCalls = 0;
    const service = createProductionMediaService(db, cfg, log, {
      fetchVideoCatalog: async () => routedCatalog(),
      generateText: async () => {
        plannerCalls += 1;
        if (plannerCalls === 1) {
          const error = new Error('temporary planner transport failure');
          error.code = 'TEXT_TRANSPORT_FAILED';
          throw error;
        }
        return JSON.stringify({
          failure_memory: [{
            review_id: 1,
            observed_failure: 'The hatch stayed open and a second subject appeared.',
            violated_constraint: 'The hatch must close and the cast count may not change.',
            required_state: 'Keep one subject and end with the hatch fully closed.',
          }],
          provider_prompt: 'Keep exactly one approved subject in the same room. Close the hatch completely during this shot, then hold the final still state without adding any person or object.',
        });
      },
      createVideo: async () => { throw new Error('video dispatch must not run in this planner test'); },
    });
    const bundled = await service.ensureReferenceBundles(run);
    assert.equal(bundled.state, 'progressed');
    repo.reviewArtifact(db, bundled.artifact.id, {
      reviewer_type: 'human', decision: 'approved', reason: 'Bundle approved for planner retry test',
    });

    const first = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(first.state, 'waiting_review');
    assert.equal(first.reason, 'video_prompt_plan_failed');
    assert.equal(first.action.status, 'failed');
    const firstLedger = db.prepare('SELECT * FROM cost_ledger WHERE action_id = ?').get(first.action.id);
    assert.ok(firstLedger);
    repo.updateAction(db, first.action.id, {
      status: 'cancelled',
      result: { retry_authorized: true, retry_reason: 'Retry the temporary planner failure' },
    });
    repo.updateRun(db, run.id, { status: 'running', waiting_reason: null, error_code: null, error_message: null });

    const second = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(second.state, 'progressed');
    assert.equal(second.reason, 'video_prompt_planned');
    assert.notEqual(second.action.id, first.action.id);
    assert.equal(second.action.attempt, first.action.attempt + 1);
    assert.equal(second.action.request.retry_of_action_id, first.action.id);
    assert.equal(second.action.result.prior_failures[0].action_id, first.action.id);
    assert.equal(repo.getAction(db, first.action.id).status, 'cancelled');
    const secondLedger = db.prepare('SELECT * FROM cost_ledger WHERE action_id = ?').get(second.action.id);
    assert.ok(secondLedger);
    assert.notEqual(secondLedger.id, firstLedger.id);
    assert.equal(db.prepare(
      `SELECT COUNT(*) AS n FROM production_actions
       WHERE run_id = ? AND kind = 'video_prompt_plan' AND scope_id = '1'`
    ).get(run.id).n, 2);
    assert.equal(db.prepare(
      `SELECT COUNT(*) AS n FROM cost_ledger
       WHERE action_id IN (?, ?)`
    ).get(first.action.id, second.action.id).n, 2);
    assert.equal(plannerCalls, 2);
  });

  it('applies configurable final-video creative guidance while preserving its locked receipt', () => {
    const run = makeRun('provider-guidance-override');
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', 'Guidance shot', {
      number: 1,
      duration: 5,
      action: 'The subject turns once and stops.',
      visual: 'Medium shot.',
      video_prompt: 'Turn once, then stop in the marked position.',
      continuity_in: 'One subject in the approved room.',
      continuity_out: 'The same subject is still.',
      cut_out: 'Cut on stillness.',
    });
    const customGuidance = '保持动作克制，确保接触关系、重心与衣料运动可信；镜头不抖动。';
    require('../src/services/productionPromptRegistry').set(
      db, 'production.video_provider.guidance', customGuidance,
    );
    const packaged = buildProviderPromptPackage(
      db,
      run,
      shot,
      { content: { images: [], videos: [], audios: [] } },
      shot.content.video_prompt,
    );
    assert.match(packaged.prompt, /保持动作克制/);
    assert.match(packaged.prompt, /不得覆盖镜头边界/);
    assert.equal(packaged.receipt.prompt_snapshot.prompt_id, 'production.video_provider.guidance');
    assert.equal(packaged.receipt.prompt_snapshot.customized, true);
    assert.equal(packaged.receipt.prompt_snapshot.content, packaged.prompt
      .split('【统一生成禁令】\n')[1].split('\n\n【相关固定资产约束】')[0]);
  });

  it('compacts oversized provider prompts without dropping references, exits, or fixed assets', () => {
    const run = makeRun('overflow-provider-prompt');
    const oversized = '必须保持同一可见状态、空间位置、材质、数量和照明，不得自行解释或替换。'.repeat(500);
    const resources = [
      ['character', 'character-overflow', 'HeroOverflow'],
      ['scene', 'scene-overflow', 'SceneOverflow'],
      ['prop', 'prop-overflow-a', 'PropOverflowA'],
      ['prop', 'prop-overflow-b', 'PropOverflowB'],
    ].map(([scopeType, scopeId, name]) => addApproved(
      run,
      'asset_text',
      scopeType,
      scopeId,
      name,
      {
        name,
        appearance: oversized,
        description: oversized,
        identity_anchors: [oversized],
        spatial_anchors: [oversized],
        continuity_rules: [oversized],
        negative_prompt: oversized,
      }
    ));
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', 'Overflow shot', {
      number: 1,
      duration: 7,
      boundary_prompt: `BOUNDARY_SENTINEL ${oversized}`,
      cut_in: `ENTRY_SENTINEL ${oversized}`,
      continuity_in: oversized,
      visual: oversized,
      shot_type: oversized,
      camera_angle: oversized,
      camera_movement: oversized,
      lighting: oversized,
      video_prompt: `TIMELINE_SENTINEL ${oversized}`,
      continuity_out: `EXIT_SENTINEL ${oversized}`,
      cut_out: `CUT_SENTINEL ${oversized}`,
      character_names: [resources[0].content.name],
      scene_name: resources[1].content.name,
      prop_names: [resources[2].content.name, resources[3].content.name],
    });
    const bundle = {
      content: {
        images: [
          { source: 'storyboard', label: 'REF_IMAGE_1' },
          { source: 'asset', scope_type: 'scene', label: 'REF_IMAGE_2' },
          { source: 'asset', scope_type: 'character', label: 'REF_IMAGE_3' },
          { source: 'asset', scope_type: 'prop', label: 'REF_IMAGE_4' },
        ],
        videos: [
          { source: 'director', label: 'REF_VIDEO_1' },
          { source: 'continuity_in', label: 'REF_VIDEO_2' },
          { source: 'reference', label: 'REF_VIDEO_3' },
        ],
        audios: [{ source: 'reference', label: 'REF_AUDIO_1' }],
      },
    };

    const prompt = buildProviderPrompt(db, run, shot, bundle, shot.content.video_prompt);
    assert.ok(prompt.length <= 4000);
    assert.doesNotMatch(prompt, /\.\.\./);
    for (const heading of [
      '镜头边界，最高优先级', '生成任务', '参考媒体使用规则，严格按传入顺序',
      '精确入镜状态', '画面与摄影', '本镜头完整动作时间线',
      '精确出镜状态与剪辑点', '统一生成禁令', '相关固定资产约束',
    ]) assert.match(prompt, new RegExp(`【${heading}】`));
    for (const sentinel of [
      'BOUNDARY_SENTINEL', 'ENTRY_SENTINEL', 'TIMELINE_SENTINEL', 'EXIT_SENTINEL', 'CUT_SENTINEL',
      'REF_IMAGE_1', 'REF_IMAGE_2', 'REF_IMAGE_3', 'REF_IMAGE_4',
      'REF_VIDEO_1', 'REF_VIDEO_2', 'REF_VIDEO_3', 'REF_AUDIO_1',
      'HeroOverflow', 'SceneOverflow', 'PropOverflowA', 'PropOverflowB',
    ]) assert.match(prompt, new RegExp(sentinel));
  });

  it('fails locally when a mandatory oversized semantic unit cannot be packaged intact', () => {
    const run = makeRun('uncompactable-provider-prompt');
    const unbroken = 'X'.repeat(1800);
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', 'Uncompactable shot', {
      number: 1,
      duration: 5,
      boundary_prompt: unbroken,
      cut_in: unbroken,
      visual: unbroken,
      video_prompt: `TIME_A。${'timeline detail。'.repeat(500)}TIME_B。`,
      continuity_out: unbroken,
      cut_out: unbroken,
    });
    assert.throws(
      () => buildProviderPromptPackage(db, run, shot, { content: { images: [], videos: [], audios: [] } }, shot.content.video_prompt),
      (error) => error.code === 'PROVIDER_PROMPT_UNCOMPACTABLE'
    );
  });

  it('treats a lost synchronous image response as ambiguous but keeps provider rejections definite', async () => {
    assert.equal(isAmbiguousImageGenerationFailure({ status: 'failed', error_msg: 'Image generation HTTP timeout after 600000ms' }), true);
    assert.equal(isAmbiguousImageGenerationFailure({ status: 'failed', error_msg: 'read ECONNRESET' }), true);
    assert.equal(isAmbiguousImageGenerationFailure({ status: 'failed', error_msg: '400 moderation rejected' }), false);
    assert.equal(isAmbiguousImageGenerationFailure({ status: 'completed', error_msg: 'timeout in old log' }), false);

    const run = makeRun('ambiguous-image-run');
    addApproved(run, 'asset_text', 'character', 'character-1', 'Lin Lan', {
      name: 'Lin Lan', description: 'adult astronaut', visual_prompt: 'four-view identity sheet',
    });
    const service = createProductionMediaService(db, cfg, log, {
      createImage: async () => ({ id: 72, task_id: 'image-task-72' }),
      getImage: async () => ({
        id: 72,
        task_id: 'image-task-72',
        status: 'failed',
        error_msg: 'Image generation HTTP timeout after 600000ms',
      }),
    });

    assert.equal((await service.ensureImageStage(run, 'asset_images')).state, 'waiting_task');
    const reconciled = await service.ensureImageStage(repo.getRun(db, run.id), 'asset_images');
    assert.equal(reconciled.state, 'waiting_review');
    assert.equal(reconciled.reason, 'image_generation_ambiguous');
    const action = repo.getLatestAction(db, run.id, {
      stage: 'asset_images', scope_type: 'character', scope_id: 'character-1', kind: 'image_generate',
    });
    assert.equal(action.status, 'ambiguous');
    assert.equal(action.result.ambiguous_reason, 'provider_transport_lost');
    assert.equal(repo.getRun(db, run.id).waiting_reason, 'image_generation_ambiguous');
  });

  it('reconciles an image task into a validated draft artifact without duplicate submission', async () => {
    let run = makeRun('media-run', { image_retry_reference_policy: 'include_rejected', aspect_ratio: '9:16' });
    const source = addApproved(run, 'asset_text', 'character', 'character-1', '林夏', {
      name: '林夏', description: '年轻宇航员', visual_prompt: '角色四视图', required_fields: ['name', 'description', 'visual_prompt'],
    });
    let creates = 0;
    const imageRequests = [];
    const imageValidationOptions = [];
    let status = 'processing';
    const service = createProductionMediaService(db, cfg, log, {
      createImage: async (request) => {
        creates += 1;
        imageRequests.push(request);
        return { id: 71, task_id: 'image-task-71' };
      },
      getImage: async () => ({ id: 71, task_id: 'image-task-71', status, local_path: 'images/linxia.png', prompt: '角色四视图' }),
      validateImage: async (_mediaPath, options) => {
        imageValidationOptions.push(options);
        return imageReceipt('images/linxia.png');
      },
    });

    assert.equal((await service.ensureImageStage(run, 'asset_images')).state, 'waiting_task');
    assert.equal((await service.ensureImageStage(run, 'asset_images')).state, 'waiting_task');
    assert.equal(creates, 1);
    status = 'completed';
    const completed = await service.ensureImageStage(run, 'asset_images');
    assert.equal(completed.state, 'progressed');
    assert.equal(completed.artifact.status, 'draft');
    assert.equal(completed.artifact.content.source_artifact_id, source.id);
    assert.equal(imageRequests[0].aspect_ratio, '9:16');
    assert.match(imageRequests[0].prompt, /目标画幅 9:16/);
    assert.equal(imageValidationOptions[0].expected_aspect_ratio, '9:16');
    assert.equal(completed.artifact.content.aspect_ratio, '9:16');
    assert.equal(repo.stageCompletion(db, run.id, 'asset_images').complete, false);
    const rejectionReason = '角色脸型不一致';
    const rejected = repo.reviewArtifact(db, completed.artifact.id, {
      reviewer_type: 'human', decision: 'rejected', reason: rejectionReason,
    });
    status = 'processing';
    const retry = await service.ensureImageStage(repo.getRun(db, run.id), 'asset_images');
    assert.equal(retry.state, 'waiting_task');
    assert.equal(creates, 2);
    assert.equal(retry.action.attempt, 2);
    assert.deepEqual(imageRequests[1].reference_images, [completed.artifact.media_path]);
    assert.deepEqual(imageRequests[1].reference_artifact_ids, [completed.artifact.id]);
    assert.equal(imageRequests[1].revision_reference_artifact_id, completed.artifact.id);
    assert.match(imageRequests[1].prompt, /HIGH-PRIORITY REVISION REQUIREMENTS/);
    assert.match(imageRequests[1].prompt, new RegExp(rejectionReason));
    assert.deepEqual(imageRequests[1].rejected_review_evidence, [{
      review_id: rejected.review.id,
      artifact_id: completed.artifact.id,
      artifact_revision: completed.artifact.revision,
      reason: rejectionReason,
      created_at: rejected.review.created_at,
    }]);
    const retryPoll = await service.ensureImageStage(repo.getRun(db, run.id), 'asset_images');
    assert.equal(retryPoll.state, 'waiting_task');
    assert.equal(retryPoll.action.id, retry.action.id);
    assert.equal(creates, 2);
    status = 'completed';
    const revised = await service.ensureImageStage(repo.getRun(db, run.id), 'asset_images');
    assert.equal(revised.state, 'progressed');
    assert.deepEqual(
      repo.listUpstreamArtifactIds(db, revised.artifact.id).sort((left, right) => left - right),
      [source.id, completed.artifact.id].sort((left, right) => left - right)
    );
    const approved = repo.reviewArtifact(db, revised.artifact.id, {
      reviewer_type: 'human', decision: 'approved', reason: '修订图通过',
    });
    assert.equal(approved.artifact.status, 'approved');
  });

  it('uses separate configured models for asset sheets and storyboard frames', async () => {
    let run = makeRun('separate-image-models');
    run = repo.updateRun(db, run.id, {
      policy: {
        ...run.policy,
        image_model: 'legacy-fallback-model',
        asset_image_model: 'asset-model-v2',
        storyboard_image_model: 'storyboard-model-v3',
        asset_image_config_id: 41,
        storyboard_image_config_id: 42,
      },
    });
    addApproved(run, 'asset_text', 'character', 'character-1', 'Hero', {
      name: 'Hero', description: 'production hero', visual_prompt: 'identity sheet',
    });
    addApproved(run, 'storyboard_plan', 'shot', '1', 'Opening shot', {
      number: 1, duration: 3, visual: 'Hero enters', video_prompt: 'Hero enters frame', character_names: ['Hero'],
    });
    const requests = [];
    let nextId = 700;
    const service = createProductionMediaService(db, cfg, log, {
      createImage: async (request) => {
        requests.push(request);
        nextId += 1;
        return { id: nextId, task_id: `image-task-${nextId}` };
      },
      getImage: async (id) => ({ id, task_id: `image-task-${id}`, status: 'processing' }),
    });

    await service.ensureImageStage(run, 'asset_images');
    await service.ensureImageStage(run, 'storyboard_images');
    assert.equal(requests.find((item) => item.frame_type === 'character_reference_sheet').model, 'asset-model-v2');
    assert.equal(requests.find((item) => item.frame_type === 'production_storyboard').model, 'storyboard-model-v3');
    assert.equal(requests.find((item) => item.frame_type === 'character_reference_sheet').image_service_type, 'image');
    assert.equal(requests.find((item) => item.frame_type === 'character_reference_sheet').image_config_id, 41);
    assert.equal(requests.find((item) => item.frame_type === 'production_storyboard').image_service_type, 'storyboard_image');
    assert.equal(requests.find((item) => item.frame_type === 'production_storyboard').image_config_id, 42);
    assert.equal(requests.find((item) => item.frame_type === 'production_storyboard').reference_autolink_receipt.items[0].status, 'missing_approved_image');
  });

  it('rebuilds a failed image action from the live model and config revision', async () => {
    const imageConfig = aiConfigService.createConfig(db, log, {
      service_type: 'image', provider: 'yinzi', name: 'Live image config',
      base_url: 'https://old-image.example/v1', api_key: 'old-image-key',
      model: ['image-model-a'], default_model: 'image-model-a', is_default: true,
    });
    let run = makeRun('live-image-config-switch', {
      asset_image_config_id: imageConfig.id,
      asset_image_model: 'image-model-a',
      image_concurrency: 1,
    });
    addApproved(run, 'asset_text', 'character', 'character-1', 'Hero', {
      name: 'Hero', description: 'stable identity', visual_prompt: 'identity sheet',
    });

    const statuses = new Map();
    const requests = [];
    let nextGenerationId = 5000;
    const service = createProductionMediaService(db, cfg, log, {
      createImage: async (request) => {
        requests.push(request);
        nextGenerationId += 1;
        statuses.set(nextGenerationId, 'processing');
        return { id: nextGenerationId, task_id: `image-live-${nextGenerationId}` };
      },
      getImage: async (id) => ({
        id, task_id: `image-live-${id}`, status: statuses.get(id) || 'processing',
      }),
    });

    const started = await service.ensureImageStage(run, 'asset_images');
    assert.equal(started.state, 'waiting_task');
    assert.equal(requests[0].model, 'image-model-a');
    assert.equal(requests[0].image_config_id, imageConfig.id);
    const oldAction = repo.getLatestAction(db, run.id, {
      stage: 'asset_images', scope_type: 'character', scope_id: 'character-1', kind: 'image_generate',
    });
    statuses.set(oldAction.generation_id, 'failed');
    const failed = await service.ensureImageStage(repo.getRun(db, run.id), 'asset_images');
    assert.equal(failed.state, 'waiting_review');

    const updatedConfig = aiConfigService.updateConfig(db, log, imageConfig.id, {
      base_url: 'https://new-image.example/v1',
      api_key: 'new-image-key',
      model: ['image-model-b'],
      default_model: 'image-model-b',
    });
    run = repo.updateRun(db, run.id, {
      policy: { ...repo.getRun(db, run.id).policy, asset_image_model: 'image-model-b' },
    });
    assert.equal(updatedConfig.default_model, 'image-model-b');

    const retried = await service.ensureImageStage(repo.getRun(db, run.id), 'asset_images');
    assert.equal(retried.state, 'waiting_task');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].model, 'image-model-b');
    assert.equal(requests[1].image_config_id, imageConfig.id);
    assert.notEqual(requests[0].image_config_fingerprint, requests[1].image_config_fingerprint);
    const superseded = repo.getAction(db, oldAction.id);
    assert.equal(superseded.status, 'cancelled');
    assert.equal(superseded.result.superseded_by_config_change, true);
    assert.equal(superseded.result.retry_authorized, true);
  });

  it('rebuilds a failed video action with the newly selected config instead of the old snapshot', async () => {
    const oldConfig = aiConfigService.createConfig(db, log, {
      service_type: 'video', provider: 'yinzi', name: 'Old live video config',
      base_url: 'https://old-video.example/v1', api_key: 'old-video-key',
      model: ['mg-seedance2.0 -480p mini'], default_model: 'mg-seedance2.0 -480p mini', is_default: true,
    });
    const newConfig = aiConfigService.createConfig(db, log, {
      service_type: 'video', provider: 'yinzi', name: 'New live video config',
      base_url: 'https://new-video.example/v1', api_key: 'new-video-key',
      model: ['cc-seedance2.0 480p-fast-nsp'], default_model: 'cc-seedance2.0 480p-fast-nsp', is_default: false,
    });
    let run = makeRun('live-video-config-switch', {
      video_routing_mode: 'fixed',
      video_group: '特价视频分组(即梦)',
      video_model: 'mg-seedance2.0 -480p mini',
      video_config_id: oldConfig.id,
      director_mode: 'off',
    });
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', 'Config switch shot', {
      number: 1, duration: 5, visual: 'Stable medium shot', action: 'Hold one pose',
      video_prompt: 'Hold the pose for the entire shot', previs_mode: 'skip', transition_mode: 'opening',
    });
    const storyboard = addApproved(run, 'storyboard_images', 'shot', '1', 'Config switch frame', {
      source_artifact_id: shot.id,
    }, [shot.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?')
      .run('images/config-switch.png', storyboard.id);

    const requests = [];
    const service = createProductionMediaService(db, cfg, log, {
      fetchVideoCatalog: async () => routedCatalog(),
      createVideo: async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          const error = new Error('old video route unavailable');
          error.code = 'UPSTREAM_UNAVAILABLE';
          throw error;
        }
        return { id: 6100, task_id: 'new-video-task', model: request.model };
      },
    });

    const firstBundle = await service.ensureReferenceBundles(run);
    assert.equal(firstBundle.state, 'progressed');
    repo.reviewArtifact(db, firstBundle.artifact.id, {
      reviewer_type: 'human', decision: 'approved', reason: 'old route bundle approved',
    });
    await assert.rejects(
      () => service.ensureShotVideos(repo.getRun(db, run.id)),
      (error) => error.code === 'UPSTREAM_UNAVAILABLE'
    );
    const oldAction = repo.getLatestAction(db, run.id, {
      stage: 'shot_video', scope_type: 'shot', scope_id: '1', kind: 'video_generate',
    });
    assert.equal(oldAction.status, 'failed');
    assert.equal(oldAction.request.model, 'mg-seedance2.0 -480p mini');
    assert.equal(oldAction.request.video_config_id, oldConfig.id);

    run = repo.updateRun(db, run.id, {
      policy: {
        ...repo.getRun(db, run.id).policy,
        video_model: 'cc-seedance2.0 480p-fast-nsp',
        video_config_id: newConfig.id,
      },
    });
    const refreshed = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(refreshed.state, 'waiting_review');
    assert.equal(refreshed.reason, 'reference_bundle_stale');
    assert.equal(refreshed.artifact.status, 'draft');
    assert.equal(refreshed.artifact.content.routing_receipt.model, 'cc-seedance2.0 480p-fast-nsp');
    repo.reviewArtifact(db, refreshed.artifact.id, {
      reviewer_type: 'human', decision: 'approved', reason: 'new route bundle approved',
    });

    const retried = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(retried.state, 'waiting_provider');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].model, 'cc-seedance2.0 480p-fast-nsp');
    assert.equal(requests[1].video_config_id, newConfig.id);
    assert.notEqual(requests[0].video_config_fingerprint, requests[1].video_config_fingerprint);
    const superseded = repo.getAction(db, oldAction.id);
    assert.equal(superseded.status, 'cancelled');
    assert.equal(superseded.result.retry_authorized, true);
    assert.equal(superseded.result.superseded_by_route_change, true);
    assert.equal(retried.action.request.video_config_id, newConfig.id);
    assert.equal(retried.action.request.model, 'cc-seedance2.0 480p-fast-nsp');
  });

  it('keeps an already accepted provider task on its immutable config snapshot while polling', async () => {
    const oldConfig = aiConfigService.createConfig(db, log, {
      service_type: 'video', provider: 'yinzi', name: 'Polling old config',
      base_url: 'https://poll-old.example/v1', api_key: 'poll-old-key',
      model: ['mg-seedance2.0 -480p mini'], default_model: 'mg-seedance2.0 -480p mini', is_default: true,
    });
    const newConfig = aiConfigService.createConfig(db, log, {
      service_type: 'video', provider: 'yinzi', name: 'Polling new config',
      base_url: 'https://poll-new.example/v1', api_key: 'poll-new-key',
      model: ['mg-seedance2.0 -480p mini'], default_model: 'mg-seedance2.0 -480p mini', is_default: false,
    });
    let run = makeRun('immutable-video-poll-snapshot', {
      video_routing_mode: 'fixed',
      video_group: '特价视频分组(即梦)',
      video_model: 'mg-seedance2.0 -480p mini',
      video_config_id: oldConfig.id,
      director_mode: 'off',
    });
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', 'Polling snapshot shot', {
      number: 1, duration: 5, visual: 'Stable medium shot', action: 'Hold one pose',
      video_prompt: 'Hold the pose for the entire shot', previs_mode: 'skip', transition_mode: 'opening',
    });
    const storyboard = addApproved(run, 'storyboard_images', 'shot', '1', 'Polling snapshot frame', {
      source_artifact_id: shot.id,
    }, [shot.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?')
      .run('images/polling-snapshot.png', storyboard.id);

    let createCalls = 0;
    const pollIds = [];
    const service = createProductionMediaService(db, cfg, log, {
      fetchVideoCatalog: async () => routedCatalog(),
      createVideo: async (request) => {
        createCalls += 1;
        return { id: 6200, task_id: 'immutable-poll-task', model: request.model };
      },
      getVideo: async (id) => {
        pollIds.push(id);
        return { id: 6200, task_id: 'immutable-poll-task', status: 'processing', model: 'mg-seedance2.0 -480p mini' };
      },
    });
    const bundle = await service.ensureReferenceBundles(run);
    repo.reviewArtifact(db, bundle.artifact.id, {
      reviewer_type: 'human', decision: 'approved', reason: 'polling bundle approved',
    });
    const submitted = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(submitted.state, 'waiting_provider');
    assert.equal(createCalls, 1);
    assert.equal(submitted.action.request.video_config_id, oldConfig.id);

    run = repo.updateRun(db, run.id, {
      policy: { ...repo.getRun(db, run.id).policy, video_config_id: newConfig.id },
    });
    const polled = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(polled.state, 'waiting_provider');
    assert.equal(polled.reason, 'video_generation');
    assert.deepEqual(pollIds, [6200]);
    assert.equal(createCalls, 1);
    assert.equal(polled.action.request.video_config_id, oldConfig.id);
    assert.equal(polled.action.request.model, 'mg-seedance2.0 -480p mini');
  });

  it('fills the configured asset-image concurrency and refills each completed slot', async () => {
    let run = makeRun('parallel-asset-images');
    run = repo.updateRun(db, run.id, {
      policy: { ...run.policy, image_concurrency: 2 },
    });
    const sources = [
      ['character', 'character-1', 'Hero'],
      ['character', 'character-2', 'Mentor'],
      ['scene', 'scene-1', 'Courtyard'],
      ['prop', 'prop-1', 'Sword'],
    ].map(([scopeType, scopeId, title]) => addApproved(run, 'asset_text', scopeType, scopeId, title, {
      name: title,
      description: `${title} production asset`,
      visual_prompt: `${title} reference sheet`,
    }));
    const statusByGeneration = new Map();
    const sourceByGeneration = new Map();
    let nextGenerationId = 100;
    let createCalls = 0;
    let activeCreates = 0;
    let maxActiveCreates = 0;
    const service = createProductionMediaService(db, cfg, log, {
      createImage: async (request) => {
        createCalls += 1;
        activeCreates += 1;
        maxActiveCreates = Math.max(maxActiveCreates, activeCreates);
        await new Promise((resolve) => setImmediate(resolve));
        activeCreates -= 1;
        nextGenerationId += 1;
        statusByGeneration.set(nextGenerationId, 'processing');
        sourceByGeneration.set(nextGenerationId, request.source_artifact_id);
        return { id: nextGenerationId, task_id: `image-task-${nextGenerationId}` };
      },
      getImage: async (id) => ({
        id,
        task_id: `image-task-${id}`,
        status: statusByGeneration.get(id),
        local_path: `images/${sourceByGeneration.get(id)}.png`,
      }),
      validateImage: async (mediaPath) => imageReceipt(mediaPath),
    });

    const started = await service.ensureImageStage(run, 'asset_images');
    assert.equal(started.state, 'waiting_task');
    assert.equal(started.actions.length, 2);
    assert.equal(createCalls, 2);
    assert.equal(maxActiveCreates, 2);

    const unchanged = await service.ensureImageStage(repo.getRun(db, run.id), 'asset_images');
    assert.equal(unchanged.state, 'waiting_task');
    assert.equal(createCalls, 2);

    const firstGenerationId = Math.min(...statusByGeneration.keys());
    statusByGeneration.set(firstGenerationId, 'completed');
    const refilled = await service.ensureImageStage(repo.getRun(db, run.id), 'asset_images');
    assert.equal(refilled.state, 'waiting_task');
    assert.equal(refilled.artifacts.length, 1);
    assert.equal(createCalls, 3);
    assert.equal(repo.listActions(db, run.id, { page_size: 20 }).items.filter((item) => item.kind === 'image_generate').length, 3);

    const repeated = await service.ensureImageStage(repo.getRun(db, run.id), 'asset_images');
    assert.equal(repeated.state, 'waiting_task');
    assert.equal(createCalls, 3);
    assert.equal(new Set(repeated.actions.map((item) => item.id)).size, repeated.actions.length);
    assert.equal(sources.length, 4);
  });

  it('keeps an approved user-edited reference bundle authoritative', async () => {
    let run = makeRun('approved-user-reference-bundle');
    run = repo.updateRun(db, run.id, {
      policy: {
        ...run.policy,
        video_routing_mode: 'auto',
        video_group: '特价视频分组(即梦)',
      },
    });
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', 'Opening', {
      number: 1,
      duration: 2,
      action: 'The heroine looks toward camera.',
      visual: 'Stable close-up.',
      video_prompt: 'A complete two-second reaction.',
      previs_mode: 'skip',
      transition_mode: 'opening',
    });
    const storyboard = addApproved(run, 'storyboard_images', 'shot', '1', 'Opening frame', {
      source_artifact_id: shot.id,
    }, [shot.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?')
      .run('images/opening.png', storyboard.id);
    const service = createProductionMediaService(db, cfg, log, {
      fetchVideoCatalog: async () => routedCatalog(),
    });

    const generated = await service.ensureReferenceBundles(run);
    assert.equal(generated.state, 'progressed');
    const { autolink_receipt: _receipt, ...legacyContent } = generated.artifact.content;
    const edited = repo.editArtifact(db, generated.artifact.id, {
      content: {
        ...legacyContent,
        bundle_origin: 'manual_revision',
        images: [{ path: 'uploads/user-selected.png', label: 'User selected identity', source: 'upload', role: 'reference' }],
        videos: [],
        audios: [],
      },
    });
    const approved = repo.reviewArtifact(db, edited.id, {
      reviewer_type: 'human',
      decision: 'approved',
      reason: 'Use my selected reference image',
    }).artifact;

    const checked = await service.ensureReferenceBundles(repo.getRun(db, run.id));
    assert.equal(checked.state, 'stage_ready');
    assert.equal(checked.artifacts[0].id, approved.id);
    assert.deepEqual(checked.artifacts[0].content.images.map((item) => item.path), ['uploads/user-selected.png']);
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'reference_bundle', page_size: 20 }).items.length, 2);
  });

  it('does not refresh an approved bundle when only live catalog metadata changes', async () => {
    let run = makeRun('approved-bundle-catalog-refresh');
    run = repo.updateRun(db, run.id, {
      policy: { ...run.policy, video_routing_mode: 'auto', video_group: '特价视频分组(即梦)', director_mode: 'off' },
    });
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', 'Catalog refresh shot', {
      number: 1, duration: 5, action: 'Hold', visual: 'Stable', video_prompt: 'Hold',
      previs_mode: 'skip', transition_mode: 'opening', cut_in: 'start', cut_out: 'end', boundary_prompt: 'hard cut',
    });
    const frame = addApproved(run, 'storyboard_images', 'shot', '1', 'Frame', { source_artifact_id: shot.id }, [shot.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?').run('images/catalog-refresh.png', frame.id);
    let version = 1;
    const service = createProductionMediaService(db, cfg, log, {
      fetchVideoCatalog: async () => ({
        ...routedCatalog(),
        pricing_version: `refresh-${version}`,
        fetched_at: `2026-08-31T00:00:0${version}.000Z`,
      }),
    });
    const first = await service.ensureReferenceBundles(repo.getRun(db, run.id));
    assert.equal(first.state, 'progressed');
    repo.reviewArtifact(db, first.artifact.id, { reviewer_type: 'human', decision: 'approved', reason: 'confirm' });
    const approvedId = first.artifact.id;
    version = 2;
    const second = await service.ensureReferenceBundles(repo.getRun(db, run.id));
    assert.equal(second.state, 'stage_ready');
    assert.equal(second.artifacts[0].id, approvedId);
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'reference_bundle', page_size: 20 }).items.length, 1);
  });

  it('pins an approved automatic route when a later catalog refresh would reorder models', async () => {
    let run = makeRun('approved-bundle-route-stability', {
      video_model: '',
      video_routing_mode: 'auto',
      video_group: '特价视频分组(即梦)',
      director_mode: 'off',
    });
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', 'Stable automatic route', {
      number: 1,
      duration: 5,
      action: 'Hold the pose.',
      visual: 'Stable medium shot.',
      video_prompt: 'Hold the pose for five seconds.',
      previs_mode: 'skip',
      transition_mode: 'opening',
    });
    const frame = addApproved(run, 'storyboard_images', 'shot', '1', 'Stable frame', {
      source_artifact_id: shot.id,
    }, [shot.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?').run('images/stable-route.png', frame.id);
    let refresh = 1;
    const item = (model, price) => ({
      model,
      endpoint_types: ['openai-video'],
      groups: ['特价视频分组(即梦)'],
      prices: [{ group: '特价视频分组(即梦)', billing_unit: 'per_second', effective_price: price }],
    });
    const service = createProductionMediaService(db, cfg, log, {
      fetchVideoCatalog: async () => ({
        pricing_version: `route-refresh-${refresh}`,
        fetched_at: `2026-09-01T00:00:0${refresh}.000Z`,
        video: refresh === 1
          ? [item('mg-seedance2.0 -480p mini', 0.1), item('cc-seedance2.0 480p-fast-nsp', 0.2)]
          : [item('mg-seedance2.0 -480p mini', 0.3), item('cc-seedance2.0 480p-fast-nsp', 0.05)],
      }),
    });

    const first = await service.ensureReferenceBundles(run);
    assert.equal(first.state, 'progressed');
    assert.equal(first.artifact.content.routing_receipt.model, 'mg-seedance2.0 -480p mini');
    repo.reviewArtifact(db, first.artifact.id, { reviewer_type: 'human', decision: 'approved', reason: 'confirm automatic route' });
    refresh = 2;

    const second = await service.ensureReferenceBundles(repo.getRun(db, run.id));
    assert.equal(second.state, 'stage_ready');
    assert.equal(second.artifacts[0].id, first.artifact.id);
    assert.equal(second.artifacts[0].content.routing_receipt.model, 'mg-seedance2.0 -480p mini');
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'reference_bundle', page_size: 20 }).items.length, 1);
  });

  it('does not report a stale bundle when the next video step revalidates an unchanged approval', async () => {
    let run = makeRun('approved-bundle-next-step', {
      video_model: '',
      video_routing_mode: 'auto',
      video_group: '特价视频分组(即梦)',
      director_mode: 'off',
    });
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', 'Next-step stability', {
      number: 1,
      duration: 5,
      action: 'Hold the pose.',
      visual: 'Stable medium shot.',
      video_prompt: 'Hold the pose for five seconds.',
      previs_mode: 'skip',
      transition_mode: 'opening',
    });
    const frame = addApproved(run, 'storyboard_images', 'shot', '1', 'Next-step frame', {
      source_artifact_id: shot.id,
    }, [shot.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?').run('images/next-step.png', frame.id);
    let refresh = 1;
    const requests = [];
    const item = (model, price) => ({
      model,
      endpoint_types: ['openai-video'],
      groups: ['特价视频分组(即梦)'],
      prices: [{ group: '特价视频分组(即梦)', billing_unit: 'per_second', effective_price: price }],
    });
    const service = createProductionMediaService(db, cfg, log, {
      fetchVideoCatalog: async () => ({
        pricing_version: `next-step-refresh-${refresh}`,
        fetched_at: `2026-09-01T00:00:1${refresh}.000Z`,
        video: refresh === 1
          ? [item('mg-seedance2.0 -480p mini', 0.1), item('cc-seedance2.0 480p-fast-nsp', 0.2)]
          : [item('mg-seedance2.0 -480p mini', 0.3), item('cc-seedance2.0 480p-fast-nsp', 0.05)],
      }),
      createVideo: async (request) => {
        requests.push(structuredClone(request));
        return { id: 9901, task_id: 'next-step-stable-task', model: request.model };
      },
    });
    const generated = await service.ensureReferenceBundles(run);
    assert.equal(generated.state, 'progressed');
    repo.reviewArtifact(db, generated.artifact.id, {
      reviewer_type: 'human', decision: 'approved', reason: 'confirm before next step',
    });
    refresh = 2;

    const submitted = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(submitted.state, 'waiting_provider');
    assert.notEqual(submitted.reason, 'reference_bundle_stale');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, 'mg-seedance2.0 -480p mini');
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'reference_bundle', page_size: 20 }).items.length, 1);
  });

  it('keeps a manually cleared bundle empty across polling and submits it with advisory warnings', async () => {
    let run = makeRun('empty-user-reference-bundle');
    run = repo.updateRun(db, run.id, {
      policy: {
        ...run.policy,
        video_routing_mode: 'auto',
        video_group: '特价视频分组(即梦)',
      },
    });
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', 'Text-only opening', {
      number: 1,
      duration: 5,
      action: 'The heroine enters frame and stops.',
      visual: 'Stable medium shot.',
      video_prompt: 'Create the complete five-second beat.',
      previs_mode: 'skip',
      transition_mode: 'opening',
    });
    const storyboard = addApproved(run, 'storyboard_images', 'shot', '1', 'Suggested opening frame', {
      source_artifact_id: shot.id,
    }, [shot.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?')
      .run('images/text-only-opening.png', storyboard.id);
    const requests = [];
    const service = createProductionMediaService(db, cfg, log, {
      fetchVideoCatalog: async () => routedCatalog(),
      createVideo: async (request) => {
        requests.push(structuredClone(request));
        return { id: 904, task_id: 'empty-reference-task', model: request.model };
      },
    });

    const generated = await service.ensureReferenceBundles(run);
    assert.equal(generated.state, 'progressed');
    const edited = repo.editArtifact(db, generated.artifact.id, {
      content: {
        ...generated.artifact.content,
        bundle_origin: 'manual_revision',
        revision_source: { type: 'user_edit', source_artifact_id: generated.artifact.id },
        images: [],
        videos: [],
        audios: [],
      },
    });

    const draftCheck = await service.ensureReferenceBundles(repo.getRun(db, run.id));
    assert.equal(draftCheck.state, 'stage_ready');
    assert.equal(draftCheck.artifacts[0].id, edited.id);
    assert.deepEqual(draftCheck.artifacts[0].content.images, []);
    const approved = repo.reviewArtifact(db, edited.id, {
      reviewer_type: 'human', decision: 'approved', reason: 'Submit without reference media',
    }).artifact;
    const approvedCheck = await service.ensureReferenceBundles(repo.getRun(db, run.id));
    assert.equal(approvedCheck.state, 'stage_ready');
    assert.equal(approvedCheck.artifacts[0].id, approved.id);
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'reference_bundle', page_size: 20 }).items.length, 2);

    const submitted = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(submitted.state, 'waiting_provider');
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].reference_image_urls, []);
    assert.deepEqual(requests[0].reference_video_urls, []);
    assert.deepEqual(requests[0].reference_audio_urls, []);
    assert.equal(requests[0].contract_validation_mode, 'advisory');
    assert.ok(requests[0].reference_warnings.includes('reference_image_missing'));
    assert.ok(submitted.action.result.dispatch_receipt.reference_warnings.includes('reference_image_missing'));
  });

  it('excludes a rejected storyboard frame when approved visual authorities exist', async () => {
    const run = makeRun('rejected-storyboard-reference-exclusion');
    const character = addApproved(run, 'asset_text', 'character', 'character-1', 'Lan Yin', {
      name: 'Lan Yin', description: 'silver-haired adult swordswoman', visual_prompt: 'character sheet',
    });
    const scene = addApproved(run, 'asset_text', 'scene', 'scene-1', 'Night street', {
      name: 'Night street', location: 'cyberpunk street', reference_state: 'empty', visual_prompt: 'empty street sheet',
    });
    const characterImage = addApproved(run, 'asset_images', 'character', 'character-1', 'Lan Yin', {
      source_artifact_id: character.id,
    }, [character.id]);
    const sceneImage = addApproved(run, 'asset_images', 'scene', 'scene-1', 'Night street', {
      source_artifact_id: scene.id,
    }, [scene.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?').run('images/lan-yin.png', characterImage.id);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?').run('images/night-street.png', sceneImage.id);
    addApproved(run, 'storyboard_plan', 'shot', '3', 'Seal', {
      number: 3,
      duration: 7,
      action: 'Lan Yin seals the dog spirit',
      visual: 'front-side low angle',
      image_prompt: 'No plants. Abstract non-readable seal.',
      video_prompt: 'Complete the seal in one shot.',
      character_names: ['Lan Yin'],
      scene_name: 'Night street',
      prop_names: [],
    });
    const requests = [];
    let nextGenerationId = 80;
    const service = createProductionMediaService(db, cfg, log, {
      createImage: async (request) => {
        requests.push(request);
        nextGenerationId += 1;
        return { id: nextGenerationId, task_id: `image-task-${nextGenerationId}` };
      },
      getImage: async (id) => ({
        id,
        task_id: `image-task-${id}`,
        status: 'completed',
        local_path: `images/storyboard-${id}.png`,
      }),
      validateImage: async (mediaPath) => imageReceipt(mediaPath),
    });

    assert.equal((await service.ensureImageStage(run, 'storyboard_images')).state, 'waiting_task');
    const first = await service.ensureImageStage(repo.getRun(db, run.id), 'storyboard_images');
    assert.equal(first.state, 'progressed');
    repo.reviewArtifact(db, first.artifact.id, {
      reviewer_type: 'human',
      decision: 'rejected',
      reason: 'Remove all foliage and keep the seal abstract.',
    });

    const retry = await service.ensureImageStage(repo.getRun(db, run.id), 'storyboard_images');
    assert.equal(retry.state, 'waiting_task');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].reference_images, ['images/night-street.png', 'images/lan-yin.png']);
    assert.deepEqual(requests[1].reference_artifact_ids, [sceneImage.id, characterImage.id]);
    assert.equal(requests[1].revision_reference_artifact_id, null);
    assert.equal(requests[1].rejected_reference_artifact_id, first.artifact.id);
    assert.equal(requests[1].rejected_reference_excluded, true);
    assert.doesNotMatch(requests[1].reference_images.join('\n'), /storyboard-/);
    assert.match(requests[1].prompt, /Preserve every source-defined trait/);
    assert.match(requests[1].prompt, /Remove all foliage/);
  });

  it('only bypasses a cancelled image action when duplicate cancellation is proven terminal', async () => {
    const run = makeRun();
    const source = addApproved(run, 'asset_text', 'scene', 'scene-1', '温室', {
      name: '温室', description: '空置穹顶', visual_prompt: '空场四视图', reference_state: 'empty',
    });
    const rejected = addApproved(run, 'asset_images', 'scene', 'scene-1', '温室', {
      source_artifact_id: source.id,
    }, [source.id]);
    repo.reviewArtifact(db, rejected.id, { reviewer_type: 'human', decision: 'rejected', reason: '出现了不应存在的植物' });
    const duplicate = repo.reserveAction(db, {
      run_id: run.id,
      action_key: 'scene-duplicate-attempt-3',
      stage: 'asset_images',
      scope_type: 'scene',
      scope_id: 'scene-1',
      kind: 'image_generate',
      attempt: 3,
      request: { source_artifact_id: source.id },
    }).action;
    repo.updateAction(db, duplicate.id, {
      status: 'cancelled',
      result: { source_artifact_id: source.id, duplicate_cancelled: true, task_cancelled: true },
    });
    let creates = 0;
    const service = createProductionMediaService(db, cfg, log, {
      createImage: async () => { creates += 1; return { id: 73, task_id: 'image-task-73' }; },
    });

    const replacement = await service.ensureImageStage(repo.getRun(db, run.id), 'asset_images');
    assert.equal(replacement.state, 'waiting_task');
    assert.equal(replacement.action.attempt, 4);
    assert.equal(creates, 1);

    const blockedRun = makeRun('media-run-unproven-cancel');
    const blockedSource = addApproved(blockedRun, 'asset_text', 'scene', 'scene-1', '机库', {
      name: '机库', description: '空置机库', visual_prompt: '机库四视图', reference_state: 'empty',
    });
    const blockedTarget = addApproved(blockedRun, 'asset_images', 'scene', 'scene-1', '机库', {
      source_artifact_id: blockedSource.id,
    }, [blockedSource.id]);
    repo.reviewArtifact(db, blockedTarget.id, { reviewer_type: 'human', decision: 'rejected', reason: '空间结构错误' });
    const unproven = repo.reserveAction(db, {
      run_id: blockedRun.id,
      action_key: 'scene-unproven-cancel-attempt-2',
      stage: 'asset_images',
      scope_type: 'scene',
      scope_id: 'scene-1',
      kind: 'image_generate',
      attempt: 2,
      request: { source_artifact_id: blockedSource.id },
    }).action;
    repo.updateAction(db, unproven.id, { status: 'cancelled', result: { task_cancelled: true } });
    const blocked = await service.ensureImageStage(repo.getRun(db, blockedRun.id), 'asset_images');
    assert.equal(blocked.state, 'waiting_review');
    assert.equal(blocked.reason, 'cancelled');
    assert.equal(creates, 1);
  });

  it('requires every upstream resource image instead of completing on a partial collection', async () => {
    const run = makeRun();
    const a = addApproved(run, 'asset_text', 'character', 'character-1', '林夏', { name: '林夏', description: '宇航员', visual_prompt: '四视图' });
    addApproved(run, 'asset_text', 'scene', 'scene-1', '温室', { name: '温室', description: '透明穹顶', visual_prompt: '场景四视图' });
    addApproved(run, 'asset_images', 'character', 'character-1', '林夏', {
      source_artifact_id: a.id, validation: imageReceipt(),
    });
    const completion = repo.stageCompletion(db, run.id, 'asset_images');
    assert.equal(completion.complete, false);
    assert.equal(completion.unresolved.some((item) => item.scope_id === 'scene-1' && item.reason === 'missing_derived_artifact'), true);
  });

  it('allows multi-view resource sheets while keeping storyboard images single-frame', async () => {
    const run = makeRun();
    addApproved(run, 'asset_text', 'scene', 'scene-1', '温室', {
      name: '温室',
      location: '月面固定玻璃穹顶',
      description: '激活前空置，激活后未来藤蔓覆盖地面',
      spatial_anchors: ['第二镜未来藤蔓形成光桥'],
      reference_state: 'pre_activation_empty',
      visual_prompt: '同一空场的四视图，完全没有植物',
      negative_prompt: '人物，花草，藤蔓',
    });
    addApproved(run, 'storyboard_plan', 'shot', '1', '镜头一', {
      number: 1, duration: 5, action: '宇航员进入温室', visual: '单张广角电影画面', video_prompt: '缓慢推进',
      scene_name: '温室', continuity_in: '空置温室', continuity_out: '仍然没有植物', image_prompt: '人物抵达空培养台',
    });
    const requests = [];
    const service = createProductionMediaService(db, cfg, log, {
      createImage: async (request) => {
        requests.push(request);
        return { id: 80 + requests.length, task_id: `image-task-${80 + requests.length}` };
      },
    });

    assert.equal((await service.ensureImageStage(run, 'asset_images')).state, 'waiting_task');
    assert.equal((await service.ensureImageStage(run, 'storyboard_images')).state, 'waiting_task');
    assert.equal(requests[0].frame_type, 'scene_reference_sheet');
    assert.doesNotMatch(requests[0].negative_prompt, /split panels|collage/);
    assert.match(requests[0].negative_prompt, /inconsistent geometry/);
    assert.match(requests[0].prompt, /pre_activation_empty/);
    assert.match(requests[0].prompt, /同一空场的四视图，完全没有植物/);
    assert.match(requests[0].prompt, /花草，藤蔓/);
    assert.doesNotMatch(requests[0].prompt, /激活后未来藤蔓覆盖地面|第二镜未来藤蔓形成光桥/);
    assert.equal(requests[1].frame_type, 'production_storyboard');
    assert.match(requests[1].negative_prompt, /split panels/);
    assert.match(requests[1].negative_prompt, /collage/);
    assert.match(requests[1].prompt, /人物抵达空培养台/);
    assert.match(requests[1].prompt, /月面固定玻璃穹顶/);
    assert.match(requests[1].prompt, /镜头自身的入镜状态、出镜状态、动作和完整提示/);
    assert.doesNotMatch(requests[1].prompt, /同一空场的四视图|激活后未来藤蔓覆盖地面|第二镜未来藤蔓形成光桥/);
  });

  it('sends exact four-view layouts and type-specific exclusions for every resource kind', async () => {
    const run = makeRun('typed-four-view-resource-sheets', {
      aspect_ratio: '9:16',
      image_concurrency: 3,
    });
    addApproved(run, 'asset_text', 'character', 'character-1', '银发少女', {
      name: '银发少女',
      description: '冷漠神情，银色长发，青白短袍，固定桃木剑鞘',
      identity_anchors: ['银色长发', '青白短袍', '右腰桃木剑鞘'],
      visual_prompt: '同一名少女的标准角色设定板',
      negative_prompt: '短发，红衣，第二角色',
    });
    addApproved(run, 'asset_text', 'scene', 'scene-1', '赛博城屋顶', {
      name: '赛博城屋顶',
      location: '同一栋高楼的固定屋顶平台',
      description: '雨夜，东侧霓虹塔，西侧水箱，中央停机坪',
      spatial_anchors: ['东侧霓虹塔', '西侧水箱', '中央停机坪'],
      reference_state: 'rainy_night_empty_rooftop',
      visual_prompt: '同一屋顶平台的可还原空间设定板',
      negative_prompt: '鲜花，白昼，人群',
    });
    addApproved(run, 'asset_text', 'prop', 'prop-1', '桃木剑', {
      name: '桃木剑',
      description: '同一柄深色桃木剑，铜制八卦护手，剑身一道朱砂符纹',
      continuity_rules: ['始终只有一柄', '护手与符纹位置固定'],
      visual_prompt: '同一柄桃木剑的产品设定板',
      negative_prompt: '金属长剑，人物手持，双剑',
    });

    const requests = [];
    const service = createProductionMediaService(db, cfg, log, {
      createImage: async (request) => {
        requests.push(request);
        return { id: 900 + requests.length, task_id: `typed-sheet-${requests.length}` };
      },
    });

    assert.equal((await service.ensureImageStage(run, 'asset_images')).state, 'waiting_task');
    assert.equal(requests.length, 3);
    const byType = Object.fromEntries(requests.map((request) => [request.frame_type, request]));
    const character = byType.character_reference_sheet;
    const scene = byType.scene_reference_sheet;
    const prop = byType.prop_reference_sheet;

    for (const request of [character, scene, prop]) {
      assert.ok(request);
      assert.equal(request.aspect_ratio, '9:16');
      assert.match(request.prompt, /恰好四个等宽、互不重叠的清晰视图/);
      assert.match(request.prompt, /目标画幅 9:16/);
      assert.equal(request.prompt_snapshot.prompt_id, 'production.image_asset.template');
      assert.equal(request.prompt_snapshot.customized, false);
      assert.match(request.negative_prompt, /three panels/);
      assert.match(request.negative_prompt, /five panels/);
      assert.match(request.negative_prompt, /text/);
      assert.match(request.negative_prompt, /watermark/);
    }

    assert.match(character.prompt, /正面、左侧面、背面、右侧面/);
    assert.match(character.prompt, /头顶到脚底完整/);
    assert.match(character.negative_prompt, /second character/);
    assert.match(character.negative_prompt, /cropped feet/);
    assert.match(character.negative_prompt, /短发，红衣，第二角色/);

    assert.match(scene.prompt, /全景、主方向、反方向、关键区域/);
    assert.match(scene.prompt, /rainy_night_empty_rooftop/);
    assert.match(scene.negative_prompt, /four different places/);
    assert.match(scene.negative_prompt, /changing landmarks/);
    assert.match(scene.negative_prompt, /鲜花，白昼，人群/);

    assert.match(prop.prompt, /正面、侧面、背面、关键结构角度/);
    assert.match(prop.prompt, /无手持者、人物、战斗/);
    assert.match(prop.negative_prompt, /person holding the object/);
    assert.match(prop.negative_prompt, /four different objects/);
    assert.match(prop.negative_prompt, /金属长剑，人物手持，双剑/);
  });

  it('keeps custom image templates authoritative while still filling live asset and aspect variables', async () => {
    promptRegistry.set(
      db,
      'production.image_asset.template',
      '用户模板标记\n动态资源：{{base_prompt}}\n动态画幅：{{aspect_prompt}}'
    );
    const run = makeRun('custom-resource-image-template', {
      aspect_ratio: '9:16',
      image_concurrency: 1,
    });
    addApproved(run, 'asset_text', 'prop', 'prop-1', '罗盘', {
      name: '罗盘',
      description: '同一枚黑铜罗盘，十二刻度与中心指针固定',
      visual_prompt: '同一件罗盘的四角度设定板',
      negative_prompt: '人物，剧情动作',
    });
    let request;
    const service = createProductionMediaService(db, cfg, log, {
      createImage: async (value) => {
        request = value;
        return { id: 920, task_id: 'custom-sheet-1' };
      },
    });

    assert.equal((await service.ensureImageStage(run, 'asset_images')).state, 'waiting_task');
    assert.match(request.prompt, /^用户模板标记/);
    assert.match(request.prompt, /同一件关键道具恰好四格产品设定板/);
    assert.match(request.prompt, /目标画幅 9:16/);
    assert.equal(request.prompt_snapshot.customized, true);
  });

  it('persists every selected asset image as a storyboard dependency', async () => {
    const run = makeRun();
    const character = addApproved(run, 'asset_text', 'character', 'character-1', '林夏', {
      name: '林夏', description: '宇航员', visual_prompt: '角色四视图',
    });
    const scene = addApproved(run, 'asset_text', 'scene', 'scene-1', '温室', {
      name: '温室', location: '月面穹顶', reference_state: 'empty', visual_prompt: '空温室四视图',
    });
    const prop = addApproved(run, 'asset_text', 'prop', 'prop-1', '种子舱', {
      name: '种子舱', description: '六边晶体', visual_prompt: '道具四视图',
    });
    const assetImages = [character, scene, prop].map((asset, index) => {
      const image = addApproved(run, 'asset_images', asset.scope_type, asset.scope_id, asset.title, {
        source_artifact_id: asset.id,
      }, [asset.id]);
      db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?').run(`images/asset-${index + 1}.png`, image.id);
      return image;
    });
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', '镜头一', {
      number: 1,
      duration: 5,
      action: '林夏放下种子舱',
      visual: '中景',
      image_prompt: '林夏站在培养台前',
      video_prompt: '缓慢推进',
      character_names: ['林夏'],
      scene_name: '温室',
      prop_names: ['种子舱'],
    });
    let request;
    const service = createProductionMediaService(db, cfg, log, {
      createImage: async (value) => { request = value; return { id: 88, task_id: 'image-task-88' }; },
      getImage: async () => ({ id: 88, task_id: 'image-task-88', status: 'completed', local_path: 'images/shot-1.png' }),
      validateImage: async () => imageReceipt('images/shot-1.png'),
    });

    assert.equal((await service.ensureImageStage(run, 'storyboard_images')).state, 'waiting_task');
    const completed = await service.ensureImageStage(repo.getRun(db, run.id), 'storyboard_images');
    assert.equal(completed.state, 'progressed');
    assert.deepEqual([...request.reference_images].sort(), ['images/asset-1.png', 'images/asset-2.png', 'images/asset-3.png']);
    assert.deepEqual([...request.reference_artifact_ids].sort((a, b) => a - b), assetImages.map((item) => item.id).sort((a, b) => a - b));
    assert.deepEqual(
      request.reference_images.map((path, index) => [path, request.reference_artifact_ids[index]]).sort(([a], [b]) => a.localeCompare(b)),
      assetImages.map((item, index) => [`images/asset-${index + 1}.png`, item.id]).sort(([a], [b]) => a.localeCompare(b)),
    );
    assert.deepEqual(repo.listUpstreamArtifactIds(db, completed.artifact.id), [shot.id, ...assetImages.map((item) => item.id)].sort((a, b) => a - b));
  });

  it('uses a one-time client token and validates a real director WebM before creating the preview artifact', async () => {
    let run = makeRun('media-run', { aspect_ratio: '9:16' });
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', '镜头一', {
      number: 1, duration: 5, action: '林夏前行', visual: '中景', video_prompt: '缓慢推进', character_names: ['林夏'],
    });
    const document = createFallbackDirectorDocument(shot.content);
    const plan = addApproved(run, 'director_plan', 'shot', '1', '镜头一导演台', {
      source_artifact_id: shot.id, document,
    }, [shot.id]);
    let validationOptions;
    const service = createProductionMediaService(db, cfg, log, {
      validateVideo: async (_mediaPath, options) => {
        validationOptions = options;
        return videoReceipt('previews/shot-1.webm', 'webm');
      },
    });
    const request = service.requestDirectorCapture(run);
    assert.equal(request.state, 'client_action');
    assert.equal(request.client_action.expected_aspect_ratio, '9:16');
    await assert.rejects(() => service.acceptDirectorCapture(run.id, {
      action_id: request.client_action.action_id,
      token: 'wrong',
      media_path: 'previews/shot-1.webm',
      frame_count: 150,
    }), /令牌无效/);
    const accepted = await service.acceptDirectorCapture(run.id, {
      action_id: request.client_action.action_id,
      token: request.client_action.token,
      media_path: 'previews/shot-1.webm',
      frame_count: 150,
    });
    assert.equal(accepted.artifact.content.source_artifact_id, plan.id);
    assert.equal(accepted.artifact.status, 'draft');
    assert.equal(accepted.artifact.content.aspect_ratio, '9:16');
    assert.equal(validationOptions.expected_aspect_ratio, '9:16');
    const reused = await service.acceptDirectorCapture(run.id, {
      action_id: request.client_action.action_id,
      token: request.client_action.token,
      media_path: 'ignored.webm',
    });
    assert.equal(reused.reused, true);
    repo.reviewArtifact(db, accepted.artifact.id, { reviewer_type: 'human', decision: 'rejected', reason: '摄影机构图需要调整' });
    const replacement = service.requestDirectorCapture(repo.getRun(db, run.id));
    const replacementPoll = service.requestDirectorCapture(repo.getRun(db, run.id));
    assert.equal(replacement.state, 'client_action');
    assert.equal(replacement.client_action.action_id, replacementPoll.client_action.action_id);
    assert.notEqual(replacement.client_action.action_id, request.client_action.action_id);
  });

  it('keeps a legacy two-second shot image-only but submits and reserves the five-second provider minimum', async () => {
    const run = makeRun('short-routed-shot');
    const policy = {
      ...run.policy,
      video_routing_mode: 'auto',
      video_group: '特价视频分组(即梦)',
      video_quality: 'balanced',
    };
    repo.updateRun(db, run.id, { policy });
    const currentRun = repo.getRun(db, run.id);
    const shot = addApproved(currentRun, 'storyboard_plan', 'shot', '1', 'Two-second close-up', {
      number: 1,
      duration: 2,
      route_profile: 'short_image_guided',
      previs_mode: 'auto',
      transition_mode: 'opening',
      boundary_prompt: 'Opening shot with one complete reaction beat.',
      cut_in: 'The heroine is still and looking down.',
      action: 'She raises her eyes toward the off-screen threat, then holds.',
      visual: 'A stable tight close-up with a clean background.',
      shot_type: 'close-up',
      camera_angle: 'eye level',
      camera_movement: 'locked camera',
      lighting: 'stable cyan and warm rim light',
      continuity_in: 'Identity, costume, and background geometry are fixed.',
      continuity_out: 'Her eyes are raised and her face is still.',
      cut_out: 'Cut on the completed reaction.',
      video_prompt: 'Complete the eye movement and settle within exactly two seconds.',
      character_names: [],
      prop_names: [],
    });
    const frame = addApproved(currentRun, 'storyboard_images', 'shot', '1', 'Close-up frame', {
      source_artifact_id: shot.id,
    }, [shot.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?')
      .run('images/short-shot.png', frame.id);

    const requests = [];
    const service = createProductionMediaService(db, cfg, log, {
      fetchVideoCatalog: async () => routedCatalog(),
      createVideo: async (request) => {
        requests.push(structuredClone(request));
        return { id: 101, task_id: 'short-task-101' };
      },
    });
    const bundled = await service.ensureReferenceBundles(currentRun);
    assert.equal(bundled.state, 'progressed');
    assert.equal(bundled.artifact.status, 'draft');
    assert.equal(bundled.artifact.content.routing_receipt.model, 'mg-seedance2.0 -480p mini');
    assert.equal(bundled.artifact.content.routing_receipt.estimated_price, 1.002);
    assert.equal(bundled.artifact.content.routing_receipt.planned_duration, 2);
    assert.equal(bundled.artifact.content.routing_receipt.duration, 5);
    assert.equal(bundled.artifact.content.routing_receipt.duration_adjusted, true);
    assert.equal(bundled.artifact.content.limits.videos, 0);
    assert.deepEqual(bundled.artifact.content.videos, []);
    repo.reviewArtifact(db, bundled.artifact.id, {
      reviewer_type: 'human', decision: 'approved', reason: 'Image-only references approved',
    });

    const submitted = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(submitted.state, 'waiting_provider');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, 'mg-seedance2.0 -480p mini');
    assert.equal(requests[0].duration, 5);
    assert.deepEqual(requests[0].reference_video_urls, []);
    assert.equal(requests[0].routing_receipt.capability_model, 'mg-seedance2.0 -480p mini');
    assert.equal(requests[0].routing_receipt.capability_snapshot.max_images, 4);
    assert.equal(requests[0].routing_receipt.capability_snapshot.max_videos, 3);
    assert.deepEqual(repo.getRun(db, run.id).usage, {
      video_attempts_reserved: 1,
      video_seconds_reserved: 5,
    });
    assert.equal(
      repo.listActions(db, run.id, { page_size: 200 }).items.filter((item) => item.kind === 'client_capture').length,
      0
    );
  });

  it('executes a sixty-second Seedance 2.5 shot as two idempotent thirty-second child tasks', async () => {
    let run = makeRun('seedance-25-two-units', {
      video_routing_mode: 'fixed',
      video_model: 'Seedance 2.5-720',
      video_group: '限时特价即梦分组',
      video_provider: 'yinzi',
      director_mode: 'off',
    });
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', 'Sixty-second logical shot', {
      number: 1, duration: 60, route_profile: 'long_previs_guided', previs_mode: 'skip',
      transition_mode: 'opening', boundary_prompt: 'One continuous logical shot.',
      cut_in: 'The character starts in the garden.', action: 'Dance continuously.',
      visual: 'Stable garden and identity.', shot_type: 'full shot', camera_angle: 'eye level',
      camera_movement: 'gentle follow', lighting: 'stable daylight',
      continuity_in: 'Opening state.', continuity_out: 'Dance ends.', cut_out: 'End after the dance.',
      video_prompt: 'Keep the same character dancing in the same garden.', character_names: [], prop_names: [],
    });
    const frame = addApproved(run, 'storyboard_images', 'shot', '1', 'Sixty-second frame', {
      source_artifact_id: shot.id,
    }, [shot.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?')
      .run('images/seedance-25-frame.png', frame.id);

    const catalog = {
      pricing_version: 'seedance-25-missing-contract-v1', fetched_at: '2026-09-01T00:00:00.000Z',
      video: [{
        model: 'Seedance 2.5-720', endpoint_types: ['openai-video'],
        groups: ['限时特价即梦分组'], capabilities: null,
        capability_source: 'unknown', contract_status: 'missing', catalog_verified: true,
        prices: [{ group: '限时特价即梦分组', billing_unit: 'per_request', effective_price: 3.5 }],
      }],
    };
    const requests = [];
    const generations = new Map();
    let nextId = 600;
    const service = createProductionMediaService(db, cfg, log, {
      fetchVideoCatalog: async () => catalog,
      createVideo: async (request) => {
        const id = ++nextId;
        requests.push(structuredClone(request));
        generations.set(id, { id, task_id: `seedance-unit-${id}`, model: request.model, status: 'processing' });
        return { id, task_id: `seedance-unit-${id}`, model: request.model };
      },
      getVideo: async (id) => generations.get(Number(id)),
      validateVideo: async (mediaPath, options) => ({
        ...videoReceipt(String(mediaPath).includes('merged-60')
          ? 'videos/merged-60.mp4'
          : `videos/unit-${options.expected_duration}.mp4`),
        duration: Number(options.expected_duration),
      }),
      extractContinuityFrame: async () => ({ path: 'continuity/segment-1-tail.png', sha256: 'f'.repeat(64) }),
      mergeVideoSegments: async (paths) => ({ relative_path: 'videos/merged-60.mp4', paths }),
    });
    const bundled = await service.ensureReferenceBundles(run);
    assert.equal(bundled.state, 'progressed');
    assert.equal(bundled.artifact.content.routing_receipt.planned_duration, 60);
    assert.equal(bundled.artifact.content.routing_receipt.provider_duration, 30);
    assert.equal(bundled.artifact.content.routing_receipt.execution_unit_count, 2);
    repo.reviewArtifact(db, bundled.artifact.id, { reviewer_type: 'human', decision: 'approved', reason: 'approve two-unit route' });

    let state = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(state.state, 'waiting_provider');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].duration, 30);
    assert.equal(requests[0].fixed_execution_segment_index, 1);
    assert.deepEqual(repo.getRun(db, run.id).usage, {
      video_attempts_reserved: 1, video_seconds_reserved: 30,
    });
    const firstId = Number(state.action.generation_id);

    state = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(state.state, 'waiting_provider');
    assert.equal(requests.length, 1, 'polling must not duplicate the first paid POST');
    generations.set(firstId, {
      ...generations.get(firstId), status: 'completed', local_path: 'videos/segment-1.mp4', video_url: null,
    });

    state = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(state.state, 'waiting_provider');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].duration, 30);
    assert.equal(requests[1].fixed_execution_segment_index, 2);
    assert.ok(requests[1].reference_image_urls.includes('continuity/segment-1-tail.png'));
    assert.match(requests[1].prompt, /连续执行片段 2\/2/);
    assert.deepEqual(repo.getRun(db, run.id).usage, {
      video_attempts_reserved: 2, video_seconds_reserved: 60,
    });
    const secondId = Number(state.action.generation_id);

    state = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(state.state, 'waiting_provider');
    assert.equal(requests.length, 2, 'polling must not duplicate the second paid POST');
    generations.set(secondId, {
      ...generations.get(secondId), status: 'completed', local_path: 'videos/segment-2.mp4', video_url: null,
    });
    state = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(state.state, 'progressed');
    assert.equal(state.reason, 'fixed_duration_execution_converged');
    assert.equal(state.artifact.content.fixed_duration_execution.execution_unit_count, 2);
    assert.equal(state.artifact.media_path, 'videos/merged-60.mp4');
    assert.equal(requests.length, 2);
    const actions = repo.listActions(db, run.id, { page_size: 200 }).items;
    assert.equal(actions.filter((item) => item.kind === 'video_execution_parent').length, 1);
    assert.equal(actions.filter((item) => item.kind === 'video_generate').length, 2);
  });

  it('releases local cost and duration after a definitive provider rejection with no task ID', async () => {
    const run = makeRun('provider-rejected-video');
    const policy = {
      ...run.policy,
      shot_video_models: { '1': 'mg-seedance2.0 -480p mini' },
      video_model: 'mg-seedance2.0 -480p mini',
      video_provider: 'yinzi',
      video_group: '特价视频分组(即梦)',
      video_quality: 'balanced',
    };
    repo.updateRun(db, run.id, { policy });
    const currentRun = repo.getRun(db, run.id);
    const shot = addApproved(currentRun, 'storyboard_plan', 'shot', '1', 'Rejected shot', {
      number: 1, duration: 5, route_profile: 'short_image_guided', previs_mode: 'auto',
      transition_mode: 'opening', boundary_prompt: 'One complete shot.',
      cut_in: 'Opening composition.', action: 'The subject turns toward camera.',
      visual: 'Stable medium shot.', shot_type: 'medium shot', camera_angle: 'eye level',
      camera_movement: 'locked camera', lighting: 'stable', continuity_in: 'Opening state.',
      continuity_out: 'Turn completed.', cut_out: 'Cut after the action.',
      video_prompt: 'Complete the turn.', character_names: [], prop_names: [],
    });
    const frame = addApproved(currentRun, 'storyboard_images', 'shot', '1', 'Rejected frame', {
      source_artifact_id: shot.id,
    }, [shot.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?')
      .run('images/rejected-shot.png', frame.id);

    const service = createProductionMediaService(db, cfg, log, {
      fetchVideoCatalog: async () => routedCatalog(),
      createVideo: async () => ({ id: 102, task_id: 'local-video-task-102' }),
      getVideo: async () => ({
        id: 102,
        task_id: 'local-video-task-102',
        status: 'failed',
        generation_status: 'failed',
        submission_status: 'rejected',
        submission_http_status: 400,
        submission_receipt: {
          error_code: 'unsupported_media_reference',
          request_id: 'request-rejected-102',
        },
        provider_task_id: null,
        error_msg: 'HTTP 400 - this route supports at most 1 reference images',
      }),
    });
    const bundled = await service.ensureReferenceBundles(currentRun);
    repo.reviewArtifact(db, bundled.artifact.id, {
      reviewer_type: 'human', decision: 'approved', reason: 'Approved for rejection accounting test',
    });

    assert.equal((await service.ensureShotVideos(repo.getRun(db, run.id))).state, 'waiting_provider');
    assert.deepEqual(repo.getRun(db, run.id).usage, {
      video_attempts_reserved: 1,
      video_seconds_reserved: 5,
    });
    const reconciled = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(reconciled.state, 'waiting_review');
    assert.equal(reconciled.action.status, 'failed');
    assert.equal(reconciled.action.result.reservation_released, true);
    assert.equal(reconciled.action.result.submission_status, 'rejected');
    assert.deepEqual(repo.getRun(db, run.id).usage, {
      video_attempts_reserved: 0,
      video_seconds_reserved: 0,
    });
    assert.equal(
      db.prepare('SELECT status FROM cost_ledger WHERE action_id = ?').get(reconciled.action.id).status,
      'released'
    );
  });

  it('prioritizes the scene and cast in a bounded reference bundle before reserving video', async () => {
    const run = makeRun();
    const character = addApproved(run, 'asset_text', 'character', 'character-1', '林夏', {
      name: '林夏', description: '宇航员', appearance: '短黑发、白色舱外服、蓝色肩章',
      identity_anchors: ['短黑发', '蓝色肩章'], continuity_rules: ['服装和脸部全程不变'],
      negative_prompt: '不得改变发色或服装', visual_prompt: '角色四视图',
    });
    const secondCharacter = addApproved(run, 'asset_text', 'character', 'character-2', '巡检机器人', {
      name: '巡检机器人', description: '小型机器人', appearance: '白色圆柱机身、单枚蓝色镜头',
      identity_anchors: ['单枚蓝色镜头'], continuity_rules: ['机身尺寸不变'],
      negative_prompt: '不得复制机器人', visual_prompt: '机器人四视图',
    });
    const scene = addApproved(run, 'asset_text', 'scene', 'scene-1', '星尘温室', {
      name: '星尘温室', description: '空旷月面玻璃穹顶温室', location: '月面穹顶', reference_state: 'empty',
      spatial_anchors: ['中央培养基座', '左侧栏杆', '远处封闭穹顶'],
      continuity_rules: ['背景始终空旷且没有花'], negative_prompt: '不得新增花朵或植物', visual_prompt: '温室四视图',
    });
    const prop = addApproved(run, 'asset_text', 'prop', 'prop-1', '发光种子', {
      name: '发光种子', description: '唯一一枚闭合的蓝色晶体种子舱',
      identity_anchors: ['六片闭合晶体瓣'], continuity_rules: ['始终只有一个且不可换手'],
      negative_prompt: '不得复制或变成花', visual_prompt: '道具四视图',
    });
    const unrelated = addApproved(run, 'asset_text', 'prop', 'prop-2', '备用工具', { name: '备用工具', description: '工具', visual_prompt: '工具四视图' });
    const assetImages = [character, secondCharacter, scene, prop, unrelated].map((asset, index) => {
      const image = addApproved(run, 'asset_images', asset.scope_type, asset.scope_id, asset.title, { source_artifact_id: asset.id }, [asset.id]);
      db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?').run(`images/bundle-asset-${index + 1}.png`, image.id);
      return image;
    });
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', '镜头一', {
      number: 1, duration: 5, action: '林夏拿起种子', visual: '林夏与机器人位于空旷温室中央的中景',
      route_profile: 'long_previs_guided',
      video_prompt: '镜头缓慢推进', boundary_prompt: '开场单一完整镜头，内部不得切镜。',
      cut_in: '林夏站在中央培养基座左侧，双手尚未接触闭合种子舱。',
      continuity_in: '温室为空，中央基座、左侧栏杆和远处穹顶位置固定。',
      shot_type: '双人中景', camera_angle: '平视', camera_movement: '五秒内稳定缓慢推近',
      lighting: '冷白月光与培养基座蓝光保持恒定。',
      continuity_out: '林夏双手稳定托住唯一闭合种子舱，机器人仍在右侧。',
      cut_out: '动作完整停止后，在稳定构图上切镜。',
      character_names: ['林夏', '巡检机器人'], scene_name: '星尘温室', prop_names: ['发光种子'],
    });
    const storyboardImage = addApproved(run, 'storyboard_images', 'shot', '1', '镜头一分镜图', {
      source_artifact_id: shot.id,
    }, [shot.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?').run('images/shot-1.png', storyboardImage.id);
    const plan = addApproved(run, 'director_plan', 'shot', '1', '镜头一导演台', { source_artifact_id: shot.id, document: createFallbackDirectorDocument(shot.content) }, [shot.id]);
    const preview = addApproved(run, 'director_preview', 'shot', '1', '镜头一预演', { source_artifact_id: plan.id }, [plan.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?').run('previews/shot-1.webm', preview.id);

    let creates = 0;
    const videoRequests = [];
    let plannerUserPrompt = '';
    let plannerCalls = 0;
    let videoStatus = 'processing';
    const service = createProductionMediaService(db, cfg, log, {
      fetchVideoCatalog: async () => routedCatalog(),
      createVideo: async (request) => {
        creates += 1;
        videoRequests.push(structuredClone(request));
        return { id: 91, task_id: 'video-task-91' };
      },
      getVideo: async () => ({
        id: 91,
        task_id: 'video-task-91',
        provider_task_id: 'provider-video-91',
        submission_status: 'accepted',
        status: videoStatus,
        local_path: 'videos/shot-1.mp4',
      }),
      validateVideo: async () => videoReceipt('videos/shot-1.mp4'),
      generateText: async (user, _system) => {
        plannerCalls += 1;
        plannerUserPrompt = user;
        return JSON.stringify({
        failure_memory: [{
          review_id: 1, observed_failure: 'The pod moved back into the character hands at frame zero.',
          violated_constraint: 'Shot 2 must inherit the seated pod state from shot 1.',
          required_state: 'For the first two seconds, keep the closed pod seated in the base with both hands released.',
        }, {
          review_id: 2, observed_failure: 'Flowers appeared outside the bridge corridor.',
          violated_constraint: 'The approved background remains the same empty greenhouse.',
          required_state: 'Keep the dome, railings, floor, and distant background unchanged and empty throughout.',
        }],
        provider_prompt: 'Begin on the exact final frame of shot 1. For the first two seconds, the closed seed pod remains seated vertically in the cultivation base and both hands stay released. The six petals then open while the pod remains in the base. Continue the approved camera move and end in the approved exit state.',
      });
      },
    });
    const bundled = await service.ensureReferenceBundles(run);
    assert.equal(bundled.state, 'progressed');
    assert.equal(bundled.artifact.content.images.length, 4);
    assert.equal(bundled.artifact.content.videos.length, 1);
    assert.equal(bundled.artifact.status, 'draft');
    const approvedBundle = repo.reviewArtifact(db, bundled.artifact.id, {
      reviewer_type: 'human',
      decision: 'approved',
      reason: 'Reference selection approved for this shot',
    }).artifact;
    assert.equal(approvedBundle.status, 'approved');
    assert.deepEqual(
      bundled.artifact.content.images.slice(1).map((item) => item.artifact_id).sort((a, b) => a - b),
      assetImages.slice(0, 3).map((item) => item.id).sort((a, b) => a - b),
    );
    assert.deepEqual(
      repo.listUpstreamArtifactIds(db, bundled.artifact.id),
      [
        shot.id,
        storyboardImage.id,
        preview.id,
        character.id,
        secondCharacter.id,
        scene.id,
        ...assetImages.slice(0, 3).map((item) => item.id),
      ].sort((a, b) => a - b),
    );
    assert.deepEqual(bundled.artifact.content.autolink_receipt.items.map((item) => item.status), [
      'matched', 'matched', 'matched', 'omitted_by_capacity',
    ]);
    assert.doesNotMatch(JSON.stringify(bundled.artifact.content.autolink_receipt), /备用工具/);
    assert.equal(repo.listUpstreamArtifactIds(db, bundled.artifact.id).includes(assetImages[3].id), false);
    assert.equal(repo.listUpstreamArtifactIds(db, bundled.artifact.id).includes(assetImages[4].id), false);
    assert.equal((await service.ensureShotVideos(repo.getRun(db, run.id))).state, 'waiting_provider');
    assert.deepEqual(repo.getRun(db, run.id).usage, { video_attempts_reserved: 1, video_seconds_reserved: 5 });
    assert.equal(creates, 1);
    assert.ok(videoRequests[0].prompt.length <= PROVIDER_PROMPT_MAX_CHARS);
    assert.match(videoRequests[0].prompt, /^【镜头边界，最高优先级】/);
    assert.match(videoRequests[0].prompt, /开场单一完整镜头，内部不得切镜/);
    assert.match(videoRequests[0].prompt, /【参考媒体使用规则，严格按传入顺序】/);
    assert.match(videoRequests[0].prompt, /参考图1「镜头一分镜图」/);
    assert.match(videoRequests[0].prompt, /参考视频1「镜头一预演」/);
    assert.match(videoRequests[0].prompt, /林夏站在中央培养基座左侧/);
    assert.match(videoRequests[0].prompt, /双人中景；平视/);
    assert.match(videoRequests[0].prompt, /五秒内稳定缓慢推近/);
    assert.match(videoRequests[0].prompt, /冷白月光与培养基座蓝光保持恒定/);
    assert.match(videoRequests[0].prompt, /镜头缓慢推进/);
    assert.match(videoRequests[0].prompt, /动作完整停止后，在稳定构图上切镜/);
    assert.match(videoRequests[0].prompt, /角色「林夏」/);
    assert.match(videoRequests[0].prompt, /场景「星尘温室」/);
    assert.match(videoRequests[0].prompt, /道具「发光种子」/);
    assert.match(videoRequests[0].prompt, /背景始终空旷且没有花/);
    assert.match(videoRequests[0].prompt, /始终只有一个且不可换手/);
    assert.doesNotMatch(videoRequests[0].prompt, /备用工具/);
    assert.equal(videoRequests[0].prompt_contract.profile, 'structured-provider-prompt-v2');
    assert.equal(videoRequests[0].prompt_contract.max_chars, 4000);
    assert.equal(videoRequests[0].prompt_contract.provider_hard_max_chars, 4096);
    assert.equal(videoRequests[0].prompt_contract.final_chars, videoRequests[0].prompt.length);
    assert.ok(videoRequests[0].prompt_contract.final_chars <= videoRequests[0].prompt_contract.max_chars);
    assert.equal(videoRequests[0].retry_feedback, undefined);
    videoStatus = 'completed';
    const completed = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(completed.state, 'progressed');
    assert.equal(completed.artifact.status, 'draft');
    assert.equal(creates, 1);
    const retryFeedback = 'Keep the seed pod seated in the base during the opening action.';
    repo.reviewArtifact(db, completed.artifact.id, { reviewer_type: 'human', decision: 'rejected', reason: retryFeedback });
    const backgroundFeedback = 'Keep the dome and distant background empty; no flowers may appear outside the bridge corridor.';
    const secondRejected = repo.createArtifact(db, {
      run_id: run.id, stage: 'shot_video', scope_type: 'shot', scope_id: '1', title: 'Second rejected result',
      content: { source_artifact_id: shot.id, bundle_artifact_id: bundled.artifact.id, included: true },
      status: 'draft', media_path: 'videos/rejected-2.mp4', mime_type: 'video/mp4',
      depends_on: [shot.id, bundled.artifact.id],
    });
    repo.reviewArtifact(db, secondRejected.id, { reviewer_type: 'human', decision: 'rejected', reason: backgroundFeedback });
    videoStatus = 'processing';
    const planned = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(planned.state, 'progressed');
    assert.equal(planned.reason, 'video_prompt_planned');
    assert.equal(creates, 1);
    assert.deepEqual(repo.getRun(db, run.id).usage, { video_attempts_reserved: 1, video_seconds_reserved: 5 });
    assert.equal(planned.action.kind, 'video_prompt_plan');
    assert.equal(plannerCalls, 1);
    assert.equal(planned.action.result.evidence[0].reason, retryFeedback);
    assert.equal(planned.action.result.evidence[1].reason, backgroundFeedback);
    assert.ok(plannerUserPrompt.indexOf(retryFeedback) < plannerUserPrompt.indexOf(backgroundFeedback));
    const retry = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(retry.state, 'waiting_provider');
    assert.equal(retry.action.attempt, 2);
    assert.equal(creates, 2);
    assert.equal(videoRequests[1].retry_feedback, undefined);
    assert.equal(retry.action.request.retry_feedback, undefined);
    assert.equal(videoRequests[1].prompt, retry.action.request.prompt);
    assert.match(videoRequests[1].prompt, /first two seconds/);
    assert.match(videoRequests[1].prompt, /^【镜头边界，最高优先级】/);
    assert.match(videoRequests[1].prompt, /参考视频1「镜头一预演」/);
    assert.match(videoRequests[1].prompt, /角色「林夏」/);
    assert.match(videoRequests[1].prompt, /动作完整停止后，在稳定构图上切镜/);
    assert.ok(videoRequests[1].prompt.length <= 4000);
    assert.doesNotMatch(videoRequests[1].prompt, /Retry correction|rejected result/);
    assert.equal(retry.action.request.failure_memory.length, 2);
    assert.equal(retry.action.request.retry_evidence[0].reason, retryFeedback);
    assert.equal(retry.action.request.retry_evidence[1].reason, backgroundFeedback);
    assert.equal(typeof retry.action.request.prompt_plan_action_id, 'number');
    assert.deepEqual(repo.getRun(db, run.id).usage, { video_attempts_reserved: 2, video_seconds_reserved: 10 });
    const versionBeforeRetryPoll = repo.getRun(db, run.id).version;
    const retryPoll = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(retryPoll.state, 'waiting_provider');
    assert.equal(retryPoll.action.id, retry.action.id);
    assert.equal(creates, 2);
    assert.equal(videoRequests.length, 2);
    assert.equal(repo.getRun(db, run.id).version, versionBeforeRetryPoll);
    assert.deepEqual(repo.getRun(db, run.id).usage, { video_attempts_reserved: 2, video_seconds_reserved: 10 });

    videoStatus = 'failed';
    const transportFailure = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(transportFailure.state, 'waiting_review');
    assert.equal(transportFailure.reason, 'video_generation_failed');
    const failedAction = repo.getAction(db, retry.action.id);
    repo.updateAction(db, failedAction.id, {
      status: 'cancelled',
      result: { ...(failedAction.result || {}), retry_authorized: true, retry_reason: 'transport-only retry' },
    });
    const retryLimitedRun = repo.getRun(db, run.id);
    repo.updateRun(db, run.id, {
      budget: { ...retryLimitedRun.budget, max_video_attempts_per_shot: 2 },
    });
    videoStatus = 'processing';
    const transportRetry = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(transportRetry.state, 'waiting_provider');
    assert.equal(transportRetry.action.attempt, 3);
    assert.equal(transportRetry.action.request.prompt_plan_action_id, retry.action.request.prompt_plan_action_id);
    assert.equal(plannerCalls, 1);
    assert.equal(creates, 3);
    assert.deepEqual(repo.getRun(db, run.id).usage, { video_attempts_reserved: 3, video_seconds_reserved: 15 });
  });

  it('refreshes continuity lineage before submit and rejects an in-flight stale bundle on completion', async () => {
    let run = makeRun('reference-lineage-run');
    run = repo.updateRun(db, run.id, {
      policy: { ...run.policy, video_model: 'strict-test-model' },
    });
    const character = addApproved(run, 'asset_text', 'character', 'character-1', 'Lin Lan', {
      name: 'Lin Lan', description: 'adult astronaut', visual_prompt: 'identity sheet',
    });
    const characterImage = addApproved(run, 'asset_images', 'character', 'character-1', 'Lin Lan identity', {
      source_artifact_id: character.id,
    }, [character.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?').run('images/lin-lan.png', characterImage.id);

    const shots = [1, 2].map((number) => addApproved(run, 'storyboard_plan', 'shot', String(number), `Shot ${number}`, {
      number,
      duration: 5,
      route_profile: 'long_previs_guided',
      action: `Action ${number}`,
      visual: `Visual ${number}`,
      video_prompt: `Chronological provider prompt for shot ${number} with stable continuity and camera motion.`,
      transition_mode: number === 1 ? 'opening' : 'strict_continuation',
      continuous_take_id: number === 1 ? '' : 'take-1',
      cut_in: number === 1 ? 'Opening greenhouse state' : 'Exact decoded final frame from shot 1',
      cut_out: `Completed action ${number}`,
      boundary_prompt: number === 1 ? 'Opening shot.' : 'Use the supplied image as the exact first frame.',
      character_names: ['Lin Lan'],
      scene_name: 'Greenhouse',
      prop_names: ['Seed pod'],
    }));
    const previews = [];
    for (const shot of shots) {
      const image = addApproved(run, 'storyboard_images', 'shot', shot.scope_id, `${shot.title} frame`, {
        source_artifact_id: shot.id,
      }, [shot.id]);
      db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?').run(`images/shot-${shot.scope_id}.png`, image.id);
      const plan = addApproved(run, 'director_plan', 'shot', shot.scope_id, `${shot.title} plan`, {
        source_artifact_id: shot.id,
        document: createFallbackDirectorDocument(shot.content),
      }, [shot.id]);
      const preview = addApproved(run, 'director_preview', 'shot', shot.scope_id, `${shot.title} preview`, {
        source_artifact_id: plan.id,
        validation: { duration: 9.935 },
      }, [plan.id]);
      db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?').run(`previews/shot-${shot.scope_id}.webm`, preview.id);
      previews.push(preview);
    }

    const lineageCapability = {
      max_images: 4,
      max_videos: 3,
      max_audios: 1,
      max_total_references: 8,
      max_reference_video_seconds_total: 15,
      reference_video_safety_margin_seconds: 1.2,
      duration_min: 5,
      duration_max: 15,
      resolution: '720p',
      roles: { image: ['reference', 'first_frame'], video: ['reference'], audio: ['reference'] },
    };
    let videoStatus = 'processing';
    const requests = [];
    let excerptCalls = 0;
    const service = createProductionMediaService(db, cfg, log, {
      getVideoCapability: () => lineageCapability,
      fetchVideoCatalog: async () => customVideoCatalog('strict-test-model'),
      extractContinuityFrame: async () => imageReceipt('production/continuity-frames/lineage.png'),
      validateContinuityFrame: async () => imageReceipt('production/continuity-frames/lineage.png'),
      createVideo: async (request) => {
        requests.push(structuredClone(request));
        return { id: 901, task_id: 'video-task-901' };
      },
      getVideo: async () => ({
        id: 901,
        task_id: 'video-task-901',
        provider_task_id: 'provider-901',
        status: videoStatus,
        local_path: 'videos/shot-2.mp4',
      }),
      validateVideo: async () => videoReceipt('videos/shot-2.mp4'),
      prepareReferenceVideoTransport: async (mediaPath, options) => {
        const isContinuityTail = mediaPath.startsWith('videos/shot-1-');
        if (isContinuityTail) {
          excerptCalls += 1;
          assert.ok(options.start_seconds > 2);
          assert.ok(options.duration_seconds > 3.5 && options.duration_seconds < 4.1);
        } else {
          assert.equal(options.start_seconds, undefined);
          assert.equal(options.duration_seconds, undefined);
        }
        return {
          relative_path: isContinuityTail ? 'production/reference-cache/shot-1-tail.mp4' : mediaPath,
          duration: isContinuityTail ? options.duration_seconds + (1 / 24) : 9.935,
          width: 1280,
          height: 720,
          video_codec: 'h264',
          pixel_format: 'yuv420p',
          r_frame_rate: '24/1',
          avg_frame_rate: '24/1',
        };
      },
    });

    const firstBundlePass = await service.ensureReferenceBundles(run);
    assert.equal(firstBundlePass.state, 'progressed');
    const shot1Bundle = repo.getArtifact(db, firstBundlePass.artifact.id);
    assert.equal(shot1Bundle.status, 'draft');
    assert.deepEqual(shot1Bundle.content.images.map((item) => item.label), ['当前分镜图', '角色 · Lin Lan']);
    assert.equal(shot1Bundle.content.autolink_receipt.summary.matched_count, 1);
    assert.deepEqual(shot1Bundle.content.autolink_receipt.items.map((item) => item.status), [
      'missing_asset_definition', 'matched', 'missing_asset_definition',
    ]);
    assert.ok(repo.listUpstreamArtifactIds(db, shot1Bundle.id).includes(character.id));
    assert.ok(repo.listUpstreamArtifactIds(db, shot1Bundle.id).includes(characterImage.id));
    repo.reviewArtifact(db, shot1Bundle.id, {
      reviewer_type: 'human',
      decision: 'approved',
      reason: 'Approve the first shot reference bundle',
    });

    const firstShotVideo = addApproved(run, 'shot_video', 'shot', '1', 'Shot 1 approved video', {
      source_artifact_id: shots[0].id,
      bundle_artifact_id: shot1Bundle.id,
      validation: { duration: 6.08 },
    }, [shots[0].id, shot1Bundle.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?').run('videos/shot-1-v1.mp4', firstShotVideo.id);

    assert.equal((await service.ensureReferenceBundles(repo.getRun(db, run.id))).state, 'progressed');
    const provisionalShot2Bundle = repo.listArtifacts(db, run.id, {
      stage: 'reference_bundle', current: true, page_size: 10,
    }).items.find((item) => item.scope_id === '2');
    assert.equal(provisionalShot2Bundle.status, 'draft');
    assert.deepEqual(provisionalShot2Bundle.content.videos.map((item) => item.source), ['director']);
    assert.equal(provisionalShot2Bundle.content.images[0].role, 'first_frame');

    const firstShotReplacement = addApproved(run, 'shot_video', 'shot', '1', 'Shot 1 replacement before shot 2', {
      source_artifact_id: shots[0].id,
      bundle_artifact_id: shot1Bundle.id,
      validation: { duration: 6.08 },
    }, [shots[0].id, shot1Bundle.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?').run('videos/shot-1-v2.mp4', firstShotReplacement.id);

    assert.equal((await service.ensureReferenceBundles(repo.getRun(db, run.id))).state, 'progressed');
    assert.equal((await service.ensureReferenceBundles(repo.getRun(db, run.id))).state, 'stage_ready');
    const initialShot2Bundle = repo.listArtifacts(db, run.id, {
      stage: 'reference_bundle', current: true, page_size: 10,
    }).items.find((item) => item.scope_id === '2');
    assert.equal(initialShot2Bundle.status, 'draft');
    assert.deepEqual(initialShot2Bundle.content.videos.map((item) => item.source), ['director']);
    assert.equal(initialShot2Bundle.content.images[0].role, 'first_frame');
    repo.reviewArtifact(db, initialShot2Bundle.id, {
      reviewer_type: 'human',
      decision: 'approved',
      reason: 'Approve the strict continuation reference bundle',
    });

    const submitted = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(submitted.state, 'waiting_provider');
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].reference_video_urls, ['previews/shot-2.webm']);
    assert.equal(requests[0].reference_video_budget.profile, 'continuity-tail-v2-final-transport');
    assert.equal(excerptCalls, 0);
    assert.doesNotMatch(requests[0].prompt, /tail excerpt ending at the approved real cut boundary/);
    assert.equal(requests[0].bundle_artifact_id, initialShot2Bundle.id);

    const replacementDraft = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'shot_video',
      scope_type: 'shot',
      scope_id: '1',
      title: 'Shot 1 replacement',
      content: { source_artifact_id: shots[0].id, bundle_artifact_id: shot1Bundle.id, included: true },
      status: 'draft',
      media_path: 'videos/shot-1-v3.mp4',
      mime_type: 'video/mp4',
      depends_on: [shots[0].id, shot1Bundle.id],
    });
    const replacement = repo.reviewArtifact(db, replacementDraft.id, {
      reviewer_type: 'human', decision: 'approved', reason: 'Approved continuity replacement',
    }).artifact;
    videoStatus = 'completed';

    const stale = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(stale.state, 'progressed');
    assert.equal(stale.reason, 'superseded_video_converged');
    const staleAction = repo.getAction(db, submitted.action.id);
    assert.equal(staleAction.status, 'completed');
    assert.equal(staleAction.error_code, null);
    assert.equal(staleAction.result.stale_bundle_artifact_id, initialShot2Bundle.id);
    assert.equal(staleAction.result.current_bundle_artifact_id, stale.bundle.id);
    assert.equal(stale.bundle.content.continuity_in_artifact_id, replacement.id);
    assert.equal(repo.listArtifacts(db, run.id, {
      stage: 'shot_video', scope_id: '2', current: true, page_size: 10,
    }).items.length, 0);
    assert.equal(requests.length, 1);
  });

  it('sends an optional predecessor tail frame first as an ordinary image reference', async () => {
    let run = makeRun('ordinary-tail-reference-run');
    run = repo.updateRun(db, run.id, {
      policy: {
        ...run.policy,
        video_routing_mode: 'auto',
        video_group: '特价视频分组(即梦)',
      },
    });
    const shots = [
      addApproved(run, 'storyboard_plan', 'shot', '1', 'Opening shot', {
        number: 1,
        duration: 5,
        route_profile: 'short_image_guided',
        transition_mode: 'opening',
        action: 'Complete the opening pose.',
        visual: 'Stable wide opening frame.',
        cut_in: 'Opening state.',
        cut_out: 'The heroine settles into a stable stance.',
        boundary_prompt: 'Independent opening shot.',
        video_prompt: 'Complete the opening pose and hold.',
      }),
      addApproved(run, 'storyboard_plan', 'shot', '2', 'Best-effort continuation', {
        number: 2,
        duration: 5,
        route_profile: 'short_image_guided',
        transition_mode: 'reference_continuation',
        action: 'She turns her head and completes one reaction.',
        visual: 'A closer angle preserving the approved state.',
        cut_in: 'Begin from the settled stance shown by the predecessor tail reference.',
        cut_out: 'The reaction ends on a stable close-up.',
        boundary_prompt: 'Use the predecessor tail only as an ordinary image reference.',
        video_prompt: 'Preserve identity and scene state, then complete the head turn.',
      }),
    ];
    for (const shot of shots) {
      const image = addApproved(run, 'storyboard_images', 'shot', shot.scope_id, `${shot.title} frame`, {
        source_artifact_id: shot.id,
      }, [shot.id]);
      db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?')
        .run(`images/ordinary-tail-shot-${shot.scope_id}.png`, image.id);
    }
    const previousVideo = addApproved(run, 'shot_video', 'shot', '1', 'Approved predecessor video', {
      source_artifact_id: shots[0].id,
      validation: { duration: 5 },
    }, [shots[0].id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?')
      .run('videos/ordinary-tail-predecessor.mp4', previousVideo.id);

    const requests = [];
    const service = createProductionMediaService(db, cfg, log, {
      fetchVideoCatalog: async () => routedCatalog(),
      extractContinuityFrame: async (_mediaPath, input) => {
        assert.equal(input.source_artifact_id, previousVideo.id);
        return imageReceipt('production/continuity-frames/ordinary-tail.png');
      },
      validateContinuityFrame: async () => imageReceipt('production/continuity-frames/ordinary-tail.png'),
      createVideo: async (request) => {
        requests.push(structuredClone(request));
        return { id: 903, task_id: 'ordinary-tail-task' };
      },
    });

    assert.equal((await service.ensureReferenceBundles(run)).state, 'progressed');
    const secondPass = await service.ensureReferenceBundles(repo.getRun(db, run.id));
    assert.equal(secondPass.state, 'progressed');
    const bundle = secondPass.artifact;
    assert.equal(bundle.scope_id, '2');
    assert.equal(bundle.content.transition_mode, 'reference_continuation');
    assert.equal(bundle.content.continuity_frame_transport, 'generic_image_reference');
    assert.equal(bundle.content.images[0].source, 'continuity_first_frame');
    assert.equal(bundle.content.images[0].role, 'reference');
    assert.equal(bundle.content.images[0].locked, true);
    assert.equal(bundle.content.videos.length, 0);
    repo.reviewArtifact(db, bundle.id, {
      reviewer_type: 'human',
      decision: 'approved',
      reason: 'Ordinary tail-frame reference approved',
    });

    const submitted = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(submitted.state, 'waiting_provider');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].first_frame_url, undefined);
    assert.equal(requests[0].reference_image_urls[0], 'production/continuity-frames/ordinary-tail.png');
    assert.deepEqual(requests[0].reference_video_urls, []);
    assert.match(requests[0].prompt, /第一顺位普通参考图/);
  });

  it('omits historical director media from a bundle when the project disables 3D', async () => {
    let run = makeRun('director-disabled-bundle-run');
    run = repo.updateRun(db, run.id, {
      policy: { ...run.policy, director_mode: 'off' },
    });
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', 'Long shot without 3D', {
      number: 1,
      duration: 8,
      route_profile: 'long_previs_guided',
      previs_mode: 'force',
      transition_mode: 'opening',
      action: 'Complete one continuous walk.',
      visual: 'Stable wide camera.',
      cut_in: 'Opening state.',
      cut_out: 'The walk ends.',
      boundary_prompt: 'Opening shot.',
      video_prompt: 'Complete the walk in eight seconds.',
    });
    const frame = addApproved(run, 'storyboard_images', 'shot', '1', 'Approved storyboard frame', {
      source_artifact_id: shot.id,
    }, [shot.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?')
      .run('images/director-disabled.png', frame.id);
    const plan = addApproved(run, 'director_plan', 'shot', '1', 'Historical director plan', {
      source_artifact_id: shot.id,
      document: createFallbackDirectorDocument(shot.content),
    }, [shot.id]);
    const preview = addApproved(run, 'director_preview', 'shot', '1', 'Historical director preview', {
      source_artifact_id: plan.id,
    }, [plan.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?')
      .run('previews/historical-director.webm', preview.id);

    const service = createProductionMediaService(db, cfg, log, {
      fetchVideoCatalog: async () => routedCatalog(),
    });
    const result = await service.ensureReferenceBundles(run);
    assert.equal(result.state, 'progressed');
    assert.equal(result.artifact.content.routing_receipt.director_mode, 'off');
    assert.equal(result.artifact.content.requires_director_preview, false);
    assert.equal(result.artifact.content.uses_reference_video, false);
    assert.equal(result.artifact.content.limits.videos, 0);
    assert.deepEqual(result.artifact.content.videos, []);
    assert.equal(repo.listUpstreamArtifactIds(db, result.artifact.id).includes(preview.id), false);
  });

  it('warns on unknown strict-first-frame capability and transports a derived frame when available', async () => {
    let run = makeRun('strict-first-frame-run');
    run = repo.updateRun(db, run.id, {
      policy: { ...run.policy, video_model: 'strict-test-model' },
    });
    const resources = [
      addApproved(run, 'asset_text', 'character', 'character-1', 'Silver heroine', {
        name: 'Silver heroine', description: 'silver-haired heroine', visual_prompt: 'identity sheet',
      }),
      addApproved(run, 'asset_text', 'scene', 'scene-1', 'Cyber street', {
        name: 'Cyber street', description: 'fixed neon street', visual_prompt: 'scene sheet',
      }),
      addApproved(run, 'asset_text', 'prop', 'prop-1', 'Peach sword', {
        name: 'Peach sword', description: 'fixed wooden sword', visual_prompt: 'prop sheet',
      }),
    ];
    for (const [index, resource] of resources.entries()) {
      const image = addApproved(run, 'asset_images', resource.scope_type, resource.scope_id, `${resource.title} image`, {
        source_artifact_id: resource.id,
      }, [resource.id]);
      db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?')
        .run(`images/strict-asset-${index + 1}.png`, image.id);
    }
    const shots = [
      addApproved(run, 'storyboard_plan', 'shot', '1', 'Opening', {
        number: 1, duration: 6, action: 'Complete the standoff', visual: 'Wide street',
        video_prompt: 'Complete the standoff and end on a flash.', transition_mode: 'opening',
        cut_in: 'Opening street state', cut_out: 'The talisman flash fills frame',
        boundary_prompt: 'This is the opening shot.', character_names: ['Silver heroine'],
        scene_name: 'Cyber street', prop_names: ['Peach sword'],
      }),
      addApproved(run, 'storyboard_plan', 'shot', '2', 'Strict continuation', {
        number: 2, duration: 7, action: 'Continue the same take', visual: 'Same camera take',
        video_prompt: 'Continue the same motion and complete the sword action.',
        transition_mode: 'strict_continuation', continuous_take_id: 'take-1',
        cut_in: 'Exact prior final frame', cut_out: 'Sword action complete',
        boundary_prompt: 'Use the supplied image as the exact first frame.',
        character_names: ['Silver heroine'], scene_name: 'Cyber street', prop_names: ['Peach sword'],
      }),
    ];
    for (const shot of shots) {
      const image = addApproved(run, 'storyboard_images', 'shot', shot.scope_id, `${shot.title} frame`, {
        source_artifact_id: shot.id,
      }, [shot.id]);
      db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?')
        .run(`images/strict-shot-${shot.scope_id}.png`, image.id);
      const plan = addApproved(run, 'director_plan', 'shot', shot.scope_id, `${shot.title} plan`, {
        source_artifact_id: shot.id, document: createFallbackDirectorDocument(shot.content),
      }, [shot.id]);
      const preview = addApproved(run, 'director_preview', 'shot', shot.scope_id, `${shot.title} preview`, {
        source_artifact_id: plan.id,
      }, [plan.id]);
      db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?')
        .run(`previews/strict-shot-${shot.scope_id}.webm`, preview.id);
    }

    const unsupported = createProductionMediaService(db, cfg, log, {
      fetchVideoCatalog: async () => customVideoCatalog('strict-test-model'),
    });
    const firstBundle = await unsupported.ensureReferenceBundles(run);
    assert.equal(firstBundle.state, 'progressed');
    const previousVideo = addApproved(run, 'shot_video', 'shot', '1', 'Approved opening video', {
      source_artifact_id: shots[0].id,
      bundle_artifact_id: firstBundle.artifact.id,
    }, [shots[0].id, firstBundle.artifact.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?')
      .run('videos/strict-previous.mp4', previousVideo.id);
    const unsupportedBundle = await unsupported.ensureReferenceBundles(repo.getRun(db, run.id));
    assert.equal(unsupportedBundle.state, 'progressed');
    assert.ok(unsupportedBundle.artifact.content.reference_warnings.includes('strict_first_frame_unsupported'));
    assert.ok(unsupportedBundle.artifact.content.reference_warnings.includes('continuity_frame_unavailable'));
    assert.deepEqual(repo.getRun(db, run.id).usage, { video_attempts_reserved: 0, video_seconds_reserved: 0 });

    const requests = [];
    let videoStatus = 'processing';
    let extracted = 0;
    let compared = 0;
    const strictCapability = {
      max_images: 4, max_videos: 3, max_audios: 1, max_total_references: 8,
      duration_min: 5, duration_max: 15, resolution: '720p',
      roles: { image: ['reference', 'first_frame'], video: ['reference'], audio: ['reference'] },
    };
    const supported = createProductionMediaService(db, cfg, log, {
      getVideoCapability: () => strictCapability,
      fetchVideoCatalog: async () => customVideoCatalog('strict-test-model'),
      extractContinuityFrame: async (_path, input) => {
        extracted += 1;
        assert.equal(input.source_artifact_id, previousVideo.id);
        return imageReceipt('production/continuity-frames/strict.png');
      },
      validateContinuityFrame: async () => imageReceipt('production/continuity-frames/strict.png'),
      createVideo: async (request) => {
        requests.push(structuredClone(request));
        return { id: 902, task_id: 'strict-video-task' };
      },
      getVideo: async () => ({
        id: 902, task_id: 'strict-video-task', status: videoStatus,
        local_path: 'videos/strict-result.mp4',
      }),
      validateVideo: async () => videoReceipt('videos/strict-result.mp4'),
      compareStrictFirstFrame: async (expectedPath, generatedPath) => {
        compared += 1;
        assert.equal(expectedPath, 'production/continuity-frames/strict.png');
        assert.equal(generatedPath, 'videos/strict-result.mp4');
        return { mode: 'strict_continuation', similarity: 0.98, threshold: 0.9, passed: true };
      },
    });

    const supportedFirstPass = await supported.ensureReferenceBundles(repo.getRun(db, run.id));
    assert.equal(supportedFirstPass.state, 'progressed');
    const strictBundle = supportedFirstPass;
    assert.equal(extracted, 1);
    assert.equal(strictBundle.artifact.content.images.length, 4);
    assert.equal(strictBundle.artifact.content.images[0].role, 'first_frame');
    assert.equal(strictBundle.artifact.content.images[0].locked, true);
    const continuityFrame = repo.getArtifact(db, strictBundle.artifact.content.strict_first_frame_artifact_id);
    assert.equal(continuityFrame.stage, 'continuity_frame');
    assert.deepEqual(repo.listUpstreamArtifactIds(db, continuityFrame.id), [shots[1].id, previousVideo.id].sort((a, b) => a - b));
    assert.equal(repo.listUpstreamArtifactIds(db, strictBundle.artifact.id).includes(continuityFrame.id), true);
    repo.reviewArtifact(db, strictBundle.artifact.id, {
      reviewer_type: 'human',
      decision: 'approved',
      reason: 'Approve strict first-frame reference package',
    });

    const submitted = await supported.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(submitted.state, 'waiting_provider');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].first_frame_url, 'production/continuity-frames/strict.png');
    assert.equal(requests[0].reference_image_urls.length, 3);
    assert.equal(requests[0].reference_image_urls.includes(requests[0].first_frame_url), false);
    assert.match(requests[0].prompt, /^【镜头边界，最高优先级】\nUse the supplied image as the exact first frame\./);
    assert.match(requests[0].prompt, /参考图1「Strict continuation predecessor tail frame」：严格首帧/);
    videoStatus = 'completed';
    const completed = await supported.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(completed.state, 'progressed');
    assert.equal(compared, 1);
    assert.equal(completed.artifact.content.boundary_validation.passed, true);
  });

  it('executes the bounded Seedance 2.5 to 2.0 parent/child fallback chain exactly once', async () => {
    const run = makeRun('seedance-parent-child-fallback', {
      video_routing_mode: 'auto', video_model: 'seedance-2.5-720p',
      video_fallback_model: 'seedance2.0 -720p-fast-15s',
      video_group: '特价视频分组(即梦)', allow_auto_model_switch: true, director_mode: 'off',
    });
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', 'Fallback shot', {
      number: 1, duration: 20, action: '保持连续动作', visual: '稳定中景',
      video_prompt: 'One continuous action beat.', previs_mode: 'skip', transition_mode: 'opening',
    });
    const frame = addApproved(run, 'storyboard_images', 'shot', '1', 'Fallback frame', {
      source_artifact_id: shot.id,
    }, [shot.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?').run('images/fallback.png', frame.id);
    const requests = [];
    const states = new Map();
    let nextId = 2000;
    let mergeCalls = 0;
    const model25 = 'seedance-2.5-720p';
    const model20 = 'seedance2.0 -720p-fast-15s';
    const catalogItem = (model, capability, price) => ({
      model, endpoint_types: ['openai-video'], groups: ['特价视频分组(即梦)'], capabilities: capability,
      prices: [{ group: '特价视频分组(即梦)', billing_unit: 'per_request', effective_price: price }],
    });
    const service = createProductionMediaService(db, cfg, log, {
      fetchVideoCatalog: async () => ({ pricing_version: 'fallback-test-v1', fetched_at: new Date().toISOString(), video: [
        catalogItem(model25, getYinziVideoCapability(model25), 3.5),
      ] }),
      createVideo: async (request) => {
        requests.push(structuredClone(request));
        nextId += 1;
        states.set(nextId, {
          status: request.model === model25 ? 'failed' : 'completed',
          model: request.model,
        });
        return { id: nextId, task_id: `fallback-task-${nextId}`, model: request.model };
      },
      getVideo: async (id) => ({
        id, task_id: `fallback-task-${id}`, ...states.get(id),
        local_path: `videos/fallback-${id}.mp4`, video_url: `videos/fallback-${id}.mp4`,
        submission_status: states.get(id)?.status === 'failed' ? 'rejected' : 'accepted',
        error_msg: states.get(id)?.status === 'failed' ? 'model unavailable' : null,
      }),
      validateVideo: async (mediaPath) => videoReceipt(mediaPath),
      extractContinuityFrame: async () => ({ relative_path: 'production/fallback-tail.png', sha256: 'c'.repeat(64) }),
      mergeVideoSegments: async (paths) => {
        mergeCalls += 1;
        assert.equal(paths.length, 2);
        return { relative_path: 'videos/fallback-merged.mp4', absolute_path: 'C:/storage/videos/fallback-merged.mp4' };
      },
    });
    const bundle = await service.ensureReferenceBundles(run);
    repo.reviewArtifact(db, bundle.artifact.id, { reviewer_type: 'human', decision: 'approved', reason: 'fallback fixture' });
    assert.equal((await service.ensureShotVideos(repo.getRun(db, run.id))).state, 'waiting_provider');
    const afterFailure = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(afterFailure.state, 'waiting_provider');
    assert.deepEqual(requests.map((item) => [item.model, item.duration]), [[model25, 30], [model20, 15]]);
    const afterA = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(afterA.state, 'waiting_provider');
    assert.deepEqual(requests.map((item) => [item.model, item.duration]), [[model25, 30], [model20, 15], [model20, 15]]);
    const done = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(done.state, 'progressed');
    assert.equal(done.reason, 'video_fallback_converged');
    assert.equal(mergeCalls, 1);
    assert.equal(requests.length, 3);
    const actions = repo.listActions(db, run.id, { page_size: 200 }).items;
    const children = actions.filter((item) => item.parent_action_id);
    assert.equal(children.length, 2);
    assert.deepEqual(children.map((item) => item.segment_index).sort(), [1, 2]);
    assert.equal(repo.getRun(db, run.id).runtime.fallback_reserved_microusd, 0);
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'shot_video', current: true, page_size: 20 }).items.length, 1);
  });

  it('keeps explicit local cancellation local and releases only an unsubmitted reservation', async () => {
    const run = makeRun('cancel-local-reserved');
    const reserved = repo.reserveAction(db, {
      run_id: run.id, action_key: 'local-cancel-a1', stage: 'shot_video',
      scope_type: 'shot', scope_id: '1', kind: 'video_generate', attempt: 1,
      request: { model: 'manual-video' }, reserved_video_seconds: 5,
    }).action;
    let cancelCalls = 0;
    const service = createProductionMediaService(db, cfg, log, {
      cancelProviderTask: async () => { cancelCalls += 1; return { cancelled: true }; },
    });
    const result = await service.cancelRunAction(run.id, {
      action_id: reserved.id, cancel_mode: 'cancel_local_request', reason: '先看历史记录',
    });
    assert.equal(result.status, 'cancelled_local');
    assert.equal(cancelCalls, 0);
    assert.equal(repo.getAction(db, reserved.id).status, 'cancelled');
    assert.equal(db.prepare('SELECT status FROM cost_ledger WHERE action_id = ?').get(reserved.id), undefined);
    const repeated = await service.cancelRunAction(run.id, {
      action_id: reserved.id, cancel_mode: 'cancel_local_request',
    });
    assert.equal(repeated.status, 'cancelled');
    assert.equal(cancelCalls, 0);
  });

  it('stops local observation for an accepted task without polling or releasing its charge', async () => {
    const run = makeRun('cancel-local-accepted');
    const accepted = repo.reserveAction(db, {
      run_id: run.id, action_key: 'local-cancel-accepted-a1', stage: 'shot_video',
      scope_type: 'shot', scope_id: '1', kind: 'video_generate', attempt: 1,
      request: { model: 'manual-video' }, reserved_video_seconds: 5,
    }).action;
    repo.updateAction(db, accepted.id, {
      status: 'waiting', task_id: 'provider-task-1', generation_id: 91, provider_id: 'provider-task-1',
    });
    let pollCalls = 0;
    const service = createProductionMediaService(db, cfg, log, {
      getVideo: async () => { pollCalls += 1; return { id: 91, status: 'processing' }; },
    });
    const result = await service.cancelRunAction(run.id, {
      action_id: accepted.id, cancel_mode: 'cancel_local_request', reason: '停止当前页面等待',
    });
    assert.equal(result.status, 'local_observation_stopped');
    assert.equal(result.billable_status, 'uncertain');
    assert.equal(repo.getAction(db, accepted.id).status, 'waiting');
    assert.equal(repo.getAction(db, accepted.id).result.local_observation_stopped, true);
    assert.equal(repo.getAction(db, accepted.id).provider_id, 'provider-task-1');
    assert.equal(pollCalls, 0);
    const repeated = await service.cancelRunAction(run.id, { action_id: accepted.id, cancel_mode: 'cancel_local_request' });
    assert.equal(repeated.status, 'local_observation_stopped');
    assert.equal(pollCalls, 0);
  });

  it('calls the provider adapter only through explicit provider cancellation and remains truthful on failure', async () => {
    const run = makeRun('cancel-provider-explicit');
    const accepted = repo.reserveAction(db, {
      run_id: run.id, action_key: 'provider-cancel-a1', stage: 'shot_video',
      scope_type: 'shot', scope_id: '1', kind: 'video_generate', attempt: 1,
      request: { model: 'manual-video' }, reserved_video_seconds: 5,
    }).action;
    repo.updateAction(db, accepted.id, {
      status: 'waiting', task_id: 'provider-task-2', generation_id: 92, provider_id: 'provider-task-2',
    });
    let calls = 0;
    const service = createProductionMediaService(db, cfg, log, {
      cancelProviderTask: async ({ provider_task_id }) => {
        calls += 1;
        assert.equal(provider_task_id, 'provider-task-2');
        throw new Error('provider cancel endpoint unavailable');
      },
    });
    const result = await service.cancelRunAction(run.id, {
      action_id: accepted.id, cancel_mode: 'cancel_provider_task', reason: '供应商任务过久',
    });
    assert.equal(result.status, 'cancel_requested_provider_unknown');
    assert.equal(result.billable_status, 'uncertain');
    assert.equal(calls, 1);
    assert.equal(repo.getAction(db, accepted.id).status, 'waiting');
    assert.equal(repo.getAction(db, accepted.id).result.cancel_requested_provider_unknown, true);
    const repeated = await service.cancelRunAction(db ? run.id : run.id, {
      action_id: accepted.id, cancel_mode: 'cancel_provider_task',
    });
    assert.equal(repeated.status, 'cancel_requested_provider_unknown');
    assert.equal(calls, 1);
  });

  it('does not poll a provider-cancelled action when the shot runner is re-entered', async () => {
    const run = makeRun('cancel-provider-no-poll', {
      video_routing_mode: 'fixed', video_model: 'manual-video', director_mode: 'off',
    });
    const shot = addApproved(run, 'storyboard_plan', 'shot', '1', 'Cancelled shot', {
      number: 1, duration: 5, action: 'Hold', visual: 'Static', video_prompt: 'Hold still.',
      previs_mode: 'skip', transition_mode: 'opening', character_names: [], prop_names: [],
    });
    const frame = addApproved(run, 'storyboard_images', 'shot', '1', 'Cancelled frame', {
      source_artifact_id: shot.id,
    }, [shot.id]);
    db.prepare('UPDATE production_artifacts SET media_path = ? WHERE id = ?').run('images/cancelled.png', frame.id);
    const bundle = await createProductionMediaService(db, cfg, log, {
      fetchVideoCatalog: async () => customVideoCatalog('manual-video'),
    }).ensureReferenceBundles(run);
    repo.reviewArtifact(db, bundle.artifact.id, { reviewer_type: 'human', decision: 'approved', reason: 'cancel test' });
    const action = repo.reserveAction(db, {
      run_id: run.id, action_key: 'shot_video:1:generate:a1', stage: 'shot_video',
      scope_type: 'shot', scope_id: '1', kind: 'video_generate', attempt: 1,
      request: { model: 'manual-video', source_artifact_id: shot.id, bundle_artifact_id: bundle.artifact.id,
        routing_receipt: { model: 'manual-video', duration: 5 } }, reserved_video_seconds: 5,
    }).action;
    repo.updateAction(db, action.id, {
      status: 'waiting', task_id: 'provider-task-3', generation_id: 93, provider_id: 'provider-task-3',
      result: { source_artifact_id: shot.id, bundle_artifact_id: bundle.artifact.id,
        local_observation_stopped: true },
    });
    let polls = 0;
    const service = createProductionMediaService(db, cfg, log, {
      fetchVideoCatalog: async () => customVideoCatalog('manual-video'),
      getVideo: async () => { polls += 1; return { id: 93, status: 'processing' }; },
    });
    const result = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(result.state, 'waiting_review');
    assert.equal(result.reason, 'local_observation_stopped');
    assert.equal(polls, 0);
  });
});
