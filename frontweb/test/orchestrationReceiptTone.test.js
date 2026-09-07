import assert from 'node:assert/strict'
import test from 'node:test'

import { orchestrationReceiptTone } from '../src/utils/orchestrationReceiptTone.js'

test('uses distinct truthful tones for orchestration receipts', () => {
  assert.equal(orchestrationReceiptTone({ status: 'success' }), 'receipt-success')
  assert.equal(orchestrationReceiptTone({ status: 'partial' }), 'receipt-warning')
  assert.equal(orchestrationReceiptTone({ status: 'failed' }), 'receipt-danger')
})

test('keeps unknown and missing receipt states neutral', () => {
  assert.equal(orchestrationReceiptTone({ status: 'pending' }), 'receipt-neutral')
  assert.equal(orchestrationReceiptTone({}), 'receipt-neutral')
  assert.equal(orchestrationReceiptTone(null), 'receipt-neutral')
})
