import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getConfigReadiness,
  isConfiguredDefault,
  REQUIRED_AI_SERVICES,
} from '../src/utils/configReadiness.js'

function config(serviceType, overrides = {}) {
  return {
    service_type: serviceType,
    is_default: true,
    is_active: true,
    base_url: 'https://api.yinziapi.top/v1',
    has_api_key: true,
    model: [`${serviceType}-model`],
    ...overrides,
  }
}

test('requires exactly the four production-critical services', () => {
  assert.deepEqual(REQUIRED_AI_SERVICES.map((item) => item.type), [
    'text', 'image', 'storyboard_image', 'video',
  ])
  const readiness = getConfigReadiness([
    config('text'), config('image'), config('storyboard_image'), config('video'),
  ])
  assert.equal(readiness.readyCount, 4)
  assert.equal(readiness.total, 4)
  assert.equal(readiness.isReady, true)
  assert.deepEqual(readiness.missing, [])
})

test('explains why a service is not ready without treating saved state as tested', () => {
  const readiness = getConfigReadiness([
    config('text'),
    config('image', { has_api_key: false }),
    config('storyboard_image', { is_default: false }),
    config('video', { model: [], default_model: '' }),
  ])
  assert.equal(readiness.isReady, false)
  assert.deepEqual(readiness.missing.map((item) => [item.type, item.reason]), [
    ['image', '缺少 API Key'],
    ['storyboard_image', '尚未设为默认配置'],
    ['video', '缺少默认模型'],
  ])
  assert.equal(readiness.required[0].reason, '已配置')
})

test('ignores disabled defaults and accepts an explicit default_model', () => {
  assert.equal(isConfiguredDefault(config('text', { is_active: false })), false)
  assert.equal(isConfiguredDefault(config('text', { model: [], default_model: 'gpt-5.6-sol' })), true)

  const readiness = getConfigReadiness([
    config('text', { is_active: false }),
    config('text', { is_default: false }),
  ])
  assert.equal(readiness.required[0].ready, false)
  assert.equal(readiness.required[0].reason, '尚未设为默认配置')
})

test('optional TTS never blocks real project creation', () => {
  const readiness = getConfigReadiness([
    config('text'), config('image'), config('storyboard_image'), config('video'),
    config('tts', { has_api_key: false }),
  ])
  assert.equal(readiness.isReady, true)
  assert.equal(readiness.optional[0].ready, false)
  assert.equal(readiness.optional[0].reason, '缺少 API Key')
})

test('invalid API data degrades to four named missing services', () => {
  const readiness = getConfigReadiness(null)
  assert.equal(readiness.readyCount, 0)
  assert.equal(readiness.missing.length, 4)
  assert.ok(readiness.missing.every((item) => item.reason === '尚未添加配置'))
})
