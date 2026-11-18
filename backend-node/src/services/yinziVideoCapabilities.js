const { getYinziVideoReferenceContract } = require('./yinziVideoReferenceContracts');

const COMMON_LIMITS = Object.freeze({
  provider_contract: 'aizzz-video-v1',
  provider_create_path: '/videos',
  provider_query_path: '/videos/{taskId}',
  provider_content_path: '/videos/{taskId}/content',
  provider_prompt_hard_max_chars: 4096,
  max_prompt_chars: 4000,
  max_image_bytes: 30 * 1024 * 1024,
  max_video_bytes: 50 * 1024 * 1024,
  max_audio_bytes: 15 * 1024 * 1024,
});

function freezeProfile(input) {
  const roles = Object.fromEntries(Object.entries(input.roles || {})
    .map(([key, values]) => [key, Object.freeze([...(values || [])])]));
  return Object.freeze({
    ...COMMON_LIMITS,
    duration_step: 1,
    allowed_durations: Array.isArray(input.allowed_durations)
      ? Object.freeze([...new Set(input.allowed_durations.map(Number).filter(Number.isFinite))].sort((a, b) => a - b))
      : null,
    automatic_eligible: false,
    expensive_bypass: false,
    requires_director_preview: false,
    reference_video_safety_margin_seconds: 1.2,
    ...input,
    roles: Object.freeze(roles),
    route_profiles: Object.freeze([...(input.route_profiles || [])]),
  });
}

function shortImageGuidedProfile({ quality = 'fast', preferenceRank = 10 } = {}) {
  return freezeProfile({
    family: 'cc-seedance2-free-duration',
    duration_mode: 'free',
    duration_min: 5,
    duration_max: 15,
    auto_duration_min: 5,
    auto_duration_max: 15,
    max_images: 9,
    max_videos: 0,
    max_audios: 3,
    max_total_references: 12,
    max_reference_video_seconds_total: 0,
    resolution: '480p',
    quality_tier: quality,
    automatic_eligible: true,
    preference_rank: preferenceRank,
    requires_director_preview: false,
    route_profiles: ['short_image_guided'],
    roles: { image: ['reference'], video: [], audio: ['reference'] },
  });
}

function longPrevisProfile(resolution, quality, preferenceRank) {
  return freezeProfile({
    family: 'mg-seedance2-reference',
    duration_mode: 'range',
    duration_min: 5,
    duration_max: 15,
    auto_duration_min: 5,
    auto_duration_max: 15,
    max_images: 4,
    max_videos: 3,
    max_audios: 1,
    max_total_references: 8,
    max_reference_video_seconds_total: 15,
    resolution,
    quality_tier: quality,
    automatic_eligible: true,
    preference_rank: preferenceRank,
    requires_director_preview: true,
    route_profiles: ['short_image_guided', 'long_previs_guided'],
    roles: { image: ['reference'], video: ['reference'], audio: ['reference'] },
  });
}

function multimodalSeedanceProfile({
  family,
  resolution,
  quality,
  preferenceRank,
  maxImages,
  maxVideos,
  maxAudios,
  maxReferenceVideoSeconds,
  durationMode = 'free',
  durationMin = 5,
  durationMax = 15,
  autoDurationMin = 5,
  autoDurationMax = 15,
  allowedDurations = null,
  fixedDurationSeconds = null,
  automaticEligible = true,
  exclusionReason = null,
} = {}) {
  return freezeProfile({
    family,
    duration_mode: durationMode,
    duration_min: durationMin,
    duration_max: durationMax,
    auto_duration_min: autoDurationMin,
    auto_duration_max: autoDurationMax,
    allowed_durations: allowedDurations,
    fixed_duration_seconds: fixedDurationSeconds,
    max_images: maxImages,
    max_videos: maxVideos,
    max_audios: maxAudios,
    max_total_references: maxImages + maxVideos + maxAudios,
    max_reference_video_seconds_total: maxReferenceVideoSeconds,
    resolution,
    quality_tier: quality,
    automatic_eligible: automaticEligible,
    preference_rank: preferenceRank,
    ...(exclusionReason ? { exclusion_reason: exclusionReason } : {}),
    route_profiles: ['short_image_guided', 'long_previs_guided'],
    roles: {
      image: maxImages > 0 ? ['reference'] : [],
      video: maxVideos > 0 ? ['reference'] : [],
      audio: maxAudios > 0 ? ['reference'] : [],
    },
  });
}

