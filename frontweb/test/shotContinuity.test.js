import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildShotContinuityView,
  continuityModeMeta,
  normalizeContinuityMode,
  previousStoryboardArtifact,
} from '../src/utils/shotContinuity.js'

const shot = (id, number, mode = number === 1 ? 'opening' : 'hard_cut') => ({
  id,
  stage: 'storyboard_plan',
  scope_type: 'shot',
  scope_id: String(number),
  status: 'approved',
  current: true,
  content: { number, transition_mode: mode, included: true },
})

test('normalizes the opening shot and locates the real previous storyboard', () => {
  const artifacts = [shot(1, 1), shot(2, 2), shot(3, 3)]
  assert.equal(normalizeContinuityMode('strict_continuation', 1), 'opening')
  assert.equal(continuityModeMeta('opening', 1).label, '成片开场')
  assert.equal(previousStoryboardArtifact(artifacts, artifacts[2]).id, 2)
})

test('warns without blocking when a continuation has no predecessor video', () => {
  const first = shot(1, 1)
  const second = shot(2, 2, 'reference_continuation')
  const view = buildShotContinuityView({ artifact: second, artifacts: [first, second] })
  assert.equal(view.plannedTransport.code, 'generic_image_reference')
  assert.equal(view.blocker, '')
  assert.match(view.advisory, /仍可提交不带尾帧/)
  assert.equal(view.actualTransport.code, 'pending')
})

test('distinguishes ordinary reference transport from strict first-frame transport', () => {
  const first = shot(1, 1)
  const second = shot(2, 2, 'strict_continuation')
  const previousVideo = { id: 10, stage: 'shot_video', scope_id: '1', status: 'approved', media_path: 'prev.mp4', current: true }
  const frame = { id: 11, stage: 'continuity_frame', scope_id: '2', status: 'approved', media_path: 'tail.png', current: true }
  const bundle = {
    id: 12, stage: 'reference_bundle', scope_id: '2', status: 'approved', current: true,
    content: { continuity_in_artifact_id: 10, continuity_frame_artifact_id: 11, continuity_frame_transport: 'strict_first_frame' },
  }
  const video = {
    id: 13, stage: 'shot_video', scope_id: '2', status: 'draft', current: true,
    content: { dispatch_transport: { first_frame: 'tail.png', reference_images: ['board.png'] } },
  }
  const view = buildShotContinuityView({
    artifact: video,
    draft: { number: 2, transition_mode: 'strict_continuation', continuity_in_artifact_id: 10 },
    artifacts: [first, second, previousVideo, frame, bundle, video],
    route: { model: 'compatible', roles: { image: ['reference', 'first_frame'] } },
  })
  assert.equal(view.previousVideo.id, 10)
  assert.equal(view.continuityFrame.id, 11)
  assert.equal(view.actualTransport.code, 'strict_first_frame')
  assert.equal(view.firstFrameSupport, true)
  assert.equal(view.blocker, '')
  assert.equal(view.advisory, '')
})

test('warns but keeps a fixed incompatible model manually submittable', () => {
  const first = shot(1, 1)
  const second = shot(2, 2, 'strict_continuation')
  const previousVideo = { id: 10, stage: 'shot_video', scope_id: '1', status: 'approved', media_path: 'prev.mp4', current: true }
  const view = buildShotContinuityView({
    artifact: second,
    artifacts: [first, second, previousVideo],
    route: { model: 'reference-only', roles: { image: ['reference'] } },
  })
  assert.equal(view.blocker, '')
  assert.match(view.advisory, /仍可提交/)
  assert.equal(view.plannedTransport.code, 'strict_first_frame')
  assert.equal(view.actualTransport.code, 'pending')
})
