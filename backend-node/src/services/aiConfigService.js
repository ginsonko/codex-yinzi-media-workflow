// AI 配置 CRUD，与 Go application/services/ai_service.go 对齐
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { normalizeMaterialHubToken } = require('./jimengMaterialHubService');
const { getYinziVideoCapability } = require('./yinziVideoCapabilities');

function normalizeApiKeyForService(serviceType, apiKey) {
  if (serviceType === 'jimeng2_character_auth' && apiKey != null) {
    return normalizeMaterialHubToken(apiKey);
  }
  return apiKey;
}
const { applyDeepSeekConnectivityOptions } = require('./deepseekConfig');
function modelToDb(model) {
  if (model == null) return null;
  if (Array.isArray(model)) return JSON.stringify(model);
  if (typeof model === 'string') return JSON.stringify([model]);
  return JSON.stringify([]);
}

function modelFromDb(val) {
  if (val == null || val === '') return [];
  try {
    const arr = JSON.parse(val);
    return Array.isArray(arr) ? arr : [String(arr)];
  } catch {
    return [String(val)];
  }
}

const CAPABILITY_STRING_FIELDS = new Set([
  'provider_contract', 'family', 'duration_mode', 'resolution', 'quality_tier', 'exclusion_reason',
]);
const CAPABILITY_BOOLEAN_FIELDS = new Set([
  'automatic_eligible', 'expensive_bypass', 'requires_director_preview',
]);
const CAPABILITY_NUMBER_FIELDS = new Set([
  'duration_min', 'duration_max', 'auto_duration_min', 'auto_duration_max', 'fixed_duration_seconds',
  'duration_step', 'max_images', 'max_videos', 'max_audios', 'max_total_references',
  'max_reference_video_seconds_total', 'max_prompt_chars', 'provider_prompt_hard_max_chars',
  'max_image_bytes', 'max_video_bytes', 'max_audio_bytes', 'preference_rank',
]);
const CAPABILITY_ARRAY_FIELDS = new Set(['route_profiles']);
const CAPABILITY_OBJECT_FIELDS = new Set(['roles']);
const CAPABILITY_FIELDS = new Set([
  ...CAPABILITY_STRING_FIELDS,
  ...CAPABILITY_BOOLEAN_FIELDS,
  ...CAPABILITY_NUMBER_FIELDS,
  ...CAPABILITY_ARRAY_FIELDS,
  ...CAPABILITY_OBJECT_FIELDS,
]);
const CAPABILITY_ROUTE_PROFILES = new Set(['short_image_guided', 'long_previs_guided']);
const CAPABILITY_MEDIA_TYPES = new Set(['image', 'video', 'audio']);

function parseSettings(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return { ...value };
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

const TEXT_CONFIG_LIMIT = 100;

function ensureMetadataColumn(db) {
  try {
    const columns = db.prepare('PRAGMA table_info(ai_service_configs)').all().map((item) => item.name);
    if (!columns.includes('metadata_json')) db.exec('ALTER TABLE ai_service_configs ADD COLUMN metadata_json TEXT');
  } catch (_) { /* callers using a read-only legacy database keep the old contract */ }
}

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return { ...value };
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) { return {}; }
}

function normalizeMetadata(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const metadata = {};
  const note = String(input.note ?? input.notes ?? '').trim();
  if (note) metadata.note = note.slice(0, 500);
  const useCases = Array.isArray(input.use_cases)
    ? input.use_cases.map((item) => String(item || '').trim().slice(0, 80)).filter(Boolean).slice(0, 20)
    : String(input.use_cases || '').split(/[\n,，]/).map((item) => item.trim().slice(0, 80)).filter(Boolean).slice(0, 20);
  if (useCases.length) metadata.use_cases = [...new Set(useCases)];
  const capability = input.capability && typeof input.capability === 'object' && !Array.isArray(input.capability) ? input.capability : {};
  const safeCapability = {};
  for (const key of ['resolution', 'quality_tier', 'price_unit', 'price_notes', 'fallback_group']) {
    const value = String(capability[key] ?? '').trim();
    if (value) safeCapability[key] = value.slice(0, 160);
  }
  for (const key of ['supports_1k', 'supports_2k', 'supports_4k', 'supports_reference', 'supports_audio']) {
    if (typeof capability[key] === 'boolean') safeCapability[key] = capability[key];
  }
  for (const key of ['price_cny', 'max_duration_seconds']) {
    if (capability[key] === '' || capability[key] == null) continue;
    const number = Number(capability[key]);
    if (Number.isFinite(number) && number >= 0 && number <= 1e9) safeCapability[key] = number;
  }
  if (Object.keys(safeCapability).length) metadata.capability = safeCapability;
  const tags = Array.isArray(input.tags) ? input.tags : String(input.tags || '').split(/[\n,，]/);
  const cleanTags = [...new Set(tags.map((item) => String(item || '').trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
  if (cleanTags.length) metadata.tags = cleanTags;
  return metadata;
}

function getConfigMetadata(config) {
  return normalizeMetadata(parseMetadata(config?.metadata_json || config?.metadata));
}

function assertConfigCapacity(db, serviceType, existingId = null) {
  if (serviceType !== 'text') return;
  const row = db.prepare('SELECT COUNT(*) AS count FROM ai_service_configs WHERE deleted_at IS NULL AND service_type = ? AND id != COALESCE(?, -1)').get(serviceType, existingId);
  if (Number(row?.count || 0) >= TEXT_CONFIG_LIMIT) {
    const error = new Error(`文本模型配置最多保存 ${TEXT_CONFIG_LIMIT} 条，请先删除不需要的配置`);
    error.code = 'TEXT_CONFIG_LIMIT_REACHED';
    error.details = { limit: TEXT_CONFIG_LIMIT, service_type: serviceType };
    throw error;
  }
}

function candidateConfigs(db, input = {}) {
  const serviceType = String(input.service_type || 'text').trim();
  const configs = listConfigs(db, serviceType)
    .filter((config) => config.is_active)
    .map((config) => ({
      ...toPublicConfig(config),
      metadata: getConfigMetadata(config),
      selection_reason: config.is_default ? '默认配置' : '按优先级候选',
    }));
  return { service_type: serviceType, count: configs.length, limit: serviceType === 'text' ? TEXT_CONFIG_LIMIT : null, items: configs };
}

function normalizeModelCapabilityOverride(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    const error = new Error('模型能力提示必须是对象');
    error.code = 'MODEL_CAPABILITY_INVALID';
    throw error;
  }
  const unknown = Object.keys(input).filter((key) => !CAPABILITY_FIELDS.has(key));
  if (unknown.length) {
    const error = new Error(`模型能力提示包含未知字段：${unknown.join(', ')}`);
    error.code = 'MODEL_CAPABILITY_UNKNOWN_FIELD';
    throw error;
  }
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (CAPABILITY_STRING_FIELDS.has(key)) {
      const text = String(value ?? '').trim();
      if (text) output[key] = text.slice(0, 200);
      continue;
    }
    if (CAPABILITY_BOOLEAN_FIELDS.has(key)) {
      if (typeof value !== 'boolean') {
        const error = new Error(`模型能力提示字段 ${key} 必须是布尔值`);
        error.code = 'MODEL_CAPABILITY_INVALID';
        throw error;
      }
      output[key] = value;
      continue;
    }
    if (CAPABILITY_NUMBER_FIELDS.has(key)) {
      if (value === '' || value == null) continue;
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0 || number > 1_000_000_000) {
        const error = new Error(`模型能力提示字段 ${key} 必须是非负数字`);
        error.code = 'MODEL_CAPABILITY_INVALID';
        throw error;
      }
      output[key] = number;
      continue;
    }
    if (CAPABILITY_ARRAY_FIELDS.has(key)) {
      if (!Array.isArray(value)) {
        const error = new Error(`模型能力提示字段 ${key} 必须是数组`);
        error.code = 'MODEL_CAPABILITY_INVALID';
        throw error;
      }
      output[key] = [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
        .filter((item) => CAPABILITY_ROUTE_PROFILES.has(item));
      continue;
    }
    if (CAPABILITY_OBJECT_FIELDS.has(key)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        const error = new Error(`模型能力提示字段 ${key} 必须是对象`);
        error.code = 'MODEL_CAPABILITY_INVALID';
        throw error;
      }
      const roles = {};
      for (const [mediaType, rolesValue] of Object.entries(value)) {
        if (!CAPABILITY_MEDIA_TYPES.has(mediaType) || !Array.isArray(rolesValue)) continue;
        roles[mediaType] = [...new Set(rolesValue.map((role) => String(role || '').trim()).filter(Boolean))]
          .slice(0, 12);
      }
      output[key] = roles;
    }
  }
  if (!Object.keys(output).length) {
    const error = new Error('至少填写一项模型能力提示');
    error.code = 'MODEL_CAPABILITY_EMPTY';
    throw error;
  }
  return output;
}

function normalizeCapabilityOverrideMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [model, override] of Object.entries(value)) {
    const name = String(model || '').trim();
    if (!name || !override || typeof override !== 'object' || Array.isArray(override)) continue;
    try { result[name] = normalizeModelCapabilityOverride(override); } catch (_) {}
  }
  return result;
}

function getModelCapabilityOverrides(config) {
  const settings = parseSettings(config?.settings);
  return normalizeCapabilityOverrideMap(settings.model_capability_overrides);
}

function findModelCapabilityOverride(overrides, model) {
  const target = String(model || '').trim().toLowerCase();
  if (!target) return null;
  const key = Object.keys(overrides || {}).find((item) => item.toLowerCase() === target);
  return key ? overrides[key] : null;
}

function mergeModelCapability(base, override) {
  if (!override) return base || null;
  const fallback = {
    provider_contract: 'local-advisory',
    family: 'local-model',
    duration_mode: 'range',
    duration_min: 1,
    duration_max: 15,
    auto_duration_min: 1,
    auto_duration_max: 15,
    max_images: 0,
    max_videos: 0,
    max_audios: 0,
    max_total_references: 0,
    max_reference_video_seconds_total: 0,
    automatic_eligible: false,
    expensive_bypass: false,
    requires_director_preview: false,
    route_profiles: ['short_image_guided', 'long_previs_guided'],
    roles: { image: ['reference'], video: [], audio: [] },
  };
  const merged = { ...(base || fallback), ...override };
  if (base?.roles || override.roles) merged.roles = { ...(base?.roles || fallback.roles), ...(override.roles || {}) };
  if (override.route_profiles) merged.route_profiles = [...override.route_profiles];
  return merged;
}

function modelCapabilityStates(config) {
  const overrides = getModelCapabilityOverrides(config);
  const snapshotModels = parseSettings(config?.settings)?.model_catalog_snapshot?.models;
  const names = new Set([
    ...(Array.isArray(config?.model) ? config.model : []),
    ...(Array.isArray(snapshotModels) ? snapshotModels.map((item) => item?.model || item) : []),
    ...Object.keys(overrides),
  ].map((item) => String(item || '').trim()).filter(Boolean));
  return [...names].map((model) => {
    const builtin = getYinziVideoCapability(model);
    const override = findModelCapabilityOverride(overrides, model);
    const effective = mergeModelCapability(builtin, override);
    return {
      model,
      source: builtin && override ? 'builtin+local' : override ? 'local' : builtin ? 'builtin' : 'unknown',
      contract_status: builtin ? 'known' : override ? 'local' : 'missing',
      override: override || null,
      capability: effective,
      automatic_eligible: effective?.automatic_eligible === true,
    };
  });
}

