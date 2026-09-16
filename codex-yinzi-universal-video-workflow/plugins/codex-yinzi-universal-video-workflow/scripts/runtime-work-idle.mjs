const EXECUTION_COUNT_KEYS = Object.freeze([
  'async_tasks',
  'media_batches',
  'production_runs',
  'orchestration_blender_jobs',
  'local_media_jobs',
])

const EXTENDED_EXECUTION_COUNT_KEYS = Object.freeze([
  ...EXECUTION_COUNT_KEYS,
  'media_batch_items',
  'image_generations',
  'video_generations',
  'asset_import_sessions',
  'production_actions',
  'live_orchestration_nodes',
])

function unwrap(payload) {
  if (!payload || typeof payload !== 'object') return null
  return payload.data && typeof payload.data === 'object' ? payload.data : payload
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}

function positiveCount(counts, key) {
  const value = numberOrNull(counts?.[key])
  return value != null && value > 0
}

function missingKeys(counts, keys) {
  return keys.filter((key) => numberOrNull(counts?.[key]) == null)
}

function blockingReasons(work) {
  return Array.isArray(work.blocking) ? work.blocking.filter((item) => typeof item === 'string' && item.trim()) : []
}

function liveExecutionReason(counts) {
  if (!counts || typeof counts !== 'object') return null
  if (EXTENDED_EXECUTION_COUNT_KEYS.some((key) => positiveCount(counts, key))) return 'execution'
  if (positiveCount(counts, 'unknown_paid_requests')) return 'unknown_paid_request'
  return null
}

function interpretV2(work) {
  const blocking = blockingReasons(work)
  const protectedBlock = blocking.find((item) => item === 'unreadable' || item === 'incomplete')
  if (protectedBlock || work.readable === false) {
    return { idle: false, reason: protectedBlock || 'unreadable', schema: work.schema }
  }
  if (blocking.length) {
    return { idle: false, reason: blocking.join(','), schema: work.schema }
  }
  const conflict = liveExecutionReason(work.counts)
  if (conflict) {
    return { idle: false, reason: conflict, schema: work.schema }
  }
  if (work.busy === true) {
    return { idle: false, reason: 'busy', schema: work.schema }
  }
  return { idle: true, reason: 'idle', schema: work.schema }
}

function interpretLegacy(work) {
  const counts = work.counts
  if (!counts || typeof counts !== 'object') {
    if (work.busy === false) return { idle: true, reason: 'legacy_idle', schema: 'legacy' }
    return { idle: false, reason: 'legacy_counts_missing', schema: 'legacy' }
  }

  const missingExecution = missingKeys(counts, EXECUTION_COUNT_KEYS)
  if (missingExecution.length) return { idle: false, reason: 'legacy_incomplete_counts', schema: 'legacy' }
  if (EXECUTION_COUNT_KEYS.some((key) => positiveCount(counts, key))) {
    return { idle: false, reason: 'legacy_execution', schema: 'legacy' }
  }
  if (EXTENDED_EXECUTION_COUNT_KEYS.some((key) => positiveCount(counts, key))) {
    return { idle: false, reason: 'legacy_execution', schema: 'legacy' }
  }
  if (positiveCount(counts, 'unknown_paid_requests')) {
    return { idle: false, reason: 'legacy_unknown_paid_request', schema: 'legacy' }
  }
  if (positiveCount(counts, 'analysis')) {
    return { idle: true, reason: 'legacy_analysis_context', schema: 'legacy' }
  }
  if (work.busy === true) {
    return { idle: false, reason: 'legacy_busy_unexplained', schema: 'legacy' }
  }
  return { idle: true, reason: 'legacy_idle', schema: 'legacy' }
}

export function interpretWorkStatus(payload) {
  const work = unwrap(payload)
  if (!work) return { idle: false, reason: 'unreadable', schema: 'unknown' }
  if (typeof work.busy !== 'boolean') return { idle: false, reason: 'busy_flag_unreadable', schema: work.schema || 'unknown' }
  if (work.schema === 'yinzi.runtime-work-status/v2') return interpretV2(work)
  return interpretLegacy(work)
}

export function assertIdleWorkStatus(payload) {
  const interpreted = interpretWorkStatus(payload)
  if (!interpreted.idle) {
    throw new Error('工作流仍有运行或待核对任务，保留原后台与记录，稍后继续更新')
  }
  return interpreted
}
