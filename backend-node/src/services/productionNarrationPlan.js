const crypto = require('node:crypto');

const DEFAULT_EDGE_VOICE = 'zh-CN-XiaoyiNeural';
const SUBTITLE_MODES = new Set(['off', 'sidecar', 'burn']);
const VOICE_PROVIDERS = new Set(['edge', 'openai', 'minimax']);

function cleanText(value, max = 3000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function sortByShot(items) {
  return [...items].sort((left, right) => Number(left.scope_id) - Number(right.scope_id));
}

function sourceRows(shots, videos) {
  const videoByScope = new Map(videos.map((item) => [String(item.scope_id), item]));
  return sortByShot(shots).map((shot) => {
    const video = videoByScope.get(String(shot.scope_id));
    if (!video) throw new Error(`镜头 ${shot.scope_id} 缺少已确认视频`);
    return { shot, video };
  });
}

function fingerprintPayload(plan) {
  return {
    plan_version: Number(plan.plan_version) || 1,
    source_shot_artifact_ids: (plan.source_shot_artifact_ids || []).map(Number),
    source_shot_video_artifact_ids: (plan.source_shot_video_artifact_ids || []).map(Number),
    narration_enabled: !!plan.narration_enabled,
    voice_provider: plan.voice_provider,
    voice_id: plan.voice_id,
    speed: Number(plan.speed),
    subtitle_mode: plan.subtitle_mode,
    keep_provider_audio: !!plan.keep_provider_audio,
    provider_audio_volume: Number(plan.provider_audio_volume),
    narration_volume: Number(plan.narration_volume),
    ducking_enabled: !!plan.ducking_enabled,
    max_speed_ratio: Number(plan.max_speed_ratio),
    segments: (plan.segments || []).map((segment) => ({
      shot_id: String(segment.shot_id),
      shot_artifact_id: Number(segment.shot_artifact_id),
      video_artifact_id: Number(segment.video_artifact_id),
      duration: Number(segment.duration),
      narration: cleanText(segment.narration),
    })),
  };
}

function calculateFingerprint(plan) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(fingerprintPayload(plan)))
    .digest('hex');
}

function normalizeNarrationPlan(input, shots, videos) {
  const rows = sourceRows(shots, videos);
  const incomingSegments = new Map(
    (Array.isArray(input?.segments) ? input.segments : [])
      .map((item) => [String(item?.shot_id || ''), item])
      .filter(([shotId]) => shotId)
  );
  const segments = rows.map(({ shot, video }) => {
    const incoming = incomingSegments.get(String(shot.scope_id));
    return {
      shot_id: String(shot.scope_id),
      shot_artifact_id: shot.id,
      video_artifact_id: video.id,
      title: cleanText(shot.title || shot.content?.title || `镜头 ${shot.scope_id}`, 160),
      duration: clamp(video.content?.validation?.duration || shot.content?.duration, 0.2, 60, 5),
      narration: cleanText(incoming?.narration ?? shot.content?.narration),
    };
  });
  const hasNarration = segments.some((segment) => segment.narration);
  const requestedEnabled = input?.narration_enabled == null ? hasNarration : !!input.narration_enabled;
  const narrationEnabled = requestedEnabled && hasNarration;
  const voiceProvider = VOICE_PROVIDERS.has(input?.voice_provider) ? input.voice_provider : 'edge';
  const subtitleMode = narrationEnabled && SUBTITLE_MODES.has(input?.subtitle_mode)
    ? input.subtitle_mode
    : narrationEnabled ? 'burn' : 'off';
  const plan = {
    kind: 'narration_plan',
    plan_version: 1,
    narration_enabled: narrationEnabled,
    voice_provider: voiceProvider,
    voice_id: cleanText(input?.voice_id || DEFAULT_EDGE_VOICE, 120),
    speed: clamp(input?.speed, 0.75, 1.5, 1),
    subtitle_mode: subtitleMode,
    keep_provider_audio: input?.keep_provider_audio !== false,
    provider_audio_volume: clamp(input?.provider_audio_volume, 0, 1.5, 1),
    narration_volume: clamp(input?.narration_volume, 0, 2, 1),
    ducking_enabled: input?.ducking_enabled !== false,
    max_speed_ratio: clamp(input?.max_speed_ratio, 1, 1.35, 1.2),
    segments,
    source_shot_artifact_ids: rows.map(({ shot }) => shot.id),
    source_shot_video_artifact_ids: rows.map(({ video }) => video.id),
    included: true,
  };
  plan.confirmation_fingerprint = calculateFingerprint(plan);
  return plan;
}

function validateNarrationPlan(plan, shots, videos) {
  if (plan?.kind !== 'narration_plan') throw new Error('最终旁白设置类型无效');
  const normalized = normalizeNarrationPlan(plan, shots, videos);
  if (plan.confirmation_fingerprint !== normalized.confirmation_fingerprint) {
    const error = new Error('旁白设置或上游镜头已经变化，请保存新修订并重新确认');
    error.code = 'NARRATION_CONFIRMATION_STALE';
    throw error;
  }
  if (normalized.narration_enabled && !normalized.segments.some((segment) => segment.narration)) {
    throw new Error('已启用旁白，但没有任何可合成的旁白文本');
  }
  if (normalized.voice_provider === 'edge' && !/^[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z0-9]+Neural$/.test(normalized.voice_id)) {
    throw new Error('Edge 音色名称无效，请使用类似 zh-CN-XiaoyiNeural 的完整名称');
  }
  return normalized;
}

module.exports = {
  DEFAULT_EDGE_VOICE,
  SUBTITLE_MODES,
  calculateFingerprint,
  normalizeNarrationPlan,
  validateNarrationPlan,
};
