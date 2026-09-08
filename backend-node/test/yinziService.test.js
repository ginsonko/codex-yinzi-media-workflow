const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  normalizeYinziBaseUrl,
  normalizeYinziCatalog,
  fetchYinziCatalogForConfig,
  prepareYinziSetupInput,
  upsertYinziConfigs,
} = require('../src/services/yinziService');

function createConfigDb() {
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

const log = { info() {}, warn() {}, error() {} };

describe('normalizeYinziCatalog', () => {
  it('preserves opaque model names and groups media endpoints', () => {
    const result = normalizeYinziCatalog({
      success: true,
      pricing_version: 'v1',
      data: [
        { model_name: 'mg-seedance2.0 -480p mini', supported_endpoint_types: ['openai-video', 'openai'], enable_groups: ['视频组'], group_pricing: { v: { group: '视频组', billing_mode: 'fixed_price', billing_unit: 'per_second', effective_model_price: 0.2004 } } },
        { model_name: 'gpt-image-2', supported_endpoint_types: ['image-generation', 'openai'], enable_groups: ['图片组'] },
        { model_name: 'gpt-5.4-mini', supported_endpoint_types: ['openai'], enable_groups: ['文本组'] },
        { model_name: 'gpt-5.6-sol', supported_endpoint_types: ['openai'], enable_groups: ['文本组'] },
      ],
    });
    assert.equal(result.video[0].model, 'mg-seedance2.0 -480p mini');
    assert.equal(result.video[0].cheapest_effective_price, 0.2004);
    assert.equal(result.video[0].capabilities.max_images, 4);
    assert.equal(result.video[0].capabilities.max_videos, 3);
    assert.equal(result.video[0].capabilities.max_audios, 1);
    assert.equal(result.video[0].capabilities.duration_min, 5);
    assert.equal(result.video[0].capabilities.duration_max, 15);
    assert.equal(result.image[0].model, 'gpt-image-2');
    assert.equal(result.text[0].model, 'gpt-5.6-sol');
  });

  it('uses the V0.1.2 video price snapshot while the public catalog is on the known stale revision', () => {
    const staleVideoPrice = (model, unit, value, group = '特价视频分组(即梦)') => ({
      model_name: model,
      supported_endpoint_types: ['openai-video', 'openai'],
      enable_groups: [group],
      group_pricing: {
        [group]: {
          group,
          billing_mode: unit === 'per_million_tokens' ? 'ratio' : 'fixed_price',
          billing_unit: unit,
          effective_model_price: value,
          effective_input_usd: unit === 'per_million_tokens' ? value : null,
          effective_output_usd: unit === 'per_million_tokens' ? value : null,
        },
      },
    });
    const result = normalizeYinziCatalog({
      success: true,
      pricing_version: 'a42d372ccf0b5dd13ecf71203521f9d2',
      data: [
        staleVideoPrice('mg-seedance2.0 -480p mini', 'per_second', 0.2004),
        staleVideoPrice('af-seedance-2.0', 'per_million_tokens', 90),
        staleVideoPrice('seedance-2.5-720p', 'per_million_tokens', 90),
        staleVideoPrice('grok-imagine-video', 'per_request', 0.1125, '视频模型渠道'),
        staleVideoPrice('MiniMax-H3-2k', 'per_second', 0.205, 'minimax/可灵视频'),
        staleVideoPrice('Kling VIDEO 3.0 Omni', 'per_request', 0.25, 'minimax/可灵视频'),
      ],
    });
    const price = (model) => result.video.find((item) => item.model === model).prices[0];
    assert.deepEqual(price('mg-seedance2.0 -480p mini'), {
      group: '特价视频分组(即梦)', billing_mode: 'fixed_price', billing_unit: 'per_second',
      effective_price: 0.1664, effective_input_usd: null, effective_output_usd: null,
      fixed_duration_seconds: null, allowed_durations: null, currency: 'CNY', source: 'yinzi-catalog-2026-08-16',
    });
    assert.equal(price('af-seedance-2.0').billing_unit, 'per_request');
    assert.equal(price('af-seedance-2.0').effective_price, 0.3484);
    assert.equal(price('seedance-2.5-720p').billing_unit, 'per_request');
    assert.equal(price('seedance-2.5-720p').effective_price, 3.5);
    assert.equal(price('grok-imagine-video').effective_price, 0.1125);
    assert.equal(price('MiniMax-H3-2k').effective_price, 0.20475);
    assert.equal(price('Kling VIDEO 3.0 Omni').effective_price, 0.25);
  });

  it('honors explicit endpoint types and does not leak a known text model into video', () => {
    const result = normalizeYinziCatalog({
      success: true,
      pricing_version: 'mixed-endpoint-v1',
      data: [
        {
          model_name: 'MiniMax-H3-4k',
          supported_endpoint_types: ['openai'],
          enable_groups: ['文本模型'],
        },
        {
          model_name: 'seedance-2.5-720p',
          supported_endpoint_types: ['openai-video'],
          enable_groups: ['视频模型'],
          group_pricing: {
            video: {
              group: '视频模型',
              billing_mode: 'fixed_price',
              billing_unit: 'per_second',
              effective_model_price: 0.672,
            },
          },
        },
        {
          // Legacy public rows may omit endpoint metadata. The exact local
          // registry hint remains valid only for this metadata-free shape.
          model_name: 'mg-seedance2.0 -480p mini',
          enable_groups: ['视频模型'],
        },
      ],
    });
    assert.equal(result.video.some((item) => item.model === 'MiniMax-H3-4k'), false);
    assert.equal(result.text.some((item) => item.model === 'MiniMax-H3-4k'), true);
    assert.equal(result.text.find((item) => item.model === 'MiniMax-H3-4k').capabilities, null);
    assert.equal(result.text.find((item) => item.model === 'MiniMax-H3-4k').contract_status, 'missing');
    assert.equal(result.video.some((item) => item.model === 'seedance-2.5-720p'), true);
    assert.equal(result.video.some((item) => item.model === 'mg-seedance2.0 -480p mini'), true);
  });
});

describe('normalizeYinziBaseUrl', () => {
  it('adds /v1 only when the URL has no API path', () => {
    assert.equal(normalizeYinziBaseUrl('https://api.yinziapi.top'), 'https://api.yinziapi.top/v1');
    assert.equal(normalizeYinziBaseUrl('https://relay.example/api/v1/'), 'https://relay.example/api/v1');
  });
});

describe('fetchYinziCatalogForConfig', () => {
  it('parses the standard data capability contract and preserves unknown limits', async () => {
    const headersSeen = [];
    const fetchImpl = async (_url, options) => {
      headersSeen.push(options.headers);
      return {
        ok: true,
        status: 200,
        headers: { get(name) { return name.toLowerCase() === 'etag' ? '"data-v1"' : null; } },
        async json() {
          return {
            schema_version: 'yinzi.model-capability-catalog/v1',
            catalog_revision: 'data-v1',
            scope: { group: 'smart-video', token_model_limit_applied: true },
            data: [{
              id: 'seedance-2.5-720p',
              endpoint_types: ['openai-video'],
              contract_status: 'active',
              validation_status: 'verified',
              transport: {
                protocol: 'yinzi-video-v1',
                create: { method: 'POST', path: '/videos' },
                query: { method: 'GET', path_template: '/videos/{task_id}' },
              },
              capabilities: {
                generation: { duration: { mode: 'range', min_seconds: 5, max_seconds: 15 }, resolutions: ['720p'] },
                references: {
                  limits: { images: 0 },
                  roles: { image: ['reference'], video: ['reference'] },
                  videos: { max: 3 },
                  files: {
                    max_image_bytes: 31457280,
                    max_video_bytes: 52428800,
                    max_audio_bytes: 15728640,
                  },
                },
                routing: { automatic_eligible: true },
              },
              pricing: { currency: 'CNY', billing_unit: 'per_second', unit_price: 0.672 },
            }, {
              id: 'gpt-5.6-sol',
              contract_status: 'active',
              capabilities: { routing: { automatic_eligible: true } },
            }],
          };
        },
      };
    };
    const catalog = await fetchYinziCatalogForConfig(
      { base_url: 'https://standard-data.example/v1', api_key: 'standard-key' },
      fetchImpl
    );
    const item = catalog.video[0];
    assert.equal(catalog.catalog_format, 'data');
    assert.equal(catalog.scope.group, 'smart-video');
    assert.equal(catalog.etag, '"data-v1"');
    assert.equal(catalog.video.length, 1, 'untyped standard entries are not invented as video models');
    assert.equal(item.model, 'seedance-2.5-720p');
    assert.equal(item.capabilities.max_images, 0, 'explicit zero remains unsupported');
    assert.equal(item.capabilities.max_videos, 3);
    assert.equal(Object.hasOwn(item.capabilities, 'max_audios'), false, 'missing field stays unknown');
    assert.equal(Object.hasOwn(item.capabilities, 'max_total_references'), false, 'missing field stays unknown');
    assert.equal(item.capabilities.max_image_bytes, 31457280);
    assert.equal(item.capabilities.max_video_bytes, 52428800);
    assert.equal(item.capabilities.max_audio_bytes, 15728640);
    assert.equal(Object.hasOwn(item.capabilities, 'route_profiles'), false, 'provider contract need not invent local route labels');
    assert.equal(item.capabilities.provider_query_path, '/videos/{task_id}');
    assert.equal(item.prices[0].effective_price, 0.672);
    assert.equal(headersSeen[0].Accept.includes('yinzi.model-capability'), true);
  });

  it('reuses a same-key ETag cache on HTTP 304 without sharing it across keys', async () => {
    let call = 0;
    const requests = [];
    const fetchImpl = async (_url, options) => {
      requests.push(options.headers);
      call += 1;
      if (call === 1) return {
        ok: true, status: 200,
        headers: { get() { return '"etag-v1"'; } },
        async json() { return { data: [{ id: 'etag-video', endpoint_types: ['openai-video'], capabilities: { routing: { automatic_eligible: true } } }] }; },
      };
      if (call === 2) return { ok: false, status: 304, headers: { get() { return '"etag-v1"'; } } };
      return {
        ok: true, status: 200,
        headers: { get() { return '"etag-other"'; } },
        async json() { return { data: [{ id: 'other-key-video', endpoint_types: ['openai-video'] }] }; },
      };
    };
    const config = { base_url: 'https://etag.example/v1', api_key: 'etag-key' };
    const first = await require('../src/services/yinziService').fetchYinziCapabilityCatalog(config, fetchImpl, { force_refresh: true });
    const second = await require('../src/services/yinziService').fetchYinziCapabilityCatalog(config, fetchImpl, { force_refresh: true });
    const other = await require('../src/services/yinziService').fetchYinziCapabilityCatalog({ ...config, api_key: 'other-key' }, fetchImpl, { force_refresh: true });
    assert.equal(first.video[0].model, 'etag-video');
    assert.equal(second.video[0].model, 'etag-video');
    assert.equal(second.cache_status, 'not_modified');
    assert.equal(other.video[0].model, 'other-key-video');
    assert.equal(requests[1]['If-None-Match'], '"etag-v1"');
    assert.equal(requests[2]['If-None-Match'], undefined, 'ETag is isolated by key');
  });

  it('uses the key-scoped capability catalog and preserves Seedance 2.5 reference limits', async () => {
    let request = null;
    const fetchImpl = async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            schema_version: 'yinzi.model-capability-catalog/v1',
            catalog_revision: 'cap-v1',
            models: [{
              group: 'video', model: 'seedance-2.5-720p', contract_status: 'active', automatic_eligible: true,
              local_pricing: { billing_mode: 'fixed_price', use_price: true, model_price: 0.7644, task_profile: { unit: 'per_second' } },
              capabilities: {
                schema_version: 'relayops.model-capability-contract/v1', contract_id: 'seedance-25', revision: 'r1',
                target: { site_id: 1, group: 'video', model: 'seedance-2.5-720p' },
                provider: { protocol: 'aizzz-video-v1', endpoint_types: ['openai-video'], create: { method: 'POST', path: '/videos' } },
                generation: { duration: { mode: 'free', min: 5, max: 15, step: 1 }, resolutions: ['720p'], quality: 'quality' },
                references: {
                  images: { roles: ['reference'], max: 30, max_bytes: 31457280 },
                  videos: { roles: ['reference'], max: 10, max_total_duration_seconds: 29 },
                  audios: { roles: ['reference'], max: 10 }, max_total: 50, prompt_max_chars: 4000,
                },
                routing: { automatic_eligible: true, expensive: false, manual_only: false, requires_explicit_confirmation: false },
                provenance: { source_kind: 'document', generated_at: '2026-08-16T00:00:00Z', validation_status: 'validated' },
              },
            }],
          };
        },
      };
    };
    const catalog = await fetchYinziCatalogForConfig({ base_url: 'https://relay-cap.example/v1', api_key: 'capability-key-1' }, fetchImpl);
    assert.equal(request.url, 'https://relay-cap.example/v1/model-capabilities');
    assert.equal(request.options.headers.Authorization, 'Bearer capability-key-1');
    assert.equal(catalog.catalog_verified, true);
    assert.equal(catalog.video[0].capabilities.max_images, 30);
    assert.equal(catalog.video[0].capabilities.max_videos, 10);
    assert.equal(catalog.video[0].capabilities.max_audios, 10);
    assert.equal(catalog.video[0].automatic_eligible, true);
  });

  it('keeps missing contracts visible but manual-only', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, async json() {
      return { catalog_revision: 'cap-missing', models: [{ group: 'video', model: 'new-video', contract_status: 'missing', capabilities: null, local_pricing: {} }] };
    } });
    const catalog = await fetchYinziCatalogForConfig({ base_url: 'https://relay-missing.example/v1', api_key: 'capability-key-2' }, fetchImpl);
    assert.equal(catalog.video[0].model, 'new-video');
    assert.equal(catalog.video[0].capabilities, null);
    assert.equal(catalog.video[0].contract_status, 'missing');
    assert.equal(catalog.video[0].automatic_eligible, false);
  });

  it('treats an HTTP 200 degraded capability catalog as deferred and unverified', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get() { return '"degraded-v1"'; } },
      async json() {
        return {
          schema_version: 'yinzi.model-capability-catalog/v1',
          catalog_revision: 'degraded-v1',
          capability_data_available: false,
          advisory: 'capability data is temporarily unavailable',
          groups: [],
          models: [],
        };
      },
    });
    const catalog = await fetchYinziCatalogForConfig(
      { base_url: 'https://relay-degraded.example/v1', api_key: 'capability-key-degraded' },
      fetchImpl,
    );
    assert.equal(catalog.catalog_verified, false);
    assert.equal(catalog.capability_data_available, false);
    assert.equal(catalog.capability_outcome, 'deferred');
    assert.equal(catalog.video.length, 0);
    assert.match(catalog.warnings[0], /视频能力目录暂不可用/);
    assert.match(catalog.warnings[1], /temporarily unavailable/);
  });

  it('falls back for an unavailable capability endpoint and marks the result unverified', async () => {
    let call = 0;
    const fetchImpl = async () => {
      call += 1;
      if (call === 1) return { ok: false, status: 404 };
      return { ok: true, status: 200, async json() { return { success: true, pricing_version: 'legacy-v1', data: [] }; } };
    };
    const catalog = await fetchYinziCatalogForConfig({ base_url: 'https://relay-legacy.example/v1', api_key: 'capability-key-3' }, fetchImpl);
    assert.equal(call, 2);
    assert.equal(catalog.source, 'legacy_fallback');
    assert.equal(catalog.catalog_verified, false);
    assert.equal(catalog.capability_outcome, 'deferred');
    assert.match(catalog.warnings[0], /模型能力合同暂不可用/);
  });

  it('keeps the optional capability and pricing failures non-blocking', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401 });
    const catalog = await fetchYinziCatalogForConfig(
      { base_url: 'https://relay-auth.example/v1', api_key: 'capability-key-4' },
      fetchImpl
    );
    assert.equal(catalog.source, 'discovery_only');
    assert.equal(catalog.capability_outcome, 'deferred');
    assert.equal(catalog.video.length, 0);
    assert.match(catalog.fallback_reason, /HTTP 401/);
    assert.match(catalog.pricing_fallback_reason, /HTTP 401/);
  });
});

