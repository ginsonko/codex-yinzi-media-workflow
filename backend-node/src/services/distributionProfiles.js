/**
 * Shared, non-secret distribution metadata.
 *
 * A distribution profile describes the onboarding defaults and copy shown to
 * a user. It is deliberately not an allow-list for providers or models: an
 * unknown model remains manually selectable and an unknown capability remains
 * advisory. Keeping this metadata in one place prevents the YinZi and
 * universal editions from drifting while sharing the same workflow kernel.
 */

const IMAGE_YINZI_PROFILE = 'image_yinzi_laoli_compatible_v1';
const LAOLI_VIDEO_PROFILE = 'laoli_newapi_seedance_alias_v1';

const IMAGE_YINZI_PRICE_SNAPSHOT = Object.freeze({
  source: 'image.yinziapi.top-public-catalog-2026-08-29',
  currency: 'CNY',
  models: Object.freeze({
    'gpt-image-2': Object.freeze({ billing_unit: 'per_request', effective_price: 0.015 }),
    'Seedance 2.0-720': Object.freeze({ billing_unit: 'per_request', effective_price: 3.5, allowed_durations: Object.freeze([5, 10, 15]) }),
    'Seedance 2.5-720': Object.freeze({ billing_unit: 'per_request', effective_price: 4, fixed_duration_seconds: 30, allowed_durations: Object.freeze([30]) }),
  }),
});

const IMAGE_YINZI_VIDEO_CAPABILITIES = Object.freeze({
  'Seedance 2.5-720': Object.freeze({
    duration_mode: 'fixed', fixed_duration_seconds: 30, allowed_durations: Object.freeze([30]),
    max_images: 30, max_videos: 10, max_audios: 10,
  }),
  'Seedance 2.0-720': Object.freeze({
    duration_mode: 'enumerated', allowed_durations: Object.freeze([5, 10, 15]),
    max_images: 30, max_videos: 10, max_audios: 10,
  }),
});

// 老李站点使用 3.5 / 3.0 作为即梦 2.5 / 2.0 的站内别名。保留独立
// 的 key，避免调用时因为名称不同而丢失时长提示；这些信息仍是 advisory。
const LAOLI_VIDEO_CAPABILITIES = Object.freeze({
  '3.5': Object.freeze({
    alias_of: 'Seedance 2.5-720',
    duration_mode: 'fixed', fixed_duration_seconds: 30, allowed_durations: Object.freeze([30]),
    max_images: 30, max_videos: 10, max_audios: 10,
  }),
  '3.0': Object.freeze({
    alias_of: 'Seedance 2.0-720',
    duration_mode: 'enumerated', allowed_durations: Object.freeze([5, 10, 15]),
    max_images: 30, max_videos: 10, max_audios: 10,
  }),
});

const IMAGE_YINZI_SITE = Object.freeze({
  id: 'image_yinzi',
  name: '银子媒体站（老李兼容）',
  site_profile: IMAGE_YINZI_PROFILE,
  base_url: 'https://image.yinziapi.top/v1',
  routing_mode: 'group',
  smart_routing: false,
  credential_mode: 'three_keys',
  key_roles: Object.freeze({ text: 'text', image: 'image + storyboard_image', video: 'video' }),
  protocol: Object.freeze({ text: 'openai', image: 'openai', storyboard_image: 'openai', video: 'yinzi' }),
  defaults: Object.freeze({ text_model: 'gpt-5.6-sol', image_model: 'gpt-image-2', video_model: 'Seedance 2.5-720' }),
  video_models: Object.freeze({ 'Seedance 2.5-720': '固定 30 秒', 'Seedance 2.0-720': '5 / 10 / 15 秒' }),
  price_snapshot: IMAGE_YINZI_PRICE_SNAPSHOT,
  model_capabilities: IMAGE_YINZI_VIDEO_CAPABILITIES,
});

