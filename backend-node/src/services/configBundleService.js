const crypto = require('node:crypto');
const promptRegistry = require('./productionPromptRegistry');
const costs = require('./productionCostLedger');
const settingsService = require('./settingsService');

const SCHEMA_VERSION = 1;
const PREVIEW_TTL_MS = 15 * 60 * 1000;
const AUTO_KEEP = 20;
const AUTO_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PORTABLE_SETTING_KEYS = Object.freeze([
  'pipeline_concurrency',
  'pipeline_video_concurrency',
  'production_default_budget',
  'production_allow_unknown_price',
  'production_automation_preferences',
  'production_backup_policy',
]);
const LEGACY_PROMPT_KEYS = Object.freeze([
  'scene_extraction',
  'prop_extraction',
  'storyboard_user_suffix',
  'first_frame_prompt',
  'key_frame_prompt',
  'last_frame_prompt',
]);

const SECRET_KEY_PATTERN = /(^|[_-])(api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|authorization|bearer|token|password|passwd|cookie|session)([_-]|$)/i;
const PATH_KEY_PATTERN = /(^|[_-])(path|dir|directory|folder|file|storage[_-]?(?:root|path)|local[_-]?path|output[_-]?path)([_-]|$)/i;
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;
const UNC_ABSOLUTE_PATH = /^\\\\[^\\]+\\[^\\]+/;
const POSIX_ABSOLUTE_PATH = /^\/(?!\/)/;

function json(value) {
  return JSON.stringify(value == null ? {} : value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : json(value)).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function isAbsoluteLocalPath(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return WINDOWS_ABSOLUTE_PATH.test(text) || UNC_ABSOLUTE_PATH.test(text) || POSIX_ABSOLUTE_PATH.test(text);
}

function sanitizePortableValue(value, key = '') {
  if (SECRET_KEY_PATTERN.test(String(key || ''))) return undefined;
  if (typeof value === 'string' && (
    WINDOWS_ABSOLUTE_PATH.test(value.trim())
    || UNC_ABSOLUTE_PATH.test(value.trim())
    || (PATH_KEY_PATTERN.test(String(key || '')) && POSIX_ABSOLUTE_PATH.test(value.trim()))
  )) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizePortableValue(entry, ''))
      .filter((entry) => entry !== undefined);
  }
  if (value && typeof value === 'object') {
    const clean = {};
    for (const [childKey, entry] of Object.entries(value)) {
      const sanitized = sanitizePortableValue(entry, childKey);
      if (sanitized !== undefined) clean[childKey] = sanitized;
    }
    return clean;
  }
  return value;
}

