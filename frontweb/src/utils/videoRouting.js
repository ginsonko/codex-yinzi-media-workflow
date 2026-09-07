export const ROUTE_PROFILES = Object.freeze({
  SHORT: 'short_image_guided',
  LONG: 'long_previs_guided',
})

const PROFILE_LABELS = Object.freeze({
  [ROUTE_PROFILES.SHORT]: '图片引导镜头',
  [ROUTE_PROFILES.LONG]: '预演引导长镜头',
})

const BOUNDARY_LABELS = Object.freeze({
  opening: '成片开场，不继承上一镜',
  hard_cut: '独立切镜，不携带上一镜尾帧',
  reference_continuation: '携带上一镜尾帧，作为普通参考图',
  strict_continuation: '携带上一镜尾帧，作为严格 first_frame',
})

const REASON_LABELS = Object.freeze({
  short_complete_visual_beat: '短促且完整的视觉节拍',
  free_duration_exact_fit: '保留剧本要求的精确时长',
  provider_minimum_duration_5s: '上游最低 5 秒，旧短镜头已按 5 秒提交',
  image_references_only: '只发送图片和文本，不上传参考视频',
  long_continuous_take: '同一机位的连续动作',
  reference_video_supported: '模型支持参考视频',
  director_preview_required: '先确认本地 3D 预演',
  director_preview_forced_locally: '本镜头强制生成本地 3D 预演，但模型不会接收参考视频',
  director_preview_skipped_by_user: '已按本镜头设置跳过 3D 预演',
  director_disabled_for_run: '本任务已完全关闭 3D 导演台',
  fixed_model_override: '专家指定模型',
  shot_model_override: '本镜头指定模型',
  route_receipt_pending: '模型配置已更新，等待对应参考包回执',
  static_catalog_preview: '目录尚未刷新，当前为静态预览',
})

export function normalizeRoute(route = {}, shot = {}) {
  const source = route?.routing_receipt || route?.route || route || {}
  const content = shot?.content || shot || {}
  const plannedDuration = Math.round(Number(source.planned_duration ?? content.duration ?? source.duration) || 0)
  const persistedDuration = source.duration != null
    ? Math.round(Number(source.duration) || 0)
    : plannedDuration
  const duration = persistedDuration ? Math.max(5, persistedDuration) : 0
  const durationAdjusted = Boolean(source.duration_adjusted)
    || Boolean(plannedDuration && duration && plannedDuration !== duration)
  const profile = source.profile
    || content.route_profile
    || (plannedDuration > 5 ? ROUTE_PROFILES.LONG : ROUTE_PROFILES.SHORT)
  const directorMode = String(source.director_mode || content.director_mode || 'auto') === 'off' ? 'off' : 'auto'
  const requestedPrevisMode = ['auto', 'force', 'skip'].includes(source.previs_mode || content.previs_mode)
    ? (source.previs_mode || content.previs_mode)
    : 'auto'
  const previsMode = directorMode === 'off' ? 'skip' : requestedPrevisMode
  const usesReferenceVideo = source.uses_reference_video != null
    ? directorMode !== 'off' && Boolean(source.uses_reference_video)
    : profile === ROUTE_PROFILES.LONG && previsMode !== 'skip'
  const requiresDirectorPreview = source.requires_director_preview != null
    ? directorMode !== 'off' && Boolean(source.requires_director_preview)
    : previsMode === 'force' || (profile === ROUTE_PROFILES.LONG && previsMode !== 'skip')
  const routeProfileLabel = PROFILE_LABELS[profile] || '自动镜头路由'
  const profileLabel = usesReferenceVideo ? routeProfileLabel : PROFILE_LABELS[ROUTE_PROFILES.SHORT]
  const transitionMode = source.transition_mode || content.transition_mode || (Number(content.number) === 1 ? 'opening' : 'hard_cut')
  const continuityFrameTransport = source.continuity_frame_transport || content.continuity_frame_transport || (
    transitionMode === 'reference_continuation'
      ? 'generic_image_reference'
      : transitionMode === 'strict_continuation' ? 'strict_first_frame' : 'none'
  )
  const limits = source.limits || content.limits || {}
  const limitsKnown = Object.hasOwn(limits, 'images')
    || Object.hasOwn(limits, 'videos')
    || Object.hasOwn(limits, 'audios')
  return {
    ...source,
    duration,
    planned_duration: plannedDuration,
    duration_adjusted: durationAdjusted,
    plannedDuration,
    durationAdjusted,
    profile,
    profileLabel,
    routeProfileLabel,
    previs_mode: previsMode,
    director_mode: directorMode,
    uses_reference_video: usesReferenceVideo,
    requires_director_preview: requiresDirectorPreview,
    transition_mode: transitionMode,
    continuity_frame_transport: continuityFrameTransport,
    previsMode,
    directorMode,
    usesReferenceVideo,
    requiresDirectorPreview,
    transitionMode,
    continuityFrameTransport,
    model: source.model || content.video_model_override || '',
    limits: {
      images: limitsKnown && limits.images != null ? Number(limits.images) : null,
      videos: limitsKnown && limits.videos != null ? Number(limits.videos) : null,
      audios: limitsKnown && limits.audios != null ? Number(limits.audios) : null,
    },
  }
}

