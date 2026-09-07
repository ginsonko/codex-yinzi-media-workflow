import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTargetShots, resolveTemplateTargetShots, resolvedPlanTargetShots } from '../src/utils/templateTargetShotOwnership.js'

test('uses a template default only while the system owns the field', () => {
  assert.equal(resolveTemplateTargetShots({ currentValue: 1, templateDefault: 4, userEdited: false }), 4)
  assert.equal(resolveTemplateTargetShots({ currentValue: 2, templateDefault: 4, userEdited: true }), 2)
})

test('uses the backend recommendation as the same source of truth', () => {
  assert.equal(resolvedPlanTargetShots({ recommended_settings: { target_shots: { value: 7 } } }, 1), 7)
  assert.equal(resolvedPlanTargetShots({}, 3), 3)
})

test('keeps the shared editable boundary at 999', () => {
  assert.equal(normalizeTargetShots(1000), 999)
  assert.equal(normalizeTargetShots(0, 4), 4)
})