function singleImageVideoProfile(family, resolution = '720p', options = {}) {
  return freezeProfile({
    provider_contract: 'yinzi-openai-video-v1',
    family,
    duration_mode: 'free',
    duration_min: 5,
    duration_max: 15,
    max_images: 1,
    max_videos: 0,
    max_audios: 0,
    max_total_references: 1,
    max_reference_video_seconds_total: 0,
    resolution,
    quality_tier: options.quality || 'balanced',
    automatic_eligible: options.automaticEligible !== false,
    preference_rank: Number(options.preferenceRank ?? 200),
    route_profiles: ['short_image_guided', 'long_previs_guided'],
    roles: { image: ['reference'], video: [], audio: [] },
  });
}

function fixedFifteenProfile(resolution, quality = 'fast', options = {}) {
  const maxImages = Number(options.maxImages ?? 9);
  const maxVideos = Number(options.maxVideos ?? 3);
  const maxAudios = Number(options.maxAudios ?? 3);
  const automaticEligible = options.automaticEligible === true;
  return freezeProfile({
    family: options.family || 'seedance2-fixed-15s',
    duration_mode: 'fixed',
    duration_min: 15,
    duration_max: 15,
    fixed_duration_seconds: 15,
    max_images: maxImages,
    max_videos: maxVideos,
    max_audios: maxAudios,
    max_total_references: maxImages + maxVideos + maxAudios,
    max_reference_video_seconds_total: maxVideos > 0 ? 15 : 0,
    resolution,
    quality_tier: quality,
    automatic_eligible: automaticEligible,
    preference_rank: Number(options.preferenceRank ?? 100),
    ...(!automaticEligible ? { exclusion_reason: options.exclusionReason || 'fixed_15_second_product' } : {}),
    requires_director_preview: maxVideos > 0,
    route_profiles: ['long_previs_guided'],
    roles: {
      image: maxImages > 0 ? ['reference'] : [],
      video: maxVideos > 0 ? ['reference'] : [],
      audio: maxAudios > 0 ? ['reference'] : [],
    },
  });
}

const CURRENT_YINZI_JIMENG_MODELS = Object.freeze([
  '官转-seedance2.0 720p-fast',
  '官转-seedance2.0 720p-pro',
  '破甲seedance 720p-fast',
  'cm-seedance2.0 -720p-15s',
  'cm-seedance2.0特价fast-720p-gz-15s',
  'seedance-2.5-720p',
  'seedance2.0 -720p-fast-15s',
  'seedance2.0 720p-pro-nv-nsp',
  'seedance2.0特价pro-720p-gz-15s',
  'seedance2.0特价pro-720p-gz-15s-nsp',
]);