export function routeHeadline(route, shot = {}) {
  const normalized = normalizeRoute(route, shot)
  const duration = normalized.durationAdjusted && normalized.plannedDuration
    ? `计划 ${normalized.plannedDuration} 秒 → 上游 ${normalized.duration} 秒`
    : normalized.duration ? `${normalized.duration} 秒` : '待定时长'
  return `${duration} · ${normalized.profileLabel}`
}

export function routeDescription(route, shot = {}) {
  const normalized = normalizeRoute(route, shot)
  if (normalized.directorMode === 'off') {
    return '本任务已完全关闭 3D 导演台；不会生成导演台 JSON、预演视频或参考视频，只发送已确认的图片、音频和文本。'
  }
  if (normalized.profile === ROUTE_PROFILES.SHORT) {
    if (normalized.previsMode === 'force') {
      return '适合短促完整的视觉节拍；会先生成本地 3D 预演供审核，但当前图片引导模型不会接收参考视频。'
    }
    return '适合表情、反应、插入和新角度等紧凑五秒节拍；跳过 3D 录制，只发送图片、音频和文本。'
  }
  if (normalized.previsMode === 'skip') {
    return '连续长镜头仍按精确时长生成，但已明确跳过 3D 预演；只发送已批准的图片、音频和文本描述。'
  }
  return '适合同一机位内完成的连续动作；先确认 3D 导演台预演，再把可用参考图和参考视频一起发送。'
}

export function boundaryStateLabel(route, shot = {}) {
  const normalized = normalizeRoute(route, shot)
  return BOUNDARY_LABELS[normalized.transitionMode] || '待确认与上一镜的衔接方式'
}

export function directorStateLabel(route, shot = {}) {
  const normalized = normalizeRoute(route, shot)
  if (normalized.directorMode === 'off') return '项目已关闭 3D 导演台'
  if (normalized.requiresDirectorPreview) return '本镜头需要已确认的 3D 预演'
  return '本镜头跳过 3D 预演'
}

export function reasonLabels(route) {
  const reasons = Array.isArray(route?.reason_codes) ? route.reason_codes : []
  return reasons.map((reason) => REASON_LABELS[reason] || reason).filter(Boolean)
}

export function mediaContract(route, content = {}) {
  const normalized = normalizeRoute(route, content)
  const limits = normalized.limits
  if (![limits.images, limits.videos, limits.audios].every(Number.isFinite)) return '媒体能力待路由选择'
  return `${limits.images} 图 / ${limits.videos} 视频 / ${limits.audios} 音频`
}

