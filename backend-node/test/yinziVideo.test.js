const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfigService = require('../src/services/aiConfigService');
const { getFfmpegPath, hasLocalFfmpeg, hasLocalFfprobe } = require('../src/utils/ffmpegPath');
const {
  buildYinziVideoRequest,
  buildYinziReferences,
  extractYinziVideoUrl,
  buildYinziPollUrl,
  buildYinziContentUrl,
  buildProviderConfigSnapshot,
  applyProviderConfigSnapshot,
  resolveYinziCapabilityContext,
  callYinziVideoApi,
  callVideoApi,
  pollVideoTask,
  formatVideoPostBodyForLog,
  normalizeYinziAssetPromptReceipt,
} = require('../src/services/videoClient');

const log = { info() {}, warn() {}, error() {} };
const mediaToolsAvailable = hasLocalFfmpeg() && hasLocalFfprobe();

function makeReferenceVideo(filePath, codec = 'libx264', fps = 24, duration = 1) {
  const result = spawnSync(getFfmpegPath(), [
    '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x24636b:s=320x180:r=${fps}:d=${duration}`,
    '-c:v', codec, '-pix_fmt', 'yuv420p', '-r', String(fps), '-an', '-y', filePath,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

describe('YinziAPI video request mapping', () => {
  it('preserves opaque model names and reference role order', () => {
    const references = buildYinziReferences(
      { reference_urls: ['a', 'b'] },
      { references: ['https://cdn/a.png', 'https://cdn/b.png'] }
    );
    const body = buildYinziVideoRequest({
      model: 'mg-seedance2.0 -480p mini',
      prompt: 'A slow dolly in',
      duration: 5,
      aspect_ratio: '9:16',
      references,
    });
    assert.equal(body.model, 'mg-seedance2.0 -480p mini');
    assert.equal(body.duration, 5);
    assert.equal(body.seconds, 5);
    assert.deepEqual(body.references.map((ref) => ref.role), ['reference', 'reference']);
  });

  it('maps a single first frame to a generic reference and clamps AIZZZ Seedance to five seconds', () => {
    const refs = buildYinziReferences(
      { model: 'mg-seedance2.0 -480p mini', first_frame_url: 'first' },
      { first: 'https://cdn/first.png' }
    );
    const body = buildYinziVideoRequest({
      model: 'mg-seedance2.0 -480p mini', prompt: 'move', duration: 4, references: refs,
    });
    assert.deepEqual(refs, [{ type: 'image', role: 'reference', url: 'https://cdn/first.png' }]);
    assert.equal(body.seconds, 5);
    assert.equal(body.duration, 5);
  });

  it('uses the fixed thirty-second execution unit for Seedance 2.5 direct submissions', () => {
    const body = buildYinziVideoRequest({
      model: 'seedance-2.5-720p', prompt: 'safe short beat', duration: 4, references: [],
    });
    assert.equal(body.seconds, 30);
    assert.equal(body.duration, 30);
    assert.equal(buildYinziVideoRequest({
      model: 'seedance-2.5-720p', prompt: 'safe short beat', duration: 0, references: [],
    }).seconds, 30);
    assert.equal(buildYinziVideoRequest({
      model: 'seedance-2.5-720p', prompt: 'safe short beat', duration: 16, references: [],
    }).seconds, 30);
  });

  it('maps classic first and last frames without mixing generic references', () => {
    const refs = buildYinziReferences(
      { first_frame_url: 'first', last_frame_url: 'last' },
      { first: 'https://cdn/first.png', last: 'https://cdn/last.png' }
    );
    assert.deepEqual(refs, [
      { type: 'image', role: 'first_frame', url: 'https://cdn/first.png' },
      { type: 'image', role: 'last_frame', url: 'https://cdn/last.png' },
    ]);
  });

  it('preserves typed file references and clamps the target duration to fifteen seconds', () => {
    const refs = buildYinziReferences(
      {
        model: 'mg-seedance2.0 -480p mini',
        reference_urls: ['image'],
        reference_video_urls: ['video'],
        reference_audio_urls: ['audio'],
      },
      {
        images: [{ file_id: 'file-image' }],
        videos: [{ file_id: 'file-video' }],
        audios: [{ file_id: 'file-audio' }],
      }
    );
    const body = buildYinziVideoRequest({
      model: 'mg-seedance2.0 -480p mini', prompt: 'move', duration: 99, references: refs,
    });
    assert.equal(body.seconds, 15);
    assert.deepEqual(body.references, [
      { type: 'image', role: 'reference', file_id: 'file-image' },
      { type: 'video', role: 'reference', file_id: 'file-video' },
      { type: 'audio', role: 'reference', file_id: 'file-audio' },
    ]);
  });

  it('redacts base64 reference bytes in request logs', () => {
    const formatted = formatVideoPostBodyForLog({
      references: [{ type: 'image', role: 'first_frame', url: 'data:image/png;base64,' + 'A'.repeat(100) }],
    });
    assert.match(formatted.references[0].url, /^\(base64, \d+ chars\)$/);
    const typed = formatVideoPostBodyForLog({
      references: [{ type: 'image', role: 'reference', data_url: 'data:image/png;base64,' + 'B'.repeat(80), file_id: 'private-id' }],
    });
    assert.match(typed.references[0].data_url, /^\(base64, \d+ chars\)$/);
    assert.equal(typed.references[0].file_id, '(site file reference)');
  });

  it('preserves explicit first and last frame roles when the model capability is unknown', () => {
    const refs = buildYinziReferences(
      {
        model: 'future-video-model',
        first_frame_url: 'first',
        last_frame_url: 'last',
        reference_urls: ['storyboard'],
      },
      {
        first: 'https://cdn/first.png',
        last: 'https://cdn/last.png',
        images: ['https://cdn/storyboard.png'],
      },
      null
    );
    assert.deepEqual(refs.map((item) => item.role), ['first_frame', 'reference', 'last_frame']);
  });
});

describe('YinziAPI asynchronous lifecycle', () => {
  it('freezes model-specific create, query, and content paths into one task protocol snapshot', () => {
    const config = {
      id: 17,
      provider: 'yinzi',
      api_protocol: 'yinzi',
      base_url: 'https://api.yinziapi.top/v1',
      endpoint: '/videos',
      query_endpoint: '/videos/{taskId}',
      settings: JSON.stringify({
        model_catalog_snapshot: {
          models: [{
            model: 'new-task-video',
            provider_contract: 'newapi-video-generations-v1',
            provider_create_path: '/video/generations',
            provider_query_path: '/video/generations/{taskId}',
            provider_content_path: '/video/generations/{taskId}/content',
          }],
        },
      }),
    };
    const snapshot = buildProviderConfigSnapshot(config, 'new-task-video');
    assert.equal(snapshot.provider_contract, 'newapi-video-generations-v1');
    assert.equal(snapshot.endpoint, '/video/generations');
    assert.equal(snapshot.query_endpoint, '/video/generations/{taskId}');
    assert.equal(snapshot.content_endpoint, '/video/generations/{taskId}/content');
    assert.equal(snapshot.protocol_source, 'model_catalog_snapshot');

    const frozen = applyProviderConfigSnapshot({ ...config, endpoint: '/changed-after-submit' }, snapshot);
    assert.equal(buildYinziPollUrl(frozen, 'task 123'), 'https://api.yinziapi.top/v1/video/generations/task%20123');
    assert.equal(buildYinziContentUrl(frozen, 'task 123'), 'https://api.yinziapi.top/v1/video/generations/task%20123/content');
  });

  it('freezes a dynamic contract and marks the bounded builtin fallback when a known model contract is missing', () => {
    const dynamicCapability = {
      duration_mode: 'range', duration_min: 6, duration_max: 12,
      max_images: 30, max_videos: 2, max_audios: 1, max_total_references: 33,
      roles: { image: ['reference', 'first_frame'], video: ['reference'], audio: ['reference'] },
    };
    const config = {
      id: 19,
      provider: 'yinzi',
      api_protocol: 'yinzi',
      base_url: 'https://api.yinziapi.top/v1',
      settings: JSON.stringify({
        model_catalog_snapshot: {
          models: [{
            model: 'mg-seedance2.0 -480p mini',
            capabilities: dynamicCapability,
            capability_source: 'key_scoped_contract',
            contract_status: 'active',
            catalog_verified: true,
          }],
        },
      }),
    };
    const snapshot = buildProviderConfigSnapshot(config, 'mg-seedance2.0 -480p mini');
    assert.deepEqual(snapshot.capability_snapshot, dynamicCapability);
    assert.equal(snapshot.capability_source, 'key_scoped_contract');
    assert.equal(snapshot.catalog_verified, true);

    const explicitUnknown = resolveYinziCapabilityContext(config, 'mg-seedance2.0 -480p mini', {
      capability_model: 'mg-seedance2.0 -480p mini',
      capability_snapshot: null,
      capability_source: 'key_scoped_contract',
      contract_status: 'missing',
      catalog_verified: true,
    });
    assert.equal(explicitUnknown.capability.duration_mode, 'range');
    assert.equal(explicitUnknown.contract_status, 'missing');
    assert.equal(explicitUnknown.capability_source, 'builtin_legacy_fallback');
    assert.equal(explicitUnknown.resolution_source, 'builtin_legacy_fallback');
    assert.deepEqual(explicitUnknown.contract_warnings, ['unknown_contract', 'legacy_capability_fallback']);

    const wrongModel = resolveYinziCapabilityContext({}, 'another-video-model', snapshot);
    assert.equal(wrongModel.capability, null);
    assert.equal(wrongModel.resolution_source, 'unknown');
  });

  it('uses the exact Yinzi display alias as a fixed thirty-second unit without claiming a server contract', async () => {
    const context = resolveYinziCapabilityContext({}, 'Seedance 2.5-720', {
      capability_model: 'Seedance 2.5-720',
      capability_snapshot: null,
      capability_source: 'unknown',
      contract_status: 'missing',
      catalog_verified: true,
    });
    assert.equal(context.capability.fixed_duration_seconds, 30);
    assert.equal(context.contract_status, 'missing');
    assert.equal(context.capability_source, 'builtin_legacy_fallback');
    assert.ok(context.contract_warnings.includes('unknown_contract'));

    const originalFetch = global.fetch;
    let submittedBody;
    global.fetch = async (_url, init) => {
      submittedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'display-alias-task', status: 'queued' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'test-only', endpoint: '/videos',
      }, log, {
        model: 'Seedance 2.5-720', prompt: 'bounded alias test', duration: 60,
        contract_validation_mode: 'advisory',
        capability_context: {
          capability_model: 'Seedance 2.5-720', capability_snapshot: null,
          capability_source: 'unknown', contract_status: 'missing', catalog_verified: true,
        },
      });
      assert.equal(result.task_id, 'display-alias-task');
      assert.equal(submittedBody.duration, 30);
      assert.equal(submittedBody.seconds, 30);
      assert.equal(result.contract_validation.contract_status, 'missing');
      assert.equal(result.contract_validation.capability_source, 'builtin_legacy_fallback');
      assert.ok(result.contract_validation.warnings.includes('legacy_capability_fallback'));
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('uses a catalog snapshot exposed at the normalized config top level', () => {
    const capability = {
      duration_mode: 'range', duration_min: 5, duration_max: 15,
      max_images: 30, max_videos: 0, max_audios: 10,
      roles: { image: ['reference'], video: [], audio: ['reference'] },
    };
    const config = {
      id: 20,
      provider: 'yinzi',
      api_protocol: 'yinzi',
      base_url: 'https://api.yinziapi.top/v1',
      settings: JSON.stringify({ routing_mode: 'smart' }),
      model_catalog_snapshot: {
        models: [{
          model: 'seedance-2.5-720p',
          capabilities: capability,
          capability_source: 'key_scoped_contract',
          contract_status: 'active',
          catalog_verified: true,
        }],
      },
    };
    const snapshot = buildProviderConfigSnapshot(config, 'seedance-2.5-720p');
    assert.deepEqual(snapshot.capability_snapshot, capability);
    assert.deepEqual(snapshot.model_catalog_snapshot, config.model_catalog_snapshot);
    assert.equal(snapshot.capability_source, 'key_scoped_contract');
    assert.equal(snapshot.catalog_verified, true);
  });

  it('uses the frozen dynamic capability for duration, role mapping, limits, and receipt truth', async () => {
    const db = new Database(':memory:');
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try { runMigrationsAndEnsure(db); } finally { console.log = originalLog; console.warn = originalWarn; }
    const config = aiConfigService.createConfig(db, log, {
      service_type: 'video', provider: 'yinzi', api_protocol: 'yinzi', name: 'dynamic capability task',
      base_url: 'https://api.yinziapi.top/v1', api_key: 'test-key', model: ['mg-seedance2.0 -480p mini'],
      default_model: 'mg-seedance2.0 -480p mini', endpoint: '/videos', query_endpoint: '/videos/{taskId}',
      is_default: true,
    });
    const dynamicCapability = {
      duration_mode: 'range', duration_min: 6, duration_max: 12,
      max_images: 30, max_videos: 0, max_audios: 0, max_total_references: 30,
      roles: { image: ['reference', 'first_frame'], video: [], audio: [] },
    };
    const frozen = buildProviderConfigSnapshot(config, 'mg-seedance2.0 -480p mini', {
      capability_model: 'mg-seedance2.0 -480p mini',
      capability_snapshot: dynamicCapability,
      capability_source: 'key_scoped_contract',
      contract_status: 'active',
      catalog_verified: true,
    });
    const originalFetch = global.fetch;
    let submittedBody;
    global.fetch = async (_url, init) => {
      submittedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'dynamic-capability-task', status: 'queued' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const result = await callVideoApi(db, log, {
        video_config_id: config.id,
        provider_config_snapshot: frozen,
        model: 'mg-seedance2.0 -480p mini', prompt: 'dynamic capability request', duration: 5,
        contract_validation_mode: 'advisory',
        first_frame_url: 'https://media.test/first.png',
        reference_urls: Array.from({ length: 5 }, (_, index) => `https://media.test/ref-${index}.png`),
      });
      assert.equal(result.task_id, 'dynamic-capability-task');
      assert.equal(submittedBody.duration, 6);
      assert.equal(submittedBody.references.length, 6);
      assert.equal(submittedBody.references[0].role, 'first_frame');
      assert.equal(result.contract_validation.catalog_verified, true);
      assert.equal(result.contract_validation.capability_source, 'key_scoped_contract');
      assert.equal(result.contract_validation.contract_status, 'active');
      assert.equal(result.contract_validation.warnings.includes('reference_count_over_contract'), false);
      assert.equal(result.contract_validation.warnings.includes('first_frame_role_unsupported'), false);
    } finally {
      global.fetch = originalFetch;
      db.close();
    }
  });

  it('submits unknown-model first and last frame roles without a local contract gate', async () => {
    const originalFetch = global.fetch;
    let submittedBody;
    global.fetch = async (_url, init) => {
      submittedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'unknown-contract-task', status: 'queued' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'future-video-model', prompt: 'provider decides the contract', duration: 3,
        first_frame_url: 'https://media.test/first.png',
        last_frame_url: 'https://media.test/last.png',
        reference_urls: ['https://media.test/storyboard.png'],
        capability_context: {
          model: 'future-video-model', capability: null,
          capability_source: 'unknown', contract_status: 'missing', catalog_verified: false,
        },
      });
      assert.equal(result.task_id, 'unknown-contract-task');
      assert.deepEqual(submittedBody.references.map((item) => item.role), [
        'first_frame', 'reference', 'last_frame',
      ]);
      assert.ok(result.contract_validation.warnings.includes('unknown_contract'));
      assert.equal(result.contract_validation.warnings.includes('first_frame_role_unsupported'), false);
      assert.equal(result.contract_validation.warnings.includes('last_frame_role_unsupported'), false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('classifies the provider asset prompt receipt without trusting a UI label', () => {
    const prompt = '固定角色；固定场景；完整动作时间线；固定道具';
    const verified = normalizeYinziAssetPromptReceipt({
      data: { prompt, prompt_truncated: false },
    }, prompt, 'asset-verified', '2026-08-06T00:00:00.000Z');
    assert.equal(verified.status, 'verified');
    assert.equal(verified.submitted_chars, prompt.length);
    assert.equal(verified.stored_chars, prompt.length);
    assert.equal(verified.exact_match, true);

    const truncated = normalizeYinziAssetPromptReceipt({
      data: { prompt: prompt.slice(0, 12), prompt_truncated: true },
    }, prompt, 'asset-truncated', '2026-08-06T00:00:00.000Z');
    assert.equal(truncated.status, 'truncated');
    assert.equal(truncated.prompt_truncated, true);
    assert.equal(truncated.prefix_match, true);

    const unavailable = normalizeYinziAssetPromptReceipt({}, prompt, 'asset-unknown', '2026-08-06T00:00:00.000Z');
    assert.equal(unavailable.status, 'unverified');
  });

  it('builds polling and authenticated content fallback URLs', () => {
    const config = { base_url: 'https://api.yinziapi.top/v1' };
    assert.equal(buildYinziPollUrl(config, 'task 123'), 'https://api.yinziapi.top/v1/videos/task%20123');
    assert.equal(buildYinziContentUrl(config, 'task 123'), 'https://api.yinziapi.top/v1/videos/task%20123/content');
  });

  it('prefers the signed Yinzi asset URL over a protected upstream video URL', () => {
    const signed = 'https://api.yinziapi.top/v1/assets/asset-1/content?signature=test';
    assert.equal(extractYinziVideoUrl({
      status: 'completed',
      content_url: signed,
      video_url: 'https://api.aizzz.xyz/v1/videos/upstream-task/content',
      artifacts: [{ type: 'video', download_url: signed }],
    }), signed);
  });

  it('never retries an ambiguous POST failure', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      throw new Error('socket closed');
    };
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'mg-seedance2.0 -480p mini', prompt: 'test', duration: 5, aspect_ratio: '16:9', video_gen_id: 1,
      });
      assert.equal(calls, 1);
      assert.equal(result.ambiguous_submission, true);
      assert.equal(result.submission_status, 'ambiguous');
      assert.match(result.error, /不会自动重试/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('rejects unsupported AIZZZ first/last semantics before submitting', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      throw new Error('must not submit');
    };
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'mg-seedance2.0 -480p mini', prompt: 'test', duration: 5,
        aspect_ratio: '16:9', first_frame_url: 'first.png', last_frame_url: 'last.png', video_gen_id: 2,
      });
      assert.equal(calls, 0);
      assert.equal(result.submission_status, 'not_sent');
      assert.match(result.error, /未创建上游任务/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('classifies a provider 4xx without a task ID as rejected', async () => {
    const originalFetch = global.fetch;
    const states = [];
    global.fetch = async () => new Response(JSON.stringify({
      error: { code: 'unsupported_media_reference', message: 'this route supports at most 1 reference images' },
      request_id: 'request-rejected-1',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'mg-seedance2.0 -480p mini', prompt: 'test', duration: 5,
        aspect_ratio: '16:9', video_gen_id: 23,
        on_submission_state: (state) => states.push(state),
      });
      assert.equal(result.submission_status, 'rejected');
      assert.equal(result.submission_http_status, 400);
      assert.equal(result.submission_receipt.error_code, 'unsupported_media_reference');
      assert.deepEqual(states.map((state) => state.status), ['ambiguous', 'rejected']);
      assert.equal(result.task_id, undefined);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('keeps a provider 5xx as ambiguous', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ message: 'temporary upstream error' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'mg-seedance2.0 -480p mini', prompt: 'test', duration: 5,
        aspect_ratio: '16:9', video_gen_id: 24,
      });
      assert.equal(result.submission_status, 'ambiguous');
      assert.equal(result.submission_http_status, 503);
      assert.equal(result.ambiguous_submission, true);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('classifies the deterministic smart-router no-channel 503 as rejected', async () => {
    const originalFetch = global.fetch;
    const states = [];
    global.fetch = async () => new Response(JSON.stringify({
      code: 'get_channel_failed',
      message: 'smartrouter: no eligible automatic route',
      data: null,
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'seedance-2.5-720p', prompt: 'safe test', duration: 5,
        aspect_ratio: '16:9', video_gen_id: 25,
        on_submission_state: (state) => states.push(state),
      });
      assert.equal(result.submission_status, 'rejected');
      assert.equal(result.submission_http_status, 503);
      assert.equal(result.ambiguous_submission, false);
      assert.equal(result.submission_receipt.error_code, 'get_channel_failed');
      assert.deepEqual(states.map((state) => state.status), ['ambiguous', 'rejected']);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('classifies a smart-router contract-not-found 503 without request authority as rejected', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({
      code: 'get_channel_failed',
      message: 'smartrouter: automatic route contract not found',
      data: null,
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'seedance-2.5-720p', prompt: 'safe test', duration: 30,
        aspect_ratio: '16:9', video_gen_id: 26,
      });
      assert.equal(result.submission_status, 'rejected');
      assert.equal(result.submission_http_status, 503);
      assert.equal(result.ambiguous_submission, false);
      assert.equal(result.submission_receipt.request_id, null);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('classifies a model_not_found 503 with no available channel as rejected', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({
      error_code: 'model_not_found',
      message: 'No available channel for model seedance-2.5-720p under group 限时特价即梦分组 (distributor)',
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'seedance-2.5-720p', prompt: 'safe test', duration: 30,
        aspect_ratio: '9:16', video_gen_id: 261,
      });
      assert.equal(result.submission_status, 'rejected');
      assert.equal(result.submission_http_status, 503);
      assert.equal(result.ambiguous_submission, false);
      assert.equal(result.submission_receipt.error_code, 'model_not_found');
      assert.match(result.error, /No available channel for model/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('keeps the same smart-router 503 ambiguous when a request ID exists', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({
      code: 'get_channel_failed',
      message: 'smartrouter: automatic route contract not found',
      request_id: 'request-may-have-reached-upstream',
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'seedance-2.5-720p', prompt: 'safe test', duration: 30,
        aspect_ratio: '16:9', video_gen_id: 27,
      });
      assert.equal(result.submission_status, 'ambiguous');
      assert.equal(result.ambiguous_submission, true);
      assert.equal(result.submission_receipt.request_id, 'request-may-have-reached-upstream');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('keeps a smart-router 503 ambiguous when the only request ID is embedded in the message', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({
      code: 'get_channel_failed',
      message: 'smartrouter: automatic route contract not found (request id: embedded-request-27)',
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'seedance-2.5-720p', prompt: 'safe test', duration: 30,
        aspect_ratio: '16:9', video_gen_id: 28,
      });
      assert.equal(result.submission_status, 'ambiguous');
      assert.equal(result.ambiguous_submission, true);
      assert.equal(result.submission_receipt.request_id, 'embedded-request-27');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('rejects a fake strict first frame mixed with generic AIZZZ references before upload or POST', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      throw new Error('must not upload or submit');
    };
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'mg-seedance2.0 -480p mini', prompt: 'test', duration: 5,
        aspect_ratio: '16:9', first_frame_url: 'strict.png',
        reference_urls: ['storyboard.png'], video_gen_id: 22,
      });
      assert.equal(calls, 0);
      assert.match(result.error, /不能同时把 first_frame 当作严格首帧/);
      assert.match(result.error, /未创建上游任务/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('submits the full 4 image, 3 video, 1 audio contract with reference roles', async () => {
    const originalFetch = global.fetch;
    let submittedBody;
    global.fetch = async (_url, init) => {
      submittedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'task-multimedia', status: 'queued' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'mg-seedance2.0 -480p mini', prompt: 'test', duration: 5, aspect_ratio: '16:9',
        reference_urls: Array.from({ length: 4 }, (_, i) => `https://media.test/image-${i}.png`),
        reference_video_urls: Array.from({ length: 3 }, (_, i) => `https://media.test/video-${i}.mp4`),
        reference_audio_urls: ['https://media.test/audio.mp3'],
        video_gen_id: 3,
      });
      assert.equal(result.task_id, 'task-multimedia');
      assert.equal(result.submission_status, 'accepted');
      assert.equal(submittedBody.references.length, 8);
      assert.deepEqual(submittedBody.references.map((ref) => ref.type), [
        'image', 'image', 'image', 'image', 'video', 'video', 'video', 'audio',
      ]);
      assert.ok(submittedBody.references.every((ref) => ref.role === 'reference'));
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('keeps a manually selected over-limit reference package in advisory mode', async () => {
    const originalFetch = global.fetch;
    let submittedBody;
    global.fetch = async (_url, init) => {
      submittedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'task-advisory-over-limit', status: 'queued' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'mg-seedance2.0 -480p mini', prompt: 'test', duration: 5,
        contract_validation_mode: 'advisory',
        reference_urls: Array.from({ length: 5 }, (_, i) => `https://media.test/image-${i}.png`),
        reference_video_urls: Array.from({ length: 4 }, (_, i) => `https://media.test/video-${i}.mp4`),
        reference_audio_urls: ['https://media.test/audio-1.mp3', 'https://media.test/audio-2.mp3'],
        video_gen_id: 31,
      });
      assert.equal(result.task_id, 'task-advisory-over-limit');
      assert.equal(result.contract_validation.mode, 'advisory');
      assert.ok(result.contract_validation.warnings.includes('reference_count_over_contract'));
      assert.equal(submittedBody.references.length, 11);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('forwards advisory mode and a routing protocol snapshot through the common dispatcher', async () => {
    const db = new Database(':memory:');
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try { runMigrationsAndEnsure(db); } finally { console.log = originalLog; console.warn = originalWarn; }
    const config = aiConfigService.createConfig(db, log, {
      service_type: 'video', provider: 'yinzi', api_protocol: 'yinzi', name: 'smart route snapshot',
      base_url: 'https://api.yinziapi.top/v1', api_key: 'test-key', model: ['mg-seedance2.0 -480p mini'],
      default_model: 'mg-seedance2.0 -480p mini', endpoint: '/videos', query_endpoint: '/videos/{taskId}',
      is_default: true,
    });
    const originalFetch = global.fetch;
    let submittedUrl = '';
    const states = [];
    global.fetch = async (url) => {
      submittedUrl = String(url);
      return new Response(JSON.stringify({ id: 'smart-protocol-task', status: 'queued' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const result = await callVideoApi(db, log, {
        video_config_id: config.id,
        model: 'mg-seedance2.0 -480p mini', prompt: 'safe abstract light movement', duration: 5,
        contract_validation_mode: 'advisory',
        reference_urls: Array.from({ length: 5 }, (_, i) => `https://media.test/image-${i}.png`),
        routing_receipt: { provider_protocol_snapshot: {
          contract: 'newapi-video-generations-v1',
          create_path: '/video/generations',
          query_path: '/video/generations/{taskId}',
          content_path: '/video/generations/{taskId}/content',
          source: 'test-contract',
        } },
        on_submission_state: (state) => states.push(state.status),
      });
      assert.equal(submittedUrl, 'https://api.yinziapi.top/v1/video/generations');
      assert.equal(result.task_id, 'smart-protocol-task');
      assert.equal(result.contract_validation.mode, 'advisory');
      assert.ok(result.contract_validation.warnings.includes('reference_count_over_contract'));
      assert.deepEqual(states, ['ambiguous', 'accepted']);
    } finally {
      global.fetch = originalFetch;
      db.close();
    }
  });

  it('downgrades unsupported first and last frame roles to ordinary references in advisory mode', async () => {
    const originalFetch = global.fetch;
    let submittedBody;
    global.fetch = async (_url, init) => {
      submittedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'task-advisory-frames', status: 'queued' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'mg-seedance2.0 -480p mini', prompt: 'test', duration: 5,
        contract_validation_mode: 'advisory',
        first_frame_url: 'https://media.test/first.png',
        last_frame_url: 'https://media.test/last.png',
        reference_urls: ['https://media.test/reference.png'],
        video_gen_id: 32,
      });
      assert.equal(result.task_id, 'task-advisory-frames');
      assert.ok(result.contract_validation.warnings.includes('first_frame_role_unsupported'));
      assert.ok(result.contract_validation.warnings.includes('last_frame_role_unsupported'));
      assert.deepEqual(submittedBody.references.map((item) => item.role), ['reference', 'reference', 'reference']);
      assert.deepEqual(submittedBody.references.map((item) => item.url), [
        'https://media.test/first.png',
        'https://media.test/reference.png',
        'https://media.test/last.png',
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('forwards typed references through the production Yinzi dispatcher', async () => {
    const db = new Database(':memory:');
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
      runMigrationsAndEnsure(db);
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }
    aiConfigService.createConfig(db, log, {
      service_type: 'video',
      provider: 'yinzi',
      api_protocol: 'yinzi',
      name: 'dispatcher test',
      base_url: 'https://api.yinziapi.top/v1',
      api_key: 'test-key',
      model: ['mg-seedance2.0 -480p mini'],
      endpoint: '/videos',
      is_default: true,
    });

    const originalFetch = global.fetch;
    let submittedBody;
    global.fetch = async (_url, init) => {
      submittedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'task-dispatcher', status: 'queued' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const result = await callVideoApi(db, log, {
        model: 'mg-seedance2.0 -480p mini',
        prompt: 'test',
        duration: 5,
        aspect_ratio: '16:9',
        reference_urls: ['https://media.test/frame.png'],
        reference_video_urls: ['https://media.test/motion.mp4'],
        reference_audio_urls: ['https://media.test/voice.mp3'],
        video_gen_id: 6,
      });
      assert.equal(result.task_id, 'task-dispatcher');
      assert.deepEqual(submittedBody.references.map((ref) => ref.type), ['image', 'video', 'audio']);
    } finally {
      global.fetch = originalFetch;
      db.close();
    }
  });

  it('uses the auto-routed cc model and clamps a legacy two-second request to five seconds', async () => {
    const db = new Database(':memory:');
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try { runMigrationsAndEnsure(db); }
    finally { console.log = originalLog; console.warn = originalWarn; }
    aiConfigService.createConfig(db, log, {
      service_type: 'video',
      provider: 'yinzi',
      api_protocol: 'yinzi',
      name: 'group-scoped routing test',
      base_url: 'https://api.yinziapi.top/v1',
      api_key: 'test-key',
      model: ['mg-seedance2.0 -480p mini'],
      endpoint: '/videos',
      is_default: true,
    });

    const originalFetch = global.fetch;
    let submittedBody;
    global.fetch = async (_url, init) => {
      submittedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'task-short-two-seconds', status: 'queued' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const result = await callVideoApi(db, log, {
        model: 'cc-seedance2.0 480p-fast-nsp',
        prompt: 'A complete two-second close-up reaction.',
        duration: 2,
        aspect_ratio: '16:9',
        reference_urls: ['https://media.test/close-up.png'],
        reference_video_urls: [],
        video_gen_id: 61,
      });
      assert.equal(result.task_id, 'task-short-two-seconds');
      assert.equal(submittedBody.model, 'cc-seedance2.0 480p-fast-nsp');
      assert.equal(submittedBody.duration, 5);
      assert.equal(submittedBody.seconds, 5);
      assert.deepEqual(submittedBody.references.map((item) => item.type), ['image']);
    } finally {
      global.fetch = originalFetch;
      db.close();
    }
  });

  it('rejects any video reference for a cc route before upload or submission', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      throw new Error('provider must not be called');
    };
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'cc-seedance2.0 480p-fast-nsp',
        prompt: 'A short close-up.',
        duration: 2,
        reference_urls: ['https://media.test/frame.png'],
        reference_video_urls: ['local-director-preview.webm'],
        storage_local_path: 'C:/media-that-must-not-be-read',
        video_gen_id: 62,
      });
      assert.equal(calls, 0);
      assert.match(result.error, /0 个参考视频/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('rejects media over the 4/3/1 limits before any POST', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => { calls += 1; throw new Error('must not submit'); };
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'mg-seedance2.0 -480p mini', prompt: 'test', duration: 5,
        reference_urls: Array.from({ length: 5 }, (_, i) => `https://media.test/image-${i}.png`),
        video_gen_id: 4,
      });
      assert.equal(calls, 0);
      assert.match(result.error, /最多支持 4 个参考图片/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('uploads local reference media to Yinzi files and submits file_id sources', async () => {
    const originalFetch = global.fetch;
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-reference-test-'));
    if (!mediaToolsAvailable) {
      fs.rmSync(storage, { recursive: true, force: true });
      return;
    }
    await sharp({ create: { width: 320, height: 180, channels: 3, background: '#315f73' } })
      .png().toFile(path.join(storage, 'frame.png'));
    makeReferenceVideo(path.join(storage, 'motion.mp4'));
    fs.writeFileSync(path.join(storage, 'voice.mp3'), Buffer.from('audio'));
    let uploadCount = 0;
    let submittedBody;
    global.fetch = async (url, init) => {
      if (String(url).endsWith('/files')) {
        uploadCount += 1;
        assert.ok(init.body instanceof FormData);
        return new Response(JSON.stringify({ id: `file-${uploadCount}` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      submittedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'task-local-files' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'mg-seedance2.0 -480p mini', prompt: 'test', duration: 5,
        reference_urls: ['frame.png'],
        reference_video_urls: ['motion.mp4'],
        reference_audio_urls: ['voice.mp3'],
        storage_local_path: storage,
        video_gen_id: 5, reference_transport: 'file_id',
      });
      assert.equal(result.task_id, 'task-local-files');
      assert.equal(uploadCount, 3);
      assert.deepEqual(submittedBody.references.map((ref) => ref.file_id), ['file-1', 'file-2', 'file-3']);
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it('submits a local image reference as bounded data_url by default', async () => {
    const originalFetch = global.fetch;
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-data-url-test-'));
    await sharp({ create: { width: 320, height: 180, channels: 3, background: '#315f73' } }).png().toFile(path.join(storage, 'frame.png'));
    let submittedBody;
    global.fetch = async (url, init) => {
      assert.equal(String(url), 'https://api.yinziapi.top/v1/videos');
      submittedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'task-data-url' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const result = await callYinziVideoApi(null, { base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos' }, log, {
        model: 'Seedance 2.0-720', prompt: 'test', duration: 5, reference_urls: ['frame.png'], storage_local_path: storage, video_gen_id: 51,
        capability_context: { capability: { max_image_bytes: 2 * 1024 * 1024, roles: { image: ['reference'] } }, contract_status: 'known', catalog_verified: true, capability_source: 'test' },
      });
      assert.equal(result.task_id, 'task-data-url');
      assert.match(submittedBody.references[0].data_url, /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/);
      assert.equal(submittedBody.references[0].file_id, undefined);
      assert.equal(submittedBody.references[0].url, undefined);
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it('uploads a bounded JPEG copy for an oversized local image and preserves the source', async () => {
    const originalFetch = global.fetch;
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-bounded-image-upload-'));
    const source = path.join(storage, 'large.png');
    await sharp({ create: { width: 3000, height: 1800, channels: 3, background: '#315f73' } })
      .png().toFile(source);
    const sourceBytes = fs.readFileSync(source);
    let uploadedFile;
    global.fetch = async (url, init) => {
      if (String(url).endsWith('/files')) {
        uploadedFile = init.body.get('file');
        return new Response(JSON.stringify({ id: 'bounded-image-file' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: 'task-bounded-image' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'mg-seedance2.0 -480p mini', prompt: 'test', duration: 5, aspect_ratio: '16:9',
        reference_urls: ['large.png'], storage_local_path: storage, video_gen_id: 10, reference_transport: 'file_id',
      });
      assert.equal(result.task_id, 'task-bounded-image');
      assert.equal(uploadedFile.type, 'image/jpeg');
      assert.match(uploadedFile.name, /yinzi-image-v1-jpeg1920-2m\.jpg$/);
      assert.ok(uploadedFile.size <= 2 * 1024 * 1024);
      assert.deepEqual(fs.readFileSync(source), sourceBytes);
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it('prepares every local image before the first provider call', async () => {
    const originalFetch = global.fetch;
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-image-preflight-'));
    await sharp({ create: { width: 320, height: 180, channels: 3, background: '#315f73' } })
      .png().toFile(path.join(storage, 'valid.png'));
    fs.writeFileSync(path.join(storage, 'invalid.png'), Buffer.from('not an image'));
    let calls = 0;
    global.fetch = async () => { calls += 1; throw new Error('provider must not be called'); };
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'mg-seedance2.0 -480p mini', prompt: 'test', duration: 5, aspect_ratio: '16:9',
        reference_urls: ['valid.png', 'invalid.png'], storage_local_path: storage, video_gen_id: 11,
      });
      assert.equal(calls, 0);
      assert.match(result.error, /image|unsupported|format/i);
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it('normalizes a director WebM before the production dispatcher uploads 3 images and 2 videos', {
    skip: !mediaToolsAvailable,
  }, async () => {
    const db = new Database(':memory:');
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try { runMigrationsAndEnsure(db); }
    finally { console.log = originalLog; console.warn = originalWarn; }
    aiConfigService.createConfig(db, log, {
      service_type: 'video', provider: 'yinzi', api_protocol: 'yinzi', name: 'local dispatcher test',
      base_url: 'https://api.yinziapi.top/v1', api_key: 'test-key',
      model: ['mg-seedance2.0 -480p mini'], endpoint: '/videos', is_default: true,
    });

    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-dispatcher-media-'));
    for (let i = 0; i < 3; i++) {
      await sharp({ create: { width: 320, height: 180, channels: 3, background: { r: 40 + i * 20, g: 90, b: 120 } } })
        .png().toFile(path.join(storage, `frame-${i}.png`));
    }
    makeReferenceVideo(path.join(storage, 'approved.mp4'), 'libx264');
    makeReferenceVideo(path.join(storage, 'director.webm'), 'libvpx-vp9');

    const originalFetch = global.fetch;
    const uploads = [];
    let submittedBody;
    global.fetch = async (url, init) => {
      if (String(url).endsWith('/files')) {
        const file = init.body.get('file');
        uploads.push({ name: file.name, type: file.type });
        return new Response(JSON.stringify({ id: `file-${uploads.length}` }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      submittedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'task-normalized-dispatcher' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const result = await callVideoApi(db, log, {
        model: 'mg-seedance2.0 -480p mini', prompt: 'test', duration: 5, aspect_ratio: '16:9',
        reference_urls: ['frame-0.png', 'frame-1.png', 'frame-2.png'],
        reference_video_urls: ['approved.mp4', 'director.webm'],
        storage_local_path: storage, video_gen_id: 7, reference_transport: 'file_id',
      });
      assert.equal(result.task_id, 'task-normalized-dispatcher');
      assert.deepEqual(submittedBody.references.map((ref) => ref.type), [
        'image', 'image', 'image', 'video', 'video',
      ]);
      assert.deepEqual(uploads.map((file) => file.type), ['video/mp4', 'video/mp4']);
      assert.ok(uploads.every((file) => file.name.endsWith('.mp4')));
      assert.match(uploads[0].name, /yinzi-ref-v3-fps24-1280x720\.mp4$/);
      assert.match(uploads[1].name, /yinzi-ref-v3-fps24-1280x720\.mp4$/);
    } finally {
      global.fetch = originalFetch;
      db.close();
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it('fails closed before upload or video submission when a local reference video cannot be probed', async () => {
    const originalFetch = global.fetch;
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-bad-reference-'));
    fs.writeFileSync(path.join(storage, 'broken.webm'), Buffer.from('not a video'));
    let calls = 0;
    global.fetch = async () => { calls += 1; throw new Error('must not call provider'); };
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'mg-seedance2.0 -480p mini', prompt: 'test', duration: 5, aspect_ratio: '16:9',
        reference_video_urls: ['broken.webm'], storage_local_path: storage, video_gen_id: 8,
      });
      assert.equal(calls, 0);
      assert.match(result.error, /FFprobe|reference video/i);
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it('rejects a prompt above the confirmed 4,096-character provider boundary before any upload', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => { calls += 1; throw new Error('provider must not be called'); };
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'mg-seedance2.0 -480p mini', prompt: 'X'.repeat(4097), duration: 5,
        aspect_ratio: '16:9', reference_urls: ['missing.png'], video_gen_id: 81,
      });
      assert.equal(calls, 0);
      assert.match(result.error, /4097 characters.*4096-character model limit/i);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('allows exactly the confirmed hard boundary when called directly', async () => {
    const originalFetch = global.fetch;
    let submittedBody;
    global.fetch = async (_url, init) => {
      submittedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'task-hard-boundary' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'mg-seedance2.0 -480p mini', prompt: 'X'.repeat(4096), duration: 5, video_gen_id: 82,
      });
      assert.equal(result.task_id, 'task-hard-boundary');
      assert.equal(submittedBody.prompt.length, 4096);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('automatically adapts known local reference videos before provider submission', async () => {
    const originalFetch = global.fetch;
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-over-duration-'));
    let calls = 0;
    makeReferenceVideo(path.join(storage, 'previous.mp4'), 'libx264', 24, 8);
    makeReferenceVideo(path.join(storage, 'director.mp4'), 'libx264', 24, 8);
    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: calls === 1 ? 'file-video-1' : calls === 2 ? 'file-video-2' : 'task-adapted' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'mg-seedance2.0 -480p mini', prompt: 'test', duration: 5, aspect_ratio: '16:9',
        reference_video_urls: ['previous.mp4', 'director.mp4'], storage_local_path: storage, video_gen_id: 9,
      });
      assert.ok(calls >= 1);
      assert.equal(result.task_id, 'task-adapted');
      assert.equal(result.contract_validation.reference_video_adaptations.length, 1);
      assert.ok(result.contract_validation.reference_video_adaptations.every((item) => item.excerpt_duration_seconds < item.source_duration_seconds));
      assert.ok(result.contract_validation.reference_video_adaptations.every((item) => item.excerpt_duration_seconds <= 13.8));
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it('returns the authenticated content endpoint when a completed task has no public URL', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: 'task-1', status: 'completed', progress: 100 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const result = await pollVideoTask(null, log, 1, 'task-1', {
        provider: 'yinzi', api_protocol: 'yinzi', base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key',
      }, 1, 0);
      assert.equal(calls, 1);
      assert.equal(result.content_url, 'https://api.yinziapi.top/v1/videos/task-1/content');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('keeps a queued task recoverable when the local polling window ends', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({
      id: 'task-queued', status: 'queued', progress: 20,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    try {
      const result = await pollVideoTask(null, log, 1, 'task-queued', {
        provider: 'yinzi', api_protocol: 'yinzi', base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key',
      }, 1, 0);
      assert.deepEqual(result, { pending: true, status: 'queued', progress: 20 });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