const AIZZZ_PROFILES = Object.freeze({
  'cc-seedance2.0 480p-fast-nsp': shortImageGuidedProfile({ quality: 'fast', preferenceRank: 10 }),
  'cc-seedance2.0 480p-nsp': shortImageGuidedProfile({ quality: 'balanced', preferenceRank: 20 }),

  'mg-seedance2.0 -480p mini': longPrevisProfile('480p', 'economy', 10),
  'mg-seedance2.0 -480p fast': longPrevisProfile('480p', 'fast', 20),
  'mg-seedance2.0 -480p': longPrevisProfile('480p', 'balanced', 30),
  'mg-seedance2.0 -720p mini': longPrevisProfile('720p', 'economy', 40),
  'mg-seedance2.0 -720p fast': longPrevisProfile('720p', 'fast', 50),
  'mg-seedance2.0 -720p pro': longPrevisProfile('720p', 'quality', 60),

  'af-seedance-2.0': multimodalSeedanceProfile({
    family: 'af-seedance2-reference', resolution: '720p', quality: 'balanced', preferenceRank: 12,
    maxImages: 4, maxVideos: 3, maxAudios: 1, maxReferenceVideoSeconds: 15,
  }),
  'af-seedance-2.0-fast': multimodalSeedanceProfile({
    family: 'af-seedance2-reference', resolution: '720p', quality: 'fast', preferenceRank: 11,
    maxImages: 4, maxVideos: 3, maxAudios: 1, maxReferenceVideoSeconds: 15,
  }),
  '官转-seedance2.0 720p-fast': multimodalSeedanceProfile({
    family: 'official-seedance2-reference', resolution: '720p', quality: 'fast', preferenceRank: 70,
    maxImages: 9, maxVideos: 3, maxAudios: 3, maxReferenceVideoSeconds: 15,
  }),
  '官转-seedance2.0 720p-pro': multimodalSeedanceProfile({
    family: 'official-seedance2-reference', resolution: '720p', quality: 'quality', preferenceRank: 80,
    maxImages: 9, maxVideos: 3, maxAudios: 3, maxReferenceVideoSeconds: 15,
  }),
  'seedance-2.5-480p': multimodalSeedanceProfile({
    family: 'seedance2.5-reference', resolution: '480p', quality: 'balanced', preferenceRank: 35,
    maxImages: 30, maxVideos: 10, maxAudios: 10, maxReferenceVideoSeconds: 29,
    durationMode: 'fixed', durationMin: 30, durationMax: 30, autoDurationMin: 30, autoDurationMax: 30,
    allowedDurations: [30],
    fixedDurationSeconds: 30,
  }),
  'seedance-2.5-720p': multimodalSeedanceProfile({
    family: 'seedance2.5-reference', resolution: '720p', quality: 'quality', preferenceRank: 55,
    maxImages: 30, maxVideos: 10, maxAudios: 10, maxReferenceVideoSeconds: 29,
    durationMode: 'fixed', durationMin: 30, durationMax: 30, autoDurationMin: 30, autoDurationMax: 30,
    allowedDurations: [30], fixedDurationSeconds: 30,
  }),
  // 老李 NewAPI 的站内别名：3.5=即梦 2.5（固定 30 秒），
  // 3.0=即梦 2.0（5/10/15 秒）。作为兼容提示，不限制未知模型提交。
  '3.5': multimodalSeedanceProfile({
    family: 'laoli-seedance2.5-alias', resolution: '720p', quality: 'quality', preferenceRank: 56,
    maxImages: 30, maxVideos: 10, maxAudios: 10, maxReferenceVideoSeconds: 29,
    durationMode: 'fixed', durationMin: 30, durationMax: 30, autoDurationMin: 30, autoDurationMax: 30,
    allowedDurations: [30], fixedDurationSeconds: 30,
  }),
  '3.0': multimodalSeedanceProfile({
    family: 'laoli-seedance2.0-alias', resolution: '720p', quality: 'balanced', preferenceRank: 57,
    maxImages: 30, maxVideos: 10, maxAudios: 10, maxReferenceVideoSeconds: 15,
    durationMode: 'enumerated', durationMin: 5, durationMax: 15, autoDurationMin: 5, autoDurationMax: 15,
    allowedDurations: [5, 10, 15],
  }),
  '特价seedance-2.5-480p': multimodalSeedanceProfile({
    family: 'seedance2.5-discount-reference', resolution: '480p', quality: 'economy', preferenceRank: 25,
    maxImages: 30, maxVideos: 10, maxAudios: 10, maxReferenceVideoSeconds: 29,
    durationMode: 'fixed', durationMin: 30, durationMax: 30, autoDurationMin: 30, autoDurationMax: 30,
    allowedDurations: [30], fixedDurationSeconds: 30,
  }),
  '特价seedance-2.5-720p': multimodalSeedanceProfile({
    family: 'seedance2.5-discount-reference', resolution: '720p', quality: 'balanced', preferenceRank: 45,
    maxImages: 30, maxVideos: 10, maxAudios: 10, maxReferenceVideoSeconds: 29,
    durationMode: 'fixed', durationMin: 30, durationMax: 30, autoDurationMin: 30, autoDurationMax: 30,
    allowedDurations: [30], fixedDurationSeconds: 30,
  }),
  'ca-seedance 2.0 720pro-15s': multimodalSeedanceProfile({
    family: 'ca-seedance2-reference', resolution: '720p', quality: 'quality', preferenceRank: 100,
    maxImages: 9, maxVideos: 3, maxAudios: 3, maxReferenceVideoSeconds: 15,
    automaticEligible: false, exclusionReason: 'manual_fixed_price_product',
  }),
  'cav2-seedance 2.0 720pro-15s': multimodalSeedanceProfile({
    family: 'cav2-seedance2-reference', resolution: '720p', quality: 'quality', preferenceRank: 110,
    maxImages: 9, maxVideos: 3, maxAudios: 3, maxReferenceVideoSeconds: 15,
    automaticEligible: false, exclusionReason: 'manual_fixed_price_product',
  }),

  'cm-seedance2.0 -720p-15s': multimodalSeedanceProfile({
    family: 'cm-seedance2-reference', resolution: '720p', quality: 'balanced', preferenceRank: 90,
    maxImages: 9, maxVideos: 3, maxAudios: 3, maxReferenceVideoSeconds: 15,
  }),
  'cm-seedance2.0特价fast-720p-gz-15s': fixedFifteenProfile('720p', 'fast', {
    family: 'cm-seedance2-discount-fixed', automaticEligible: true, preferenceRank: 25,
  }),
  'seedance2.0 -720p-fast-15s': multimodalSeedanceProfile({
    family: 'seedance2-fast-request-priced', resolution: '720p', quality: 'fast', preferenceRank: 30,
    maxImages: 9, maxVideos: 3, maxAudios: 3, maxReferenceVideoSeconds: 15,
  }),
  'seedance2.0 720p-pro-nv-nsp': multimodalSeedanceProfile({
    family: 'seedance2-pro-no-video', resolution: '720p', quality: 'quality', preferenceRank: 5,
    maxImages: 9, maxVideos: 0, maxAudios: 3, maxReferenceVideoSeconds: 0,
  }),
  'seedance2.0特价pro-720p-gz-15s': fixedFifteenProfile('720p', 'quality', {
    family: 'seedance2-pro-discount-fixed', automaticEligible: true, preferenceRank: 40,
  }),
  'seedance2.0特价pro-720p-gz-15s-nsp': fixedFifteenProfile('720p', 'quality', {
    family: 'seedance2-pro-discount-fixed-no-video', automaticEligible: true,
    preferenceRank: 35, maxVideos: 0,
  }),

  'mg-seedance2.0 -480p-fast-gz-15s': fixedFifteenProfile('480p', 'fast'),
  'mg-seedance2.0 -480p-gz-15s': fixedFifteenProfile('480p', 'balanced'),
  'mg-seedance2.0 -720p-mini-gz-15s': fixedFifteenProfile('720p', 'economy'),
  'mg-seedance2.0 -720p-fast-gz-15s': fixedFifteenProfile('720p', 'fast'),
  'mg-seedance2.0 -720p-gz-15s': fixedFifteenProfile('720p', 'balanced'),
  'xx-seedance 720p-mini-nyp-15s': fixedFifteenProfile('720p', 'economy'),
  'xx-seedance 720p-fast-nyp-15s': fixedFifteenProfile('720p', 'fast'),
  'xx-seedance 720p-pro-nyp-15s': fixedFifteenProfile('720p', 'quality'),
  'xx-seedance 1080p-pro-nyp-15s': fixedFifteenProfile('1080p', 'quality'),
  'seedance2.0 -720p-15s': fixedFifteenProfile('720p', 'quality'),
  'seedance2.0 -720p-gz-15s': fixedFifteenProfile('720p', 'quality'),

  '破甲seedance 720p-fast': freezeProfile({
    family: 'seedance2-expensive-bypass',
    duration_mode: 'free',
    duration_min: 5,
    duration_max: 15,
    max_images: 9,
    max_videos: 3,
    max_audios: 3,
    max_total_references: 15,
    max_reference_video_seconds_total: 15,
    resolution: '720p',
    quality_tier: 'bypass',
    automatic_eligible: false,
    expensive_bypass: true,
    exclusion_reason: 'explicit_user_approval_required',
    requires_director_preview: true,
    route_profiles: ['short_image_guided', 'long_previs_guided'],
    roles: { image: ['reference'], video: ['reference'], audio: ['reference'] },
  }),

  'grok-imagine-video': singleImageVideoProfile('grok-imagine-video', '720p', {
    quality: 'balanced', preferenceRank: 210,
  }),
  'minimax-h3-2k': singleImageVideoProfile('minimax-h3-2k', '2k', {
    quality: 'quality', preferenceRank: 220,
  }),
  'minimax-h3-4k': singleImageVideoProfile('minimax-h3-4k', '4k', {
    quality: 'quality', preferenceRank: 225,
  }),
  'kling video 3.0 omni': singleImageVideoProfile('kling-video-3-omni', '720p', {
    quality: 'balanced', preferenceRank: 230,
  }),
  'kling video 3.0 omni-1080p': singleImageVideoProfile('kling-video-3-omni', '1080p', {
    quality: 'quality', preferenceRank: 240,
  }),
  'kling video 3.0 omni-4k': singleImageVideoProfile('kling-video-3-omni', '4k', {
    quality: 'quality', preferenceRank: 250,
  }),
});