export function configuredShotModel(run = {}, scopeId = null) {
  const policy = run?.policy || {}
  const overrides = policy.video_model_overrides && typeof policy.video_model_overrides === 'object'
    ? policy.video_model_overrides
    : {}
  const shotModel = String(overrides[String(scopeId ?? '')] || '').trim()
  if (shotModel) return shotModel
  const projectMode = policy.video_routing_mode || (String(policy.video_model || '').trim() ? 'fixed' : 'auto')
  return projectMode === 'fixed' ? String(policy.video_model || '').trim() : ''
}

export function configuredShotPrevisMode(run = {}, scopeId = null) {
  const policy = run?.policy || {}
  if (String(policy.director_mode || 'auto') === 'off') return 'skip'
  const overrides = policy.video_previs_overrides && typeof policy.video_previs_overrides === 'object'
    ? policy.video_previs_overrides
    : {}
  const value = String(overrides[String(scopeId ?? '')] || '').trim()
  return ['auto', 'force', 'skip'].includes(value) ? value : null
}

export function mergeShotDraftPolicy(content = {}, shot = {}, run = {}) {
  const draft = { ...(content || {}) }
  const scopeId = shot?.scope_id ?? shot?.content?.scope_id ?? shot?.content?.number ?? draft.scope_id ?? draft.number
  const policyMode = configuredShotPrevisMode(run, scopeId)
  if (policyMode) draft.previs_mode = policyMode
  return draft
}

/**
 * Apply the live run policy to an immutable artifact receipt for display.
 * Artifact receipts are historical; a persisted shot override must be visible
 * immediately even before the next approved bundle is rebuilt.
 */
export function mergeShotRoutePolicy(route = {}, shot = {}, run = {}) {
  const source = route?.routing_receipt || route?.route || route || {}
  const scopeId = shot?.scope_id ?? shot?.content?.scope_id ?? shot?.content?.number
  const policyMode = configuredShotPrevisMode(run, scopeId)
  if (!policyMode) return source

  const base = normalizeRoute(source, shot)
  const directorDisabled = String(run?.policy?.director_mode || 'auto') === 'off'
  const usesReferenceVideo = base.profile === ROUTE_PROFILES.LONG && policyMode !== 'skip'
  const requiresDirectorPreview = policyMode === 'force'
    || (base.profile === ROUTE_PROFILES.LONG && policyMode !== 'skip')
  const limits = { ...(source.limits || base.limits || {}) }
  limits.videos = usesReferenceVideo
    ? (Number.isFinite(Number(limits.videos)) && Number(limits.videos) > 0 ? Number(limits.videos) : null)
    : 0
  const staleReasons = new Set([
    ...(Array.isArray(source.reason_codes) ? source.reason_codes : []),
  ])
  staleReasons.delete('reference_video_supported')
  staleReasons.delete('director_preview_required')
  staleReasons.delete('director_preview_skipped_by_user')
  staleReasons.delete('director_disabled_for_run')
  staleReasons.delete('image_references_only')
  staleReasons.delete('director_preview_forced_locally')
  if (policyMode === 'skip') {
    staleReasons.add('image_references_only')
    staleReasons.add(directorDisabled ? 'director_disabled_for_run' : 'director_preview_skipped_by_user')
  } else if (usesReferenceVideo) {
    staleReasons.add('reference_video_supported')
    staleReasons.add('director_preview_required')
  } else if (policyMode === 'force') {
    staleReasons.add('image_references_only')
    staleReasons.add('director_preview_forced_locally')
  }

  return {
    ...source,
    director_mode: directorDisabled ? 'off' : 'auto',
    previs_mode: policyMode,
    uses_reference_video: usesReferenceVideo,
    requires_director_preview: requiresDirectorPreview,
    limits,
    reason_codes: [...staleReasons],
    route_policy_state: 'pending_approval',
    policy_previs_override: policyMode,
  }
}

