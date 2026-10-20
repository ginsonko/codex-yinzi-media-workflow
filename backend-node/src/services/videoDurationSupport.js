'use strict';
/**
 * Single-generation video duration hints.
 *
 * A concrete model's allowed durations come from its resolved capability
 * contract (site /model-capabilities snapshot, local override or bundled
 * profile). The site's smart-video virtual model routes across many physical
 * models, so its support is a per-duration route count (`duration_support`)
 * published by the site; when the site does not publish it, the count is
 * estimated from the automatic route contracts in the saved catalog snapshot.
 *
 * Everything here is advisory. Only the canvas assistant's own generation
 * requests may be stopped by `checkVideoDuration`; user-initiated requests are
 * never vetoed by these hints.
 */
const crypto = require('node:crypto');

const SMART_VIDEO_MODEL = 'smart-video';
const COMMON_SECONDS = [5, 10, 15, 30];
const SITE_CACHE_TTL_MS = 10 * 60 * 1000;
const SITE_FAILURE_TTL_MS = 2 * 60 * 1000;
const SITE_TIMEOUT_MS = 4000;
const MAX_CACHE_ENTRIES = 32;
const siteCache = new Map();
const observedSupport = new Map();

function positive(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function positiveList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(positive).filter((n) => n !== undefined))].sort((a, b) => a - b);
}

function modelKey(model) {
  return String(model || '').trim().toLowerCase().split('/').pop();
}

function isSmartVideoModel(model) {
  return modelKey(model) === SMART_VIDEO_MODEL;
}

/** `{ allowed: [5, 10, 15] }`, `{ min, max }` or null when the contract says nothing about duration. */
function durationRule(capability, options = {}) {
  if (!capability || typeof capability !== 'object') return null;
  const mode = String(capability.duration_mode || '').toLowerCase();
  const allowed = positiveList(capability.allowed_durations);
  const fixed = positive(capability.fixed_duration_seconds) ?? (mode === 'fixed' ? positive(capability.duration_min) : undefined);
  if (mode === 'fixed' && fixed) return { allowed: [fixed] };
  if (allowed.length) return { allowed };
  if (fixed) return { allowed: [fixed] };
  const min = positive(options.automatic ? capability.auto_duration_min ?? capability.duration_min : capability.duration_min);
  const max = positive(options.automatic ? capability.auto_duration_max ?? capability.duration_max : capability.duration_max);
  if (min === undefined && max === undefined) return null;
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

function ruleAccepts(rule, seconds) {
  const value = Number(seconds);
  if (!rule || !Number.isFinite(value)) return null;
  if (rule.allowed) return rule.allowed.includes(value);
  return (rule.min === undefined || value >= rule.min) && (rule.max === undefined || value <= rule.max);
}

function formatRule(rule) {
  if (!rule) return '';
  if (rule.allowed) return `${rule.allowed.join(' / ')} 秒`;
  if (rule.min !== undefined && rule.max !== undefined) return rule.min === rule.max ? `${rule.min} 秒` : `${rule.min}-${rule.max} 秒`;
  return rule.min !== undefined ? `${rule.min} 秒以上` : `${rule.max} 秒以内`;
}

/** Nearest allowed duration; a tie goes to the longer one so a shot is not shortened needlessly. */
function nearestAllowed(rule, seconds) {
  if (!rule) return undefined;
  const target = Number(seconds);
  if (rule.allowed) {
    if (!Number.isFinite(target)) return rule.allowed[0];
    return rule.allowed.reduce((best, value) => {
      const d = Math.abs(value - target), bd = Math.abs(best - target);
      return d < bd || (d === bd && value > best) ? value : best;
    }, rule.allowed[0]);
  }
  if (!Number.isFinite(target)) return rule.min ?? rule.max;
  return Math.min(rule.max ?? Infinity, Math.max(rule.min ?? 0, target));
}

function normalizeDurationSupport(value) {
  if (!Array.isArray(value)) return [];
  const bySeconds = new Map();
  for (const entry of value) {
    const seconds = positive(Array.isArray(entry) ? entry[0] : entry?.seconds ?? entry?.duration);
    const count = Number(Array.isArray(entry) ? entry[1] : entry?.count ?? entry?.routes ?? entry?.models);
    if (seconds === undefined || !Number.isFinite(count) || count < 0) continue;
    bySeconds.set(seconds, Math.max(bySeconds.get(seconds) || 0, Math.floor(count)));
  }
  return [...bySeconds.entries()].sort((a, b) => a[0] - b[0]).map(([seconds, count]) => ({ seconds, count }));
}

/** The duration with the most routes; on a tie the shorter one, as the site does. */
function recommendFromSupport(support) {
  let best;
  for (const entry of support || []) if (entry.count > 0 && (!best || entry.count > best.count)) best = entry;
  return best?.seconds;
}

function formatDurationSupport(support, exceptSeconds) {
  return (support || []).filter((entry) => entry.count > 0 && entry.seconds !== Number(exceptSeconds))
    .map((entry) => `${entry.seconds} 秒 ${entry.count} 个`).join('、');
}

/**
 * Route count for one duration from a site-published list. A listed duration
 * is exact; a duration beyond the longest (or below the shortest) supported
 * one has no route; anything in between that the site did not list is
 * unknown, because range routes may accept it.
 */
function supportCountFor(support, seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || !support?.length) return null;
  const listed = support.find((entry) => entry.seconds === value);
  if (listed) return listed.count;
  const available = support.filter((entry) => entry.count > 0).map((entry) => entry.seconds);
  if (!available.length) return 0;
  if (value > Math.max(...available) || value < Math.min(...available)) return 0;
  return null;
}