// Operational availability is intentionally separate from the model's media
// contract. These models remain visible and manually selectable, while the
// automatic router avoids channels the operator has currently reported down.
const CURRENT_AUTOMATIC_ROUTE_EXCLUSIONS = Object.freeze({
  'cc-seedance2.0 480p-fast-nsp': 'channel_temporarily_unavailable',
  'cc-seedance2.0 480p-nsp': 'channel_temporarily_unavailable',
  'seedance2.0 720p-pro-nv-nsp': 'channel_temporarily_unavailable',
  'seedance2.0特价pro-720p-gz-15s-nsp': 'channel_temporarily_unavailable',
  'minimax-h3-2k': 'channel_temporarily_unavailable',
  'minimax-h3-4k': 'channel_temporarily_unavailable',
  'kling video 3.0 omni': 'channel_temporarily_unavailable',
  'kling video 3.0 omni-1080p': 'channel_temporarily_unavailable',
  'kling video 3.0 omni-4k': 'channel_temporarily_unavailable',
});

const CANONICAL_MODEL_NAMES = Object.freeze({
  'minimax-h3-2k': 'MiniMax-H3-2k',
  'minimax-h3-4k': 'MiniMax-H3-4k',
  'kling video 3.0 omni': 'Kling VIDEO 3.0 Omni',
  'kling video 3.0 omni-1080p': 'Kling VIDEO 3.0 Omni-1080p',
  'kling video 3.0 omni-4k': 'Kling VIDEO 3.0 Omni-4k',
});