function assertPortableValue(value, key = '', path = 'sections') {
  if (SECRET_KEY_PATTERN.test(String(key || ''))) throw new Error(`配置包包含禁止的秘密字段：${path}`);
  if (typeof value === 'string' && (
    WINDOWS_ABSOLUTE_PATH.test(value.trim())
    || UNC_ABSOLUTE_PATH.test(value.trim())
    || (PATH_KEY_PATTERN.test(String(key || '')) && POSIX_ABSOLUTE_PATH.test(value.trim()))
  )) {
    throw new Error(`配置包包含不可迁移的本机绝对路径：${path}`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPortableValue(entry, '', `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, entry] of Object.entries(value)) {
      assertPortableValue(entry, childKey, `${path}.${childKey}`);
    }
  }
}

function sanitizedAiConfigs(db) {
  return db.prepare(
    `SELECT service_type, provider, api_protocol, name, base_url, model, default_model,
            endpoint, query_endpoint, priority, is_default, is_active, settings
     FROM ai_service_configs WHERE deleted_at IS NULL ORDER BY service_type, is_default DESC, priority DESC, id`
  ).all().map((row) => ({
    ...row,
    model: (() => { try { return JSON.parse(row.model || '[]'); } catch (_) { return row.model ? [row.model] : []; } })(),
    settings: (() => {
      let value = {};
      try { value = JSON.parse(row.settings || '{}'); } catch (_) { return {}; }
      return sanitizePortableValue(value || {});
    })(),
    needs_credential: Boolean(db.prepare(
      `SELECT api_key FROM ai_service_configs WHERE deleted_at IS NULL AND service_type = ? AND provider = ? AND name = ? ORDER BY id LIMIT 1`
    ).get(row.service_type, row.provider, row.name)?.api_key),
  }));
}

function portableSettings(db) {
  const result = {};
  for (const key of PORTABLE_SETTING_KEYS) {
    const value = settingsService.getGlobalSetting(db, key, undefined);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function portableModelRoutes(db) {
  return db.prepare(
    `SELECT m.key, m.service_type, m.model_override, m.description,
            c.service_type AS config_service_type, c.provider AS config_provider, c.name AS config_name
     FROM ai_model_map m
     LEFT JOIN ai_service_configs c ON c.id = m.config_id AND c.deleted_at IS NULL
     ORDER BY m.key`
  ).all();
}

function currentSections(db) {
  return sanitizePortableValue({
    settings: portableSettings(db),
    prompts: promptRegistry.exportPackage(db).prompts,
    legacy_prompts: db.prepare(
      `SELECT key AS prompt_id, content, updated_at FROM prompt_overrides
       WHERE key IN (${LEGACY_PROMPT_KEYS.map(() => '?').join(',')}) ORDER BY key`
    ).all(...LEGACY_PROMPT_KEYS).map((item) => ({ ...item, prompt_version: 1 })),
    prices: costs.listPrices(db),
    ai_configs: sanitizedAiConfigs(db),
    model_routes: portableModelRoutes(db),
  });
}

function fingerprint(db) {
  return sha256(currentSections(db));
}

function exportBundle(db, options = {}) {
  const sections = currentSections(db);
  const bundle = {
    product: 'yinzi-ai-video-workflow',
    kind: 'configuration-bundle',
    schema_version: SCHEMA_VERSION,
    created_at: nowIso(),
    secrets_included: false,
    apply_mode: 'merge',
    sections: options.sections && Array.isArray(options.sections)
      ? Object.fromEntries(Object.entries(sections).filter(([key]) => options.sections.includes(key)))
      : sections,
  };
  return { ...bundle, checksum: sha256(bundle) };
}

function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error('配置包必须是 JSON 对象');
  if (bundle.product !== 'yinzi-ai-video-workflow' || bundle.kind !== 'configuration-bundle') throw new Error('不是银子 AI 视频工作流配置包');
  if (Number(bundle.schema_version) !== SCHEMA_VERSION) throw new Error('配置包版本不兼容');
  if (bundle.secrets_included !== false) throw new Error('当前版本拒绝导入包含密钥的配置包');
  if (!['merge', 'replace'].includes(bundle.apply_mode || 'merge')) throw new Error('配置包 apply_mode 无效');
  if (!bundle.sections || typeof bundle.sections !== 'object' || Array.isArray(bundle.sections)) throw new Error('配置包缺少 sections');
  assertPortableValue(bundle.sections);
  const expectedChecksum = bundle.checksum;
  const { checksum: _checksum, ...unsigned } = bundle;
  if (!expectedChecksum || sha256(unsigned) !== expectedChecksum) throw new Error('配置包校验和不匹配，文件可能损坏');
  const allowedSections = new Set(['settings', 'prompts', 'legacy_prompts', 'prices', 'ai_configs', 'model_routes']);
  for (const key of Object.keys(bundle.sections)) if (!allowedSections.has(key)) throw new Error(`配置包包含未知 section: ${key}`);

  const settings = bundle.sections.settings || {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings section 无效');
  for (const key of Object.keys(settings)) if (!PORTABLE_SETTING_KEYS.includes(key)) throw new Error(`配置包包含不可迁移设置：${key}`);

  const promptPackage = {
    kind: 'prompt-package', schema_version: promptRegistry.PACKAGE_SCHEMA_VERSION,
    prompts: Array.isArray(bundle.sections.prompts) ? bundle.sections.prompts : [],
  };
  const prompts = promptRegistry.validatePackage(promptPackage).items;
  const legacyPrompts = Array.isArray(bundle.sections.legacy_prompts) ? bundle.sections.legacy_prompts : [];
  if (legacyPrompts.length > LEGACY_PROMPT_KEYS.length) throw new Error('旧版兼容提示词项目过多');
  const legacySeen = new Set();
  for (const item of legacyPrompts) {
    const id = String(item?.prompt_id || '');
    if (!LEGACY_PROMPT_KEYS.includes(id)) throw new Error(`配置包包含未知旧版提示词：${id}`);
    if (legacySeen.has(id)) throw new Error(`配置包重复包含旧版提示词：${id}`);
    legacySeen.add(id);
    if (!String(item?.content || '').trim() || String(item.content).length > 50000) throw new Error(`${id} 内容无效`);
  }
  const prices = Array.isArray(bundle.sections.prices) ? bundle.sections.prices : [];
  if (prices.length > 5000) throw new Error('价格表项目过多');
  for (const price of prices) {
    if (!price || typeof price !== 'object' || !price.provider || !price.service_type || !price.model) throw new Error('价格表存在无效条目');
  }
  const aiConfigs = Array.isArray(bundle.sections.ai_configs) ? bundle.sections.ai_configs : [];
  if (aiConfigs.length > 200) throw new Error('AI 配置项目过多');
  for (const config of aiConfigs) {
    if (!config?.service_type || !config?.name) throw new Error('AI 配置条目缺少 service_type 或 name');
  }
  const modelRoutes = Array.isArray(bundle.sections.model_routes) ? bundle.sections.model_routes : [];
  if (modelRoutes.length > 500) throw new Error('模型路由项目过多');
  const modelRouteSeen = new Set();
  for (const route of modelRoutes) {
    const key = String(route?.key || '').trim();
    if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(key)) throw new Error('模型路由包含无效 key');
    if (modelRouteSeen.has(key)) throw new Error(`模型路由重复包含 ${key}`);
    modelRouteSeen.add(key);
    if (!String(route.service_type || '').trim()) throw new Error(`${key} 缺少 service_type`);
  }
  return { settings, prompts, legacy_prompts: legacyPrompts, prices, ai_configs: aiConfigs, model_routes: modelRoutes };
}

function summarizeDiff(db, normalized) {
  const current = currentSections(db);
  const promptMap = new Map(current.prompts.map((item) => [item.prompt_id, item.content]));
  const priceKey = (item) => [item.provider, item.service_type, item.model, item.group_name || '', item.billing_unit].join('|');
  const currentPrices = new Map(current.prices.map((item) => [priceKey(item), item]));
  const configKey = (item) => [item.service_type, item.provider || '', item.name].join('|');
  const currentConfigs = new Map(current.ai_configs.map((item) => [configKey(item), item]));
  const currentRoutes = new Map(current.model_routes.map((item) => [item.key, item]));
  return {
    settings: Object.entries(normalized.settings).map(([key, value]) => ({
      key, action: Object.prototype.hasOwnProperty.call(current.settings, key) ? 'update' : 'add',
      changed: JSON.stringify(current.settings[key]) !== JSON.stringify(value),
    })),
    prompts: normalized.prompts.map((item) => ({
      key: item.prompt_id, action: promptMap.has(item.prompt_id) ? 'update' : 'add',
      changed: promptMap.get(item.prompt_id) !== item.content,
    })),
    legacy_prompts: normalized.legacy_prompts.map((item) => ({
      key: item.prompt_id,
      action: current.legacy_prompts.some((currentItem) => currentItem.prompt_id === item.prompt_id) ? 'update' : 'add',
      changed: current.legacy_prompts.find((currentItem) => currentItem.prompt_id === item.prompt_id)?.content !== item.content,
    })),
    prices: normalized.prices.map((item) => ({
      key: priceKey(item), action: currentPrices.has(priceKey(item)) ? 'update' : 'add',
      changed: JSON.stringify(currentPrices.get(priceKey(item)) || null) !== JSON.stringify(item),
    })),
    ai_configs: normalized.ai_configs.map((item) => ({
      key: configKey(item), action: currentConfigs.has(configKey(item)) ? 'update' : 'add',
      changed: JSON.stringify(currentConfigs.get(configKey(item)) || null) !== JSON.stringify(item),
      needs_key: item.needs_credential === true,
    })),
    model_routes: normalized.model_routes.map((item) => ({
      key: item.key,
      action: currentRoutes.has(item.key) ? 'update' : 'add',
      changed: JSON.stringify(currentRoutes.get(item.key) || null) !== JSON.stringify(item),
      missing_config: Boolean(item.config_name) && !normalized.ai_configs.some((config) => (
        config.service_type === item.config_service_type
        && (config.provider || '') === (item.config_provider || '')
        && config.name === item.config_name
      )),
    })),
  };
}

function createSnapshot(db, input = {}) {
  const sections = currentSections(db);
  const content = json(sections);
  const contentHash = sha256(content);
  if (input.dedupe !== false) {
    const existing = db.prepare(
      `SELECT id FROM config_snapshots
       WHERE snapshot_type = ? AND content_hash = ? ORDER BY id DESC LIMIT 1`
    ).get(input.snapshot_type || 'manual', contentHash);
    if (existing) return getSnapshot(db, existing.id);
  }
  const now = nowIso();
  const info = db.prepare(
    `INSERT INTO config_snapshots (snapshot_type, reason, schema_version, sections_json, content_hash, pinned, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(input.snapshot_type || 'manual', String(input.reason || ''), SCHEMA_VERSION, content, contentHash, input.pinned ? 1 : 0, now);
  if ((input.snapshot_type || 'manual') === 'automatic') pruneSnapshots(db);
  return getSnapshot(db, Number(info.lastInsertRowid));
}

function getSnapshot(db, id) {
  const row = db.prepare('SELECT * FROM config_snapshots WHERE id = ?').get(Number(id));
  if (!row) return null;
  const sections = JSON.parse(row.sections_json);
  if (sha256(row.sections_json) !== row.content_hash) throw new Error('配置快照校验失败');
  return { ...row, pinned: Boolean(row.pinned), sections, sections_json: undefined };
}

function listSnapshots(db, query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(query.page_size) || 20));
  const total = db.prepare('SELECT COUNT(*) AS n FROM config_snapshots').get().n;
  const items = db.prepare(
    `SELECT id, snapshot_type, reason, schema_version, content_hash, pinned, created_at
     FROM config_snapshots ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(pageSize, (page - 1) * pageSize).map((row) => ({ ...row, pinned: Boolean(row.pinned) }));
  return { items, pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) } };
}

function pruneSnapshots(db) {
  const cutoff = new Date(Date.now() - AUTO_MAX_AGE_MS).toISOString();
  db.prepare(`DELETE FROM config_snapshots WHERE pinned = 0 AND snapshot_type = 'automatic' AND created_at < ?`).run(cutoff);
  const keepIds = db.prepare(
    `SELECT id FROM config_snapshots WHERE pinned = 0 AND snapshot_type = 'automatic' ORDER BY id DESC LIMIT ?`
  ).all(AUTO_KEEP).map((row) => row.id);
  if (keepIds.length) {
    db.prepare(
      `DELETE FROM config_snapshots WHERE pinned = 0 AND snapshot_type = 'automatic'
       AND id NOT IN (${keepIds.map(() => '?').join(',')})`
    ).run(...keepIds);
  }
}

function previewImport(db, bundle) {
  const normalized = validateBundle(bundle);
  const diff = summarizeDiff(db, normalized);
  const token = crypto.randomUUID();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
  db.prepare('DELETE FROM config_import_previews WHERE expires_at < ? OR applied_at IS NOT NULL').run(now);
  db.prepare(
    `INSERT INTO config_import_previews
       (token, bundle_json, bundle_hash, base_fingerprint, diff_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(token, json(bundle), sha256(bundle), fingerprint(db), json(diff), now, expiresAt);
  return { token, expires_at: expiresAt, diff, warnings: normalized.ai_configs.filter((item) => item.needs_credential).length
    ? ['配置包不含 API Key；目标设备需要重新填写对应密钥。'] : [] };
}

function applyNormalized(db, normalized, mode = 'merge') {
  if (mode === 'replace') {
    const incomingPromptIds = new Set(normalized.prompts.map((item) => item.prompt_id));
    for (const item of promptRegistry.DEFINITIONS) {
      if (!incomingPromptIds.has(item.id)) promptRegistry.reset(db, item.id);
    }
    const incomingLegacyPromptIds = new Set(normalized.legacy_prompts.map((item) => item.prompt_id));
    for (const key of LEGACY_PROMPT_KEYS) {
      if (!incomingLegacyPromptIds.has(key)) db.prepare('DELETE FROM prompt_overrides WHERE key = ?').run(key);
    }
    const incomingSettingKeys = new Set(Object.keys(normalized.settings));
    for (const key of PORTABLE_SETTING_KEYS) {
      if (!incomingSettingKeys.has(key)) db.prepare('DELETE FROM global_settings WHERE key = ?').run(key);
    }
    db.prepare('DELETE FROM model_prices').run();
    db.prepare('DELETE FROM ai_model_map').run();
    const configKeys = new Set(normalized.ai_configs.map((item) => [item.service_type, item.provider || '', item.name].join('|')));
    const now = nowIso();
    for (const row of db.prepare('SELECT id, service_type, provider, name FROM ai_service_configs WHERE deleted_at IS NULL').all()) {
      if (!configKeys.has([row.service_type, row.provider || '', row.name].join('|'))) {
        db.prepare('UPDATE ai_service_configs SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, row.id);
      }
    }
  }
  for (const [key, value] of Object.entries(normalized.settings)) settingsService.setGlobalSetting(db, key, value);
  for (const item of normalized.prompts) promptRegistry.set(db, item.prompt_id, item.content);
  for (const item of normalized.legacy_prompts) {
    const content = String(item.content).trim();
    db.prepare(
      `INSERT INTO prompt_overrides (key, content, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
    ).run(item.prompt_id, content, nowIso());
    require('./promptI18n').setOverrideInMemory(item.prompt_id, content);
  }
  for (const item of normalized.prices) costs.upsertPrice(db, item);
  for (const item of normalized.ai_configs) {
    const current = db.prepare(
      `SELECT id FROM ai_service_configs WHERE service_type = ? AND provider = ? AND name = ? ORDER BY (deleted_at IS NULL) DESC, id LIMIT 1`
    ).get(item.service_type, item.provider || '', item.name);
    const model = json(Array.isArray(item.model) ? item.model : []);
    const settings = json(item.settings || {});
    const now = nowIso();
    if (current) {
      db.prepare(
        `UPDATE ai_service_configs SET api_protocol = ?, base_url = ?, model = ?, default_model = ?, endpoint = ?, query_endpoint = ?,
           priority = ?, is_default = ?, is_active = ?, settings = ?, deleted_at = NULL, updated_at = ? WHERE id = ?`
      ).run(item.api_protocol || '', item.base_url || '', model, item.default_model || null, item.endpoint || '', item.query_endpoint || '',
        Number(item.priority) || 0, item.is_default ? 1 : 0, item.is_active === false ? 0 : 1, settings, now, current.id);
    } else {
      db.prepare(
        `INSERT INTO ai_service_configs
           (service_type, provider, api_protocol, name, base_url, api_key, model, default_model, endpoint, query_endpoint,
            priority, is_default, is_active, settings, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(item.service_type, item.provider || '', item.api_protocol || '', item.name, item.base_url || '', model,
        item.default_model || null, item.endpoint || '', item.query_endpoint || '', Number(item.priority) || 0,
        item.is_default ? 1 : 0, item.is_active === false ? 0 : 1, settings, now, now);
    }
  }
  for (const item of normalized.model_routes) {
    const config = item.config_name ? db.prepare(
      `SELECT id FROM ai_service_configs
       WHERE deleted_at IS NULL AND service_type = ? AND provider = ? AND name = ? ORDER BY id LIMIT 1`
    ).get(item.config_service_type || item.service_type, item.config_provider || '', item.config_name) : null;
    if (item.config_name && !config) throw new Error(`模型路由 ${item.key} 对应的 AI 配置不存在`);
    const now = nowIso();
    db.prepare(
      `INSERT INTO ai_model_map (key, service_type, config_id, model_override, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET service_type = excluded.service_type, config_id = excluded.config_id,
         model_override = excluded.model_override, description = excluded.description, updated_at = excluded.updated_at`
    ).run(item.key, item.service_type, config?.id || null, item.model_override || null, item.description || '', now, now);
  }
}

function applyPreview(db, token, options = {}) {
  const row = db.prepare('SELECT * FROM config_import_previews WHERE token = ?').get(String(token || ''));
  if (!row) throw new Error('导入预览不存在或已失效');
  if (row.applied_at) throw new Error('该导入预览已经应用');
  if (row.expires_at <= nowIso()) throw new Error('导入预览已过期，请重新预览');
  if (row.base_fingerprint !== fingerprint(db)) throw new Error('配置在预览后发生变化，请重新预览后再导入');
  const bundle = JSON.parse(row.bundle_json);
  if (sha256(bundle) !== row.bundle_hash) throw new Error('导入预览数据校验失败');
  const normalized = validateBundle(bundle);
  const tx = db.transaction(() => {
    createSnapshot(db, {
      snapshot_type: options.snapshot_type || 'pre_import',
      reason: options.reason || '导入配置包前自动快照',
      dedupe: options.dedupe,
    });
    applyNormalized(db, normalized, bundle.apply_mode || 'merge');
    db.prepare('UPDATE config_import_previews SET applied_at = ? WHERE token = ?').run(nowIso(), row.token);
  });
  tx.immediate();
  return { applied: true, fingerprint: fingerprint(db), snapshot: listSnapshots(db, { page_size: 1 }).items[0] };
}

function previewSnapshotRollback(db, id) {
  const snapshot = getSnapshot(db, id);
  if (!snapshot) throw new Error('配置快照不存在');
  const unsigned = {
    product: 'yinzi-ai-video-workflow', kind: 'configuration-bundle', schema_version: snapshot.schema_version,
    created_at: snapshot.created_at, secrets_included: false, apply_mode: 'replace', sections: snapshot.sections,
  };
  return previewImport(db, { ...unsigned, checksum: sha256(unsigned) });
}

function applySnapshotRollback(db, id, token) {
  const snapshot = getSnapshot(db, id);
  if (!snapshot) throw new Error('配置快照不存在');
  const row = db.prepare('SELECT bundle_json FROM config_import_previews WHERE token = ?').get(String(token || ''));
  if (!row) throw new Error('回滚预览不存在或已失效');
  const previewBundle = JSON.parse(row.bundle_json);
  if (previewBundle.apply_mode !== 'replace' || sha256(previewBundle.sections) !== sha256(snapshot.sections)) {
    throw new Error('回滚预览与目标快照不匹配，请重新预览');
  }
  const result = applyPreview(db, token, {
    snapshot_type: 'pre_rollback',
    reason: `回滚到快照 #${snapshot.id} 前保护`,
    dedupe: false,
  });
  return { ...result, restored_snapshot_id: snapshot.id };
}

module.exports = {
  AUTO_KEEP,
  LEGACY_PROMPT_KEYS,
  PORTABLE_SETTING_KEYS,
  SCHEMA_VERSION,
  applyPreview,
  applySnapshotRollback,
  createSnapshot,
  currentSections,
  exportBundle,
  fingerprint,
  getSnapshot,
  listSnapshots,
  previewImport,
  previewSnapshotRollback,
  pruneSnapshots,
  sanitizedAiConfigs,
  portableModelRoutes,
  sanitizePortableValue,
  validateBundle,
};
