import test from 'node:test'
import assert from 'node:assert/strict'

import { demoShotReferenceLabel } from '../src/utils/guidedDemo.js'

test('the guided demo carries director media only when the user selected it', () => {
  assert.equal(demoShotReferenceLabel(0, '携带 3D 预演'), '3 图 + 1 预演')
  assert.equal(demoShotReferenceLabel(0, '跳过 3D 预演'), '3 图')
  assert.equal(demoShotReferenceLabel(2, '携带 3D 预演'), '3 图 + 1 预演')
})

test('normal hard cuts do not pretend to carry the previous tail frame', () => {
  assert.equal(demoShotReferenceLabel(1, '跳过 3D 预演', 'hard_cut'), '3 图')
  assert.equal(demoShotReferenceLabel(2, '跳过 3D 预演'), '3 图')
})

test('strict continuation explicitly carries the predecessor tail frame', () => {
  assert.equal(
    demoShotReferenceLabel(1, '跳过 3D 预演', 'strict_first_frame'),
    '上一镜尾帧 + 3 图',
  )
  assert.equal(
    demoShotReferenceLabel(2, '携带 3D 预演', 'strict_first_frame'),
    '上一镜尾帧 + 3 图 + 1 预演',
  )
})