function updateModelCapabilityOverride(db, log, id, model, capability) {
  const config = getConfig(db, id);
  if (!config) return null;
  const name = String(model || '').trim();
  if (!name) {
    const error = new Error('模型名不能为空');
    error.code = 'MODEL_CAPABILITY_MODEL_REQUIRED';
    throw error;
  }
  const normalized = normalizeModelCapabilityOverride(capability);
  const settings = parseSettings(config.settings);
  const overrides = normalizeCapabilityOverrideMap(settings.model_capability_overrides);
  const existingKey = Object.keys(overrides).find((item) => item.toLowerCase() === name.toLowerCase()) || name;
  overrides[existingKey] = normalized;
  settings.model_capability_overrides = overrides;
  const now = new Date().toISOString();
  db.prepare('UPDATE ai_service_configs SET settings = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(settings), now, id);
  log.info('AI model capability override updated', { config_id: id, model: existingKey });
  return getConfig(db, id);
}

function resetModelCapabilityOverride(db, log, id, model) {
  const config = getConfig(db, id);
  if (!config) return null;
  const name = String(model || '').trim();
  if (!name) {
    const error = new Error('模型名不能为空');
    error.code = 'MODEL_CAPABILITY_MODEL_REQUIRED';
    throw error;
  }
  const settings = parseSettings(config.settings);
  const overrides = normalizeCapabilityOverrideMap(settings.model_capability_overrides);
  const key = Object.keys(overrides).find((item) => item.toLowerCase() === name.toLowerCase());
  if (key) delete overrides[key];
  if (Object.keys(overrides).length) settings.model_capability_overrides = overrides;
  else delete settings.model_capability_overrides;
  db.prepare('UPDATE ai_service_configs SET settings = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(settings), new Date().toISOString(), id);
  log.info('AI model capability override reset', { config_id: id, model: name });
  return getConfig(db, id);
}

/** 每种服务类型只保留一个默认：若有多个 is_default=1，只保留优先级最高（同优先级取 id 最小）的那条 */
function ensureSingleDefaultPerType(db) {
  const types = ['text', 'image', 'storyboard_image', 'video', 'tts', 'jimeng2_character_auth', 'model_ark_asset'];
  for (const st of types) {
    const rows = db.prepare(
      'SELECT id, priority FROM ai_service_configs WHERE deleted_at IS NULL AND service_type = ? AND is_default = 1 ORDER BY priority DESC, id ASC'
    ).all(st);
    if (rows.length <= 1) continue;
    const keepId = rows[0].id;
    db.prepare(
      'UPDATE ai_service_configs SET is_default = 0 WHERE deleted_at IS NULL AND service_type = ? AND id != ?'
    ).run(st, keepId);
  }
}

function listConfigs(db, serviceType) {
  ensureMetadataColumn(db);
  ensureSingleDefaultPerType(db);
  const order = 'ORDER BY is_default DESC, priority DESC, created_at DESC';
  let sql = 'SELECT * FROM ai_service_configs WHERE deleted_at IS NULL ' + order;
  const params = [];
  if (serviceType) {
    sql = 'SELECT * FROM ai_service_configs WHERE deleted_at IS NULL AND service_type = ? ' + order;
    params.push(serviceType);
  }
  const rows = params.length ? db.prepare(sql).all(...params) : db.prepare(sql).all();
  return rows.map(rowToConfig);
}

function clearOtherDefault(db, serviceType, exceptId) {
  const stmt = db.prepare(
    'UPDATE ai_service_configs SET is_default = 0 WHERE deleted_at IS NULL AND service_type = ? AND id != ?'
  );
  stmt.run(serviceType, exceptId);
}

function getConfig(db, id) {
  const row = db.prepare('SELECT * FROM ai_service_configs WHERE id = ? AND deleted_at IS NULL').get(id);
  return row ? rowToConfig(row) : null;
}

function createConfig(db, log, req) {
  ensureMetadataColumn(db);
  const serviceType = req.service_type || 'text';
  assertConfigCapacity(db, serviceType);
  const now = new Date().toISOString();
  const model = modelToDb(req.model);
  const metadata = normalizeMetadata(req.metadata ?? req.metadata_json);
  let endpoint = req.endpoint || '';
  let queryEndpoint = req.query_endpoint || '';
  if (!endpoint && req.provider) {
    const p = req.provider.toLowerCase();
    const st = (req.service_type || 'text').toLowerCase();
    if (p === 'openai') {
      if (st === 'text') endpoint = '/chat/completions';
      else if (st === 'image') endpoint = '/images/generations';
      else if (st === 'video') {
        endpoint = '/videos';
        queryEndpoint = '/videos/{taskId}';
      }
    } else if (p === 'gemini' || p === 'google') {
      endpoint = '/v1beta/models/{model}:generateContent';
    } else if (p === 'dashscope' || p === 'qwen_image') {
      if (st === 'image' || st === 'storyboard_image') endpoint = '/api/v1/services/aigc/multimodal-generation/generation';
      else if (st === 'video' && p === 'dashscope') {
        endpoint = '/api/v1/services/aigc/image2video/video-synthesis';
        queryEndpoint = '/api/v1/tasks/{taskId}';
      }
    } else if (p === 'volces' || p === 'volcengine' || p === 'volc') {
      if (st === 'video') {
        endpoint = '/contents/generations/tasks';
        queryEndpoint = '/contents/generations/tasks/{taskId}';
      } else if (st === 'image' || st === 'storyboard_image') {
        endpoint = '/images/generations';
      }
    } else if (p === 'nano_banana') {
      if (st === 'image' || st === 'storyboard_image') {
        endpoint = '/api/v1/nanobanana/generate-2';
        queryEndpoint = '/api/v1/nanobanana/record-info';
      }
    } else if (p === 'agnes' || p === 'yinzi') {
      if (st === 'text') endpoint = '/chat/completions';
      else if (st === 'image' || st === 'storyboard_image') endpoint = '/images/generations';
      else if (st === 'video') {
        endpoint = '/videos';
        queryEndpoint = '/videos/{taskId}';
      }
    }
  }
  const defaultModel = req.default_model != null ? String(req.default_model).trim() || null : null;
  const info = db.prepare(
    `INSERT INTO ai_service_configs (service_type, provider, api_protocol, name, base_url, api_key, model, default_model, endpoint, query_endpoint, priority, is_default, is_active, settings, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    serviceType,
    req.provider || '',
    req.api_protocol || '',
    req.name || '',
    req.base_url || '',
    normalizeApiKeyForService(req.service_type, req.api_key || ''),
    model,
    defaultModel,
    endpoint,
    queryEndpoint,
    req.priority ?? 0,
    req.is_default ? 1 : 0,
    req.is_active === false ? 0 : 1,
    req.settings || null,
    Object.keys(metadata).length ? JSON.stringify(metadata) : null,
    now,
    now
  );
  log.info('AI config created', { config_id: info.lastInsertRowid, provider: req.provider });
  const newId = info.lastInsertRowid;
  if (req.is_default) clearOtherDefault(db, req.service_type || 'text', newId);
  return getConfig(db, newId);
}

function updateConfig(db, log, id, req) {
  ensureMetadataColumn(db);
  const existing = getConfig(db, id);
  if (!existing) return null;
  const updates = [];
  const params = [];
  if (req.name != null) {
    updates.push('name = ?');
    params.push(req.name);
  }
  if (req.provider != null) {
    updates.push('provider = ?');
    params.push(req.provider);
  }
  if (req.api_protocol != null) {
    updates.push('api_protocol = ?');
    params.push(req.api_protocol);
  }
  if (req.base_url != null) {
    updates.push('base_url = ?');
    params.push(req.base_url);
  }
  if (req.api_key != null) {
    updates.push('api_key = ?');
    const st = req.service_type != null ? req.service_type : existing.service_type;
    params.push(normalizeApiKeyForService(st, req.api_key));
  }
  if (req.model != null) {
    updates.push('model = ?');
    params.push(modelToDb(req.model));
  }
  if (req.default_model !== undefined) {
    updates.push('default_model = ?');
    params.push(req.default_model != null ? String(req.default_model).trim() || null : null);
  }
  if (req.priority != null) {
    updates.push('priority = ?');
    params.push(req.priority);
  }
  if (req.endpoint !== undefined) {
    updates.push('endpoint = ?');
    params.push(req.endpoint || '');
  }
  if (req.query_endpoint !== undefined) {
    updates.push('query_endpoint = ?');
    params.push(req.query_endpoint || '');
  }
  if (req.settings != null) {
    updates.push('settings = ?');
    params.push(req.settings);
  }
  if (req.metadata !== undefined || req.metadata_json !== undefined) {
    updates.push('metadata_json = ?');
    const metadata = normalizeMetadata(req.metadata ?? req.metadata_json);
    params.push(Object.keys(metadata).length ? JSON.stringify(metadata) : null);
  }
  if (typeof req.is_default === 'boolean') {
    updates.push('is_default = ?');
    params.push(req.is_default ? 1 : 0);
  }
  if (typeof req.is_active === 'boolean') {
    updates.push('is_active = ?');
    params.push(req.is_active ? 1 : 0);
  }
  if (updates.length === 0) return existing;
  params.push(new Date().toISOString(), id);
  db.prepare('UPDATE ai_service_configs SET ' + updates.join(', ') + ', updated_at = ? WHERE id = ?').run(...params);
  if (req.is_default === true) clearOtherDefault(db, existing.service_type, id);
  log.info('AI config updated', { config_id: id });
  return getConfig(db, id);
}

function deleteConfig(db, log, id) {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE ai_service_configs SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, id);
  if (result.changes === 0) return false;
  log.info('AI config deleted', { config_id: id });
  return true;
}

function rowToConfig(r) {
  const cfg = {
    id: r.id,
    service_type: r.service_type,
    provider: r.provider,
    api_protocol: r.api_protocol || '',
    name: r.name,
    base_url: r.base_url,
    api_key: r.api_key,
    model: modelFromDb(r.model),
    default_model: r.default_model ? String(r.default_model).trim() : null,
    endpoint: r.endpoint,
    query_endpoint: r.query_endpoint,
    priority: r.priority ?? 0,
    is_default: !!r.is_default,
    is_active: r.is_active == null ? true : !!r.is_active,
    settings: r.settings,
    metadata: normalizeMetadata(parseMetadata(r.metadata_json)),
    metadata_json: r.metadata_json || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
  // TTS 配置：从 settings JSON 展开 voice_id / group_id 供 ttsService 直接读取
  if (r.service_type === 'tts' && r.settings) {
    try {
      const s = JSON.parse(r.settings);
      if (s.voice_id) cfg.voice_id = s.voice_id;
      if (s.group_id) cfg.group_id = s.group_id;
    } catch (_) {}
  }
  if (r.settings) {
    try {
      const settings = JSON.parse(r.settings);
      if (settings?.model_catalog_snapshot) cfg.model_catalog_snapshot = settings.model_catalog_snapshot;
      if (settings?.model_capability_overrides) {
        cfg.model_capability_overrides = normalizeCapabilityOverrideMap(settings.model_capability_overrides);
      }
    } catch (_) {}
  }
  return cfg;
}

function toPublicConfig(config) {
  if (!config) return config;
  return {
    ...config,
    api_key: '',
    has_api_key: Boolean(config.api_key),
  };
}

const CONNECTION_TEST_FIELDS = [
  'base_url',
  'api_key',
  'model',
  'default_model',
  'provider',
  'api_protocol',
  'endpoint',
  'service_type',
  'settings',
];

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function normalizeConfigId(value) {
  if (value == null || value === '') return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : NaN;
}

function pickConnectionTestDraft(body) {
  const source = body?.draft && typeof body.draft === 'object' && !Array.isArray(body.draft)
    ? body.draft
    : body || {};
  const draft = {};
  for (const field of CONNECTION_TEST_FIELDS) {
    if (hasOwn(source, field)) draft[field] = source[field];
  }
  return draft;
}

/**
 * Resolve a connection-test request without exposing persisted credentials to the browser.
 * Draft fields override the stored row. An empty draft api_key means "reuse the saved key".
 */
function resolveConnectionTestConfig(db, body = {}) {
  const configId = normalizeConfigId(body.config_id);
  if (Number.isNaN(configId)) {
    const error = new Error('无效的配置 ID');
    error.code = 'INVALID_CONFIG_ID';
    throw error;
  }
  const stored = configId == null ? null : getConfig(db, configId);
  if (configId != null && !stored) {
    const error = new Error('配置不存在或已删除，请刷新配置列表后重试');
    error.code = 'CONFIG_NOT_FOUND';
    throw error;
  }

  const draft = pickConnectionTestDraft(body);
  const resolved = stored ? { ...stored } : {};
  for (const field of CONNECTION_TEST_FIELDS) {
    if (!hasOwn(draft, field)) continue;
    if (field === 'api_key' && stored && !String(draft.api_key || '').trim()) continue;
    resolved[field] = draft[field];
  }
  resolved.base_url = String(resolved.base_url || '').trim().replace(/\/$/, '');
  resolved.api_key = String(resolved.api_key || '').trim();
  const preferredModel = String(resolved.default_model || '').trim();
  const models = Array.isArray(resolved.model)
    ? resolved.model.map((item) => String(item || '').trim()).filter(Boolean)
    : String(resolved.model || '').trim() ? [String(resolved.model).trim()] : [];
  resolved.model = preferredModel || models[0] || '';

  if (!resolved.base_url) {
    const error = new Error('缺少 Base URL，请填写后再测试');
    error.code = 'BASE_URL_REQUIRED';
    throw error;
  }
  if (!resolved.api_key) {
    const error = new Error(configId == null
      ? '缺少 API Key，请填写后再测试'
      : '此配置尚未保存 API Key，请编辑配置并填写后再测试');
    error.code = 'API_KEY_REQUIRED';
    throw error;
  }
  return {
    config: resolved,
    config_id: configId,
    credential_source: stored && !String(draft.api_key || '').trim() ? 'saved' : 'draft',
  };
}

function redactConnectionTestError(value, secrets = []) {
  let message = String(value?.message || value || '未知错误');
  for (const secret of secrets) {
    const normalized = String(secret || '').trim();
    if (normalized) message = message.split(normalized).join('[REDACTED]');
  }
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .slice(0, 800);
}

/**
 * 测试连接：与 Go AIService.TestConnection 对齐，根据 provider 发最小请求验证 base_url + api_key
 * @param opts { base_url, api_key, model (string|string[]), provider?, endpoint?, settings? }
 * @returns Promise<{ probe, authenticated, generated_media }> 成功 resolve，失败 reject(error)
 */
async function testConnection(opts) {
  const base = (opts.base_url || '').replace(/\/$/, '');
  if (!base) throw new Error('base_url 必填');
  if (!opts.api_key) throw new Error('api_key 必填');
  const models = Array.isArray(opts.model) ? opts.model : opts.model != null ? [opts.model] : [];
  const model = models[0] || '';
  if (!model && (opts.provider === 'gemini' || opts.provider === 'google')) throw new Error('model 必填');
  const provider = (opts.provider || 'openai').toLowerCase();
  const serviceType = (opts.service_type || '').toLowerCase();
  let endpoint = opts.endpoint || '';

  // YinziAPI 图片/视频固定分组不保证能枚举 /models；视频连接使用无副作用的不存在任务查询。
  // 图片连接测试不能调用 /images/generations，否则一次“测试”就会真实扣费。
  if (provider === 'yinzi' && serviceType !== 'text') {
    const probePath = serviceType === 'video'
      ? '/videos/codex-connectivity-check-does-not-exist'
      : '/models';
    const res = await fetch(base + probePath, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + (opts.api_key || '') },
    });
    if (res.status === 401 || res.status === 403) throw new Error(`API Key 无效 (${res.status})`);
    if (res.status >= 500) throw new Error(`YinziAPI 服务暂时不可用 (${res.status})`);
    return {
      probe: serviceType === 'video' ? 'read_only_task_lookup' : 'read_only_model_catalog',
      authenticated: true,
      generated_media: false,
    };
  }

  // --- NanoBanana ---
  if (provider === 'nano_banana') {
    // 用 record-info 查询一个不存在的 taskId：401/403=key 无效，404=key 有效已联通
    const url = base + '/api/v1/nanobanana/record-info?taskId=test-connectivity';
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + (opts.api_key || '') },
    });
    if (res.status === 401 || res.status === 403) {
      const text = await res.text();
      let errMsg = `API Key 无效 (${res.status})`;
      try { const j = JSON.parse(text); errMsg = j.msg || j.message || errMsg; } catch {}
      throw new Error(errMsg);
    }
    return { probe: 'read_only_task_lookup', authenticated: true, generated_media: false };
  }

  // --- Gemini ---
  if (provider === 'gemini' || provider === 'google') {
    endpoint = endpoint || '/v1beta/models/{model}:generateContent';
    const path = endpoint.replace(/{model}/g, model || 'gemini-pro');
    const url = base + (path.startsWith('/') ? path : '/' + path) + '?key=' + encodeURIComponent(opts.api_key || '');
    const body = { contents: [{ parts: [{ text: 'Hello' }] }] };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`请求失败: ${res.status} ${text.slice(0, 200)}`);
    }
    const data = await res.json().catch(() => ({}));
    if (data.candidates == null && data.error != null) {
      throw new Error(data.error.message || data.error || 'Gemini 返回错误');
    }
    return { probe: 'minimal_text_response', authenticated: true, generated_media: false };
  }

  // --- TTS 语音合成：只读模型目录，不合成测试音频 ---
  if (serviceType === 'tts') {
    const probeUrl = base + '/models';
    const res = await fetch(probeUrl, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + (opts.api_key || '') },
    });
    if (res.status === 401 || res.status === 403) {
      const text = await res.text();
      let errMsg = `API Key 无效 (${res.status})`;
      try { const j = JSON.parse(text); errMsg = j.base_resp?.status_msg || j.error?.message || j.message || errMsg; } catch {}
      throw new Error(errMsg);
    }
    return {
      probe: 'read_only_model_catalog',
      authenticated: res.ok,
      reachable_only: !res.ok,
      generated_media: false,
    };
  }

  // service_type 作为主要判断信号
  const isImageService = serviceType === 'image' || serviceType === 'storyboard_image';
  const isVideoService = serviceType === 'video';
  const hasImageEndpoint = !!(endpoint && endpoint.includes('/images/'));

  const isDashscope = provider === 'dashscope' || provider === 'qwen_image';
  const isVolcengine = provider === 'volces' || provider === 'volcengine' || provider === 'volc';
  const modelLower = model.toLowerCase();

  // 兜底识别图片/视频模型（service_type 未传时使用）
  const looksLikeImageModel = /seedream|image2video|text2image|img2img|wanx|wan\d|flux|stable.?diff|dall.?e|imagen|agnes-image|-image$/i.test(modelLower)
    || (isVolcengine && /seedream|vision|image/i.test(modelLower));
  const looksLikeVideoModel = /seedance|video.?gen|video2video|kf2v|cogvideo|sora|kling|agnes-video/i.test(modelLower);
  // DashScope 图片/视频专用端点特征
  const isDashscopeNonChatEndpoint = isDashscope && !!(endpoint && (endpoint.includes('aigc') || endpoint.includes('multimodal') || endpoint.includes('video')));

  // 综合判断是否为图片服务
  const treatAsImage = isImageService || hasImageEndpoint || isDashscopeNonChatEndpoint
    || looksLikeImageModel
    || (isVolcengine && !serviceType && !endpoint);

  // --- DashScope 图片 / 视频 / 分镜 ---
  // 通义万象 / WAN 系列：API key 通过 compatible-mode chat 接口验证即可（同一 key 通用）
  if (isDashscope && (isImageService || isVideoService || looksLikeImageModel || looksLikeVideoModel || isDashscopeNonChatEndpoint)) {
    const chatUrl = base.replace(/\/(api\/v1|compatible-mode)\/.*$/, '') + '/compatible-mode/v1/chat/completions';
    const body = { model: 'qwen-turbo', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 };
    console.log('[testConnection] DashScope 非文本服务，用 compatible chat 验证 key', { chatUrl, serviceType, model });
    const res = await fetch(chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.api_key },
      body: JSON.stringify(body),
    });
    // 401/403 = key 无效，其他均视为联通
    if (res.status === 401 || res.status === 403) {
      const text = await res.text();
      let errMsg = `API Key 无效 (${res.status})`;
      try { const j = JSON.parse(text); errMsg = j.error?.message || j.message || errMsg; } catch {}
      throw new Error(errMsg);
    }
    return { probe: 'minimal_text_response', authenticated: true, generated_media: false };
  }

  // --- 视频生成服务（非 DashScope）：通过 chat/completions 验证 key 合法性 ---
  // 视频生成 API 调用代价高昂，无法直接测试；但同账号 chat 接口验证 key 有效性即可
  if (isVideoService || looksLikeVideoModel) {
    const chatPath = '/chat/completions';
    const url = base + chatPath;
    const body = { model: model || '', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 };
    console.log('[testConnection] 视频服务，用 chat/completions 验证 key', { url, serviceType, model });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (opts.api_key || '') },
      body: JSON.stringify(body),
    });
    // 401/403 = key 无效；其他（400 模型不存在等）视为联通
    if (res.status === 401 || res.status === 403) {
      const text = await res.text();
      let errMsg = `API Key 无效 (${res.status})`;
      try { const j = JSON.parse(text); errMsg = j.error?.message || j.message || errMsg; } catch {}
      throw new Error(errMsg);
    }
    return {
      probe: 'minimal_text_response',
      authenticated: res.ok,
      reachable_only: !res.ok,
      generated_media: false,
    };
  }

  // --- OpenAI 兼容图片生成：只读模型目录探针，绝不创建图片 ---
  if (treatAsImage) {
    const url = base + '/models';
    console.log('[testConnection] 图片服务只读探针', { url, serviceType, model });
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + (opts.api_key || '') },
    });
    if (res.status === 401 || res.status === 403) {
      const text = await res.text();
      let errMsg = `API Key 无效 (${res.status})`;
      try {
        const j = JSON.parse(text);
        errMsg = j.error?.message || j.message || errMsg;
      } catch {}
      throw new Error(errMsg);
    }
    return {
      probe: 'read_only_model_catalog',
      authenticated: res.ok,
      reachable_only: !res.ok,
      generated_media: false,
    };
  }

  // --- OpenAI / 默认：chat completions ---
  endpoint = endpoint || '/chat/completions';
  const path = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
  const url = base + path;
  let body = {
    model: model || 'gpt-3.5-turbo',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 5,
  };
  body = applyDeepSeekConnectivityOptions(
    { provider, base_url: base, settings: opts.settings },
    body
  );
  console.log('[testConnection] 文本/chat 服务', { url, serviceType, model });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (opts.api_key || ''),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let errMsg = `请求失败: ${res.status}`;
    try {
      const j = JSON.parse(text);
      errMsg += ' - ' + (j.error?.message || j.message || j.error || text.slice(0, 150));
    } catch {
      if (text) errMsg += ' - ' + text.slice(0, 150);
    }
    throw new Error(errMsg);
  }
  const data = await res.json().catch(() => ({}));
  if (data.choices == null && data.error != null) {
    throw new Error(data.error.message || data.error || '接口返回错误');
  }
  return { probe: 'minimal_text_response', authenticated: true, generated_media: false };
}

function normalizeCatalogPath(value) {
  const catalogPath = String(value || '/models').trim() || '/models';
  if (!catalogPath.startsWith('/') || catalogPath.startsWith('//') || catalogPath.includes('..')
    || !/^\/[A-Za-z0-9_./?=&{}-]+$/.test(catalogPath)) {
    const error = new Error('模型目录路径必须是同一 Base URL 下的安全相对路径');
    error.code = 'MODEL_DISCOVERY_PATH_INVALID';
    throw error;
  }
  return catalogPath;
}

function extractCatalogEntries(payload) {
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : Array.isArray(payload?.items)
          ? payload.items
          : Array.isArray(payload?.data?.models) ? payload.data.models : [];
  const seen = new Set();
  return candidates.map((item) => {
    const model = typeof item === 'string'
      ? item.trim()
      : String(item?.id || item?.model || item?.model_name || item?.name || '').trim();
    if (!model || seen.has(model)) return null;
    seen.add(model);
    const endpointTypes = typeof item === 'object' && item
      ? item.endpoint_types || item.supported_endpoint_types || item.endpoints || []
      : [];
    return {
      model,
      name: typeof item === 'object' && item ? String(item.name || model) : model,
      owned_by: typeof item === 'object' && item ? item.owned_by || item.owner || null : null,
      endpoint_types: Array.isArray(endpointTypes) ? endpointTypes : [String(endpointTypes || '')].filter(Boolean),
      raw_metadata: typeof item === 'object' && item ? {
        created: item.created ?? null,
        owned_by: item.owned_by || item.owner || null,
      } : {},
    };
  }).filter(Boolean);
}

function persistModelCatalogSnapshot(db, configId, snapshot) {
  if (!db || !Number.isSafeInteger(Number(configId)) || Number(configId) <= 0) return;
  const row = db.prepare('SELECT settings FROM ai_service_configs WHERE id = ? AND deleted_at IS NULL').get(Number(configId));
  if (!row) return;
  let settings = {};
  try { settings = row.settings ? JSON.parse(row.settings) : {}; } catch (_) { settings = {}; }
  settings.model_catalog_snapshot = snapshot;
  db.prepare('UPDATE ai_service_configs SET settings = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(settings), new Date().toISOString(), Number(configId));
}

async function discoverModels(opts = {}, options = {}) {
  const base = String(opts.base_url || '').trim().replace(/\/$/, '');
  const apiKey = String(opts.api_key || '').trim();
  if (!base) throw Object.assign(new Error('Base URL 必填'), { code: 'BASE_URL_REQUIRED' });
  if (!apiKey) throw Object.assign(new Error('API Key 必填'), { code: 'API_KEY_REQUIRED' });
  const catalogPath = normalizeCatalogPath(options.catalog_path || opts.catalog_path || opts.settings?.model_catalog_path);
  const url = `${base}${catalogPath}`;
  const fetchImpl = options.fetchImpl || fetch;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
  } catch (error) {
    const wrapped = new Error(`模型目录请求失败：${error.message}`);
    wrapped.code = 'MODEL_DISCOVERY_NETWORK_ERROR';
    throw wrapped;
  }
  if (response.status === 401 || response.status === 403) {
    const error = new Error(`模型目录鉴权失败 (${response.status})`);
    error.code = 'MODEL_DISCOVERY_AUTH_FAILED';
    error.status = response.status;
    throw error;
  }
  if (response.status === 404 || response.status === 405) {
    const error = new Error(`模型目录端点不存在：${catalogPath}`);
    error.code = 'MODEL_DISCOVERY_ENDPOINT_NOT_FOUND';
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`模型目录返回 HTTP ${response.status}`);
    error.code = 'MODEL_DISCOVERY_HTTP_ERROR';
    error.status = response.status;
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  const models = extractCatalogEntries(payload);
  const fetchedAt = new Date().toISOString();
  const snapshot = {
    version: 1,
    config_id: Number.isSafeInteger(Number(opts.id)) ? Number(opts.id) : null,
    source_url: url,
    availability_scope: 'credential',
    scope_verified: String(opts.provider || '').toLowerCase() === 'yinzi',
    fetched_at: fetchedAt,
    models: models.map(({ model, name, endpoint_types, owned_by }) => ({ model, name, endpoint_types, owned_by })),
  };
  snapshot.content_hash = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const snapshotPersisted = options.persist_snapshot !== false && Boolean(options.db);
  if (snapshotPersisted) persistModelCatalogSnapshot(options.db, opts.id, snapshot);
  return {
    models,
    snapshot,
    source_url: url,
    availability_scope: snapshot.availability_scope,
    snapshot_persisted: snapshotPersisted,
  };
}

function mergeDiscoveredCatalog(discovery, pricingCatalog, options = {}) {
  const rawDiscovered = Array.isArray(discovery?.models) ? discovery.models : [];
  const group = String(options.group || '').trim();
  const serviceType = String(options.service_type || 'video').trim() || 'video';
  const provider = String(options.provider || '').trim().toLowerCase();
  const smartRouting = provider === 'yinzi' && options.smart_routing === true;
  const endpointTypes = (entry) => [...new Set((Array.isArray(entry?.endpoint_types)
    ? entry.endpoint_types : Array.isArray(entry?.supported_endpoint_types)
      ? entry.supported_endpoint_types : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean))];
  const publicCatalog = pricingCatalog?.public_catalog && typeof pricingCatalog.public_catalog === 'object'
    ? pricingCatalog.public_catalog : null;
  const publicItems = Array.isArray(publicCatalog?.video)
    ? publicCatalog.video : pricingCatalog?.catalog_verified === true ? []
      : Array.isArray(pricingCatalog?.video) ? pricingCatalog.video : [];
  const contractItems = pricingCatalog?.catalog_verified === true && Array.isArray(pricingCatalog?.video)
    ? pricingCatalog.video : [];
  const publicVideoModels = new Set([...publicItems, ...contractItems]
    .filter((entry) => endpointTypes(entry).includes('openai-video'))
    .map((entry) => String(entry?.model || '').trim().toLowerCase())
    .filter(Boolean));
  const hasTypedPricingVideo = [...publicItems, ...contractItems]
    .some((entry) => endpointTypes(entry).includes('openai-video'));
  const capabilityOverrides = normalizeCapabilityOverrideMap(options.capability_overrides);
  const hasExplicitLocalVideoHint = rawDiscovered.some((entry) => Boolean(
    findModelCapabilityOverride(capabilityOverrides, entry?.model)
  ));
  // Older custom relays and historical fixtures exposed a dedicated `video`
  // catalog but omitted endpoint metadata everywhere. Keep that narrow,
  // explicitly untyped compatibility path; a mixed typed Yinzi catalog never
  // falls through to guessing.
  const legacyUnlabelledVideoCatalog = serviceType === 'video'
    && !rawDiscovered.some((entry) => endpointTypes(entry).length > 0)
    && !hasTypedPricingVideo
    && (Array.isArray(pricingCatalog?.video) || hasExplicitLocalVideoHint);
  const matchesService = (entry) => {
    if (provider !== 'yinzi') return true;
    const endpoints = endpointTypes(entry);
    const knownVideo = Boolean(getYinziVideoCapability(entry?.model));
    if (serviceType === 'video') {
      // The live /models response may omit endpoint_types for every entry.
      // In that case only exact public-video or builtin registry membership is
      // evidence of a video model; never classify the whole mixed catalog.
      return endpoints.includes('openai-video')
        || (!endpoints.length && (knownVideo
          || publicVideoModels.has(String(entry?.model || '').trim().toLowerCase())
          || legacyUnlabelledVideoCatalog));
    }
    if (serviceType === 'image' || serviceType === 'storyboard_image') {
      return endpoints.includes('image-generation');
    }
    if (serviceType === 'text') {
      return endpoints.includes('openai')
        && !endpoints.includes('openai-video')
        && !endpoints.includes('image-generation');
    }
    return true;
  };
  const discovered = rawDiscovered.filter(matchesService);
  const priced = publicItems.length ? publicItems : contractItems;
  const catalog = discovered.map((entry) => {
    const model = entry.model;
    const modelKey = String(model || '').toLowerCase();
    const publicItem = priced.find((item) => String(item.model || '').toLowerCase() === modelKey) || null;
    const contractItem = contractItems.find((item) => String(item.model || '').toLowerCase() === modelKey) || null;
    const enrichment = contractItem || publicItem;
    // A key-scoped capability catalog is authoritative even when one model's
    // contract is missing. Only the explicit legacy fallback may use the
    // bundled compatibility profiles; never invent capabilities for a model
    // that the live catalog returned as unknown.
    const capabilityCatalogVerified = pricingCatalog?.catalog_verified === true;
    const builtinCapability = contractItem?.capabilities || publicItem?.capabilities
      || (!capabilityCatalogVerified && serviceType === 'video' ? getYinziVideoCapability(model) : null);
    const localOverride = findModelCapabilityOverride(capabilityOverrides, model);
    const capability = mergeModelCapability(builtinCapability, localOverride);
    const groups = group ? [group] : (enrichment?.groups || []);
    const normalizedEndpoints = endpointTypes(entry);
    const resolvedEndpoints = normalizedEndpoints.length
      ? normalizedEndpoints
      : serviceType === 'video' && getYinziVideoCapability(model) ? ['openai-video']
        : endpointTypes(enrichment);
    return {
      ...(publicItem || {}),
      ...(contractItem || {}),
      model,
      name: entry.name || enrichment?.name || model,
      endpoint_types: resolvedEndpoints,
      groups,
      prices: contractItem?.prices?.length ? contractItem.prices : (publicItem?.prices || []),
      capabilities: capability || null,
      provider_contract: contractItem?.provider_contract || publicItem?.provider_contract
        || capability?.provider_contract || '',
      provider_create_path: contractItem?.provider_create_path || publicItem?.provider_create_path
        || capability?.provider_create_path || '',
      provider_query_path: contractItem?.provider_query_path || publicItem?.provider_query_path
        || capability?.provider_query_path || '',
      provider_content_path: contractItem?.provider_content_path || publicItem?.provider_content_path
        || capability?.provider_content_path || '',
      capability_source: contractItem?.capability_source || publicItem?.capability_source || (builtinCapability && localOverride ? 'builtin+local'
        : localOverride ? 'local' : builtinCapability ? 'builtin' : 'unknown'),
      contract_status: contractItem?.contract_status || publicItem?.contract_status || (builtinCapability ? 'known' : localOverride ? 'local' : 'missing'),
      local_capability_override: localOverride || null,
      automatic_eligible: capability?.automatic_eligible === true,
      availability_scope: discovery?.availability_scope || 'credential',
      scope_verified: discovery?.snapshot?.scope_verified === true,
      credential_verified: discovery?.snapshot?.scope_verified === true,
      smart_routing_candidate: smartRouting,
      public_catalog: Boolean(publicItem),
      manual_only: false,
      catalog_source: discovery?.source_url || null,
      provider,
      catalog_verified: capabilityCatalogVerified,
    };
  });
  if (provider === 'yinzi' && serviceType === 'video' && options.include_public_catalog === true) {
    const seen = new Set(catalog.map((item) => String(item.model || '').toLowerCase()));
    for (const publicItem of publicItems) {
      const model = String(publicItem?.model || '').trim();
      const modelKey = model.toLowerCase();
      if (!model || seen.has(modelKey) || !endpointTypes(publicItem).includes('openai-video')) continue;
      seen.add(modelKey);
      const localOverride = findModelCapabilityOverride(capabilityOverrides, model);
      const capability = mergeModelCapability(publicItem.capabilities || getYinziVideoCapability(model), localOverride);
      catalog.push({
        ...publicItem,
        model,
        name: publicItem.name || model,
        endpoint_types: endpointTypes(publicItem),
        groups: Array.isArray(publicItem.groups) ? publicItem.groups : [],
        prices: Array.isArray(publicItem.prices) ? publicItem.prices : [],
        capabilities: capability || null,
        provider_contract: publicItem.provider_contract || capability?.provider_contract || '',
        provider_create_path: publicItem.provider_create_path || capability?.provider_create_path || '',
        provider_query_path: publicItem.provider_query_path || capability?.provider_query_path || '',
        provider_content_path: publicItem.provider_content_path || capability?.provider_content_path || '',
        capability_source: publicItem.capability_source || (localOverride ? 'builtin+local' : capability ? 'builtin' : 'unknown'),
        contract_status: publicItem.contract_status || (localOverride ? 'local' : capability ? 'known' : 'missing'),
        local_capability_override: localOverride || null,
        // Public pricing proves that the site sells a model, not that this Key
        // has a physical route for it. Keep the offer visible for an explicit
        // manual attempt, but never promote it into zero-config automation.
        automatic_eligible: false,
        availability_scope: 'public',
        scope_verified: false,
        credential_verified: false,
        smart_routing_candidate: false,
        public_catalog: true,
        manual_only: true,
        catalog_source: publicCatalog?.source || pricingCatalog?.source || null,
        provider,
        catalog_verified: false,
      });
    }
  }
  // A key-scoped capability entry can safely enrich the manual picker even if
  // the standard model projection has not caught up. It still does not prove
  // an eligible physical Smart Router route: only /v1/models grants automatic
  // availability. This keeps capability advice separate from dispatch truth.
  if (provider === 'yinzi' && serviceType === 'video' && pricingCatalog?.catalog_verified === true) {
    const seen = new Set(catalog.map((item) => String(item.model || '').toLowerCase()));
    const scopeVerified = discovery?.snapshot?.scope_verified === true
      || pricingCatalog?.scope_verified === true;
    for (const contractItem of contractItems) {
      const model = String(contractItem?.model || '').trim();
      const modelKey = model.toLowerCase();
      if (!model || seen.has(modelKey) || !endpointTypes(contractItem).includes('openai-video')) continue;
      seen.add(modelKey);
      const localOverride = findModelCapabilityOverride(capabilityOverrides, model);
      const capability = mergeModelCapability(contractItem.capabilities || null, localOverride);
      catalog.push({
        ...contractItem,
        model,
        name: contractItem.name || model,
        endpoint_types: endpointTypes(contractItem),
        groups: Array.isArray(contractItem.groups) ? contractItem.groups : [],
        prices: Array.isArray(contractItem.prices) ? contractItem.prices : [],
        capabilities: capability || null,
        provider_contract: contractItem.provider_contract || capability?.provider_contract || '',
        provider_create_path: contractItem.provider_create_path || capability?.provider_create_path || '',
        provider_query_path: contractItem.provider_query_path || capability?.provider_query_path || '',
        provider_content_path: contractItem.provider_content_path || capability?.provider_content_path || '',
        capability_source: contractItem.capability_source || (localOverride ? 'local' : 'unknown'),
        contract_status: contractItem.contract_status || (localOverride ? 'local' : 'missing'),
        local_capability_override: localOverride || null,
        automatic_eligible: false,
        availability_scope: 'credential',
        scope_verified: scopeVerified,
        credential_verified: false,
        smart_routing_candidate: false,
        public_catalog: false,
        manual_only: true,
        catalog_source: pricingCatalog?.source || discovery?.source_url || null,
        provider,
        catalog_verified: true,
      });
    }
  }
  return {
    version: pricingCatalog?.version || 1,
    pricing_version: pricingCatalog?.pricing_version || '',
    fetched_at: discovery?.snapshot?.fetched_at || pricingCatalog?.fetched_at || null,
    source: discovery?.source_url || pricingCatalog?.source || null,
    availability_scope: discovery?.availability_scope || 'credential',
    scope_verified: discovery?.snapshot?.scope_verified === true,
    discovery_outcome: discovery?.discovery_outcome || 'live',
    stale_snapshot: discovery?.stale_snapshot === true,
    warnings: [
      ...(Array.isArray(discovery?.warnings) ? discovery.warnings : []),
      ...(Array.isArray(pricingCatalog?.warnings) ? pricingCatalog.warnings : []),
    ],
    video: catalog,
  };
}

/**
 * 返回 vendor_lock 状态
 */
function getVendorLockStatus(cfg) {
  const lock = cfg?.vendor_lock;
  return {
    enabled: !!(lock?.enabled),
    config_file: lock?.config_file || '',
  };
}

/**
 * 启动时同步 vendor_lock 指定的配置文件到数据库。
 * - 软删除所有现有配置，按文件重新导入
 * - 若同 service_type + provider 在 DB 中已有记录，则保留用户修改过的 api_key
 */
function applyVendorLock(db, log, cfg) {
  const status = getVendorLockStatus(cfg);
  if (!status.enabled) return;

  const configFile = status.config_file;
  if (!configFile) {
    log.warn && log.warn('vendor_lock enabled but config_file is empty');
    return;
  }

  const candidates = [
    path.join(process.cwd(), 'configs', configFile),
    path.join(__dirname, '..', '..', 'configs', configFile),
  ];
  let raw = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) { raw = fs.readFileSync(p, 'utf8'); break; }
  }
  if (!raw) {
    console.warn('[vendor_lock] config file not found:', configFile);
    return;
  }

  let configs;
  try {
    configs = JSON.parse(raw);
    if (!Array.isArray(configs)) throw new Error('config file must be a JSON array');
  } catch (e) {
    console.error('[vendor_lock] failed to parse config file:', e.message);
    return;
  }

  // 保存现有 api_key（key: "service_type:provider"）
  const existing = db.prepare('SELECT service_type, provider, api_key FROM ai_service_configs WHERE deleted_at IS NULL').all();
  const savedKeys = new Map();
  for (const row of existing) {
    savedKeys.set(`${row.service_type}:${row.provider}`, row.api_key);
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE ai_service_configs SET deleted_at = ? WHERE deleted_at IS NULL').run(now);

  for (const item of configs) {
    const mapKey = `${item.service_type}:${item.provider}`;
    const apiKey = savedKeys.get(mapKey) ?? item.api_key ?? '';
    const model = Array.isArray(item.model)
      ? JSON.stringify(item.model)
      : item.model ? JSON.stringify([item.model]) : '[]';
    db.prepare(
      `INSERT INTO ai_service_configs
        (service_type, provider, api_protocol, name, base_url, api_key, model, default_model, endpoint, query_endpoint, priority, is_default, is_active, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    ).run(
      item.service_type || 'text',
      item.provider || '',
      item.api_protocol || '',
      item.name || '',
      item.base_url || '',
      apiKey,
      model,
      item.default_model || null,
      item.endpoint || '',
      item.query_endpoint || '',
      item.priority ?? 0,
      item.is_default ? 1 : 0,
      item.settings || null,
      now,
      now
    );
  }
  for (const item of configs) {
    console.log(`[vendor_lock] loaded: service_type=${item.service_type} provider=${item.provider} api_protocol=${item.api_protocol || '(auto)'} endpoint=${item.endpoint || '(auto)'}`);
  }
  console.log(`[vendor_lock] synced ${configs.length} configs from ${configFile}`);
}

/**
 * 批量替换所有配置的 api_key（仅限锁定模式下使用）
 */
function bulkUpdateApiKey(db, log, newKey) {
  const now = new Date().toISOString();
  const info = db.prepare(
    'UPDATE ai_service_configs SET api_key = ?, updated_at = ? WHERE deleted_at IS NULL'
  ).run(newKey, now);
  log.info('Bulk update api_key', { updated: info.changes });
  return info.changes;
}

module.exports = {
  listConfigs,
  getConfig,
  createConfig,
  updateConfig,
  deleteConfig,
  testConnection,
  discoverModels,
  mergeDiscoveredCatalog,
  resolveConnectionTestConfig,
  redactConnectionTestError,
  getVendorLockStatus,
  applyVendorLock,
  bulkUpdateApiKey,
  getModelCapabilityOverrides,
  modelCapabilityStates,
  normalizeModelCapabilityOverride,
  mergeModelCapability,
  updateModelCapabilityOverride,
  resetModelCapabilityOverride,
  toPublicConfig,
  candidateConfigs,
  normalizeMetadata,
  TEXT_CONFIG_LIMIT,
};
