import test from 'node:test'
import assert from 'node:assert/strict'
import {
  boundaryStateLabel,
  configuredShotModel,
  configuredShotPrevisMode,
  directorStateLabel,
  eventLabel,
  eventSummary,
  eventTone,
  mergeShotRoutePolicy,
  normalizeRoute,
  routeDescription,
  routeHeadline,
  mediaContract,
  formatActionElapsed,
  generationFailureSummary,
  isDisplayableProviderAction,
  isFixtureAction,
  mergeShotDraftPolicy,
  providerStatusLabel,
  selectCurrentProviderAction,
  selectAmbiguousRecoveryAction,
  selectScopedStageArtifacts,
  selectShotRouteSource,
} from '../src/utils/videoRouting.js'

test('keeps an unlocked ambiguity action visible across refresh', () => {
  const action = {
    id: 159, stage: 'shot_video', scope_id: '1', kind: 'video_generate', status: 'cancelled',
    result: { ambiguous_reconciled: true, retry_authorized: true, ambiguous_resolution: 'confirmed_not_created_by_user' },
  }
  const selected = selectAmbiguousRecoveryAction({
    run: { current_stage: 'shot_video', current_scope_id: '1' },
    recovery_action: action,
    actions: [action],
  })
  assert.equal(selected.id, 159)
})

test('does not resurrect ambiguity recovery after retry start or a newer action', () => {
  const old = {
    id: 159, stage: 'shot_video', scope_id: '1', kind: 'video_generate', status: 'cancelled',
    result: { ambiguous_reconciled: true, retry_authorized: true },
  }
  const newer = { id: 160, stage: 'shot_video', scope_id: '1', kind: 'video_generate', status: 'waiting' }
  assert.equal(selectAmbiguousRecoveryAction({
    run: { current_stage: 'shot_video', current_scope_id: '1' }, actions: [newer, old],
  }), null)
  assert.equal(selectAmbiguousRecoveryAction({
    run: { current_stage: 'shot_video', current_scope_id: '1' },
    actions: [{ ...old, result: { ...old.result, retry_start_requested_at: '2026-09-01T00:00:00.000Z' } }],
  }), null)
})

test('shows a legacy short plan as a visible five-second provider adjustment', () => {
  const route = normalizeRoute({
    profile: 'short_image_guided', planned_duration: 2, duration: 5, duration_adjusted: true,
    model: 'cc-seedance2.0 480p-fast-nsp',
    uses_reference_video: false, requires_director_preview: false,
    limits: { images: 9, videos: 0, audios: 3 },
  })
  assert.equal(routeHeadline(route), '计划 2 秒 → 上游 5 秒 · 图片引导镜头')
  assert.equal(route.limits.videos, 0)
  assert.match(routeDescription(route), /紧凑五秒节拍/)
  assert.equal(mediaContract(route), '9 图 / 0 视频 / 3 音频')
})

test('repairs a persisted four-second legacy receipt for display before retry', () => {
  const route = normalizeRoute({
    profile: 'short_image_guided', duration: 4, duration_adjusted: false,
    model: 'cc-seedance2.0 480p-fast-nsp',
    uses_reference_video: false, requires_director_preview: false,
    limits: { images: 9, videos: 0, audios: 3 },
  })
  assert.equal(route.plannedDuration, 4)
  assert.equal(route.duration, 5)
  assert.equal(route.durationAdjusted, true)
  assert.match(routeHeadline(route), /计划 4 秒 → 上游 5 秒/)
})

test('makes project-level 3D opt-out and optional tail-frame transport explicit', () => {
  const route = normalizeRoute({
    profile: 'long_previs_guided', duration: 8, director_mode: 'off', previs_mode: 'force',
    transition_mode: 'reference_continuation', uses_reference_video: true,
    requires_director_preview: true, limits: { images: 4, videos: 0, audios: 1 },
  })
  assert.equal(route.previsMode, 'skip')
  assert.equal(route.usesReferenceVideo, false)
  assert.equal(route.requiresDirectorPreview, false)
  assert.equal(directorStateLabel(route), '项目已关闭 3D 导演台')
  assert.equal(boundaryStateLabel(route), '携带上一镜尾帧，作为普通参考图')
  assert.match(routeDescription(route), /不会生成导演台 JSON/)
})

