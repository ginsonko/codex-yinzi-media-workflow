import test from 'node:test'
import assert from 'node:assert/strict'
import { batchItemCanRetry, batchItemNeedsReview, batchRequestKey } from '../src/utils/batchRequestKey.js'

test('identical batch forms share one short-lived request key across tabs', () => {
  const first = { kind: 'image', concurrency: 8, items: [{ prompt: 'A', size: '1:1' }] }
  const reordered = { items: [{ size: '1:1', prompt: 'A' }], concurrency: 8, kind: 'image' }
  assert.equal(batchRequestKey(first, 240000), batchRequestKey(reordered, 240001))
  assert.notEqual(batchRequestKey(first, 240000), batchRequestKey({ ...first, concurrency: 1 }, 240001))
  assert.notEqual(batchRequestKey(first, 240000), batchRequestKey(first, 360001))
})

test('ambiguous items require reconciliation and never expose ordinary retry', () => {
  assert.equal(batchItemCanRetry({ status: 'failed' }), true)
  assert.equal(batchItemCanRetry({ status: 'needs_review' }), false)
  assert.equal(batchItemNeedsReview({ error_code: 'UPSTREAM_AMBIGUOUS' }), true)
})
