import test from 'node:test'
import assert from 'node:assert/strict'

import {
  derivePendingDirectorAction,
  isUnattendedOwner,
  selectAutonomyPresentation,
} from '../src/utils/productionAutonomyView.js'

test('shows bounded autonomous attempts for the current scoped object', () => {
  const run = {
    review_owner: 'ai', status: 'running', current_stage: 'asset_images',
    current_scope_type: 'character', current_scope_id: 'character-2',
    budget: { max_image_revisions: 4 },
    runtime: { autonomy: { objects: {
      'asset_images:character:character-2': {
        stage: 'asset_images', consecutive_generation_failures: 2,
        last_failure: { kind: 'generation', reason: '上游审核失败' },
      },
    } } },
  }
  const state = selectAutonomyPresentation(run, [{ id: 4, event_type: 'automation.attempt_recorded' }])
  assert.equal(isUnattendedOwner(run.review_owner), true)
  assert.equal(state.currentObject, '资源图 · 角色 character-2')
  assert.equal(state.attempt, 2)
  assert.equal(state.attemptLimit, 4)
  assert.equal(state.recentEvent.id, 4)
})

test('turns only a persisted intervention into a user action request', () => {
  const run = {
    review_owner: 'auto_accept', status: 'waiting_review', current_stage: 'shot_video',
    current_scope_type: 'shot', current_scope_id: '3', budget: { max_video_attempts_per_shot: 2 },
    runtime: { autonomy: {
      intervention: {
        object_key: 'shot_video:shot:3', stage: 'shot_video', scope_type: 'shot', scope_id: '3',
        reason: 'ambiguous_external_task', summary: { reason: '结果不明确' },
      },
      objects: { 'shot_video:shot:3': { last_failure: { kind: 'generation' }, consecutive_generation_failures: 1 } },
    } },
  }
  const state = selectAutonomyPresentation(run)
  assert.equal(state.title, '需要你处理一次')
  assert.match(state.detail, /停止重复提交/)
  assert.equal(state.currentObject, '镜头视频 · 镜头 3')
})

test('tells the truth when an unattended run is paused', () => {
  const state = selectAutonomyPresentation({
    review_owner: 'auto_accept', status: 'paused', current_stage: 'shot_video', current_scope_id: '2',
  })
  assert.equal(state.title, '制作已暂停')
  assert.match(state.detail, /不会继续轮询、推进或提交新任务/)
  assert.match(state.detail, /已提交给服务商的任务不会因暂停自动取消/)
})

test('reconstructs a waiting browser director capture after refresh', () => {
  const document = { timeline: { duration: 7 }, objects: [] }
  const result = derivePendingDirectorAction({
    status: 'waiting_client', policy: { director_mode: 'auto' }, runtime: { client_action_id: 82 },
  }, [{
    id: 82, kind: 'client_capture', status: 'waiting', scope_id: '4',
    request: { client_token: 'capture-token', source_artifact_id: 61, expected_duration: 7, expected_aspect_ratio: '9:16' },
  }], [{ id: 61, stage: 'director_plan', scope_id: '4', content: { document } }])

  assert.deepEqual(result, {
    type: 'capture_director_preview', action_id: 82, token: 'capture-token', shot_id: '4',
    expected_duration: 7, expected_aspect_ratio: '9:16', director_document: document,
  })
  assert.equal(derivePendingDirectorAction({ status: 'waiting_client', policy: { director_mode: 'off' } }, [], []), null)
})