test('shows a persisted shot skip over a stale auto receipt before the next approval', () => {
  const run = {
    policy: {
      director_mode: 'auto',
      video_previs_overrides: { 7: 'skip' },
    },
  }
  const shot = {
    stage: 'storyboard_plan',
    scope_type: 'shot',
    scope_id: '7',
    status: 'rejected',
    content: { number: 7, duration: 8, previs_mode: 'auto', transition_mode: 'hard_cut' },
  }
  const staleReceipt = {
    profile: 'long_previs_guided',
    duration: 8,
    previs_mode: 'auto',
    uses_reference_video: true,
    requires_director_preview: true,
    limits: { images: 4, videos: 3, audios: 1 },
    reason_codes: ['long_continuous_take', 'reference_video_supported', 'director_preview_required'],
  }
  const route = normalizeRoute(mergeShotRoutePolicy(staleReceipt, shot, run), shot)
  assert.equal(configuredShotPrevisMode(run, '7'), 'skip')
  assert.equal(route.previsMode, 'skip')
  assert.equal(route.usesReferenceVideo, false)
  assert.equal(route.requiresDirectorPreview, false)
  assert.equal(route.limits.videos, 0)
  assert.equal(routeHeadline(route, shot), '8 秒 · 图片引导镜头')
  assert.equal(route.profileLabel, '图片引导镜头')
  assert.equal(route.routeProfileLabel, '预演引导长镜头')
  assert.equal(directorStateLabel(route), '本镜头跳过 3D 预演')
  assert.match(routeDescription(route), /明确跳过 3D 预演/)

  const withoutReceipt = normalizeRoute(mergeShotRoutePolicy({}, shot, run), shot)
  assert.equal(withoutReceipt.previsMode, 'skip')
  assert.equal(withoutReceipt.requiresDirectorPreview, false)
  assert.equal(withoutReceipt.limits.videos, 0)
})

test('projects a live shot previs policy into an editing draft without mutating artifact content', () => {
  const content = { number: 7, title: '低眉藏锋', previs_mode: 'auto' }
  const shot = { scope_id: '7', content }
  const run = { policy: { video_previs_overrides: { 7: 'skip' } } }
  const draft = mergeShotDraftPolicy(content, shot, run)

  assert.notEqual(draft, content)
  assert.equal(draft.previs_mode, 'skip')
  assert.equal(content.previs_mode, 'auto')
  assert.equal(draft.title, '低眉藏锋')
})

test('derives a long route from shot duration when receipt is not available yet', () => {
  const route = normalizeRoute({}, { content: { duration: 8 } })
  assert.equal(route.profile, 'long_previs_guided')
  assert.equal(route.requiresDirectorPreview, true)
  assert.match(routeHeadline(route, { content: { duration: 8 } }), /8 秒/)
  assert.equal(mediaContract(route), '媒体能力待路由选择')
})

test('resolves the latest same-shot persisted route before the rough storyboard fallback', () => {
  const artifacts = [
    { id: 1, stage: 'storyboard_plan', scope_type: 'shot', scope_id: '1', content: { duration: 8 } },
    { id: 2, stage: 'reference_bundle', scope_type: 'shot', scope_id: '1', content: {
      routing_receipt: { model: 'mg-seedance2.0 -480p mini', limits: { images: 4, videos: 3, audios: 1 } },
    } },
    { id: 3, stage: 'reference_bundle', scope_type: 'shot', scope_id: '2', content: {
      routing_receipt: { model: 'other-model', limits: { images: 9, videos: 0, audios: 3 } },
    } },
  ]
  const resolved = selectShotRouteSource(artifacts, '1')
  assert.equal(resolved.artifact.id, 2)
  assert.equal(mediaContract(resolved.route), '4 图 / 3 视频 / 1 音频')
})

