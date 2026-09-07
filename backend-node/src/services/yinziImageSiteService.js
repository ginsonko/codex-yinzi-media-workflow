const aiConfigService = require('./aiConfigService');
const { normalizeYinziBaseUrl } = require('./yinziService');
const {
  IMAGE_YINZI_PROFILE,
  IMAGE_YINZI_PRICE_SNAPSHOT,
  IMAGE_YINZI_VIDEO_CAPABILITIES,
  resolveDistributionProfile,
  getImageYinziSiteProfile,
} = require('./distributionProfiles');

const IMAGE_YINZI_DEFAULT_BASE_URL = 'https://image.yinziapi.top/v1';

function normalizeImageYinziBaseUrl(value) {
  const base = normalizeYinziBaseUrl(value || IMAGE_YINZI_DEFAULT_BASE_URL);
  let parsed = new URL(base);
  if (!/image\.yinziapi\.top$/i.test(parsed.hostname)) {
    throw Object.assign(new Error('银子媒体站 Base URL 必须是 https://image.yinziapi.top（可带 /v1）'), { code: 'IMAGE_YINZI_HOST_INVALID' });
  }
  if (parsed.protocol !== 'https:') {
    throw Object.assign(new Error('银子媒体站只允许 HTTPS'), { code: 'IMAGE_YINZI_HTTPS_REQUIRED' });
  }
  if (!['/v1', '/v1/'].includes(parsed.pathname)) {
    throw Object.assign(new Error('银子媒体站地址只能是站点根地址或 /v1'), { code: 'IMAGE_YINZI_PATH_INVALID' });
  }
  if (parsed.pathname === '/') parsed.pathname = '/v1';
  return parsed.toString().replace(/\/$/, '');
}

function key(value, label) {
  const result = String(value || '').trim();
  if (!result) throw Object.assign(new Error(`${label} Key 不能为空`), { code: 'IMAGE_YINZI_KEY_REQUIRED' });
  return result;
}

const PRICE_SNAPSHOT = IMAGE_YINZI_PRICE_SNAPSHOT;

function parseSettings(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch (_) { return {}; }
}

function profileSettings(kind, distributionProfile = 'universal') {
  const common = {
    site_profile: IMAGE_YINZI_PROFILE,
    distribution_profile: resolveDistributionProfile(distributionProfile),
    routing_mode: 'group',
    smart_routing_enabled: false,
    provider_family: 'laoli_compatible',
    capability_source: 'built_in_advisory',
    price_snapshot: PRICE_SNAPSHOT,
    local_media_persistence: true,
  };
  if (kind === 'video') {
    return {
      ...common,
      auto_model_selection: false,
      model_capabilities: IMAGE_YINZI_VIDEO_CAPABILITIES,
    };
  }
  return common;
}

function definitions(input = {}) {
  const baseUrl = normalizeImageYinziBaseUrl(input.base_url);
  const textKey = key(input.text_api_key, '文本');
  const imageKey = key(input.image_api_key, '图片');
  const videoKey = key(input.video_api_key, '视频');
  const textModel = String(input.text_model || 'gpt-5.6-sol').trim();
  const imageModel = String(input.image_model || 'gpt-image-2').trim();
  const videoModel = String(input.video_model || 'Seedance 2.5-720').trim();
  const distributionProfile = resolveDistributionProfile(input);
  if (!textModel || !imageModel || !videoModel) throw new Error('文本、图片、视频默认模型不能为空');
  const modelLists = {
    text: [...new Set(['gpt-5.6-sol', textModel].filter(Boolean))],
    image: [...new Set(['gpt-image-2', imageModel].filter(Boolean))],
    video: [...new Set(['Seedance 2.5-720', 'Seedance 2.0-720', videoModel].filter(Boolean))],
  };
  const existingDefaults = input.existing_defaults || {};
  const defaultFlag = (type) => existingDefaults[type] ? false : input.set_default !== false;
  return [
    { service_type: 'text', name: '银子媒体站 文本', provider: 'yinzi', api_protocol: 'openai', base_url: baseUrl, api_key: textKey, model: modelLists.text, default_model: textModel, endpoint: '/chat/completions', query_endpoint: '', priority: 95, is_default: defaultFlag('text'), settings: JSON.stringify(profileSettings('text', distributionProfile)) },
    { service_type: 'image', name: '银子媒体站 图片', provider: 'yinzi', api_protocol: 'openai', base_url: baseUrl, api_key: imageKey, model: modelLists.image, default_model: imageModel, endpoint: '/images/generations', query_endpoint: '', priority: 95, is_default: defaultFlag('image'), settings: JSON.stringify(profileSettings('image', distributionProfile)) },
    { service_type: 'storyboard_image', name: '银子媒体站 分镜图', provider: 'yinzi', api_protocol: 'openai', base_url: baseUrl, api_key: imageKey, model: modelLists.image, default_model: imageModel, endpoint: '/images/generations', query_endpoint: '', priority: 95, is_default: defaultFlag('storyboard_image'), settings: JSON.stringify(profileSettings('image', distributionProfile)) },
    { service_type: 'video', name: '银子媒体站 视频', provider: 'yinzi', api_protocol: 'yinzi', base_url: baseUrl, api_key: videoKey, model: modelLists.video, default_model: videoModel, endpoint: '/videos', query_endpoint: '/videos/{taskId}', priority: 95, is_default: defaultFlag('video'), settings: JSON.stringify(profileSettings('video', distributionProfile)) },
  ];
}

function findExisting(db, serviceType) {
  const rows = db.prepare(`SELECT id, settings FROM ai_service_configs
    WHERE deleted_at IS NULL AND provider = 'yinzi' AND service_type = ?
    ORDER BY is_default DESC, priority DESC, updated_at DESC, id DESC`).all(serviceType);
  return rows.find((row) => parseSettings(row.settings).site_profile === IMAGE_YINZI_PROFILE) || null;
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
    profile: IMAGE_YINZI_PROFILE,
    distribution_profile: resolveDistributionProfile(input),
    base_url: defs[0].base_url,
    routing_mode: 'group',
    smart_routing: false,
    price_snapshot: PRICE_SNAPSHOT,
    site: getImageYinziSiteProfile(input),
    configured,
  };
}

module.exports = {
  IMAGE_YINZI_DEFAULT_BASE_URL,
  IMAGE_YINZI_PROFILE,
  PRICE_SNAPSHOT,
  IMAGE_YINZI_VIDEO_CAPABILITIES,
  getImageYinziSiteProfile,
  normalizeImageYinziBaseUrl,
  definitions,
  setup,
};