function supportNode(value, model, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return null;
  if (Array.isArray(value)) {
    for (const item of value) { const found = supportNode(item, model, depth + 1); if (found) return found; }
    return null;
  }
  const name = String(value.model || value.model_name || value.id || value.name || '').trim();
  if (Array.isArray(value.duration_support) && (!model || !name || isSmartVideoModel(name) || modelKey(name) === modelKey(model))) return value;
  for (const item of Object.values(value)) { const found = supportNode(item, model, depth + 1); if (found) return found; }
  return null;
}

function fieldNode(value, key, accept, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return undefined;
  if (!Array.isArray(value) && accept(value[key])) return value[key];
  for (const item of Object.values(value)) { const found = fieldNode(item, key, accept, depth + 1); if (found !== undefined) return found; }
  return undefined;
}

/**
 * Pull `duration_support` / `recommended_duration` / `duration_hint` out of a
 * site payload of any envelope. `model` selects the entry of a model list;
 * null accepts any entry (a task error concerns one request only).
 */
function extractDurationSupport(payload, model = SMART_VIDEO_MODEL) {
  const node = supportNode(payload, model);
  const support = normalizeDurationSupport(node?.duration_support);
  const hint = String(fieldNode(payload, 'duration_hint', (v) => typeof v === 'string' && v.trim()) || '').trim();
  const recommended = positive(node?.recommended_duration)
    ?? (model ? undefined : positive(fieldNode(payload, 'recommended_duration', (v) => positive(v) !== undefined)))
    ?? recommendFromSupport(support);
  if (!support.length && !hint && recommended === undefined) return null;
  return {
    ...(support.length ? { duration_support: support } : {}),
    ...(recommended !== undefined ? { recommended_duration: recommended } : {}),
    ...(hint ? { duration_hint: hint.slice(0, 300) } : {}),
  };
}

/** Chinese sentence appended to a provider error so batch items and the canvas assistant see the fix. */
function durationErrorHint(payload) {
  const found = extractDurationSupport(payload, null);
  if (!found) return '';
  const parts = [];
  if (found.duration_hint) parts.push(found.duration_hint);
  if (found.duration_support?.length) parts.push(`可用时长：${formatDurationSupport(found.duration_support)}`);
  if (found.recommended_duration !== undefined) parts.push(`建议改为 ${found.recommended_duration} 秒`);
  return parts.join('；');
}

function cacheKey(config, model) {
  const keyHash = crypto.createHash('sha256').update(String(config?.api_key || '')).digest('hex').slice(0, 16);
  return `${String(config?.base_url || '').trim()}\x00${keyHash}\x00${modelKey(model)}`;
}

function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_CACHE_ENTRIES) map.delete(map.keys().next().value);
}

/** Keep support data that a site error returned, so the next check of the same route uses it. */
function rememberObservedSupport(config, model, payload) {
  if (!config || !isSmartVideoModel(model)) return;
  const found = extractDurationSupport(payload, model);
  if (found?.duration_support?.length) remember(observedSupport, cacheKey(config, model), { ...found, observed_at: Date.now() });
}

