'use strict';

const {
  getYinziVideoCapability,
  capabilityAcceptsDuration,
} = require('./yinziVideoCapabilities');

function parseObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function parseJsonValue(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return null; }
}

function normalizeText(value) {
  return String(value || '').trim();
}

const FALLBACK_FAILURE_CATEGORIES = Object.freeze([
  'model_unavailable',
  'capability_mismatch',
  'parameter_rejected',
  'moderation_rejected',
]);

/**
 * Normalize provider/autonomy errors without turning an unknown error into a
 * safe-to-resubmit one.  Only the four explicit categories below can trigger
 * the 2.5 -> 2.0 fallback; transport and ambiguous outcomes remain recovery
 * queries so a second billable POST is never guessed to be safe.
 */
function classifyFallbackFailure(input = {}) {
  const source = input?.result || input?.generation || input?.error || input;
  const receipt = source?.submission_receipt && typeof source.submission_receipt === 'object'
    ? source.submission_receipt : {};
  const code = normalizeText(input.category || input.normalized_category
    || receipt.error_code || source.error_code || source.code).toLowerCase();
  const text = [
    input.message,
    source.error,
    source.error_message,
    source.error_msg,
    receipt.message,
  ].map(normalizeText).filter(Boolean).join(' ').toLowerCase();
  if (/(model[_ -]?unavailable|model[_ -]?not[_ -]?found|model.*(?:down|offline|disabled)|no such model|模型.*(?:下架|不存在|不可用))/.test(`${code} ${text}`)) {
    return 'model_unavailable';
  }
  if (/(capability|unsupported|not supported|能力|参考.*(?:数量|类型)|duration.*(?:invalid|unsupported)|时长.*不支持)/.test(`${code} ${text}`)) {
    return 'capability_mismatch';
  }
  if (/(parameter|invalid[_ -]?param|bad[_ -]?request|validation|参数|请求字段|duration.*(?:must|should)|invalid.*duration)/.test(`${code} ${text}`)) {
    return 'parameter_rejected';
  }
  if (/(moderation|content[_ -]?policy|safety|审核|内容.*(?:拒绝|违规)|涉黄|暴恐)/.test(`${code} ${text}`)) {
    return 'moderation_rejected';
  }
  if (input.ambiguous === true || receipt.status === 'ambiguous'
    || /(timeout|timed out|network|temporary|5xx|http[_ -]?5\d\d|econn|socket|premature)/.test(`${code} ${text}`)
    || ['timeout', 'network', 'temporary_error', '5xx', 'ambiguous_external'].some((v) => code.includes(v))) {
    return 'ambiguous_external';
  }
  return 'unknown';
}

function isFallbackEligibleFailure(input = {}) {
  return FALLBACK_FAILURE_CATEGORIES.includes(classifyFallbackFailure(input));
}

function normalizeSelectionMode(value, fallback = 'auto') {
  const raw = normalizeText(value).toLowerCase();
  if (['auto', 'automatic'].includes(raw)) return 'auto';
  if (['project_fixed', 'fixed', 'project-fixed'].includes(raw)) return 'project_fixed';
  if (['shot_override', 'shot', 'override', 'shot-override'].includes(raw)) return 'shot_override';
  return fallback;
}

/**
 * Automatic fallback is opt-in at the point where a user has narrowed a
 * model.  A project or shot fixed selection is therefore never silently
 * replaced.  `allow_shot_fallback` is deliberately explicit for the highest
 * priority shot override.
 */
function canAutomaticallyFallback({ selection_mode, allow_shot_fallback = false, policy = {}, failure } = {}) {
  const mode = normalizeSelectionMode(selection_mode || policy.video_routing_mode || 'auto');
  if (!isFallbackEligibleFailure(failure || {})) return false;
  if (mode === 'project_fixed') return false;
  if (mode === 'shot_override') return allow_shot_fallback === true || policy.allow_shot_fallback === true;
  return policy.allow_auto_model_switch !== false;
}

function isSeedance25Model(model) {
  return /seedance\s*[- ]?2\.5|即梦\s*2\.5|3\.5/i.test(normalizeText(model));
}

