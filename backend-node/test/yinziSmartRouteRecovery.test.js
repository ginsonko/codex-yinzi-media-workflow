const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const Database = require('better-sqlite3');
const videoClient = require('../src/services/videoClient');
const videoService = require('../src/services/videoService');
const recovery = require('../src/services/yinziSmartRouteRecovery');
const { getYinziVideoCapability } = require('../src/services/yinziVideoCapabilities');

const log = { info() {}, warn() {}, error() {} };

function rejected(overrides = {}) {
  return {
    error: 'YinziAPI 视频请求失败: HTTP 400 - no eligible automatic route for this model',
    submission_status: 'rejected',
    submission_http_status: 400,
    submission_receipt: {
      status: 'rejected',
      error_code: 'get_channel_failed',
      message: 'no eligible automatic route for this model',
    },
    ...overrides,
  };
}

function deterministic503(overrides = {}) {
  return {
    error: 'YinziAPI 视频请求失败: HTTP 503 - smartrouter: no eligible automatic route',
    submission_status: 'ambiguous',
    submission_http_status: 503,
    submission_receipt: {
      status: 'ambiguous',
      http_status: 503,
      error_code: 'get_channel_failed',
      message: 'YinziAPI 视频请求失败: HTTP 503 - smartrouter: no eligible automatic route',
    },
    ...overrides,
  };
}

