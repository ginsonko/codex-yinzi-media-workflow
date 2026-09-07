import test from 'node:test'
import assert from 'node:assert/strict'
import { hasStoryboardVisual } from '../src/utils/workflowAssets.js'

test('scene fallback does not count as a generated storyboard visual', () => {
  assert.equal(hasStoryboardVisual({ background: { local_path: 'scene.png' } }), false)
  assert.equal(hasStoryboardVisual({ local_path: 'storyboard.png', background: { local_path: 'scene.png' } }), true)
  assert.equal(hasStoryboardVisual({ director_frame_path: 'director.png' }), true)
})
