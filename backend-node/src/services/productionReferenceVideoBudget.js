const REFERENCE_VIDEO_BUDGET_PROFILE = 'continuity-tail-v2-final-transport';
const DEFAULT_SAFETY_MARGIN_SECONDS = 0.25;
const MIN_CONTINUITY_TAIL_SECONDS = 1.5;

function roundedSeconds(value) {
  return Number(Number(value).toFixed(3));
}

function finiteDuration(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0.2 ? duration : null;
}

function budgetError(message, details) {
  const error = new Error(message);
  error.code = 'REFERENCE_VIDEO_DURATION_BUDGET_UNSATISFIABLE';
  error.details = details;
  return error;
}

function planReferenceVideoBudget(references, options = {}) {
  const source = Array.isArray(references) ? references : [];
  const limit = finiteDuration(options.max_total_seconds);
  if (!limit || !source.length) {
    return {
      videos: source.map((item) => ({ ...item })),
      receipt: null,
    };
  }

  const requestedMargin = Number(options.safety_margin_seconds);
  const safetyMargin = Number.isFinite(requestedMargin)
    ? Math.min(Math.max(0, requestedMargin), Math.max(0, limit - 0.25))
    : Math.min(DEFAULT_SAFETY_MARGIN_SECONDS, Math.max(0, limit - 0.25));
  const target = limit - safetyMargin;
  const durations = source.map((item) => finiteDuration(item.source_duration_seconds));
  const unknownIndexes = durations
    .map((duration, index) => (duration == null ? index : null))
    .filter((index) => index != null);

  if (unknownIndexes.length) {
    return {
      videos: source.map((item, index) => ({
        ...item,
        transport: {
          mode: 'unverified_full',
          source_duration_seconds: durations[index],
        },
      })),
      receipt: {
        profile: REFERENCE_VIDEO_BUDGET_PROFILE,
        enforced: false,
        reason: 'unknown_source_duration',
        unknown_indexes: unknownIndexes,
        max_total_seconds: limit,
        safety_margin_seconds: safetyMargin,
        target_total_seconds: roundedSeconds(target),
      },
    };
  }

  const plannedDurations = durations.slice();
  const starts = durations.map(() => 0);
  const originalTotal = durations.reduce((sum, duration) => sum + duration, 0);
  let excess = Math.max(0, originalTotal - target);

  for (let index = 0; index < source.length && excess > 0.001; index += 1) {
    if (source[index]?.source !== 'continuity_in') continue;
    const minimum = Math.min(MIN_CONTINUITY_TAIL_SECONDS, plannedDurations[index]);
    const availableReduction = Math.max(0, plannedDurations[index] - minimum);
    const reduction = Math.min(excess, availableReduction);
    plannedDurations[index] -= reduction;
    starts[index] = durations[index] - plannedDurations[index];
    excess -= reduction;
  }

  if (excess > 0.01) {
    throw budgetError(
      `Reference videos need ${roundedSeconds(originalTotal)} seconds but only ${roundedSeconds(target)} seconds are safely available`,
      {
        profile: REFERENCE_VIDEO_BUDGET_PROFILE,
        max_total_seconds: limit,
        safety_margin_seconds: safetyMargin,
        target_total_seconds: roundedSeconds(target),
        source_total_seconds: roundedSeconds(originalTotal),
        remaining_excess_seconds: roundedSeconds(excess),
      }
    );
  }

  const videos = source.map((item, index) => {
    const sourceDuration = roundedSeconds(durations[index]);
    const duration = roundedSeconds(plannedDurations[index]);
    const start = roundedSeconds(starts[index]);
    const windowed = start > 0.001 || duration < sourceDuration - 0.001;
    return {
      ...item,
      transport: windowed
        ? {
          mode: 'tail_excerpt',
          source_duration_seconds: sourceDuration,
          start_seconds: start,
          duration_seconds: duration,
        }
        : {
          mode: 'full',
          source_duration_seconds: sourceDuration,
          start_seconds: 0,
          duration_seconds: sourceDuration,
        },
    };
  });
  const transportTotal = plannedDurations.reduce((sum, duration) => sum + duration, 0);

  return {
    videos,
    receipt: {
      profile: REFERENCE_VIDEO_BUDGET_PROFILE,
      enforced: true,
      max_total_seconds: limit,
      safety_margin_seconds: safetyMargin,
      target_total_seconds: roundedSeconds(target),
      source_total_seconds: roundedSeconds(originalTotal),
      transport_total_seconds: roundedSeconds(transportTotal),
      trimmed: videos.some((item) => item.transport.mode === 'tail_excerpt'),
    },
  };
}

module.exports = {
  planReferenceVideoBudget,
  REFERENCE_VIDEO_BUDGET_PROFILE,
  DEFAULT_SAFETY_MARGIN_SECONDS,
  MIN_CONTINUITY_TAIL_SECONDS,
};
