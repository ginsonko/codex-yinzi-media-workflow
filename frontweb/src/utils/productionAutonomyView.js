const STAGE_LABELS = Object.freeze({
  story_input: '故事输入',
  script: '剧本',
  asset_text: '资源设定',
  asset_images: '资源图',
  storyboard_plan: '分镜脚本',
  storyboard_images: '分镜图',
  director_plan: '3D 导演方案',
  director_preview: '3D 预演',
  reference_bundle: '镜头参考包',
  shot_video: '镜头视频',
  final_edit: '剪辑交付',
})

const SCOPE_LABELS = Object.freeze({
  run: '整项',
  collection: '资源集合',
  character: '角色',
  scene: '场景',
  prop: '道具',
  shot: '镜头',
  narration: '旁白',
})

const INTERVENTION_LABELS = Object.freeze({
  automation_limit_reached: '同一对象已连续达到自动处理上限',
  ambiguous_external_task: '外部任务结果不明确，已停止重复提交',
  budget_exhausted: '本项目授权预算已经用完',
  resource_unavailable: '当前模型或分组没有可用渠道，系统已停止重复提交。请切换已配置渠道，或等待上游恢复后继续。',
  automation_diagnosis_stopped: 'AI 判断继续尝试只会重复失败',
  automation_recovery_failed: '自动恢复本身未能完成',
})

export function isUnattendedOwner(owner) {
  return owner === 'ai' || owner === 'auto_accept'
}

function objectKey(run = {}) {
  const stage = String(run.current_stage || 'unknown')
  const scopeType = String(run.current_scope_type || 'run')
  const scopeId = run.current_scope_id == null ? '' : String(run.current_scope_id)
  return `${stage}:${scopeType}:${scopeId}`
}

function attemptLimit(run, stage, kind) {
  const budget = run?.budget || {}
  if (stage === 'shot_video') return Math.max(1, Number(budget.max_video_attempts_per_shot) || 2)
  if (['asset_images', 'storyboard_images'].includes(stage)) return Math.max(1, Number(budget.max_image_revisions) || 3)
  if (['director_plan', 'director_preview'].includes(stage)) return Math.max(1, Number(budget.max_director_revisions) || 2)
  if (kind === 'review' || ['script', 'asset_text', 'storyboard_plan'].includes(stage)) {
    return Math.max(1, Number(budget.max_text_revisions) || 3)
  }
  return Math.max(1, Number(budget.max_auto_recoveries) || 3)
}

function scopeTitle(run = {}, intervention = null) {
  const stage = intervention?.stage || run.current_stage
  const scopeType = intervention?.scope_type || run.current_scope_type || 'run'
  const scopeId = intervention?.scope_id ?? run.current_scope_id
  const stageLabel = STAGE_LABELS[stage] || stage || '当前阶段'
  if (scopeId == null || scopeId === '') return stageLabel
  const scopeLabel = SCOPE_LABELS[scopeType] || scopeType
  return `${stageLabel} · ${scopeLabel} ${scopeId}`
}

function recentAutomationEvent(events = []) {
  return [...events]
    .filter((event) => String(event.event_type || '').startsWith('automation.'))
    .sort((left, right) => Number(right.id || 0) - Number(left.id || 0))[0] || null
}

export function selectAutonomyPresentation(run = {}, events = []) {
  const autonomy = run.runtime?.autonomy || {}
  const intervention = autonomy.intervention || null
  const key = intervention?.object_key || objectKey(run)
  const state = autonomy.objects?.[key] || null
  const lastFailure = state?.last_failure || null
  const attemptKind = lastFailure?.kind === 'review' ? 'review' : 'generation'
  const attempt = attemptKind === 'review'
    ? Number(state?.consecutive_review_failures || 0)
    : Number(state?.consecutive_generation_failures || 0)
  const stage = intervention?.stage || state?.stage || run.current_stage
  const latestEvent = recentAutomationEvent(events)
  let title = run.review_owner === 'ai' ? 'AI 审批托管运行中' : '全自动制作运行中'
  let detail = '无需逐项确认，可以离开本页；后台会继续推进并保留完整记录。'
  if (run.status === 'paused') {
    title = '制作已暂停'
    detail = '本地不会继续轮询、推进或提交新任务；已提交给服务商的任务不会因暂停自动取消。点击右上角“继续”后再恢复。'
  } else if (run.status === 'waiting_provider') {
    title = '服务商正在排队或生成'
    detail = '无需停留在本页；任务完成后会自动校验、审核并继续下一步。'
  } else if (run.status === 'waiting_client') {
    title = '正在准备本地 3D 预演录制'
    detail = '本地 WebGL 录制必须在浏览器内完成，请暂时保持本页打开；录制完成后会继续无人值守。'
  } else if (run.status === 'failed' && !intervention) {
    title = 'AI 正在分析并修复当前故障'
    detail = '系统会先调整提示词、重试或切换已授权的普通兼容模型；达到上限前不会打扰你。'
  } else if (run.status === 'completed') {
    title = '成片与交付文件已完成'
    detail = '可以直接播放成片、下载文件或查看完整审批和生成记录。'
  }
  if (intervention) {
    title = '需要你处理一次'
    detail = INTERVENTION_LABELS[intervention.reason]
      || intervention.summary?.reason
      || '自动流程已安全停止，等待你选择下一步。'
  }
  return {
    unattended: isUnattendedOwner(run.review_owner),
    intervention,
    objectKey: key,
    objectState: state,
    currentObject: scopeTitle(run, intervention),
    attempt,
    attemptKind,
    attemptLimit: attemptLimit(run, stage, attemptKind),
    title,
    detail,
    recentEvent: latestEvent,
    lastFailure,
  }
}

export function derivePendingDirectorAction(run = {}, actions = [], artifacts = [], outcome = null) {
  if (outcome?.client_action) return outcome.client_action
  if (run.status !== 'waiting_client' || String(run.policy?.director_mode || 'auto') === 'off') return null
  const runtimeActionId = Number(run.runtime?.client_action_id || 0)
  const action = [...actions]
    .filter((item) => item.kind === 'client_capture' && item.status === 'waiting')
    .sort((left, right) => {
      if (runtimeActionId) {
        if (Number(left.id) === runtimeActionId) return -1
        if (Number(right.id) === runtimeActionId) return 1
      }
      return Number(right.id || 0) - Number(left.id || 0)
    })[0]
  if (!action?.request?.client_token) return null
  const plan = artifacts.find((item) => Number(item.id) === Number(action.request.source_artifact_id))
    || artifacts.find((item) => item.stage === 'director_plan' && String(item.scope_id || '') === String(action.scope_id || ''))
  if (!plan?.content?.document) return null
  return {
    type: 'capture_director_preview',
    action_id: action.id,
    token: action.request.client_token,
    shot_id: action.scope_id,
    expected_duration: action.request.expected_duration,
    expected_aspect_ratio: action.request.expected_aspect_ratio,
    director_document: plan.content.document,
  }
}