function siteCapabilitiesUrl(config) {
  try {
    const url = new URL(String(config?.base_url || ''));
    return /^https?:$/.test(url.protocol) ? `${url.origin}/api/media/capabilities` : null;
  } catch (_) { return null; }
}

/** Light, cached read of the site's media capabilities; any failure simply means "unknown". */
async function fetchSiteDurationSupport(config, model, options = {}) {
  const url = siteCapabilitiesUrl(config);
  if (!url || String(config?.provider || '').toLowerCase() !== 'yinzi') return null;
  const key = cacheKey(config, model);
  const cached = siteCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < (cached.value ? SITE_CACHE_TTL_MS : SITE_FAILURE_TTL_MS)) return cached.value;
  let value = null;
  try {
    const headers = { Accept: 'application/json' };
    if (config.api_key) headers.Authorization = `Bearer ${config.api_key}`;
    const res = await (options.fetchImpl || fetch)(url, { method: 'GET', headers, signal: AbortSignal.timeout(options.timeoutMs || SITE_TIMEOUT_MS) });
    if (res.ok) {
      const found = extractDurationSupport(await res.json(), model);
      if (found?.duration_support?.length) value = found;
    }
  } catch (_) { value = null; }
  remember(siteCache, key, { at: now, value });
  return value;
}

function parseSettings(config) {
  const raw = config?.settings;
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}') || {}; } catch (_) { return {}; }
}

function catalogModels(config) {
  const snapshot = parseSettings(config).model_catalog_snapshot || config?.model_catalog_snapshot;
  return Array.isArray(snapshot?.models) ? snapshot.models : [];
}

function automaticRouteRules(config) {
  return catalogModels(config)
    .filter((item) => item && !isSmartVideoModel(item.model)
      && (item.automatic_eligible === true || item.capabilities?.automatic_eligible === true))
    .map((item) => durationRule(item.capabilities, { automatic: true }))
    .filter(Boolean);
}

/** Estimate smart-video support from the automatic route contracts saved with the config. */
function localSmartVideoSupport(config, extraSeconds = []) {
  const rules = automaticRouteRules(config);
  if (!rules.length) return null;
  const candidates = new Set([...COMMON_SECONDS, ...extraSeconds.map(positive).filter(Boolean)]);
  for (const rule of rules) {
    for (const value of rule.allowed || []) candidates.add(value);
    if (rule.min !== undefined) candidates.add(rule.min);
    if (rule.max !== undefined) candidates.add(rule.max);
  }
  const counts = [...candidates].sort((a, b) => a - b)
    .map((seconds) => ({ seconds, count: rules.filter((rule) => ruleAccepts(rule, seconds)).length }));
  const support = counts.filter((entry) => entry.count > 0 || extraSeconds.map(Number).includes(entry.seconds));
  return { duration_support: support, recommended_duration: recommendFromSupport(support), route_count: rules.length, source: 'catalog_routes' };
}

function catalogSmartVideoSupport(config, model) {
  const item = catalogModels(config).find((entry) => modelKey(entry?.model) === modelKey(model));
  const found = item ? extractDurationSupport(item, model) : null;
  return found?.duration_support?.length ? found : null;
}

/** Smart-video support: site data first (catalog, observed error, site read), then the local estimate. */
async function smartVideoSupport(config, model = SMART_VIDEO_MODEL, options = {}) {
  const catalog = catalogSmartVideoSupport(config, model);
  if (catalog) return { ...catalog, source: 'site_catalog' };
  const observed = observedSupport.get(cacheKey(config, model));
  if (observed) return { duration_support: observed.duration_support, recommended_duration: observed.recommended_duration, source: 'site_error' };
  if (options.remote !== false) {
    const site = await fetchSiteDurationSupport(config, model, options);
    if (site) return { ...site, source: 'site' };
  }
  return localSmartVideoSupport(config, options.extraSeconds || []);
}

function concreteCapability(config, model) {
  if (!config) return null;
  const videoClient = require('./videoClient');
  if (videoClient.resolveVideoProtocol(config, model) !== 'yinzi') return null;
  const resolved = videoClient.resolveYinziCapabilityContext(config, model);
  return resolved?.capability ? resolved : null;
}

/** Compact duration description for one configured model, or null when nothing is known. */
async function modelDurationInfo(config, model, options = {}) {
  if (!config || !String(model || '').trim()) return null;
  if (isSmartVideoModel(model)) {
    const support = await smartVideoSupport(config, model, options);
    return support?.duration_support?.length ? { kind: 'smart', ...support } : null;
  }
  return concreteDurationInfo(config, model);
}