// Exact, evidence-backed aliases exposed by YinziAPI's current key-scoped
// `/v1/models` directory. Keep this intentionally narrow: an unknown model
// remains unknown and must not inherit limits merely because its name contains
// "seedance".
const MODEL_CAPABILITY_ALIASES = Object.freeze({
  'seedance 2.5-720': 'seedance-2.5-720p',
  'seedance 2.0-720': '3.0',
});

function normalizeModelName(model) {
  return String(model || '').trim().toLowerCase();
}

/**
 * 判断外部传入的提示信息是否明确声明该模型属于视频生成端点（如 openai-video）。
 * 仅在站点目录明确标注 video 端点时才启用通用视频兜底契约，避免把普通文本模型误判为视频模型。
 */
function hasExplicitVideoEndpointHint(hint) {
  if (!hint || typeof hint !== 'object') return false;
  if (hint.is_video_endpoint === true) return true;
  const rawEndpoints = Array.isArray(hint.endpoint_types)
    ? hint.endpoint_types
    : Array.isArray(hint.supported_endpoint_types)
      ? hint.supported_endpoint_types
      : Array.isArray(hint.endpoints) ? hint.endpoints : [];
  return rawEndpoints.some((ep) => String(ep || '').trim().toLowerCase().includes('video'));
}

/**
 * 按模型家族命名规律与端点声明动态推断视频能力契约。
 * 当精确字典（AIZZZ_PROFILES / getYinziVideoReferenceContract）未命中，但模型属于已知主力视频家族
 * 或站点明确声明了 video 端点时返回结构化契约；未知非视频模型返回 null，绝不臆造限制。
 */
