import test from 'node:test'
import assert from 'node:assert/strict'
import { batchItemCanRetry, batchItemNeedsReview, batchRequestKey, batchSubmission } from '../src/utils/batchRequestKey.js'

test('one submit intent keeps a stable body key while new intents remain distinct', () => {
  const first = { kind: 'image', concurrency: 8, items: [{ prompt: 'A', size: '1:1' }] }
  const reordered = { items: [{ size: '1:1', prompt: 'A' }], concurrency: 8, kind: 'image' }
  assert.equal(batchRequestKey(first, 'intent-one'), batchRequestKey(reordered, 'intent-one'))
  assert.notEqual(batchRequestKey(first, 'intent-one'), batchRequestKey({ ...first, concurrency: 1 }, 'intent-one'))
  assert.notEqual(batchRequestKey(first, 'intent-one'), batchRequestKey(first, 'intent-two'))
  const pending = batchSubmission(first)
  assert.equal(batchSubmission(reordered, pending), pending)
  assert.notEqual(batchSubmission(first).key, pending.key)
  assert.notEqual(batchSubmission({ ...first, concurrency: 1 }, pending).key, pending.key)
})

test('ambiguous items retain their label and expose explicit retry', () => {
  assert.equal(batchItemCanRetry({ status: 'failed' }), true)
  assert.equal(batchItemCanRetry({ status: 'needs_review' }), true)
  assert.equal(batchItemNeedsReview({ error_code: 'UPSTREAM_AMBIGUOUS' }), true)
})
