const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const aiConfigService = require('../src/services/aiConfigService');
const videoClient = require('../src/services/videoClient');
const createAiConfigRoutes = require('../src/routes/aiConfig');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_type TEXT NOT NULL,
      provider TEXT,
      api_protocol TEXT,
      name TEXT,
      base_url TEXT,
      api_key TEXT,
      model TEXT,
      default_model TEXT,
      endpoint TEXT,
      query_endpoint TEXT,
      priority INTEGER DEFAULT 0,
      is_default INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      settings TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
  `);
  return db;
}

function createMigratedDb() {
  const db = new Database(':memory:');
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = originalLog; console.warn = originalWarn; }
  return db;
}

const log = { info() {}, warn() {}, error() {} };

function captureResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

describe('AI config secret boundaries', () => {
  it('honors an explicitly inactive configuration and excludes it from candidates', () => {
    const db = createDb();
    const created = aiConfigService.createConfig(db, log, {
      service_type: 'text', provider: 'openai', name: '备用文本', base_url: 'https://example.test/v1',
      api_key: 'private-value', model: ['model-a'], is_active: false,
    });
    assert.equal(created.is_active, false);
    assert.equal(aiConfigService.candidateConfigs(db, { service_type: 'text' }).items.some((item) => item.id === created.id), false);
  });

  it('redacts API keys from public config responses', () => {
    const publicConfig = aiConfigService.toPublicConfig({ id: 7, api_key: 'private-value' });
    assert.equal(publicConfig.api_key, '');
    assert.equal(publicConfig.has_api_key, true);
    assert.equal(JSON.stringify(publicConfig).includes('private-value'), false);
  });

  it('preserves the stored API key when an update omits api_key', () => {
    const db = createDb();
    const created = aiConfigService.createConfig(db, log, {
      service_type: 'image',
      provider: 'yinzi',
      name: 'Yinzi image',
      base_url: 'https://api.yinziapi.top/v1',
      api_key: 'private-value',
      model: ['gpt-image-2'],
    });
    aiConfigService.updateConfig(db, log, created.id, { name: 'Renamed' });
    const row = db.prepare('SELECT api_key, name FROM ai_service_configs WHERE id = ?').get(created.id);
    assert.equal(row.api_key, 'private-value');
    assert.equal(row.name, 'Renamed');
  });

  it('resolves a saved config by ID without requiring the browser to return its key', () => {
    const db = createDb();
    const created = aiConfigService.createConfig(db, log, {
      service_type: 'image', provider: 'yinzi', name: 'Saved image',
      base_url: 'https://saved.example/v1/', api_key: 'saved-private-value',
      model: ['first-model', 'second-model'], default_model: 'second-model',
    });
    const result = aiConfigService.resolveConnectionTestConfig(db, { config_id: created.id });
    assert.equal(result.config.base_url, 'https://saved.example/v1');
    assert.equal(result.config.api_key, 'saved-private-value');
    assert.equal(result.config.model, 'second-model');
    assert.equal(result.credential_source, 'saved');
  });

  it('tests current draft URL and model while reusing a saved key', () => {
    const db = createDb();
    const created = aiConfigService.createConfig(db, log, {
      service_type: 'image', provider: 'yinzi', name: 'Saved image',
      base_url: 'https://old.example/v1', api_key: 'saved-private-value', model: ['old-model'],
    });
    const result = aiConfigService.resolveConnectionTestConfig(db, {
      config_id: created.id,
      draft: {
        base_url: 'https://draft.example/v1', model: ['draft-model'], default_model: 'draft-model', api_key: '',
      },
    });
    assert.equal(result.config.base_url, 'https://draft.example/v1');
    assert.equal(result.config.model, 'draft-model');
    assert.equal(result.config.api_key, 'saved-private-value');
    assert.equal(result.credential_source, 'saved');
  });

  it('uses a temporary draft key without mutating the saved key', () => {
    const db = createDb();
    const created = aiConfigService.createConfig(db, log, {
      service_type: 'text', provider: 'yinzi', name: 'Saved text',
      base_url: 'https://saved.example/v1', api_key: 'saved-private-value', model: ['text-model'],
    });
    const result = aiConfigService.resolveConnectionTestConfig(db, {
      config_id: created.id,
      draft: { api_key: 'temporary-private-value' },
    });
    assert.equal(result.config.api_key, 'temporary-private-value');
    assert.equal(result.credential_source, 'draft');
    assert.equal(aiConfigService.getConfig(db, created.id).api_key, 'saved-private-value');
  });

  it('rejects invalid IDs and accurately explains genuinely missing fields', () => {
    const db = createDb();
    assert.throws(
      () => aiConfigService.resolveConnectionTestConfig(db, { config_id: 999 }),
      /配置不存在或已删除/,
    );
    assert.throws(
      () => aiConfigService.resolveConnectionTestConfig(db, { draft: { base_url: '', api_key: 'x' } }),
      /缺少 Base URL/,
    );
    assert.throws(
      () => aiConfigService.resolveConnectionTestConfig(db, { draft: { base_url: 'https:\/\/example.test' } }),
      /缺少 API Key/,
    );
  });

  it('redacts exact and patterned credentials from connection errors', () => {
    const safe = aiConfigService.redactConnectionTestError(
      new Error('upstream echoed temporary-private-value and Bearer abcdefghijklmnop and sk-abcdefgh12345678'),
      ['temporary-private-value'],
    );
    assert.equal(safe.includes('temporary-private-value'), false);
    assert.equal(safe.includes('abcdefghijklmnop'), false);
    assert.equal(safe.includes('sk-abcdefgh12345678'), false);
  });

  it('uses only GET read-only probes for Yinzi image and video configs', async () => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET' });
      return { status: 200, ok: true };
    };
    try {
      const image = await aiConfigService.testConnection({
        base_url: 'https://api.example/v1', api_key: 'runtime-only', provider: 'yinzi',
        service_type: 'image', model: 'gpt-image-2',
      });
      const video = await aiConfigService.testConnection({
        base_url: 'https://api.example/v1', api_key: 'runtime-only', provider: 'yinzi',
        service_type: 'video', model: 'video-model',
      });
      assert.deepEqual(calls.map((item) => item.method), ['GET', 'GET']);
      assert.match(calls[0].url, /\/models$/);
      assert.match(calls[1].url, /\/videos\/codex-connectivity-check-does-not-exist$/);
      assert.equal(image.generated_media, false);
      assert.equal(video.generated_media, false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('uses a minimal text response probe for Yinzi text configs', async () => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method, body: JSON.parse(options.body) });
      return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    };
    try {
      const result = await aiConfigService.testConnection({
        base_url: 'https://api.example/v1', api_key: 'runtime-only', provider: 'yinzi',
        service_type: 'text', model: 'gpt-5.6-sol',
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, 'POST');
      assert.match(calls[0].url, /\/chat\/completions$/);
      assert.equal(calls[0].body.max_tokens, 5);
      assert.equal(result.probe, 'minimal_text_response');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('routes a saved config ID through SQLite without returning its key', async () => {
    const db = createDb();
    const created = aiConfigService.createConfig(db, log, {
      service_type: 'image', provider: 'yinzi', name: 'Saved route image',
      base_url: 'https://api.example/v1', api_key: 'route-private-value', model: ['gpt-image-2'],
    });
    const originalFetch = global.fetch;
    let authorization = '';
    global.fetch = async (_url, options = {}) => {
      authorization = options.headers?.Authorization || '';
      return { status: 200, ok: true };
    };
    try {
      const res = captureResponse();
      await createAiConfigRoutes(db, log, {}).testConnection({ body: { config_id: created.id } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.credential_source, 'saved');
      assert.equal(res.body.data.generated_media, false);
      assert.equal(authorization, 'Bearer route-private-value');
      assert.equal(JSON.stringify(res.body).includes('route-private-value'), false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('discovers models with a read-only credential-scoped request and persists a redacted snapshot', async () => {
    const db = createDb();
    const created = aiConfigService.createConfig(db, log, {
      service_type: 'video', provider: 'yinzi', name: 'Scoped video',
      base_url: 'https://api.example/v1', api_key: 'catalog-private-value', model: ['old-model'],
    });
    const calls = [];
    const result = await aiConfigService.discoverModels(aiConfigService.getConfig(db, created.id), {
      db,
      group: 'ignored-by-service',
      fetchImpl: async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method, authorization: options.headers.Authorization });
        return {
          status: 200,
          ok: true,
          async json() { return { data: [{ id: 'new-video-a', owned_by: 'group-a' }, { model: 'new-video-b' }] }; },
        };
      },
    });
    assert.deepEqual(result.models.map((item) => item.model), ['new-video-a', 'new-video-b']);
    assert.equal(calls[0].url, 'https://api.example/v1/models');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].authorization, 'Bearer catalog-private-value');
    assert.equal(aiConfigService.getConfig(db, created.id).default_model, null);
    const snapshot = aiConfigService.getConfig(db, created.id).model_catalog_snapshot;
    assert.equal(snapshot.availability_scope, 'credential');
    assert.equal(snapshot.models.length, 2);
    assert.equal(JSON.stringify(snapshot).includes('catalog-private-value'), false);
    assert.equal(videoClient.getDefaultVideoConfig(db, 'new-video-a', created.id).id, created.id);
    assert.equal(videoClient.getDefaultVideoConfig(db, 'not-in-current-key', created.id).id, created.id);
    assert.equal(videoClient.getModelFromConfig({ provider: 'custom', model: ['old-model'] }, 'new-upstream-model'), 'new-upstream-model');
  });

  it('supports a no-persist credential-scoped discovery without changing settings or updated_at', async () => {
    const db = createDb();
    const created = aiConfigService.createConfig(db, log, {
      service_type: 'video', provider: 'yinzi', name: 'No-persist video',
      base_url: 'https://api.example/v1', api_key: 'catalog-private-value', model: ['old-model'],
      settings: JSON.stringify({ keep: 'unchanged' }),
    });
    const before = db.prepare('SELECT settings, updated_at FROM ai_service_configs WHERE id = ?').get(created.id);
    const result = await aiConfigService.discoverModels(aiConfigService.getConfig(db, created.id), {
      db,
      persist_snapshot: false,
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        async json() { return { data: [{ id: 'seedance-2.5-720p', endpoint_types: ['openai-video'] }] }; },
      }),
    });
    const after = db.prepare('SELECT settings, updated_at FROM ai_service_configs WHERE id = ?').get(created.id);
    assert.equal(result.snapshot_persisted, false);
    assert.deepEqual(after, before);
    assert.deepEqual(JSON.parse(after.settings), { keep: 'unchanged' });
  });

  it('keeps the public discovery route side-effect free when persist_snapshot is false', async () => {
    const db = createDb();
    const created = aiConfigService.createConfig(db, log, {
      service_type: 'video', provider: 'custom', name: 'Route no-persist video',
      base_url: 'https://api.example/v1', api_key: 'catalog-private-value', model: ['old-model'],
      settings: JSON.stringify({ keep: 'route-unchanged' }),
    });
    const before = db.prepare('SELECT settings, updated_at FROM ai_service_configs WHERE id = ?').get(created.id);
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      status: 200,
      ok: true,
      async json() { return { data: [{ id: 'new-video-model', endpoint_types: ['openai-video'] }] }; },
    });
    try {
      const res = captureResponse();
      await createAiConfigRoutes(db, log, {}).discoverModels({ body: {
        config_id: created.id,
        service_type: 'video',
        persist_snapshot: false,
      } }, res);
      const after = db.prepare('SELECT settings, updated_at FROM ai_service_configs WHERE id = ?').get(created.id);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.snapshot_persisted, false);
      assert.deepEqual(after, before);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('retries bounded transient catalog failures and reports the verified attempt count', async () => {
    let calls = 0;
    const result = await aiConfigService.discoverModels({
      id: 9, provider: 'yinzi', base_url: 'https://api.example/v1', api_key: 'private-value',
    }, {
      retry_delay_ms: 0,
      retry_attempts: 3,
      timeout_ms: 1000,
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) return { status: 503, ok: false, async json() { return {}; } };
        return { status: 200, ok: true, async json() { return { data: [{ id: 'Seedance 2.5-720', endpoint_types: ['openai-video'] }] }; } };
      },
    });
    assert.equal(calls, 3);
    assert.equal(result.attempts, 3);
    assert.equal(result.discovery_status, 'verified');
    assert.equal(result.models[0].model, 'Seedance 2.5-720');
  });

  it('does not retry authentication failures and preserves a configured model as manual-only', async () => {
    let calls = 0;
    await assert.rejects(() => aiConfigService.discoverModels({
      provider: 'yinzi', base_url: 'https://api.example/v1', api_key: 'private-value',
    }, {
      retry_delay_ms: 0,
      fetchImpl: async () => { calls += 1; return { status: 401, ok: false, async json() { return {}; } }; },
    }), (error) => error.code === 'MODEL_DISCOVERY_AUTH_FAILED' && error.attempts === 1);
    assert.equal(calls, 1);

    const fallback = aiConfigService.buildDiscoveryFallback({
      id: 2, provider: 'yinzi', service_type: 'video', base_url: 'https://api.example/v1',
      model: ['Seedance 2.5-720'], default_model: 'Seedance 2.5-720',
    }, Object.assign(new Error('模型目录鉴权失败 (401)'), { code: 'MODEL_DISCOVERY_AUTH_FAILED', status: 401, attempts: 1 }), { service_type: 'video' });
    const merged = aiConfigService.mergeDiscoveredCatalog(fallback, null, { provider: 'yinzi', service_type: 'video' });
    assert.equal(merged.video[0].model, 'Seedance 2.5-720');
    assert.equal(merged.video[0].manual_only, true);
    assert.equal(merged.video[0].automatic_eligible, false);
    assert.equal(merged.video[0].credential_verified, false);
  });

  it('classifies network, timeout, and missing-endpoint failures without leaking credentials', async () => {
    await assert.rejects(() => aiConfigService.discoverModels({ base_url: 'https://api.example/v1', api_key: 'private-value' }, {
      retry_delay_ms: 0,
      retry_attempts: 2,
      fetchImpl: async () => { throw new Error('socket refused'); },
    }), (error) => error.code === 'MODEL_DISCOVERY_NETWORK_ERROR' && error.attempts === 2 && !error.message.includes('private-value'));
    await assert.rejects(() => aiConfigService.discoverModels({ base_url: 'https://api.example/v1', api_key: 'private-value' }, {
      retry_delay_ms: 0,
      retry_attempts: 1,
      timeout_ms: 500,
      fetchImpl: () => new Promise(() => {}),
    }), (error) => error.code === 'MODEL_DISCOVERY_TIMEOUT' && error.attempts === 1);
    await assert.rejects(() => aiConfigService.discoverModels({ base_url: 'https://api.example/v1', api_key: 'private-value' }, {
      retry_delay_ms: 0,
      fetchImpl: async () => ({ status: 404, ok: false, async json() { return {}; } }),
    }), (error) => error.code === 'MODEL_DISCOVERY_ENDPOINT_NOT_FOUND' && error.status === 404 && error.attempts === 1);
  });

  it('returns a partial manual catalog from the route instead of erasing the saved model', async () => {
    const db = createDb();
    const created = aiConfigService.createConfig(db, log, {
      service_type: 'video', provider: 'yinzi', name: 'Partial video',
      base_url: 'https://api.example/v1', api_key: 'private-value', model: ['Seedance 2.5-720'],
      default_model: 'Seedance 2.5-720',
    });
    const originalFetch = global.fetch;
    global.fetch = async () => ({ status: 401, ok: false, async json() { return {}; } });
    try {
      const res = captureResponse();
      await createAiConfigRoutes(db, log, {}).discoverModels({ body: { config_id: created.id, service_type: 'video' } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.diagnostic.code, 'MODEL_DISCOVERY_AUTH_FAILED');
      assert.equal(res.body.data.catalog.video[0].model, 'Seedance 2.5-720');
      assert.equal(res.body.data.catalog.video[0].manual_only, true);
      assert.equal(res.body.data.catalog.video[0].automatic_eligible, false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('keeps independent URLs for each Yinzi service in one-click setup definitions', () => {
    const defs = require('../src/services/yinziService').yinziConfigDefinitions({
      base_url: 'https://api.yinziapi.top/v1',
      text_base_url: 'https://text.example/v1',
      image_base_url: 'https://image.example/v1',
      video_base_url: 'https://video.example/v1',
      api_key: 'universal', text_api_key: 'text', image_api_key: 'image', video_api_key: 'video',
      text_model: 'text-model', image_model: 'image-model', video_model: 'video-model',
    });
    assert.equal(defs.find((item) => item.service_type === 'text').base_url, 'https://text.example/v1');
    assert.equal(defs.find((item) => item.service_type === 'image').base_url, 'https://image.example/v1');
    assert.equal(defs.find((item) => item.service_type === 'video').base_url, 'https://video.example/v1');
    assert.equal(defs.find((item) => item.service_type === 'text').api_key, 'text');
    assert.equal(defs.find((item) => item.service_type === 'video').api_key, 'video');
  });

  it('keeps an independent text URL for the media-site one-click setup', () => {
    const defs = require('../src/services/yinziImageSiteService').definitions({
      base_url: 'https://image.yinziapi.top/v1',
      text_base_url: 'https://text.example/v1',
      image_base_url: 'https://image.yinziapi.top/v1',
      video_base_url: 'https://image.yinziapi.top/v1',
      text_api_key: 'text', image_api_key: 'image', video_api_key: 'video',
    });
    assert.equal(defs.find((item) => item.service_type === 'text').base_url, 'https://text.example/v1');
    assert.equal(defs.find((item) => item.service_type === 'image').base_url, 'https://image.yinziapi.top/v1');
  });

  it('merges discovered Yinzi models with only matching public prices and local known capabilities', () => {
    const merged = aiConfigService.mergeDiscoveredCatalog({
      availability_scope: 'credential',
      source_url: 'https://api.example/v1/models',
      snapshot: { scope_verified: true, fetched_at: '2026-08-16T00:00:00.000Z' },
      models: [{ model: 'cc-seedance2.0 480p-fast-nsp', name: 'Fast' }, { model: 'vendor-video', name: 'Vendor' }],
    }, {
      pricing_version: 'v2',
      video: [{ model: 'cc-seedance2.0 480p-fast-nsp', groups: ['group-a'], prices: [{ group: 'group-a', effective_price: 1 }] }],
    }, { provider: 'yinzi', service_type: 'video', group: 'group-a' });
    assert.equal(merged.video.length, 2);
    assert.equal(merged.video[0].contract_status, 'known');
    assert.deepEqual(merged.video[0].groups, ['group-a']);
    assert.equal(merged.video[1].contract_status, 'missing');
    assert.equal(merged.video[1].automatic_eligible, false);
  });

  it('merges a local hint for an unknown model without making it automatic by default', () => {
    const merged = aiConfigService.mergeDiscoveredCatalog({
      availability_scope: 'credential',
      source_url: 'https://api.example/v1/models',
      snapshot: { scope_verified: true, fetched_at: '2026-08-16T00:00:00.000Z' },
      models: [{ model: 'new-video-model', name: 'New video' }],
    }, null, {
      provider: 'yinzi', service_type: 'video',
      capability_overrides: {
        'new-video-model': { duration_mode: 'range', duration_min: 5, duration_max: 10, max_images: 4 },
      },
    });
    assert.equal(merged.video[0].contract_status, 'local');
    assert.equal(merged.video[0].capability_source, 'local');
    assert.equal(merged.video[0].capabilities.max_images, 4);
    assert.equal(merged.video[0].automatic_eligible, false);
  });

  it('saves and resets one local capability hint without changing the catalog snapshot', () => {
    const db = createDb();
    const created = aiConfigService.createConfig(db, log, {
      service_type: 'video', provider: 'yinzi', name: 'Capability video',
      base_url: 'https://api.example/v1', api_key: 'private-value', model: ['new-video-model'],
      settings: JSON.stringify({ model_catalog_snapshot: { models: [{ model: 'new-video-model' }] }, other: true }),
    });
    const updated = aiConfigService.updateModelCapabilityOverride(db, log, created.id, 'new-video-model', {
      duration_mode: 'range', duration_min: 5, duration_max: 10, max_images: 4, automatic_eligible: true,
    });
    assert.equal(updated.model_capability_overrides['new-video-model'].max_images, 4);
    assert.equal(updated.model_capability_overrides['new-video-model'].automatic_eligible, true);
    assert.deepEqual(updated.model_catalog_snapshot.models, [{ model: 'new-video-model' }]);
    assert.equal(JSON.parse(updated.settings).other, true);
    const reset = aiConfigService.resetModelCapabilityOverride(db, log, created.id, 'NEW-VIDEO-MODEL');
    assert.equal(reset.model_capability_overrides, undefined);
    assert.deepEqual(reset.model_catalog_snapshot.models, [{ model: 'new-video-model' }]);
  });

  it('rejects unknown capability fields before changing persisted settings', () => {
    const db = createDb();
    const created = aiConfigService.createConfig(db, log, {
      service_type: 'video', provider: 'yinzi', name: 'Capability validation',
      base_url: 'https://api.example/v1', api_key: 'private-value', model: ['model'],
      settings: JSON.stringify({ keep: 'yes' }),
    });
    assert.throws(
      () => aiConfigService.updateModelCapabilityOverride(db, log, created.id, 'model', { guessed_limit: 30 }),
      /未知字段/,
    );
    const after = aiConfigService.getConfig(db, created.id);
    assert.equal(JSON.parse(after.settings).keep, 'yes');
    assert.equal(after.model_capability_overrides, undefined);
  });

  it('exposes capability CRUD without exposing the provider key', async () => {
    const db = createDb();
    const created = aiConfigService.createConfig(db, log, {
      service_type: 'video', provider: 'yinzi', name: 'Capability route',
      base_url: 'https://api.example/v1', api_key: 'route-secret', model: ['model'],
    });
    aiConfigService.updateModelCapabilityOverride(db, log, created.id, 'model', {
      duration_mode: 'range', duration_min: 5, duration_max: 15,
    });
    const routes = createAiConfigRoutes(db, log, {});
    const listResponse = captureResponse();
    routes.modelCapabilities({ params: { id: String(created.id) } }, listResponse);
    assert.equal(JSON.stringify(listResponse.body).includes('route-secret'), false);
    assert.equal(listResponse.body.data.models[0].override.duration_min, 5);
  });

  it('creates the image.yinzi three-key profile through the public setup route without leaking credentials', async () => {
    const db = createMigratedDb();
    const routes = createAiConfigRoutes(db, log, {});
    const res = captureResponse();
    await routes.setupImageYinzi({ body: {
      base_url: 'https://image.yinziapi.top',
      text_api_key: 'text-secret-value',
      image_api_key: 'image-secret-value',
      video_api_key: 'video-secret-value',
    } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.routing_mode, 'group');
    assert.equal(res.body.data.smart_routing, false);
    assert.equal(res.body.data.configured.length, 4);
    assert.equal(JSON.stringify(res.body).includes('secret-value'), false);
    const rows = db.prepare('SELECT service_type, provider, api_protocol, base_url, api_key, default_model, settings FROM ai_service_configs ORDER BY service_type').all();
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((row) => row.service_type), ['image', 'storyboard_image', 'text', 'video']);
    assert.equal(rows.find((row) => row.service_type === 'text').api_key, 'text-secret-value');
    assert.equal(rows.find((row) => row.service_type === 'image').api_key, 'image-secret-value');
    assert.equal(rows.find((row) => row.service_type === 'video').api_key, 'video-secret-value');
    assert.equal(rows.find((row) => row.service_type === 'video').base_url, 'https://image.yinziapi.top/v1');
    assert.equal(rows.find((row) => row.service_type === 'video').default_model, 'Seedance 2.5-720');
    const videoSettings = JSON.parse(rows.find((row) => row.service_type === 'video').settings);
    assert.equal(videoSettings.smart_routing_enabled, false);
    assert.deepEqual(videoSettings.model_capabilities['Seedance 2.5-720'].allowed_durations, [30]);
  });
});