function inferYinziVideoCapability(modelName, hint = {}) {
  const raw = String(modelName || '').trim();
  if (!raw) return null;
  const normalized = raw.normalize('NFKC').toLowerCase();

  // 1. smart-video 智能视频路由：支持 5/10/15s、720p/1080p、首尾帧与参考图
  if (normalized === 'smart-video') {
    return freezeProfile({
      provider_contract: 'yinzi-openai-video-v1',
      family: 'smart-video',
      capability_source: 'family_inferred',
      duration_mode: 'enumerated',
      allowed_durations: [5, 10, 15],
      duration_min: 5,
      duration_max: 15,
      auto_duration_min: 5,
      auto_duration_max: 15,
      allowed_resolutions: Object.freeze(['480p', '720p', '1080p']),
      resolutions: Object.freeze(['480p', '720p', '1080p']),
      default_resolution: '720p',
      resolution: '720p',
      quality_tier: 'balanced',
      max_images: 4,
      max_videos: 1,
      max_audios: 0,
      max_total_references: 5,
      max_reference_video_seconds_total: 15,
      first_last_frame_supported: true,
      automatic_eligible: true,
      preference_rank: 5,
      route_profiles: ['short_image_guided', 'long_previs_guided'],
      roles: { image: ['first_frame', 'last_frame', 'reference'], video: ['reference'], audio: [] },
    });
  }

  // 2. MiniMax H3 家族：MINIMAX H3* / H3-KS / *MiniMax H3*（含质量版、升级版、极速版、特价渠道 MiniMax H3 480p-1080p [...]）
  if (/^h3[-_\s]*ks\b/i.test(normalized) || /(?:^|[^a-z0-9])minimax[-_\s]*h3(?=$|[^a-z0-9])/i.test(normalized)) {
    const nativeCamera = /极速|高质量|质量|升级|^minimax\s+h3/i.test(normalized) && !/turbo\s*\d|h3[-_\s]*turbo/i.test(normalized);
    return freezeProfile({
      provider_contract: 'yinzi-openai-video-v1',
      family: 'minimax-h3-family',
      capability_source: 'family_inferred',
      // 兼容离散 5/6/10s 提示与 5–10s 连续范围校验
      duration_mode: 'range',
      allowed_durations: [5, 6, 10],
      duration_min: 5,
      duration_max: 10,
      auto_duration_min: 5,
      auto_duration_max: 10,
      allowed_resolutions: Object.freeze(['480p', '720p', '1080p']),
      resolutions: Object.freeze(['480p', '720p', '1080p']),
      default_resolution: '720p',
      resolution: '720p',
      quality_tier: /质量|升级/i.test(normalized) ? 'quality' : /极速/i.test(normalized) ? 'fast' : 'balanced',
      max_images: 3,
      max_videos: 0,
      max_audios: 0,
      max_total_references: 3,
      max_reference_video_seconds_total: 0,
      first_last_frame_supported: true,
      native_camera_presets: true,
      supports_camera_presets: nativeCamera,
      automatic_eligible: true,
      preference_rank: 15,
      route_profiles: ['short_image_guided', 'long_previs_guided'],
      roles: { image: ['first_frame', 'last_frame', 'reference'], video: [], audio: [] },
    });
  }

  // 3. Seedance 2.5 家族：Seedance 2.5* / XN2-Seedance 2.5*（含满血 480-720p、native，兼容固定 30s 特价款识别）
  if (/^(?:xn2[-_\s]*|特价(?:渠道)?[-_\s]*|官转[-_\s]*)?seedance[-_\s]*2\.5(?=$|[-_\s]|满血|fast|mini|pro|native|\d)/i.test(normalized)) {
    const isFixed30s = /(?:^|[-_\s])30s(?=$|[-_\s])|^特价(?:渠道)?[-_\s]*seedance[-_\s]*2\.5[-_\s]*(?:480|720|1080)p?$/i.test(normalized);
    const resolutions = /1080p/i.test(normalized)
      ? Object.freeze(['480p', '720p', '1080p'])
      : Object.freeze(['480p', '720p']);
    const defaultRes = /480p/i.test(normalized) && !/720p/i.test(normalized) ? '480p' : '720p';
    return freezeProfile({
      family: 'seedance-2.5-family',
      capability_source: 'family_inferred',
      duration_mode: isFixed30s ? 'fixed' : 'range',
      allowed_durations: isFixed30s ? [30] : [5, 10, 15],
      fixed_duration_seconds: isFixed30s ? 30 : null,
      duration_min: isFixed30s ? 30 : 5,
      duration_max: isFixed30s ? 30 : 15,
      auto_duration_min: isFixed30s ? 30 : 5,
      auto_duration_max: isFixed30s ? 30 : 15,
      allowed_resolutions: resolutions,
      resolutions,
      default_resolution: defaultRes,
      resolution: defaultRes,
      quality_tier: /满血|pro|native/i.test(normalized) ? 'quality' : /fast/i.test(normalized) ? 'fast' : 'balanced',
      max_images: 9,
      max_videos: 3,
      max_audios: 3,
      max_total_references: 15,
      max_reference_video_seconds_total: 15,
      automatic_eligible: true,
      preference_rank: 20,
      route_profiles: ['short_image_guided', 'long_previs_guided'],
      roles: { image: ['reference', 'first_frame', 'last_frame'], video: ['reference'], audio: ['reference'] },
    });
  }

  // 4. Seedance 2.0 家族：Seedance 2.0*（含 fast 480-720p、mini 480-720p、满血 480-720p、native）
  if (/^(?:xn2[-_\s]*|特价(?:渠道)?[-_\s]*|官转[-_\s]*|cm[-_\s]*|mg[-_\s]*|cc[-_\s]*|af[-_\s]*)?seedance[-_\s]*2\.0(?=$|[-_\s]|满血|fast|mini|pro|native|\d)/i.test(normalized)) {
    const noVideo = /(?:^|[-_\s])nv(?=$|[-_\s])|不可参考视频/i.test(normalized);
    const resolutions = /1080p/i.test(normalized)
      ? Object.freeze(['480p', '720p', '1080p'])
      : Object.freeze(['480p', '720p']);
    const defaultRes = /480p/i.test(normalized) && !/720p/i.test(normalized) ? '480p' : '720p';
    const isExpensiveBypass = /破甲/.test(normalized);
    return freezeProfile({
      family: 'seedance-2.0-family',
      capability_source: 'family_inferred',
      duration_mode: 'range',
      allowed_durations: [5, 10, 15],
      duration_min: 5,
      duration_max: 15,
      auto_duration_min: 5,
      auto_duration_max: 15,
      allowed_resolutions: resolutions,
      resolutions,
      default_resolution: defaultRes,
      resolution: defaultRes,
      quality_tier: /mini/i.test(normalized)
        ? 'economy'
        : /fast/i.test(normalized)
          ? 'fast'
          : /满血|pro|native/i.test(normalized) ? 'quality' : 'balanced',
      max_images: 9,
      max_videos: noVideo ? 0 : 3,
      max_audios: 3,
      max_total_references: noVideo ? 12 : 15,
      max_reference_video_seconds_total: noVideo ? 0 : 15,
      automatic_eligible: !isExpensiveBypass,
      expensive_bypass: isExpensiveBypass,
      preference_rank: 30,
      route_profiles: ['short_image_guided', 'long_previs_guided'],
      roles: {
        image: ['reference', 'first_frame', 'last_frame'],
        video: noVideo ? [] : ['reference'],
        audio: ['reference'],
      },
    });
  }

  // 5. WAN 3.0 家族：WAN3.0-可参考视频（图片+参考视频，5–15s）与 WAN3.0-不可参考视频（首帧/参考图，禁参考视频，5–15s）
  if (/^wan[-_\s]*3(?:\.\d+)?/i.test(normalized) && !/image|t2i|i2i|绘图|图片/i.test(normalized)) {
    const canReferenceVideo = /可参考视频/.test(normalized) && !/不可参考视频/.test(normalized);
    return freezeProfile({
      provider_contract: 'yinzi-openai-video-v1',
      family: canReferenceVideo ? 'wan3-video-reference' : 'wan3-image-guided',
      capability_source: 'family_inferred',
      duration_mode: 'range',
      allowed_durations: [5, 10, 15],
      duration_min: 5,
      duration_max: 15,
      auto_duration_min: 5,
      auto_duration_max: 15,
      allowed_resolutions: Object.freeze(['480p', '720p', '1080p']),
      resolutions: Object.freeze(['480p', '720p', '1080p']),
      default_resolution: '720p',
      resolution: '720p',
      quality_tier: 'quality',
      max_images: canReferenceVideo ? 4 : 2,
      max_videos: canReferenceVideo ? 2 : 0,
      max_audios: 0,
      max_total_references: canReferenceVideo ? 6 : 2,
      max_reference_video_seconds_total: canReferenceVideo ? 15 : 0,
      first_last_frame_supported: !canReferenceVideo,
      automatic_eligible: true,
      preference_rank: canReferenceVideo ? 35 : 40,
      route_profiles: ['short_image_guided', 'long_previs_guided'],
      roles: {
        image: canReferenceVideo ? ['first_frame', 'reference'] : ['first_frame', 'last_frame', 'reference'],
        video: canReferenceVideo ? ['reference'] : [],
        audio: [],
      },
    });
  }

  // 6. grok-imagine-video* 及其他站点明确声明 endpoint_types 含 video 的新模型：赋予安全通用视频契约
  if (/^grok-imagine-video/i.test(normalized) || hasExplicitVideoEndpointHint(hint)) {
    return freezeProfile({
      provider_contract: 'yinzi-openai-video-v1',
      family: /^grok-imagine-video/i.test(normalized) ? 'grok-imagine-video' : 'generic-video',
      capability_source: 'family_inferred',
      duration_mode: 'range',
      duration_min: 5,
      duration_max: 10,
      auto_duration_min: 5,
      auto_duration_max: 10,
      allowed_resolutions: Object.freeze(['720p']),
      resolutions: Object.freeze(['720p']),
      default_resolution: '720p',
      resolution: '720p',
      quality_tier: 'balanced',
      max_images: 1,
      max_videos: 0,
      max_audios: 0,
      max_total_references: 1,
      max_reference_video_seconds_total: 0,
      automatic_eligible: true,
      preference_rank: 210,
      route_profiles: ['short_image_guided', 'long_previs_guided'],
      roles: { image: ['first_frame', 'reference'], video: [], audio: [] },
    });
  }

  return null;
}