test('keeps the configured model authoritative over an older successful video receipt', () => {
  const artifacts = [
    { id: 20, revision: 1, stage: 'storyboard_plan', scope_type: 'shot', scope_id: '5', content: { duration: 5 } },
    { id: 21, revision: 1, stage: 'shot_video', scope_type: 'shot', scope_id: '5', content: {
      routing_receipt: { model: 'model-a', limits: { images: 9, videos: 0, audios: 3 } },
    } },
    { id: 22, revision: 2, stage: 'reference_bundle', scope_type: 'shot', scope_id: '5', content: {
      routing_receipt: { model: 'model-b', limits: { images: 4, videos: 0, audios: 1 } },
    } },
  ]
  const selected = selectShotRouteSource(artifacts, '5', { configuredModel: 'model-b' })
  assert.equal(selected.artifact.id, 22)
  assert.equal(selected.route.model, 'model-b')
  assert.equal(selected.route.model_consistent, true)
})

test('shows a newly configured model as pending instead of reverting to an old receipt', () => {
  const artifacts = [
    { id: 30, revision: 1, stage: 'storyboard_plan', scope_type: 'shot', scope_id: '5', content: { duration: 4 } },
    { id: 31, revision: 2, stage: 'reference_bundle', scope_type: 'shot', scope_id: '5', content: {
      routing_receipt: { model: 'model-b', limits: { images: 9, videos: 0, audios: 3 } },
    } },
  ]
  const selected = selectShotRouteSource(artifacts, '5', { configuredModel: 'model-c' })
  assert.equal(selected.route.model, 'model-c')
  assert.equal(selected.route.receipt_model, 'model-b')
  assert.equal(selected.route.route_sync_state, 'pending')
  assert.equal(selected.route.model_consistent, false)
  assert.equal(mediaContract(selected.route), '媒体能力待路由选择')
})

test('resolves shot override before project fixed model', () => {
  const run = { policy: {
    video_routing_mode: 'fixed',
    video_model: 'project-model',
    video_model_overrides: { 5: 'shot-model' },
  } }
  assert.equal(configuredShotModel(run, '5'), 'shot-model')
  assert.equal(configuredShotModel(run, '6'), 'project-model')
})

test('scopes provider status to the current stage and shot', () => {
  const actions = [
    { id: 10, stage: 'asset_images', scope_id: 'character-1', kind: 'image_generate', status: 'completed' },
    { id: 11, stage: 'shot_video', scope_id: '2', kind: 'video_generate', status: 'waiting' },
    { id: 12, stage: 'shot_video', scope_id: '1', kind: 'video_generate', status: 'submitted' },
  ]
  const selected = selectCurrentProviderAction(actions, { current_stage: 'shot_video', current_scope_id: '1' })
  assert.equal(selected.id, 12)
  assert.equal(selectCurrentProviderAction(actions, { current_stage: 'reference_bundle', current_scope_id: '1' }), null)
})

test('uses the newest same-shot provider action instead of reviving older failures', () => {
  const actions = [
    { id: 30, stage: 'shot_video', scope_id: '5', kind: 'video_generate', status: 'failed', request: { model: 'model-a' } },
    { id: 31, stage: 'shot_video', scope_id: '5', kind: 'video_generate', status: 'failed', request: { model: 'model-b' } },
    { id: 32, stage: 'shot_video', scope_id: '5', kind: 'video_generate', status: 'completed', request: { model: 'model-c' } },
  ]
  const selected = selectCurrentProviderAction(actions, { current_stage: 'shot_video', current_scope_id: '5' })
  assert.equal(selected.id, 32)
  assert.equal(selected.request.model, 'model-c')
})

test('keeps superseded provider actions in history without showing them as current', () => {
  assert.equal(isDisplayableProviderAction({ status: 'cancelled', result: { superseded_by_route_change: true } }), false)
  assert.equal(isDisplayableProviderAction({ status: 'waiting' }), true)
  assert.equal(isDisplayableProviderAction(null), false)
})