function createDb(snapshot) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE video_generations (
      id INTEGER PRIMARY KEY,
      model TEXT,
      provider_protocol TEXT,
      provider_config_snapshot_json TEXT,
      updated_at TEXT
    );
  `);
  db.prepare(
    `INSERT INTO video_generations (id, model, provider_protocol, provider_config_snapshot_json, updated_at)
     VALUES (1, 'seedance2.0 720p-pro-nv-nsp', 'yinzi', ?, ?)`
  ).run(JSON.stringify(snapshot), new Date().toISOString());
  return db;
}

function smartConfig(snapshot) {
  return {
    id: 9,
    provider: 'yinzi',
    api_protocol: 'yinzi',
    base_url: 'https://api.yinziapi.top/v1',
    endpoint: '/videos',
    query_endpoint: '/videos/{taskId}',
    default_model: 'seedance2.0 720p-pro-nv-nsp',
    model: ['seedance2.0 720p-pro-nv-nsp', 'grok-imagine-video'],
    settings: JSON.stringify({
      routing_mode: 'smart',
      smart_routing_enabled: true,
      model_catalog_snapshot: snapshot.model_catalog_snapshot,
    }),
  };
}

function candidateSnapshot() {
  return {
    routing_mode: 'smart',
    smart_routing: true,
    smart_routing_enabled: true,
    automatic_route: true,
    requested_model_explicit: false,
    model: 'seedance2.0 720p-pro-nv-nsp',
    model_catalog_snapshot: {
      models: [
        {
          model: 'seedance2.0 720p-pro-nv-nsp',
          endpoint_types: ['openai-video'],
          credential_verified: false,
          automatic_eligible: true,
          capabilities: getYinziVideoCapability('seedance2.0 720p-pro-nv-nsp'),
        },
        {
          model: 'grok-imagine-video',
          endpoint_types: ['openai-video'],
          credential_verified: true,
          automatic_eligible: true,
          capabilities: getYinziVideoCapability('grok-imagine-video'),
        },
        {
          model: '破甲seedance 720p-fast',
          endpoint_types: ['openai-video'],
          credential_verified: true,
          automatic_eligible: false,
          expensive_bypass: true,
          capabilities: getYinziVideoCapability('破甲seedance 720p-fast'),
        },
      ],
    },
  };
}

describe('Yinzi smart route recovery classifier', () => {
  it('classifies only explicit provider failures as fallback-eligible', () => {
    assert.equal(recovery.classifyFallbackFailure({ code: 'MODEL_UNAVAILABLE', message: 'model is down' }), 'model_unavailable');
    assert.equal(recovery.classifyFallbackFailure({ code: 'CAPABILITY_MISMATCH', message: 'reference video not supported' }), 'capability_mismatch');
    assert.equal(recovery.classifyFallbackFailure({ code: 'PARAMETER_REJECTED', message: 'invalid duration' }), 'parameter_rejected');
    assert.equal(recovery.classifyFallbackFailure({ code: 'CONTENT_MODERATION_REJECTED', message: 'content policy' }), 'moderation_rejected');
    assert.equal(recovery.classifyFallbackFailure({ code: 'ETIMEDOUT', message: 'network timeout' }), 'ambiguous_external');
    assert.equal(recovery.isFallbackEligibleFailure({ code: 'HTTP_500', message: 'temporary upstream error' }), false);
  });

  it('never switches a fixed model unless a shot explicitly opts into fallback', () => {
    const failure = { code: 'MODEL_UNAVAILABLE', message: 'model down' };
    assert.equal(recovery.canAutomaticallyFallback({ selection_mode: 'project_fixed', policy: { allow_auto_model_switch: true }, failure }), false);
    assert.equal(recovery.canAutomaticallyFallback({ selection_mode: 'shot_override', policy: { allow_auto_model_switch: true }, failure }), false);
    assert.equal(recovery.canAutomaticallyFallback({ selection_mode: 'shot_override', allow_shot_fallback: true, policy: {}, failure }), true);
    assert.equal(recovery.canAutomaticallyFallback({ selection_mode: 'auto', policy: { allow_auto_model_switch: true }, failure }), true);
  });

  it('plans a bounded 2.5 to 2x15 fallback with a stable parent and segment keys', () => {
    const plan = recovery.planSeedanceFallback({
      runId: 'run-1', shotId: '3', parentActionKey: 'shot_video:shot:3:a1',
      fromModel: 'seedance-2.5-720p', fallbackModel: 'Seedance 2.0-720',
      failure: { code: 'MODEL_UNAVAILABLE', message: 'model down' },
    });
    assert.equal(plan.eligible, true);
    assert.equal(plan.provider_duration_seconds, 30);
    assert.equal(plan.worst_case_cost, 9.5);
    assert.deepEqual(plan.segments.map((item) => item.duration), [15, 15]);
    assert.equal(plan.segments[1].depends_on_segment, 1);
    assert.equal(recovery.nextFallbackSegment(plan, []), plan.segments[0]);
    assert.equal(recovery.nextFallbackSegment(plan, [plan.segments[0]]), plan.segments[1]);
    assert.equal(recovery.nextFallbackSegment(plan, [1, 2]), null);
  });

  it('does not create a fallback plan for ambiguous results or unrelated models', () => {
    const ambiguous = recovery.planSeedanceFallback({
      fromModel: 'seedance-2.5-720p', fallbackModel: 'Seedance 2.0-720',
      failure: { code: 'HTTP_503', message: 'temporary upstream error', ambiguous: true },
    });
    assert.equal(ambiguous.eligible, false);
    const unrelated = recovery.planSeedanceFallback({
      fromModel: 'grok-imagine-video', fallbackModel: 'Seedance 2.0-720',
      failure: { code: 'MODEL_UNAVAILABLE', message: 'model down' },
    });
    assert.equal(unrelated.eligible, false);
  });

  it('treats a missing provider snapshot as an empty advisory snapshot', () => {
    assert.doesNotThrow(() => recovery.isSmartRoutingEnabled(smartConfig(candidateSnapshot()), null));
    assert.equal(recovery.isSmartRoutingEnabled(smartConfig(candidateSnapshot()), null), true);
    assert.equal(recovery.isAutomaticRouteRequest(
      smartConfig(candidateSnapshot()), { model: '' }, null
    ), true);
  });

  it('accepts only the deterministic no-channel rejection', () => {
    assert.equal(recovery.isDeterministicNoEligibleAutomaticRoute(rejected()), true);
    assert.equal(recovery.isDeterministicNoEligibleAutomaticRoute(deterministic503()), true);
    assert.equal(recovery.isDeterministicNoEligibleAutomaticRoute(rejected({
      submission_status: 'ambiguous',
      submission_receipt: { status: 'ambiguous', error_code: 'get_channel_failed', message: 'no eligible automatic route' },
    })), false);
    assert.equal(recovery.isDeterministicNoEligibleAutomaticRoute(rejected({
      task_id: 'provider-task-1',
    })), false);
    assert.equal(recovery.isDeterministicNoEligibleAutomaticRoute(deterministic503({
      error: 'HTTP 503 temporary upstream error',
      submission_receipt: { status: 'ambiguous', http_status: 503, error_code: 'temporary_error', message: 'temporary upstream error' },
    })), false);
    assert.equal(recovery.isDeterministicNoEligibleAutomaticRoute(deterministic503({
      task_id: 'provider-task-1',
    })), false);
  });

  it('selects only a verified compatible non-bypass candidate', () => {
    const snapshot = candidateSnapshot();
    const candidate = recovery.selectVerifiedFallbackModel({
      config: smartConfig(snapshot),
      row: { duration: 5, reference_image_urls: '[]', reference_video_urls: '[]', reference_audio_urls: '[]' },
      snapshot,
      duration: 5,
      currentModel: 'seedance2.0 720p-pro-nv-nsp',
    });
    assert.equal(candidate.model, 'grok-imagine-video');
  });
});

describe('Yinzi smart route recovery submission boundary', () => {
  it('retries exactly once with the verified alternate and preserves request materials', async () => {
    const snapshot = candidateSnapshot();
    const db = createDb(snapshot);
    const config = smartConfig(snapshot);
    const row = {
      id: 1,
      model: 'seedance2.0 720p-pro-nv-nsp',
      provider_config_snapshot_json: JSON.stringify(snapshot),
      reference_image_urls: JSON.stringify(['assets/character.png']),
      reference_video_urls: JSON.stringify([]),
      reference_audio_urls: JSON.stringify([]),
      first_frame_url: null,
      last_frame_url: null,
    };
    const calls = [];
    const original = videoClient.callVideoApi;
    videoClient.callVideoApi = async (_db, _log, options) => {
      calls.push({ model: options.model, prompt: options.prompt, duration: options.duration,
        aspect_ratio: options.aspect_ratio, resolution: options.resolution,
        reference_urls: options.reference_urls, reference_video_urls: options.reference_video_urls,
        reference_audio_urls: options.reference_audio_urls });
      return calls.length === 1 ? rejected() : {
        task_id: 'grok-task-1', submission_status: 'accepted',
        submission_receipt: { status: 'accepted', request_id: 'grok-task-1' },
      };
    };
    try {
      const result = await videoService._callVideoApiWithSmartRecovery(db, log, row, config, {
        model: row.model,
        prompt: 'same prompt',
        duration: 7,
        aspect_ratio: '9:16',
        resolution: '720p',
        reference_urls: ['assets/character.png'],
        reference_video_urls: [],
        reference_audio_urls: [],
        provider_config_snapshot: snapshot,
      });
      assert.equal(calls.length, 2);
      assert.equal(calls[0].model, 'seedance2.0 720p-pro-nv-nsp');
      assert.equal(calls[1].model, 'grok-imagine-video');
      assert.deepEqual(calls[1].prompt, calls[0].prompt);
      assert.deepEqual(calls[1].duration, calls[0].duration);
      assert.deepEqual(calls[1].aspect_ratio, calls[0].aspect_ratio);
      assert.deepEqual(calls[1].resolution, calls[0].resolution);
      assert.deepEqual(calls[1].reference_urls, calls[0].reference_urls);
      assert.deepEqual(calls[1].reference_video_urls, calls[0].reference_video_urls);
      assert.deepEqual(calls[1].reference_audio_urls, calls[0].reference_audio_urls);
      assert.equal(result.model, 'grok-imagine-video');
      assert.equal(result.result.task_id, 'grok-task-1');
      assert.equal(result.recovery.from_model, 'seedance2.0 720p-pro-nv-nsp');
      assert.equal(result.recovery.to_model, 'grok-imagine-video');
      const saved = db.prepare('SELECT model, provider_config_snapshot_json FROM video_generations WHERE id = 1').get();
      assert.equal(saved.model, 'grok-imagine-video');
      assert.equal(JSON.parse(saved.provider_config_snapshot_json).smart_route_recovery_attempted, true);
    } finally {
      videoClient.callVideoApi = original;
      db.close();
    }
  });

  it('does not replace an explicitly selected model or retry an ambiguous result', async () => {
    const snapshot = { ...candidateSnapshot(), requested_model_explicit: true, automatic_route: false };
    const db = createDb(snapshot);
    const config = smartConfig(snapshot);
    const row = { id: 1, model: 'seedance2.0 720p-pro-nv-nsp', provider_config_snapshot_json: JSON.stringify(snapshot) };
    const original = videoClient.callVideoApi;
    let calls = 0;
    videoClient.callVideoApi = async () => { calls += 1; return rejected(); };
    try {
      const result = await videoService._callVideoApiWithSmartRecovery(db, log, row, config, {
        model: row.model, prompt: 'manual', duration: 5, provider_config_snapshot: snapshot,
      });
      assert.equal(calls, 1);
      assert.equal(result.model, row.model);
    } finally {
      videoClient.callVideoApi = original;
      db.close();
    }
  });
});