function applyAutomaticRouteAvailability(model, capability) {
  if (!capability) return null;
  const exclusionReason = CURRENT_AUTOMATIC_ROUTE_EXCLUSIONS[normalizeModelName(model)];
  if (!exclusionReason) return capability;
  return Object.freeze({
    ...capability,
    automatic_eligible: false,
    manual_eligible: true,
    automatic_availability: 'temporarily_unavailable',
    exclusion_reason: exclusionReason,
  });
}

function getYinziVideoCapability(model, hint = undefined) {
  const normalized = normalizeModelName(model);
  if (!normalized) return null;
  const profileKey = MODEL_CAPABILITY_ALIASES[normalized] || normalized;
  const exact = AIZZZ_PROFILES[profileKey] || getYinziVideoReferenceContract(model);
  if (exact) return applyAutomaticRouteAvailability(model, exact);
  const inferred = inferYinziVideoCapability(model, hint);
  return inferred ? applyAutomaticRouteAvailability(model, inferred) : null;
}

function listYinziVideoCapabilities() {
  return Object.entries(AIZZZ_PROFILES).map(([model, capability]) => ({
    model: CANONICAL_MODEL_NAMES[model] || model,
    capability: applyAutomaticRouteAvailability(model, capability),
  }));
}

function capabilitySupportsRole(capability, mediaType, role) {
  return Array.isArray(capability?.roles?.[mediaType])
    && capability.roles[mediaType].includes(role);
}