function isSeedance20Model(model) {
  return /seedance\s*[- ]?2\.0|即梦\s*2\.0|3\.0/i.test(normalizeText(model));
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Build the deterministic parent/child fallback plan.  This is pure data: it
 * does not create a task, upload media, or contact a provider.  A runner can
 * persist the returned `plan_id` and use the segment keys as idempotency keys.
 */
function planSeedanceFallback({
  runId = null,
  shotId = null,
  parentActionKey = null,
  fromModel,
  fallbackModel,
  failure,
  firstPrice = 3.5,
  segmentPrice = 3,
  requestedDuration = 30,
  maxSegments = 2,
  strictFirstFrame = false,
} = {}) {
  const category = classifyFallbackFailure(failure || {});
  const sourceModel = normalizeText(fromModel);
  const targetModel = normalizeText(fallbackModel) || 'Seedance 2.0-720';
  const segmentCount = Math.max(1, Math.min(2, Number(maxSegments) || 2));
  const allowed = isSeedance25Model(sourceModel) && isSeedance20Model(targetModel)
    && FALLBACK_FAILURE_CATEGORIES.includes(category);
  const first = numberOrNull(firstPrice);
  const each = numberOrNull(segmentPrice);
  const worstCaseCost = first == null || each == null ? null : Number((first + each * segmentCount).toFixed(6));
  const idBase = normalizeText(parentActionKey) || `shot:${normalizeText(shotId) || 'unknown'}:seedance-fallback`;
  return {
    version: 1,
    plan_id: `${idBase}:plan`,
    run_id: runId,
    shot_id: shotId == null ? null : String(shotId),
    parent_action_key: idBase,
    from_model: sourceModel || null,
    fallback_model: targetModel || null,
    trigger_category: category,
    eligible: allowed,
    max_segments: segmentCount,
    worst_case_cost: worstCaseCost,
    first_attempt_cost: first,
    segment_cost: each,
    provider_duration_seconds: 30,
    continuity: {
      preferred: strictFirstFrame ? 'strict_first_frame' : 'last_frame_as_first_frame',
      fallback: 'ordinary_reference_or_hard_cut',
      truthful_when_unsupported: true,
    },
    segments: Array.from({ length: segmentCount }, (_, index) => ({
      index: index + 1,
      action_key: `${idBase}:segment-${index + 1}`,
      model: targetModel,
      duration: 15,
      depends_on_segment: index === 0 ? null : index,
      first_frame_source: index === 0 ? 'original_bundle' : 'segment-1:last_frame',
      status: 'planned',
    })),
  };
}

function nextFallbackSegment(plan, completedSegments = []) {
  if (!plan || plan.eligible !== true) return null;
  const completed = new Set((Array.isArray(completedSegments) ? completedSegments : [])
    .map((item) => Number(item?.index ?? item)).filter(Number.isFinite));
  return (plan.segments || []).find((segment) => {
    if (completed.has(Number(segment.index))) return false;
    return segment.depends_on_segment == null || completed.has(Number(segment.depends_on_segment));
  }) || null;
}

/**
 * Only this provider response is safe to recover automatically. A normal
 * 5xx, transport failure, malformed success, or a response carrying an ID
 * may already have created a billable task and must never be submitted
 * again. YinziAPI currently reports the deterministic "no eligible route"
 * result as HTTP 503, so that one exact error is safe only when the response
 * has no task authority at all.
 */
function isDeterministicNoEligibleAutomaticRoute(result) {
  const receipt = result?.submission_receipt && typeof result.submission_receipt === 'object'
    ? result.submission_receipt : {};
  const errorCode = normalizeText(receipt.error_code || result?.error_code).toLowerCase();
  const message = [receipt.message, result?.error]
    .map(normalizeText)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const hasTaskAuthority = Boolean(
    normalizeText(result?.task_id)
      || normalizeText(result?.provider_task_id)
      || normalizeText(result?.video_url)
  );
  const httpStatus = Number(result?.submission_http_status ?? receipt.http_status);
  const deterministicStatus = receipt.status === 'rejected'
    || (receipt.status === 'ambiguous' && httpStatus === 503);
  return deterministicStatus
    && errorCode === 'get_channel_failed'
    && message.includes('no eligible automatic route')
    && !hasTaskAuthority;
}

function routingSettings(config) {
  const settings = parseObject(config?.settings);
  return settings;
}

function normalizeSnapshot(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isSmartRoutingEnabled(config, snapshot = {}) {
  snapshot = normalizeSnapshot(snapshot);
  const settings = routingSettings(config);
  return snapshot.smart_routing === true
    || snapshot.smart_routing_enabled === true
    || String(snapshot.routing_mode || '').toLowerCase() === 'smart'
    || settings.smart_routing_enabled === true
    || settings.smart_routing === true
    || String(settings.routing_mode || '').toLowerCase() === 'smart';
}

function isAutomaticRouteRequest(config, row, snapshot = {}) {
  snapshot = normalizeSnapshot(snapshot);
  if (!isSmartRoutingEnabled(config, snapshot)) return false;
  if (snapshot.smart_route_recovery_attempted === true) return false;
  if (snapshot.requested_model_explicit === true && snapshot.automatic_route !== true) return false;
  if (snapshot.automatic_route === true || snapshot.automatic === true) return true;
  // Direct /videos callers that omit model are using the configured smart
  // default. An explicit model is never silently replaced.
  return !normalizeText(row?.model) && snapshot.requested_model_explicit !== true;
}

function arrayColumn(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  const parsed = parseJsonValue(value);
  return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
}

function requestReferenceCounts(row = {}) {
  const images = arrayColumn(row.reference_image_urls);
  const videos = arrayColumn(row.reference_video_urls);
  const audios = arrayColumn(row.reference_audio_urls);
  const firstFrame = normalizeText(row.first_frame_url);
  const lastFrame = normalizeText(row.last_frame_url);
  const legacyImage = normalizeText(row.image_url) && !images.length && !firstFrame && !lastFrame ? 1 : 0;
  return {
    images: images.length + (firstFrame ? 1 : 0) + (lastFrame ? 1 : 0) + legacyImage,
    videos: videos.length,
    audios: audios.length,
  };
}

function candidateCapability(candidate) {
  if (Object.prototype.hasOwnProperty.call(candidate || {}, 'capabilities')) {
    return candidate.capabilities || null;
  }
  return getYinziVideoCapability(candidate?.model) || null;
}

function candidateIsCompatible(candidate, row, duration) {
  const endpointTypes = Array.isArray(candidate?.endpoint_types)
    ? candidate.endpoint_types.map((item) => String(item || '').toLowerCase())
    : [];
  if (endpointTypes.length && !endpointTypes.includes('openai-video')) return false;
  if (candidate?.manual_only === true || candidate?.expensive_bypass === true) return false;
  if (candidate?.capabilities?.expensive_bypass === true) return false;
  if (candidate?.automatic_eligible === false) return false;
  const capability = candidateCapability(candidate);
  if (!capability) return true;
  if (Number.isFinite(Number(duration)) && !capabilityAcceptsDuration(capability, duration, { automatic: false })) {
    return false;
  }
  const counts = requestReferenceCounts(row);
  if (Number.isFinite(Number(capability.max_images)) && counts.images > Number(capability.max_images)) return false;
  if (Number.isFinite(Number(capability.max_videos)) && counts.videos > Number(capability.max_videos)) return false;
  if (Number.isFinite(Number(capability.max_audios)) && counts.audios > Number(capability.max_audios)) return false;
  if (Number.isFinite(Number(capability.max_total_references))
    && counts.images + counts.videos + counts.audios > Number(capability.max_total_references)) return false;
  return true;
}

function candidateRank(candidate) {
  const capability = candidateCapability(candidate);
  const familyRank = /seedance/i.test(normalizeText(candidate?.model)) ? 0 : 1;
  const preferenceRank = Number.isFinite(Number(capability?.preference_rank))
    ? Number(capability.preference_rank) : 1000;
  const price = Number.isFinite(Number(candidate?.cheapest_effective_price))
    ? Number(candidate.cheapest_effective_price) : Number.POSITIVE_INFINITY;
  return [familyRank, preferenceRank, price, normalizeText(candidate?.model).toLowerCase()];
}

function compareCandidates(left, right) {
  const a = candidateRank(left);
  const b = candidateRank(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a[3].localeCompare(b[3], 'zh-CN');
}

function candidateSnapshot(config, snapshot = {}) {
  snapshot = normalizeSnapshot(snapshot);
  const settings = routingSettings(config);
  const source = snapshot.model_catalog_snapshot
    || settings.model_catalog_snapshot
    || {};
  return Array.isArray(source.models) ? source.models : [];
}

function selectVerifiedFallbackModel({ config, row, snapshot = {}, duration, currentModel } = {}) {
  const current = normalizeText(currentModel || snapshot.model).toLowerCase();
  const candidates = candidateSnapshot(config, snapshot)
    .filter((candidate) => candidate && typeof candidate === 'object')
    .filter((candidate) => candidate.credential_verified === true)
    .filter((candidate) => normalizeText(candidate.model).toLowerCase() !== current)
    .filter((candidate) => candidateIsCompatible(candidate, row, duration))
    .sort(compareCandidates);
  return candidates[0] || null;
}

function recoverySummary(firstResult, fromModel, toModel, secondResult = null) {
  return {
    version: 1,
    attempted: true,
    from_model: normalizeText(fromModel) || null,
    to_model: normalizeText(toModel) || null,
    trigger: 'get_channel_failed:no eligible automatic route',
    first_error_code: normalizeText(firstResult?.submission_receipt?.error_code) || null,
    first_http_status: Number.isFinite(Number(firstResult?.submission_http_status))
      ? Number(firstResult.submission_http_status) : null,
    second_status: secondResult?.submission_status || null,
    second_http_status: Number.isFinite(Number(secondResult?.submission_http_status))
      ? Number(secondResult.submission_http_status) : null,
    observed_at: new Date().toISOString(),
  };
}

module.exports = {
  FALLBACK_FAILURE_CATEGORIES,
  parseObject,
  classifyFallbackFailure,
  isFallbackEligibleFailure,
  normalizeSelectionMode,
  canAutomaticallyFallback,
  isSeedance25Model,
  isSeedance20Model,
  planSeedanceFallback,
  nextFallbackSegment,
  isDeterministicNoEligibleAutomaticRoute,
  isSmartRoutingEnabled,
  isAutomaticRouteRequest,
  requestReferenceCounts,
  candidateIsCompatible,
  selectVerifiedFallbackModel,
  recoverySummary,
};
