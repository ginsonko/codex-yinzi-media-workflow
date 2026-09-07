import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeProductionAspectRatio,
  productionAspectCss,
  productionAspectMismatch,
  productionAspectSpec,
} from '../src/utils/aspectRatio.js'

test('normalizes workflow aspect ratios for form, camera, and CSS consumers', () => {
  assert.equal(normalizeProductionAspectRatio('9：16'), '9:16')
  assert.equal(normalizeProductionAspectRatio('bad'), '16:9')
  assert.equal(productionAspectSpec('9:16').ratio, 9 / 16)
  assert.equal(productionAspectCss('1:1'), '1 / 1')
  assert.equal(productionAspectMismatch('16:9', '9:16'), true)
  assert.equal(productionAspectMismatch('9：16', '9:16'), false)
})