describe('prepareYinziSetupInput', () => {
  it('keeps a mixed smart-key catalog out of the video list and separates public-only models', async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith('/models')) {
        return { ok: true, status: 200, async json() { return { data: [
          { id: 'gpt-5.6-sol', supported_endpoint_types: ['openai'] },
          { id: 'gpt-image-2', supported_endpoint_types: ['openai', 'image-generation'] },
          { id: 'grok-imagine-video', supported_endpoint_types: ['openai', 'openai-video'] },
        ] }; } };
      }
      if (url.endsWith('/model-capabilities')) return { ok: false, status: 500 };
      if (url === 'https://yinziapi.top/api/pricing') {
        const video = (model, price) => ({
          model_name: model,
          supported_endpoint_types: ['openai-video', 'openai'],
          enable_groups: ['video'],
          group_pricing: { video: { group: 'video', billing_mode: 'fixed_price', billing_unit: 'per_request', effective_model_price: price } },
        });
        return { ok: true, status: 200, async json() { return {
          success: true,
          pricing_version: 'smart-key-mixed-v1',
          data: [
            video('grok-imagine-video', 0.1),
            video('seedance-2.5-720p', 0.5),
            video('Kling VIDEO 3.0 Omni', 0.2),
            {
              model_name: 'MiniMax-H3-4k',
              supported_endpoint_types: ['openai'],
              enable_groups: ['minimax/可灵视频'],
              group_pricing: {
                video: {
                  group: 'minimax/可灵视频',
                  billing_mode: 'fixed_price',
                  billing_unit: 'per_request',
                  effective_model_price: 0.325,
                },
              },
            },
          ],
        }; } };
      }
      throw new Error(`unexpected URL ${url}`);
    };
    const prepared = await prepareYinziSetupInput({
      base_url: 'https://api.yinziapi.top/v1', api_key: 'smart-key',
    }, fetchImpl);
    assert.deepEqual(prepared.text_models, ['gpt-5.6-sol']);
    assert.deepEqual(prepared.image_models, ['gpt-image-2']);
    assert.deepEqual(prepared.video_models, ['grok-imagine-video', 'seedance-2.5-720p', 'Kling VIDEO 3.0 Omni']);
    assert.equal(prepared.video_model, 'grok-imagine-video');
    assert.equal(prepared.setup_catalog.credential_video_model_count, 1);
    assert.equal(prepared.setup_catalog.public_video_model_count, 2);
    assert.equal(prepared.setup_catalog.selection_reason, 'only_current_key_video_model');
    assert.equal(prepared.setup_catalog.models.some((item) => item.model === 'gpt-5.6-sol'), false);
    assert.equal(prepared.setup_catalog.models.some((item) => item.model === 'MiniMax-H3-4k'), false);
  });

  it('prefers Seedance when both Seedance and Grok are verified for the current key', async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith('/models')) return { ok: true, status: 200, async json() { return { data: [
        { id: 'gpt-5.6-sol', supported_endpoint_types: ['openai'] },
        { id: 'gpt-image-2', supported_endpoint_types: ['openai', 'image-generation'] },
        { id: 'grok-imagine-video', supported_endpoint_types: ['openai', 'openai-video'] },
        { id: 'mg-seedance2.0 -480p mini', supported_endpoint_types: ['openai', 'openai-video'] },
      ] }; } };
      if (url.endsWith('/model-capabilities')) return { ok: false, status: 500 };
      if (url === 'https://yinziapi.top/api/pricing') return { ok: true, status: 200, async json() { return {
        success: true, pricing_version: 'smart-key-seedance-v1', data: [
          { model_name: 'grok-imagine-video', supported_endpoint_types: ['openai-video'], enable_groups: ['video'], group_pricing: { video: { group: 'video', billing_mode: 'fixed_price', billing_unit: 'per_request', effective_model_price: 0.01 } } },
          { model_name: 'mg-seedance2.0 -480p mini', supported_endpoint_types: ['openai-video'], enable_groups: ['video'], group_pricing: { video: { group: 'video', billing_mode: 'fixed_price', billing_unit: 'per_second', effective_model_price: 0.2 } } },
        ],
      }; } };
      throw new Error(`unexpected URL ${url}`);
    };
    const prepared = await prepareYinziSetupInput({ base_url: 'https://api.yinziapi.top/v1', api_key: 'smart-key' }, fetchImpl);
    assert.equal(prepared.video_model, 'mg-seedance2.0 -480p mini');
    assert.equal(prepared.setup_catalog.selection_reason, 'current_key_seedance_preferred');
  });

  it('keeps public Seedance offers manual-only when the smart Key exposes only Grok', async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith('/models')) return { ok: true, status: 200, async json() { return { data: [
        { id: 'gpt-5.6-sol', supported_endpoint_types: ['openai'] },
        { id: 'gpt-image-2', supported_endpoint_types: ['openai', 'image-generation'] },
        { id: 'grok-imagine-video', supported_endpoint_types: ['openai', 'openai-video'] },
      ] }; } };
      if (url.endsWith('/model-capabilities')) return { ok: false, status: 500 };
      if (url === 'https://yinziapi.top/api/pricing') return { ok: true, status: 200, async json() { return {
        success: true, pricing_version: 'smart-key-seedance-25-v1', data: [
          { model_name: 'grok-imagine-video', supported_endpoint_types: ['openai-video'], enable_groups: ['video'], group_pricing: { video: { group: 'video', billing_mode: 'fixed_price', billing_unit: 'per_request', effective_model_price: 0.01 } } },
          { model_name: 'seedance2.0 720p-pro-nv-nsp', supported_endpoint_types: ['openai-video'], enable_groups: ['video'], group_pricing: { video: { group: 'video', billing_mode: 'fixed_price', billing_unit: 'per_request', effective_model_price: 0.1 } } },
          { model_name: 'seedance-2.5-720p', supported_endpoint_types: ['openai-video'], enable_groups: ['video'], group_pricing: { video: { group: 'video', billing_mode: 'fixed_price', billing_unit: 'per_second', effective_model_price: 0.672 } } },
        ],
      }; } };
      throw new Error(`unexpected URL ${url}`);
    };
    const prepared = await prepareYinziSetupInput({
      base_url: 'https://api.yinziapi.top/v1', api_key: 'smart-key', routing_mode: 'smart',
    }, fetchImpl);
    assert.equal(prepared.video_model, 'grok-imagine-video');
    assert.ok(prepared.video_models.includes('seedance2.0 720p-pro-nv-nsp'));
    const unavailable = prepared.setup_catalog.models.find((item) => item.model === 'seedance2.0 720p-pro-nv-nsp');
    assert.equal(unavailable.automatic_eligible, false);
    assert.equal(unavailable.smart_routing_candidate, false);
    assert.equal(unavailable.manual_only, true);
    const seedance = prepared.setup_catalog.models.find((item) => item.model === 'seedance-2.5-720p');
    assert.equal(seedance.smart_routing_candidate, false);
    assert.equal(seedance.manual_only, true);
    assert.equal(prepared.setup_catalog.selection_reason, 'only_current_key_video_model');
  });

  it('configures every key-scoped model when the live capability endpoint returns HTTP 500', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.endsWith('/models')) {
        return { ok: true, status: 200, async json() { return { data: [
          { id: 'gpt-5.6-sol', supported_endpoint_types: ['openai'] },
          { id: 'gpt-image-2', supported_endpoint_types: ['openai', 'image-generation'] },
          { id: 'mg-seedance2.0 -480p mini', supported_endpoint_types: ['openai', 'openai-video'] },
          { id: 'new-smart-route-video', supported_endpoint_types: ['openai', 'openai-video'] },
        ] }; } };
      }
      if (url.endsWith('/model-capabilities')) return { ok: false, status: 500 };
      if (url === 'https://yinziapi.top/api/pricing') {
        return { ok: true, status: 200, async json() { return {
          success: true,
          pricing_version: 'smart-route-price-v1',
          data: [{
            model_name: 'mg-seedance2.0 -480p mini',
            supported_endpoint_types: ['openai', 'openai-video'],
            enable_groups: ['video'],
            group_pricing: { video: { group: 'video', billing_mode: 'fixed_price', billing_unit: 'per_second', effective_model_price: 0.2 } },
          }],
        }; } };
      }
      throw new Error(`unexpected URL ${url}`);
    };
    const prepared = await prepareYinziSetupInput({
      base_url: 'https://api.yinziapi.top/v1',
      api_key: 'smart-route-key',
    }, fetchImpl);
    assert.equal(calls.filter((url) => url.endsWith('/models')).length, 1);
    assert.deepEqual(prepared.video_models.sort(), ['mg-seedance2.0 -480p mini', 'new-smart-route-video']);
    assert.equal(prepared.setup_catalog.video_model_count, 2);
    assert.equal(prepared.setup_catalog.models.length, 2);
    assert.equal(prepared.setup_catalog.availability_scope, 'credential');
    assert.equal(prepared.setup_catalog.scope_verified, true);
    assert.equal(prepared.setup_catalog.capability_outcome, 'deferred');
    assert.match(prepared.setup_catalog.warnings[0], /HTTP 500/);
    const unknown = prepared.setup_catalog.models.find((item) => item.model === 'new-smart-route-video');
    assert.ok(unknown);
    assert.equal(unknown.availability_scope, 'credential');
    assert.equal(unknown.scope_verified, true);
  });

  it('preserves the user video configuration when the directory returns 401', async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith('/models')) return { ok: false, status: 401 };
      throw new Error(`unexpected URL ${url}`);
    };
    const result = await prepareYinziSetupInput({ base_url: 'https://api.yinziapi.top/v1', api_key: 'bad-key', video_model: 'user-video-model' }, fetchImpl);
    assert.equal(result.video_model, 'user-video-model');
    assert.ok(result.setup_catalog.warnings.some(item => /401/.test(item)));
    assert.equal(result.setup_catalog.scope_verified, false);
  });
});