test('does not reuse an earlier shot media artifact for the current shot', () => {
  const artifacts = [
    { id: 1, stage: 'storyboard_images', scope_type: 'shot', scope_id: '1', status: 'approved' },
    { id: 2, stage: 'storyboard_images', scope_type: 'shot', scope_id: '2', status: 'failed' },
    { id: 3, stage: 'shot_video', scope_type: 'shot', scope_id: '1', status: 'approved' },
  ]
  assert.deepEqual(
    selectScopedStageArtifacts(artifacts, 'storyboard_images', 'shot', '2').map((item) => item.id),
    [2],
  )
  assert.deepEqual(
    selectScopedStageArtifacts(artifacts, 'storyboard_images', 'shot', '3'),
    [],
  )
})

test('keeps an in-flight concurrent image visible ahead of a newer completed sibling', () => {
  const actions = [
    { id: 21, stage: 'asset_images', scope_id: 'character-1', kind: 'image_generate', status: 'waiting' },
    { id: 22, stage: 'asset_images', scope_id: 'scene-1', kind: 'image_generate', status: 'completed' },
  ]
  const selected = selectCurrentProviderAction(actions, { current_stage: 'asset_images', current_scope_id: null })
  assert.equal(selected.id, 21)
})

test('does not invent provider progress or ETA', () => {
  assert.equal(providerStatusLabel({ status: 'waiting' }, { status: 'waiting_provider' }), '已提交，等待服务商状态')
  assert.equal(providerStatusLabel({ status: 'completed' }, { status: 'running' }), '已完成，等待审核')
  assert.equal(providerStatusLabel({ status: 'completed' }, { status: 'waiting_provider' }), '已完成，等待审核')
  assert.equal(providerStatusLabel(null, { status: 'waiting_provider' }), '尚未提交当前阶段任务')
})

test('freezes elapsed time when a provider action reaches a terminal state', () => {
  const failed = {
    status: 'failed',
    created_at: '2026-08-07T17:44:21.000Z',
    updated_at: '2026-08-07T18:16:37.000Z',
  }
  assert.equal(formatActionElapsed(failed, Date.parse('2026-08-07T19:00:00.000Z')), '处理耗时 32 分 16 秒')
  assert.equal(formatActionElapsed(null), '等待创建当前阶段任务')
})

test('turns provider zero-output failures into actionable Chinese copy', () => {
  const detail = 'Generation failed during processing; output_count=0; content safety: not flagged; failure_detail unavailable'
  assert.equal(
    generationFailureSummary(detail),
    '服务商处理失败且没有返回视频；本次回执未标记为内容审核拦截。可直接点击“一键重试”，也可以先调整模型或参考素材。',
  )
  assert.match(generationFailureSummary('provider unavailable'), /查看技术错误/)
})

test('labels zero-paid fixture actions instead of implying a provider submission', () => {
  const action = { status: 'waiting', request: { fixture: true } }
  assert.equal(isFixtureAction(action), true)
  assert.match(providerStatusLabel(action, { status: 'waiting_provider' }), /本地验收模拟/)
  assert.match(providerStatusLabel(action, { status: 'waiting_provider' }), /未提交服务商/)
  assert.equal(isFixtureAction({ result: { fixture: false } }), false)
})

test('translates autonomous retries and model switches into user-facing activity', () => {
  const attempt = {
    event_type: 'automation.attempt_recorded', scope_type: 'shot', scope_id: '3',
    payload: { kind: 'generation', count: 2, limit: 3, error_code: 'VIDEO_GENERATION_FAILED' },
  }
  assert.equal(eventLabel(attempt), 'AI 第 2 次故障恢复')
  assert.match(eventSummary(attempt), /连续尝试 2 \/ 3/)
  assert.equal(eventTone(attempt), 'progress')

  const switched = {
    event_type: 'automation.video_model_switched', scope_type: 'shot', scope_id: '3',
    payload: { from_model: 'model-a', to_model: 'model-b' },
  }
  assert.match(eventLabel(switched), /普通兼容视频模型/)
  assert.match(eventSummary(switched), /model-a → model-b/)
})
