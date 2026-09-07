import test from 'node:test'
import assert from 'node:assert/strict'
import { selectFinalEditState, selectGenerationFailureAction } from '../src/utils/finalEdit.js'

function fixtures(overrides = {}) {
  const plan = {
    id: 289,
    stage: 'final_edit',
    scope_type: 'narration',
    scope_id: 'settings',
    revision: 3,
    status: 'approved',
    content: { kind: 'narration_plan', confirmation_fingerprint: 'current-plan' },
  }
  const shots = [
    { id: 201, stage: 'shot_video', scope_type: 'shot', scope_id: '1', status: 'approved', content: { included: true } },
    { id: 202, stage: 'shot_video', scope_type: 'shot', scope_id: '2', status: 'approved', content: { included: true } },
  ]
  const final = {
    id: 288,
    stage: 'final_edit',
    scope_type: 'run',
    scope_id: '',
    status: 'rejected',
    content: {
      kind: 'final_video',
      narration_plan_artifact_id: 287,
      narration_confirmation_fingerprint: 'old-plan',
      source_shot_artifact_ids: [201, 202],
    },
  }
  return {
    plan: { ...plan, ...(overrides.plan || {}) },
    shots,
    final: { ...final, ...(overrides.final || {}) },
  }
}

test('a current failed merge outranks the stale movie notice and remains retryable', () => {
  const { plan, shots, final } = fixtures()
  const state = selectFinalEditState([plan, final, ...shots], [{
    id: 190,
    kind: 'strict_merge',
    status: 'failed',
    error_message: '镜头 1 的旁白超过本镜头时长',
    request: {
      narration_plan_artifact_id: plan.id,
      narration_confirmation_fingerprint: plan.content.confirmation_fingerprint,
      scene_ids: shots.map((shot) => shot.id),
    },
  }])

  assert.equal(state.failedAction.id, 190)
  assert.equal(state.canRebuild, true)
  assert.match(state.message, /本地合成失败/)
  assert.match(state.message, /旁白超过本镜头时长/)
})

test('a historical final-edit failure is hidden after a later matching merge succeeds', () => {
  const { plan, shots, final } = fixtures()
  const currentFinal = {
    ...final,
    id: 293,
    status: 'draft',
    content: {
      ...final.content,
      narration_plan_artifact_id: plan.id,
      narration_confirmation_fingerprint: plan.content.confirmation_fingerprint,
    },
  }
  const request = {
    narration_plan_artifact_id: plan.id,
    narration_confirmation_fingerprint: plan.content.confirmation_fingerprint,
    scene_ids: shots.map((shot) => shot.id),
  }
  const state = selectFinalEditState([plan, currentFinal, ...shots], [
    {
      id: 189,
      kind: 'strict_merge',
      status: 'failed',
      error_message: 'old failure',
      request: { ...request, narration_plan_artifact_id: 287, narration_confirmation_fingerprint: 'old-plan' },
    },
    { id: 192, kind: 'strict_merge', status: 'completed', request },
  ])

  assert.equal(selectGenerationFailureAction([
    { id: 189, stage: 'final_edit', status: 'failed', error_message: 'old failure' },
  ], { stage: 'final_edit', finalEditState: state }), null)
})

test('a failure for the current final-edit contract remains actionable', () => {
  const { plan, shots, final } = fixtures()
  const request = {
    narration_plan_artifact_id: plan.id,
    narration_confirmation_fingerprint: plan.content.confirmation_fingerprint,
    scene_ids: shots.map((shot) => shot.id),
  }
  const state = selectFinalEditState([plan, final, ...shots], [{
    id: 194,
    kind: 'strict_merge',
    status: 'failed',
    error_message: 'current failure',
    request,
  }])

  const failure = selectGenerationFailureAction([], { stage: 'final_edit', finalEditState: state })
  assert.equal(failure.id, 194)
  assert.equal(failure.error_message, 'current failure')
})

test('non-final stage failure selection remains scoped and newest-first', () => {
  const failure = selectGenerationFailureAction([
    { id: 2, stage: 'storyboard_plan', scope_id: '7', status: 'failed' },
    { id: 4, stage: 'storyboard_plan', scope_id: '7', status: 'failed' },
    { id: 5, stage: 'storyboard_plan', scope_id: '8', status: 'failed' },
  ], { stage: 'storyboard_plan', scopeId: '7' })
  assert.equal(failure.id, 4)
})

test('a pending merge is idempotent and a matching draft final is ready for review', () => {
  const { plan, shots, final } = fixtures()
  const request = {
    narration_plan_artifact_id: plan.id,
    narration_confirmation_fingerprint: plan.content.confirmation_fingerprint,
    scene_ids: shots.map((shot) => shot.id),
  }
  const pending = selectFinalEditState([plan, final, ...shots], [{
    id: 191, kind: 'strict_merge', status: 'waiting', request,
  }])
  assert.equal(pending.canRebuild, false)
  assert.equal(pending.pendingAction.id, 191)
  assert.match(pending.message, /正在按旁白修订 3/)

  const currentFinal = {
    ...final,
    id: 292,
    status: 'draft',
    content: {
      ...final.content,
      narration_plan_artifact_id: plan.id,
      narration_confirmation_fingerprint: plan.content.confirmation_fingerprint,
    },
  }
  const review = selectFinalEditState([plan, currentFinal, ...shots], [{
    id: 191, kind: 'strict_merge', status: 'completed', request,
  }])
  assert.equal(review.currentFinalId, 292)
  assert.equal(review.canRebuild, false)
  assert.match(review.message, /播放检查后确认或打回/)
})
