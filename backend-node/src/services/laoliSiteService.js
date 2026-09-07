const aiConfigService = require('./aiConfigService');
const { normalizeYinziBaseUrl } = require('./yinziService');
const {
  LAOLI_VIDEO_PROFILE,
  LAOLI_SITE,
  LAOLI_VIDEO_CAPABILITIES,
  resolveDistributionProfile,
} = require('./distributionProfiles');

const LAOLI_DEFAULT_BASE_URL = 'https://video.laoliimage2.win/v1';

/**
 * The Laoli media site is intentionally validated separately from the text
 * service. Laoli does not expose a text model, so text may point at any
 * compatible OpenAI Chat Completions gateway while image/video stay on the
 * known Laoli host.
 */
function normalizeRequiredTextBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw Object.assign(new Error('文本服务 Base URL 不能为空（老李站点没有文本模型，请填写其它兼容文本站点）'), { code: 'LAOLI_TEXT_BASE_URL_REQUIRED' });
  return normalizeYinziBaseUrl(raw);
}

function normalizeProvidedMediaBaseUrl(value, label) {
  const raw = String(value || '').trim();
  if (!raw) throw Object.assign(new Error(`${label}服务 Base URL 不能为空`), { code: 'LAOLI_MEDIA_BASE_URL_REQUIRED' });
  return normalizeLaoliBaseUrl(raw);
}

function normalizeLaoliBaseUrl(value) {
  const base = normalizeYinziBaseUrl(value || LAOLI_DEFAULT_BASE_URL);
  const parsed = new URL(base);
  if (!/video\.laoliimage2\.win$/i.test(parsed.hostname)) {
    throw Object.assign(new Error('老李站点 Base URL 必须是 https://video.laoliimage2.win（可带 /v1）'), { code: 'LAOLI_HOST_INVALID' });
  }
  if (parsed.protocol !== 'https:') {
    throw Object.assign(new Error('老李站点只允许 HTTPS'), { code: 'LAOLI_HTTPS_REQUIRED' });
  }
  if (!['/v1', '/v1/'].includes(parsed.pathname)) {
    throw Object.assign(new Error('老李站点地址只能是站点根地址或 /v1'), { code: 'LAOLI_PATH_INVALID' });
  }
  if (parsed.pathname === '/') parsed.pathname = '/v1';
  return parsed.toString().replace(/\/$/, '');
}

function key(value, label) {
  const result = String(value || '').trim();
  if (!result) throw Object.assign(new Error(`${label} Key 不能为空`), { code: 'LAOLI_KEY_REQUIRED' });
  return result;
}

function profileSettings(kind, distributionProfile = 'universal') {
  const common = {
    site_profile: LAOLI_VIDEO_PROFILE,
    distribution_profile: resolveDistributionProfile(distributionProfile),
    routing_mode: 'group',
    smart_routing_enabled: false,
    provider_family: 'laoli_compatible',
    capability_source: 'built_in_advisory',
    model_aliases: LAOLI_SITE.model_aliases,
    local_media_persistence: true,
  };
  if (kind === 'video') {
    return {
      ...common,
      auto_model_selection: false,
      model_capabilities: LAOLI_VIDEO_CAPABILITIES,
    };
  }
  return common;
}