// 老李 NewAPI 站点：普通三 Key，不支持银子智能路由。3.5/3.0 是站点
// 对即梦 2.5/2.0 的别名；能力仅用于引导和默认选择，不能阻止手动模型。
const LAOLI_SITE = Object.freeze({
  id: 'laoli',
  name: '老李 NewAPI（即梦兼容）',
  site_profile: LAOLI_VIDEO_PROFILE,
  base_url: 'https://video.laoliimage2.win/v1',
  text_base_url: '',
  image_base_url: 'https://video.laoliimage2.win/v1',
  video_base_url: 'https://video.laoliimage2.win/v1',
  routing_mode: 'group',
  smart_routing: false,
  credential_mode: 'three_keys',
  key_roles: Object.freeze({ text: 'text', image: 'image + storyboard_image', video: 'video' }),
  protocol: Object.freeze({ text: 'openai', image: 'openai', storyboard_image: 'openai', video: 'yinzi' }),
  defaults: Object.freeze({ text_model: 'gpt-5.6-sol', image_model: 'gpt-image-2', video_model: '3.5' }),
  video_models: Object.freeze({
    '3.5': '即梦 2.5 兼容别名，固定 30 秒',
    '3.0': '即梦 2.0 兼容别名，支持 5 / 10 / 15 秒',
  }),
  model_aliases: Object.freeze({ '3.5': 'Seedance 2.5-720', '3.0': 'Seedance 2.0-720' }),
  model_capabilities: LAOLI_VIDEO_CAPABILITIES,
});

const DISTRIBUTION_PROFILES = Object.freeze({
  yinzi: Object.freeze({
    id: 'yinzi',
    name: '银子 API 专用版',
    description: '填写一个银子 API 智能路由 Key 即可自动发现文本、生图和视频模型；普通站点仍可按三 Key 配置。',
    smart_routing_entry: true,
    preferred_site: 'yinzi_api',
    sites: Object.freeze({
      yinzi_api: Object.freeze({
        name: 'YinziAPI 智能路由',
        base_url: 'https://api.yinziapi.top/v1',
        smart_routing: true,
        credential_mode: 'one_key_or_three_keys',
      }),
      image_yinzi: IMAGE_YINZI_SITE,
      laoli: LAOLI_SITE,
    }),
  }),
  universal: Object.freeze({
    id: 'universal',
    name: '通用 NewAPI / sub2 版',
  description: '无需额外智能路由：默认引导老李站点三 Key，也兼容其它 NewAPI / sub2 站点；站点能力只作提示。',
    smart_routing_entry: false,
    preferred_site: 'laoli',
    sites: Object.freeze({
      generic: Object.freeze({
        name: '通用 NewAPI / sub2',
        base_url: '',
        smart_routing: false,
        credential_mode: 'three_keys',
      }),
      image_yinzi: IMAGE_YINZI_SITE,
      laoli: LAOLI_SITE,
    }),
  }),
});

function normalizeDistributionProfile(value) {
  const id = String(value || '').trim().toLowerCase();
  return Object.hasOwn(DISTRIBUTION_PROFILES, id) ? id : 'universal';
}

/**
 * Resolve an edition from an explicit request, build/runtime environment, or
 * app config. Explicit request data wins so tests and a future admin selector
 * can safely preview either edition without mutating global configuration.
 */
function resolveDistributionProfile(input = {}, cfg = {}) {
  const explicit = typeof input === 'string'
    ? input
    : input?.distribution_profile || input?.distributionProfile;
  const configured = cfg?.app?.distribution_profile || cfg?.distribution_profile;
  const env = process.env.AI_VIDEO_DISTRIBUTION_PROFILE;
  return normalizeDistributionProfile(explicit || env || configured);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function getDistributionProfile(value, cfg = {}) {
  const id = resolveDistributionProfile(value, cfg);
  const profile = DISTRIBUTION_PROFILES[id];
  return cloneJson({
    id: profile.id,
    name: profile.name,
    description: profile.description,
    smart_routing_entry: profile.smart_routing_entry,
    preferred_site: profile.preferred_site,
    sites: profile.sites,
  });
}

function getImageYinziSiteProfile(value, cfg = {}) {
  const id = resolveDistributionProfile(value, cfg);
  return cloneJson({ distribution_profile: id, ...IMAGE_YINZI_SITE });
}

module.exports = {
  DISTRIBUTION_PROFILES,
  IMAGE_YINZI_PROFILE,
  LAOLI_VIDEO_PROFILE,
  IMAGE_YINZI_PRICE_SNAPSHOT,
  IMAGE_YINZI_VIDEO_CAPABILITIES,
  LAOLI_VIDEO_CAPABILITIES,
  LAOLI_SITE,
  normalizeDistributionProfile,
  resolveDistributionProfile,
  getDistributionProfile,
  getImageYinziSiteProfile,
};
