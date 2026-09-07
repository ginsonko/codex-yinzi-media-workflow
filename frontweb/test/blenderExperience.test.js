import test from 'node:test'
import assert from 'node:assert/strict'
import { blenderActive, blenderFrameProgress, blenderLinks } from '../src/utils/blenderExperience.js'
test('Blender result links stay on local static storage for both synchronous and job responses', () => {
  const manifest = { blend: 'scene.blend', glb: 'scene.glb', frames: ['frames/frame-0001.png'], video: { status: 'succeeded', relative_path: 'preview.mp4' } }
  assert.equal(blenderLinks({ output_dir: 'blender/jobs/id', manifest }).length, 4)
  assert.equal(blenderLinks({ command: { output_dir: 'blender/render/id' }, blender: manifest })[0].href, '/static/blender/render/id/scene.blend')
  for (const output_dir of ['C:/private', '/absolute', '../escape', 'x/%2e%2e/y', 'https://bad.example', 'x\\bad']) assert.deepEqual(blenderLinks({ output_dir, manifest }), [])
  for (const blend of ['../outside', '%2e%2e/outside', '%2fabsolute', 'javascript:alert(1)']) assert.equal(blenderLinks({ output_dir: 'blender/jobs/id', manifest: { blend } }).length, 0)
})
test('unknown progress stays unknown and cancelling stays active until close', () => {
  assert.equal(blenderFrameProgress({}), null)
  assert.equal(blenderFrameProgress({ progress: { completed_frames: 1, total_frames: 3 } }), 33)
  assert.equal(blenderActive({ status: 'cancelling' }), true)
  assert.equal(blenderActive({ status: 'recoverable' }), false)
})
