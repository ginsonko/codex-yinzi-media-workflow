import test from 'node:test'
import assert from 'node:assert/strict'
import { restoredScrollTop, selectViewportAnchor } from '../src/utils/workflowViewport.js'

test('selects the closest visible workflow anchor and preserves its viewport offset', () => {
  assert.deepEqual(selectViewportAnchor([
    { id: 'previous', top: -600, bottom: -10 },
    { id: 'current', top: -120, bottom: 640 },
    { id: 'next', top: 700, bottom: 900 },
  ], 800), { id: 'current', top: -120, bottom: 640 })
  assert.equal(restoredScrollTop({ scrollY: 1500, top: 80 }, 130), 1550)
  assert.equal(restoredScrollTop({ scrollY: 40, top: 20 }, -200), 0)
  assert.equal(restoredScrollTop({ scrollY: 3178, top: -376.5 }, 2801.5, 0), 3178)
})