export function selectShotRouteSource(artifacts = [], scopeId = null, options = {}) {
  const configuredModel = String(options.configuredModel || '').trim()
  const stagePriority = { reference_bundle: 0, shot_video: 1, storyboard_plan: 2 }
  const candidates = (artifacts || [])
    .filter((item) => item.scope_type === 'shot'
      && Object.hasOwn(stagePriority, item.stage)
      && (scopeId == null || String(item.scope_id) === String(scopeId)))
    .map((artifact) => ({
      artifact,
      route: artifact.content?.routing_receipt || artifact.content?.route || {},
    }))
    .filter((item) => Object.keys(item.route).length || item.artifact.stage === 'storyboard_plan')
    .sort((left, right) => {
      const stageOrder = stagePriority[left.artifact.stage] - stagePriority[right.artifact.stage]
      if (stageOrder) return stageOrder
      const revisionOrder = Number(right.artifact.revision || 0) - Number(left.artifact.revision || 0)
      return revisionOrder || Number(right.artifact.id || 0) - Number(left.artifact.id || 0)
    })

  if (configuredModel) {
    const matched = candidates.find((item) => String(item.route?.model || '').trim() === configuredModel)
    if (matched) {
      return {
        artifact: matched.artifact,
        route: {
          ...matched.route,
          configured_model: configuredModel,
          receipt_model: configuredModel,
          route_sync_state: 'ready',
          model_consistent: true,
        },
      }
    }
    const fallback = candidates[0] || null
    const storyboard = candidates.find((item) => item.artifact.stage === 'storyboard_plan')?.artifact || fallback?.artifact
    const fallbackRoute = fallback?.route || {}
    const content = storyboard?.content || {}
    return {
      artifact: storyboard || fallback?.artifact || null,
      route: {
        profile: fallbackRoute.profile || content.route_profile,
        planned_duration: fallbackRoute.planned_duration ?? content.duration,
        duration: fallbackRoute.duration ?? content.duration,
        duration_adjusted: fallbackRoute.duration_adjusted,
        director_mode: fallbackRoute.director_mode || content.director_mode,
        previs_mode: fallbackRoute.previs_mode || content.previs_mode,
        transition_mode: fallbackRoute.transition_mode || content.transition_mode,
        model: configuredModel,
        configured_model: configuredModel,
        receipt_model: String(fallbackRoute.model || '').trim() || null,
        route_sync_state: 'pending',
        model_consistent: false,
        catalog_verified: false,
        limits: {},
        reason_codes: ['route_receipt_pending'],
      },
    }
  }

  const selected = candidates[0] || null
  if (!selected) return { artifact: null, route: {} }
  return {
    artifact: selected.artifact,
    route: {
      ...selected.route,
      receipt_model: String(selected.route?.model || '').trim() || null,
      route_sync_state: 'ready',
      model_consistent: true,
    },
  }
}

/**
 * Keep stage media scoped to the selected sequential shot. A successful
 * artifact from an earlier shot must never become a visual fallback for the
 * current shot while its own image/video is missing or failed.
 */
export function selectScopedStageArtifacts(artifacts = [], stage, scope = null, scopeId = null) {
  const items = (artifacts || []).filter((item) => item.stage === stage)
  if (scope !== 'shot' || scopeId == null || scopeId === '') return items
  return items.filter((item) => String(item.scope_id) === String(scopeId))
}

export function selectCurrentProviderAction(actions = [], run = {}) {
  const scopeId = run?.current_scope_id
  const priority = { reserved: 0, submitted: 0, waiting: 0, ambiguous: 1, failed: 1, completed: 2 }
  const matching = [...(actions || [])]
    .filter((item) => item.stage === run?.current_stage
      && ['video_generate', 'video_poll', 'image_generate'].includes(item.kind)
      && ['reserved', 'submitted', 'waiting', 'completed', 'failed', 'ambiguous'].includes(item.status)
      && (scopeId == null || String(item.scope_id || '') === String(scopeId)))
  if (scopeId != null && scopeId !== '') {
    return matching.sort((left, right) => Number(right.id || 0) - Number(left.id || 0))[0] || null
  }
  return matching
    .sort((left, right) => {
      const stateOrder = (priority[left.status] ?? 3) - (priority[right.status] ?? 3)
      return stateOrder || Number(right.id || 0) - Number(left.id || 0)
    })[0] || null
}

