import test from 'node:test'
import assert from 'node:assert/strict'

import {
  hasSeenProductionNotification,
  normalizeProductionNotificationPreferences,
  productionNotificationEvent,
  productionNotificationTone,
  readSeenProductionNotifications,
  rememberProductionNotification,
} from '../src/utils/productionNotifications.js'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  }
}

test('notifies only terminal unattended states and uses stable dedupe keys', () => {
  const preferences = normalizeProductionNotificationPreferences({})
  assert.equal(productionNotificationEvent({ id: 'run-1', review_owner: 'human', status: 'completed' }, preferences), null)
  assert.equal(productionNotificationEvent({ id: 'run-1', review_owner: 'ai', status: 'waiting_provider' }, preferences), null)

  const complete = productionNotificationEvent({
    id: 'run-1', review_owner: 'auto_accept', status: 'completed', completed_at: '2026-08-13T10:00:00.000Z',
  }, preferences)
  assert.equal(complete.kind, 'completed')
  assert.equal(complete.key, 'completed:run-1:2026-08-13T10:00:00.000Z')

  const intervention = productionNotificationEvent({
    id: 'run-2', review_owner: 'ai', status: 'waiting_review',
    runtime: { autonomy: { intervention: {
      object_key: 'shot_video:shot:2', created_at: '2026-08-13T10:01:00.000Z',
      summary: { reason: '模型和备用模型均连续不可用' },
    } } },
  }, preferences)
  assert.equal(intervention.kind, 'intervention')
  assert.match(intervention.message, /连续不可用/)
  assert.equal(intervention.duration, 0)
})

test('honors the notification switch and normalizes user preferences', () => {
  const preferences = normalizeProductionNotificationPreferences({
    review_concurrency: 99,
    max_consecutive_review_rejections: 99,
    max_consecutive_recovery_failures: 0,
    notifications_enabled: false,
    notification_sound_enabled: false,
    moderation_fallback_enabled: true,
    moderation_fallback_model: ' 破甲seedance 720p-fast ',
  })
  assert.equal(preferences.review_concurrency, 99)
  assert.equal(preferences.max_consecutive_review_rejections, 20)
  assert.equal(preferences.max_consecutive_recovery_failures, 1)
  assert.equal(preferences.moderation_fallback_model, '破甲seedance 720p-fast')
  assert.equal(productionNotificationEvent({
    id: 'run-1', review_owner: 'auto_accept', status: 'completed', completed_at: 'now',
  }, preferences), null)
})

test('persists bounded notification receipts and survives broken storage data', () => {
  const storage = memoryStorage()
  storage.setItem('yinzi:production-notifications:v1', '{bad json')
  assert.deepEqual(readSeenProductionNotifications(storage), [])
  assert.equal(rememberProductionNotification('completed:run-1:one', storage), true)
  assert.equal(hasSeenProductionNotification('completed:run-1:one', storage), true)
  assert.equal(rememberProductionNotification('completed:run-1:one', storage), true)
  assert.deepEqual(readSeenProductionNotifications(storage), ['completed:run-1:one'])
})

test('uses different sound patterns for completion and intervention', () => {
  const complete = productionNotificationTone('completed')
  const intervention = productionNotificationTone('intervention')
  assert.equal(complete.length, 2)
  assert.equal(intervention.length, 3)
  assert.notDeepEqual(complete, intervention)
})