/** Synchronous duration description for a concrete (non smart-video) model. */
function concreteDurationInfo(config, model) {
  if (!config || !String(model || '').trim() || isSmartVideoModel(model)) return null;
  const resolved = concreteCapability(config, model);
  const rule = durationRule(resolved?.capability);
  if (!rule) return null;
  return { kind: 'model', ...(rule.allowed ? { durations: rule.allowed } : {}), ...(rule.min !== undefined ? { duration_min: rule.min } : {}),
    ...(rule.max !== undefined ? { duration_max: rule.max } : {}), source: resolved.capability_source || 'unknown' };
}

function compactInfo(info) {
  if (!info) return undefined;
  if (info.kind === 'smart') {
    return { duration_support: info.duration_support.filter((entry) => entry.count > 0), recommended_duration: info.recommended_duration,
      source: info.source === 'catalog_routes' ? '本地路由估算' : '站点' };
  }
  return formatRule(info.durations ? { allowed: info.durations } : { min: info.duration_min, max: info.duration_max });
}

/** `{ [model]: '5 / 10 / 15 秒' | { duration_support, recommended_duration } }` for one video config. */
async function configDurationSummary(config, options = {}) {
  const models = [...new Set([...(Array.isArray(config?.model) ? config.model : []), config?.default_model]
    .map((item) => String(item || '').trim()).filter(Boolean))];
  const summary = {};
  for (const model of models) {
    const value = compactInfo(await modelDurationInfo(config, model, options));
    if (value) summary[model] = value;
  }
  return summary;
}

/**
 * Whether one duration is known to be impossible for the model. For
 * smart-video, site-published counts decide; the local route estimate only
 * decides when the duration is longer than every saved route allows, since a
 * stale catalog may miss newer routes in between. Concrete models follow
 * their resolved contract.
 */
async function checkVideoDuration(config, model, seconds, options = {}) {
  const value = positive(seconds);
  if (!config || value === undefined) return { supported: null };
  if (isSmartVideoModel(model)) {
    const support = await smartVideoSupport(config, model, { ...options, extraSeconds: [value] });
    if (!support?.duration_support?.length) return { supported: null };
    const count = supportCountFor(support.duration_support, value);
    const longest = Math.max(0, ...support.duration_support.filter((entry) => entry.count > 0).map((entry) => entry.seconds));
    const decisive = support.source !== 'catalog_routes' || value > longest;
    const recommended = support.recommended_duration;
    return {
      supported: count === null ? null : count > 0 ? true : decisive ? false : null,
      count,
      recommended_duration: recommended,
      duration_support: support.duration_support.filter((entry) => entry.count > 0),
      source: support.source,
      message: count === 0 ? `智能视频（${model}）没有支持 ${value} 秒的路由（${support.source === 'catalog_routes' ? '按已保存的路由目录估算，' : ''}可用：${formatDurationSupport(support.duration_support) || '无'}）`
        + (recommended !== undefined ? `，建议改为 ${recommended} 秒` : '') : '',
    };
  }
  const resolved = concreteCapability(config, model);
  const rule = durationRule(resolved?.capability);
  const accepted = ruleAccepts(rule, value);
  if (accepted === null) return { supported: null };
  const recommended = nearestAllowed(rule, value);
  return {
    supported: accepted,
    allowed: formatRule(rule),
    recommended_duration: recommended,
    source: resolved.capability_source || 'unknown',
    message: accepted ? '' : `模型 ${model} 单次生成支持 ${formatRule(rule)}，不支持 ${value} 秒，建议改为 ${recommended} 秒`,
  };
}

function resetDurationSupportCache() { siteCache.clear(); observedSupport.clear(); }

module.exports = {
  SMART_VIDEO_MODEL,
  isSmartVideoModel,
  durationRule,
  ruleAccepts,
  formatRule,
  normalizeDurationSupport,
  recommendFromSupport,
  formatDurationSupport,
  supportCountFor,
  extractDurationSupport,
  durationErrorHint,
  rememberObservedSupport,
  fetchSiteDurationSupport,
  localSmartVideoSupport,
  smartVideoSupport,
  modelDurationInfo,
  concreteDurationInfo,
  configDurationSummary,
  checkVideoDuration,
  resetDurationSupportCache,
};