/**
 * Select the one ambiguity-recovery action that is still current for a shot.
 * A reconciled/cancelled action remains visible across refresh until the user
 * explicitly starts a replacement. Any newer provider action wins and keeps
 * an old recovery card from being resurrected.
 */
export function selectAmbiguousRecoveryAction(summary = {}, runInput = {}) {
  const run = summary?.run || runInput || {}
  const scopeId = run?.current_scope_id
  const candidates = [summary?.recovery_action, summary?.current_action, ...(summary?.actions || [])]
    .filter(Boolean)
    .filter((item, index, all) => all.findIndex((candidate) => Number(candidate.id) === Number(item.id)) === index)
    .filter((item) => item.stage === 'shot_video'
      && item.kind === 'video_generate'
      && (scopeId == null || String(item.scope_id || '') === String(scopeId)))
    .sort((left, right) => Number(right.id || 0) - Number(left.id || 0))
  const latest = candidates[0] || null
  if (!latest) return null
  if (latest.status === 'ambiguous') return latest
  if (latest.status === 'cancelled'
    && latest.result?.ambiguous_reconciled === true
    && latest.result?.retry_authorized === true
    && !latest.result?.retry_start_requested_at) return latest
  return null
}

export function isDisplayableProviderAction(action = null) {
  return Boolean(action && ['reserved', 'submitted', 'waiting', 'completed', 'failed', 'ambiguous'].includes(action.status))
}

export function routeCostLabel(route) {
  const value = Number(route?.estimated_price)
  if (!Number.isFinite(value)) return '费用待目录刷新'
  return `预计 ${value.toFixed(4)} USD`
}

export function routeState(route, artifact = {}) {
  const normalized = normalizeRoute(route, artifact)
  if (!normalized.model) return '待自动选择模型'
  if (normalized.catalog_verified === false) return '静态预览，提交前会刷新目录'
  return normalized.model
}

