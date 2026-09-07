export const PRODUCTION_NOTIFICATION_STORAGE_KEY = 'yinzi:production-notifications:v1'

export const DEFAULT_PRODUCTION_NOTIFICATION_PREFERENCES = Object.freeze({
  review_concurrency: 3,
  max_consecutive_review_rejections: 5,
  max_consecutive_recovery_failures: 5,
  notifications_enabled: true,
  notification_sound_enabled: true,
  moderation_fallback_enabled: false,
  moderation_fallback_model: 'mg-seedance2.0 -480p fast',
})

const MAX_SEEN_KEYS = 200

export function normalizeProductionNotificationPreferences(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const concurrency = Number(source.review_concurrency)
  const reviewLimit = Number(source.max_consecutive_review_rejections)
  const recoveryLimit = Number(source.max_consecutive_recovery_failures)
  return {
    review_concurrency: Number.isFinite(concurrency)
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(concurrency)))
      : DEFAULT_PRODUCTION_NOTIFICATION_PREFERENCES.review_concurrency,
    max_consecutive_review_rejections: Number.isFinite(reviewLimit)
      ? Math.min(20, Math.max(1, Math.floor(reviewLimit)))
      : DEFAULT_PRODUCTION_NOTIFICATION_PREFERENCES.max_consecutive_review_rejections,
    max_consecutive_recovery_failures: Number.isFinite(recoveryLimit)
      ? Math.min(20, Math.max(1, Math.floor(recoveryLimit)))
      : DEFAULT_PRODUCTION_NOTIFICATION_PREFERENCES.max_consecutive_recovery_failures,
    notifications_enabled: source.notifications_enabled !== false,
    notification_sound_enabled: source.notification_sound_enabled !== false,
    moderation_fallback_enabled: source.moderation_fallback_enabled === true,
    moderation_fallback_model: String(
      source.moderation_fallback_model
      || DEFAULT_PRODUCTION_NOTIFICATION_PREFERENCES.moderation_fallback_model,
    ).trim() || DEFAULT_PRODUCTION_NOTIFICATION_PREFERENCES.moderation_fallback_model,
  }
}

function isUnattendedRun(run = {}) {
  return run.review_owner === 'ai' || run.review_owner === 'auto_accept'
}

export function productionNotificationEvent(run = {}, preferences = {}) {
  const normalized = normalizeProductionNotificationPreferences(preferences)
  if (!normalized.notifications_enabled || !run?.id || !isUnattendedRun(run)) return null

  const intervention = run.runtime?.autonomy?.intervention || null
  if (intervention?.object_key) {
    const createdAt = intervention.created_at || run.updated_at || run.version || 'current'
    return {
      kind: 'intervention',
      key: `intervention:${run.id}:${intervention.object_key}:${createdAt}`,
      title: '银子AI视频工作流需要你处理',
      message: intervention.summary?.reason
        || run.error_message
        || '自动流程已完成诊断和有限重试，请打开任务查看可执行的处理办法。',
      duration: 0,
    }
  }

  if (run.status === 'completed') {
    const completedAt = run.completed_at || run.updated_at || run.version || 'completed'
    return {
      kind: 'completed',
      key: `completed:${run.id}:${completedAt}`,
      title: '成片制作完成',
      message: '成片、字幕和交付文件已经准备好，可以返回任务播放或下载。',
      duration: 9000,
    }
  }

  return null
}

export function readSeenProductionNotifications(storage = globalThis?.localStorage) {
  if (!storage?.getItem) return []
  try {
    const value = JSON.parse(storage.getItem(PRODUCTION_NOTIFICATION_STORAGE_KEY) || '[]')
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(-MAX_SEEN_KEYS) : []
  } catch (_) {
    return []
  }
}

export function hasSeenProductionNotification(key, storage = globalThis?.localStorage) {
  return Boolean(key) && readSeenProductionNotifications(storage).includes(key)
}

export function rememberProductionNotification(key, storage = globalThis?.localStorage) {
  if (!key || !storage?.setItem) return false
  try {
    const next = readSeenProductionNotifications(storage).filter((item) => item !== key)
    next.push(key)
    storage.setItem(PRODUCTION_NOTIFICATION_STORAGE_KEY, JSON.stringify(next.slice(-MAX_SEEN_KEYS)))
    return true
  } catch (_) {
    return false
  }
}

export function productionNotificationTone(kind) {
  return kind === 'intervention'
    ? [
        { frequency: 392, offset: 0, duration: 0.16, gain: 0.055 },
        { frequency: 330, offset: 0.23, duration: 0.22, gain: 0.06 },
        { frequency: 330, offset: 0.58, duration: 0.22, gain: 0.06 },
      ]
    : [
        { frequency: 523.25, offset: 0, duration: 0.16, gain: 0.045 },
        { frequency: 783.99, offset: 0.22, duration: 0.24, gain: 0.055 },
      ]
}

export async function playProductionNotificationTone(kind, runtime = globalThis) {
  const AudioContextClass = runtime?.AudioContext || runtime?.webkitAudioContext
  if (!AudioContextClass) return false
  let context
  try {
    context = new AudioContextClass()
    if (context.state === 'suspended') await context.resume()
    const start = context.currentTime + 0.02
    for (const note of productionNotificationTone(kind)) {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(note.frequency, start + note.offset)
      gain.gain.setValueAtTime(0.0001, start + note.offset)
      gain.gain.exponentialRampToValueAtTime(note.gain, start + note.offset + 0.025)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.offset + note.duration)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start(start + note.offset)
      oscillator.stop(start + note.offset + note.duration + 0.02)
    }
    const total = Math.max(...productionNotificationTone(kind).map((note) => note.offset + note.duration))
    runtime.setTimeout?.(() => context.close().catch(() => {}), Math.ceil((total + 0.2) * 1000))
    return true
  } catch (_) {
    try { await context?.close?.() } catch (_) {}
    return false
  }
}
