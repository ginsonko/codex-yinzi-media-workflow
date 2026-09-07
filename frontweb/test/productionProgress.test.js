import test from 'node:test'
import assert from 'node:assert/strict'

import {
  productionIdleBackoffDelay,
  productionSemanticProgressSignature,
} from '../src/utils/productionProgress.js'

test('workflow semantic signatures ignore refresh bookkeeping and detect artifact/action progress', () => {
  const base = {
    run: {
      id: 'run-1', status: 'running', current_stage: 'asset_images',
      current_scope_type: 'scene', current_scope_id: '1', version: 1, updated_at: 'one', runtime: {},
    },
    artifacts: [{ id: 1, stage: 'asset_images', scope_type: 'scene', scope_id: '1', revision: 1, status: 'rejected' }],
    actions: [],
  }
  const refreshed = structuredClone(base)
  refreshed.run.version = 2
  refreshed.run.updated_at = 'two'
  assert.equal(productionSemanticProgressSignature(base), productionSemanticProgressSignature(refreshed))

  const progressed = structuredClone(base)
  progressed.actions.push({ id: 3, stage: 'asset_images', scope_type: 'scene', scope_id: '1', kind: 'image_generate', attempt: 2, status: 'reserved' })
  assert.notEqual(productionSemanticProgressSignature(base), productionSemanticProgressSignature(progressed))
})

test('workflow semantic idle backoff is bounded', () => {
  assert.equal(productionIdleBackoffDelay(1), 3500)
  assert.equal(productionIdleBackoffDelay(2), 7000)
  assert.equal(productionIdleBackoffDelay(20), 30000)
})