export function formatElapsed(from, now = Date.now()) {
  if (!from) return '等待服务商状态'
  const timestamp = new Date(from).getTime()
  if (!Number.isFinite(timestamp)) return '等待服务商状态'
  const seconds = Math.max(0, Math.floor((Number(now) - timestamp) / 1000))
  if (seconds < 60) return `已等待 ${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  return `已等待 ${minutes} 分 ${seconds % 60} 秒`
}

export function formatActionElapsed(action, now = Date.now()) {
  if (!action) return '等待创建当前阶段任务'
  const terminal = ['completed', 'failed', 'ambiguous'].includes(action.status)
  const terminalAt = new Date(action.updated_at || action.completed_at || '').getTime()
  const until = terminal && Number.isFinite(terminalAt) ? terminalAt : now
  const value = formatElapsed(action.created_at, until)
  return terminal ? value.replace(/^已等待/, '处理耗时') : value
}

export function generationFailureSummary(error) {
  const detail = String(error || '').trim()
  if (/output_count\s*=\s*0/i.test(detail) && /content safety:\s*not flagged/i.test(detail)) {
    return '服务商处理失败且没有返回视频；本次回执未标记为内容审核拦截。可直接点击“一键重试”，也可以先调整模型或参考素材。'
  }
  if (/output_count\s*=\s*0/i.test(detail)) {
    return '服务商处理结束但没有返回视频。请查看技术错误，可直接点击“一键重试”。'
  }
  return '视频生成失败。请查看技术错误，可直接点击“一键重试”。'
}

export function isFixtureAction(action = {}) {
  return action?.request?.fixture === true || action?.result?.fixture === true
}

export function providerStatusLabel(action, run = {}) {
  if (isFixtureAction(action)) {
    return action?.status === 'completed'
      ? '本地验收模拟已完成（未提交服务商）'
      : '本地验收模拟（未提交服务商）'
  }
  if (!action) return run.status === 'completed' ? '已完成' : '尚未提交当前阶段任务'
  if (action.status === 'completed') return '已完成，等待审核'
  if (action.status === 'failed') return '生成失败，需要处理'
  if (action.status === 'ambiguous') return '提交结果不明确，需先核对'
  if (['reserved', 'submitted', 'waiting'].includes(action.status)) {
    const providerStatus = String(action?.result?.provider_status || action?.provider_status || '').toLowerCase()
    if (providerStatus === 'processing') return '服务商处理中'
    if (providerStatus === 'queued' || providerStatus === 'pending') return '服务商排队中'
    return '已提交，等待服务商状态'
  }
  return '尚未提交当前阶段任务'
}

export function eventLabel(event = {}) {
  const payload = event.payload || {}
  if (event.event_type === 'automation.attempt_recorded') {
    const kind = payload.kind === 'review' ? '审核打回' : '故障恢复'
    return `AI 第 ${payload.count || '?'} 次${kind}`
  }
  const labels = {
    'run.created': '创建制作任务',
    'run.started': '开始推进流程',
    'run.transitioned': '进入下一阶段',
    'stage.skipped': '按镜头路由跳过阶段',
    'action.reserved': '准备执行任务',
    'action.updated': '任务状态更新',
    'action.retry_authorized': '已授权一次重试',
    'action.ambiguous_reconciled': '已核对不明确的提交',
    'artifact.created': '生成内容草稿',
    'artifact.reviewed': '完成内容审核',
    'artifact.edited': '保存新的内容修订',
    'automation.artifact_revised': 'AI 已按意见生成新修订',
    'automation.video_model_switched': 'AI 已切换普通兼容视频模型',
    'automation.escalated': '自动处理达到停止条件',
  }
  return labels[event.event_type] || event.event_type || '流程事件'
}

export function eventSummary(event = {}) {
  const payload = event.payload || {}
  const scope = event.scope_id ? `${event.scope_type === 'shot' ? '镜头 ' : ''}${event.scope_id}` : ''
  if (event.event_type === 'automation.attempt_recorded') {
    const counter = payload.limit ? `${payload.count || '?'} / ${payload.limit}` : payload.count || ''
    return [scope, counter ? `连续尝试 ${counter}` : '', payload.error_code || '', payload.decision || ''].filter(Boolean).join(' · ')
  }
  if (event.event_type === 'automation.video_model_switched') {
    return [scope, payload.from_model && payload.to_model ? `${payload.from_model} → ${payload.to_model}` : payload.to_model].filter(Boolean).join(' · ')
  }
  if (event.event_type === 'automation.artifact_revised') {
    return [scope, payload.reason || '已把审核意见写入下一修订'].filter(Boolean).join(' · ')
  }
  if (event.event_type === 'automation.escalated') {
    return [scope, payload.summary?.reason || payload.reason || '已安全停止，等待一次人工处理'].filter(Boolean).join(' · ')
  }
  const reason = payload.reason || payload.resolution || payload.strategy || ''
  return [scope, reason].filter(Boolean).join(' · ') || '已记录'
}

export function eventTone(event = {}) {
  if (String(event.event_type || '').includes('failed') || event.event_type === 'automation.escalated') return 'danger'
  if (String(event.event_type || '').startsWith('automation.')) return 'progress'
  if (event.event_type === 'stage.skipped') return 'muted'
  if (String(event.event_type || '').includes('review')) return 'review'
  if (String(event.event_type || '').includes('updated')) return 'progress'
  return 'default'
}