describe('upsertYinziConfigs', () => {
  it('atomically creates four configs, uses separate keys, and never returns secrets', () => {
    const db = createConfigDb();
    const result = upsertYinziConfigs(db, log, {
      base_url: 'https://api.yinziapi.top/v1',
      text_api_key: 'text-secret',
      image_api_key: 'image-secret',
      video_api_key: 'video-secret',
      text_model: 'gpt-5.4-mini',
      image_model: 'gpt-image-2',
      video_model: 'mg-seedance2.0 -480p mini',
    });
    assert.equal(result.configured.length, 4);
    assert.equal(JSON.stringify(result).includes('secret'), false);
    const rows = db.prepare('SELECT service_type, api_key, api_protocol, model FROM ai_service_configs ORDER BY id').all();
    assert.deepEqual(rows.map((row) => row.api_key), ['text-secret', 'image-secret', 'image-secret', 'video-secret']);
    assert.equal(rows[3].api_protocol, 'yinzi');
    assert.equal(JSON.parse(rows[3].model)[0], 'mg-seedance2.0 -480p mini');
  });

  it('updates existing Yinzi configs instead of creating duplicates', () => {
    const db = createConfigDb();
    const base = {
      base_url: 'https://api.yinziapi.top/v1',
      text_api_key: 'a', image_api_key: 'b', video_api_key: 'c',
      text_model: 'gpt-5.4-mini', image_model: 'gpt-image-2', video_model: 'mg-seedance2.0 -480p mini',
    };
    upsertYinziConfigs(db, log, base);
    upsertYinziConfigs(db, log, { ...base, video_api_key: 'new-video-key' });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_service_configs WHERE deleted_at IS NULL").get().n, 4);
    assert.equal(db.prepare("SELECT api_key FROM ai_service_configs WHERE service_type='video' AND deleted_at IS NULL").get().api_key, 'new-video-key');
  });
});