function definitions(input = {}) {
  const legacyBaseUrl = String(input.base_url || '').trim();
  // Old clients sent one base_url. Keep a bounded migration path for the
  // media services only; never silently use the media host for text.
  const imageBaseUrl = input.image_base_url !== undefined
    ? normalizeProvidedMediaBaseUrl(input.image_base_url, '图片')
    : normalizeLaoliBaseUrl(legacyBaseUrl || LAOLI_DEFAULT_BASE_URL);
  const videoBaseUrl = input.video_base_url !== undefined
    ? normalizeProvidedMediaBaseUrl(input.video_base_url, '视频')
    : normalizeLaoliBaseUrl(legacyBaseUrl || LAOLI_DEFAULT_BASE_URL);
  const textBaseUrl = normalizeRequiredTextBaseUrl(input.text_base_url);
  const textKey = key(input.text_api_key, '文本');
  const imageKey = key(input.image_api_key, '图片');
  const videoKey = key(input.video_api_key, '视频');
  const textModel = String(input.text_model || 'gpt-5.6-sol').trim();
  const imageModel = String(input.image_model || 'gpt-image-2').trim();
  const videoModel = String(input.video_model || '3.5').trim();
  const distributionProfile = resolveDistributionProfile(input);
  if (!textModel || !imageModel || !videoModel) throw new Error('文本、图片、视频默认模型不能为空');
  const modelLists = {
    text: [...new Set(['gpt-5.6-sol', textModel].filter(Boolean))],
    image: [...new Set(['gpt-image-2', imageModel].filter(Boolean))],
    video: [...new Set(['3.5', '3.0', videoModel].filter(Boolean))],
  };
  const existingDefaults = input.existing_defaults || {};
  const defaultFlag = (type) => existingDefaults[type] ? false : input.set_default !== false;
  return [
    { service_type: 'text', name: '老李兼容 文本', provider: 'yinzi', api_protocol: 'openai', base_url: textBaseUrl, api_key: textKey, model: modelLists.text, default_model: textModel, endpoint: '/chat/completions', query_endpoint: '', priority: 95, is_default: defaultFlag('text'), settings: JSON.stringify(profileSettings('text', distributionProfile)) },
    { service_type: 'image', name: '老李站点 图片', provider: 'yinzi', api_protocol: 'openai', base_url: imageBaseUrl, api_key: imageKey, model: modelLists.image, default_model: imageModel, endpoint: '/images/generations', query_endpoint: '', priority: 95, is_default: defaultFlag('image'), settings: JSON.stringify(profileSettings('image', distributionProfile)) },
    { service_type: 'storyboard_image', name: '老李站点 分镜图', provider: 'yinzi', api_protocol: 'openai', base_url: imageBaseUrl, api_key: imageKey, model: modelLists.image, default_model: imageModel, endpoint: '/images/generations', query_endpoint: '', priority: 95, is_default: defaultFlag('storyboard_image'), settings: JSON.stringify(profileSettings('image', distributionProfile)) },
    { service_type: 'video', name: '老李站点 视频', provider: 'yinzi', api_protocol: 'yinzi', base_url: videoBaseUrl, api_key: videoKey, model: modelLists.video, default_model: videoModel, endpoint: '/videos', query_endpoint: '/videos/{taskId}', priority: 95, is_default: defaultFlag('video'), settings: JSON.stringify(profileSettings('video', distributionProfile)) },
  ];
}

function parseSettings(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch (_) { return {}; }
}

function findExisting(db, serviceType) {
  const rows = db.prepare(`SELECT id, settings FROM ai_service_configs
    WHERE deleted_at IS NULL AND provider = 'yinzi' AND service_type = ?
    ORDER BY is_default DESC, priority DESC, updated_at DESC, id DESC`).all(serviceType);
  return rows.find((row) => parseSettings(row.settings).site_profile === LAOLI_VIDEO_PROFILE) || null;
}

function setup(db, log, input = {}) {
  const currentDefaults = {};
  for (const type of ['text', 'image', 'storyboard_image', 'video']) {
    currentDefaults[type] = Boolean(db.prepare('SELECT id FROM ai_service_configs WHERE deleted_at IS NULL AND service_type = ? AND is_default = 1 LIMIT 1').get(type));
  }
  const defs = definitions({ ...input, existing_defaults: currentDefaults });
  const tx = db.transaction(() => defs.map((definition) => {
    const existing = findExisting(db, definition.service_type);
    const config = existing
      ? aiConfigService.updateConfig(db, log, existing.id, definition)
      : aiConfigService.createConfig(db, log, definition);
    return { id: config.id, service_type: config.service_type, name: config.name, default_model: config.default_model, is_default: config.is_default };
  }));
  const configured = tx.immediate();
  return {
    provider: 'yinzi',
    profile: LAOLI_VIDEO_PROFILE,
    distribution_profile: resolveDistributionProfile(input),
    // Keep base_url as a compatibility summary (the image URL); new clients
    // should use the explicit per-service values below.
    base_url: defs.find((item) => item.service_type === 'image')?.base_url || '',
    text_base_url: defs.find((item) => item.service_type === 'text')?.base_url || '',
    image_base_url: defs.find((item) => item.service_type === 'image')?.base_url || '',
    video_base_url: defs.find((item) => item.service_type === 'video')?.base_url || '',
    routing_mode: 'group',
    smart_routing: false,
    site: {
      id: LAOLI_SITE.id,
      name: LAOLI_SITE.name,
      base_url: LAOLI_SITE.base_url,
      credential_mode: LAOLI_SITE.credential_mode,
      defaults: LAOLI_SITE.defaults,
      video_models: LAOLI_SITE.video_models,
      model_aliases: LAOLI_SITE.model_aliases,
      model_capabilities: LAOLI_VIDEO_CAPABILITIES,
    },
    configured,
  };
}

module.exports = {
  LAOLI_DEFAULT_BASE_URL,
  LAOLI_VIDEO_PROFILE,
  LAOLI_VIDEO_CAPABILITIES,
  normalizeLaoliBaseUrl,
  definitions,
  setup,
};