function capabilitySupportsRoute(capability, routeProfile) {
  const routeProfiles = capability?.route_profiles;
  // Provider contracts do not have to know the workflow's local route labels.
  // Only an explicit list can exclude a profile; absence remains compatible.
  return !Array.isArray(routeProfiles) || routeProfiles.includes(routeProfile);
}

function capabilityAcceptsDuration(capability, duration, options = {}) {
  const seconds = Number(duration);
  if (!capability || !Number.isFinite(seconds)) return false;
  if (capability.duration_mode === 'fixed') {
    return seconds === Number(capability.fixed_duration_seconds || capability.duration_min);
  }
  if (capability.duration_mode === 'enumerated') {
    const allowed = Array.isArray(capability.allowed_durations)
      ? capability.allowed_durations.map(Number).filter(Number.isFinite)
      : [];
    return allowed.includes(seconds);
  }
  const min = options.automatic
    ? Number(capability.auto_duration_min ?? capability.duration_min)
    : Number(capability.duration_min);
  const max = options.automatic
    ? Number(capability.auto_duration_max ?? capability.duration_max)
    : Number(capability.duration_max);
  return seconds >= min && seconds <= max;
}

function supportsStrictFirstFrame(model) {
  return capabilitySupportsRole(getYinziVideoCapability(model), 'image', 'first_frame');
}

function clampYinziVideoDuration(model, duration, capabilityOverride = undefined) {
  const capability = capabilityOverride === undefined
    ? getYinziVideoCapability(model)
    : capabilityOverride;
  const rounded = Math.round(Number(duration));
  if (!capability) return Math.max(1, Number.isFinite(rounded) ? rounded : 1);
  if (capability.duration_mode === 'fixed') {
    return Number(capability.fixed_duration_seconds || capability.duration_min);
  }
  if (capability.duration_mode === 'enumerated') {
    const allowed = (Array.isArray(capability.allowed_durations) ? capability.allowed_durations : [])
      .map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (allowed.length) {
      const target = Number.isFinite(rounded) ? rounded : allowed[0];
      return allowed.reduce((best, value) => {
        const bestDistance = Math.abs(best - target);
        const distance = Math.abs(value - target);
        return distance < bestDistance || (distance === bestDistance && value > best) ? value : best;
      }, allowed[0]);
    }
  }
  const minimum = capability?.auto_duration_min ?? capability?.duration_min;
  const maximum = capability?.auto_duration_max ?? capability?.duration_max;
  const fallback = Number.isFinite(Number(minimum)) ? Number(minimum) : (Number.isFinite(rounded) ? rounded : 1);
  if (!Number.isFinite(Number(minimum)) && !Number.isFinite(Number(maximum))) return Math.max(1, rounded || fallback);
  return Math.min(maximum, Math.max(minimum, rounded));
}

// The workflow keeps creative/planned duration separate from the provider's
// execution unit. This helper is the single capability-driven source of truth
// used by routing, dispatch and direct Yinzi requests.
function providerDurationForCapability(capability, plannedDuration) {
  return clampYinziVideoDuration('', plannedDuration, capability);
}

module.exports = {
  CURRENT_YINZI_JIMENG_MODELS,
  CURRENT_AUTOMATIC_ROUTE_EXCLUSIONS,
  getYinziVideoCapability,
  inferYinziVideoCapability,
  listYinziVideoCapabilities,
  capabilitySupportsRole,
  capabilitySupportsRoute,
  capabilityAcceptsDuration,
  supportsStrictFirstFrame,
  clampYinziVideoDuration,
  providerDurationForCapability,
};
