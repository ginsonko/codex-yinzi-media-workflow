const QUALITY_LABELS = Object.freeze({
  fast: '速度优先',
  balanced: '均衡',
  economy: '成本优先',
  quality: '质量优先',
  bypass: '高价破甲',
})

const BILLING_LABELS = Object.freeze({
  per_second: '/ 秒',
  per_request: '/ 次',
  per_generation: '/ 次',
  fixed_duration: '/ 段',
})

function currencyPrefix(currency) {
  const normalized = String(currency || '').trim().toUpperCase()
  if (normalized === 'CNY') return '¥'
  if (normalized === 'USD') return '$'
  return normalized ? `${normalized} ` : ''
}

export function modelDurationLabel(option = {}) {
  if (option.duration_mode === 'fixed') return `固定 ${option.fixed_duration_seconds || option.duration_min || '?'} 秒`
  if (option.duration_min != null && option.duration_max != null) return `${option.duration_min}–${option.duration_max} 秒`
  return '时长待核对'
}

export function modelMediaLabel(option = {}) {
  const limits = option.limits || {}
  if (![limits.images, limits.videos, limits.audios].every(Number.isFinite)) return '媒体能力待核对'
  return `${limits.images} 图 · ${limits.videos} 视频 · ${limits.audios} 音频`
}

export function modelQualityLabel(option = {}) {
  const quality = String(option.quality_tier || '')
  return QUALITY_LABELS[quality] || quality || '质量档位待核对'
}

export function modelPriceLabel(option = {}) {
  const prefix = currencyPrefix(option.currency)
  if (option.estimated_price != null && option.estimated_price !== '') {
    const estimated = Number(option.estimated_price)
    if (Number.isFinite(estimated)) return `本镜预计 ${prefix}${estimated.toFixed(4)}`
  }
  if (option.unit_price == null || option.unit_price === '') return '价格待目录刷新'
  const unit = Number(option.unit_price)
  if (!Number.isFinite(unit)) return '价格待目录刷新'
  return `${prefix}${unit.toFixed(4)} ${BILLING_LABELS[option.billing_unit] || option.billing_unit || ''}`.trim()
}

export function modelCompatibilityLabel(option = {}) {
  const warnings = Array.isArray(option.warnings) ? option.warnings : []
  if (option.contract_status === 'missing' || warnings.includes('unknown_contract') || warnings.includes('model_not_in_catalog')) {
    return '允许尝试，能力未登记'
  }
  if (option.contract_status === 'local') return '允许尝试，使用本地能力提示'
  if (option.group_available === false || warnings.includes('group_unavailable')) {
    return '允许尝试，当前分组未确认'
  }
  if (option.selectable) return '能力已登记，可用于当前镜头'
  return option.incompatibility_reason || '兼容性待核对'
}

export function modelWarnings(option = {}) {
  const warnings = Array.isArray(option.warnings) ? option.warnings : []
  return warnings.map((warning) => ({
    expensive_bypass: '高价破甲通道，需单独确认',
    fixed_duration_product: '固定时长产品',
    unknown_contract: '本地能力提示未登记（仍可提交）',
    model_not_in_catalog: '当前 Key 目录未返回此模型（仍可提交）',
    group_unavailable: '当前 Key 分组未确认此模型（仍可尝试）',
  })[warning] || warning)
}

export function videoGroupsFromCatalog(catalog = []) {
  return [...new Set((catalog || []).flatMap((item) => Array.isArray(item.groups) ? item.groups : []))]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

export function catalogModelOption(catalog = [], model = '', group = '') {
  const normalizedModel = String(model || '').trim()
  if (!normalizedModel) return null
  const item = (catalog || []).find((candidate) => String(candidate?.model || '').trim() === normalizedModel)
  if (!item) {
    return {
      model: normalizedModel,
      name: normalizedModel,
      groups: [],
      capabilities: null,
      limits: { images: null, videos: null, audios: null },
      contract_status: 'missing',
      catalog_verified: false,
      group_available: null,
      selectable: true,
      incompatibility_reason: '当前 Key 目录未返回此模型，提交后由上游确认能力',
      warnings: ['model_not_in_catalog', 'unknown_contract'],
      requires_explicit_confirmation: false,
      resolution: null,
      quality_tier: null,
      duration_mode: null,
      duration_min: null,
      duration_max: null,
      fixed_duration_seconds: null,
      roles: null,
      billing_unit: null,
      unit_price: null,
      estimated_price: null,
    }
  }
  const capability = item.capabilities || {}
  const prices = Array.isArray(item.prices) ? item.prices : []
  const price = prices.find((candidate) => !group || candidate.group === group) || prices[0] || {}
  const groupAvailable = !group || (item.groups || []).includes(group)
  const contractStatus = String(item.contract_status || (Object.keys(capability).length ? 'known' : 'missing'))
  return {
    ...item,
    ...capability,
    model: normalizedModel,
    limits: {
      images: Number(capability.max_images),
      videos: Number(capability.max_videos),
      audios: Number(capability.max_audios),
    },
    contract_status: contractStatus,
    // Preserve the backend evidence boundary. Public smart-route offers and
    // locally entered models remain selectable, but must not look like they
    // were verified by the current credential.
    catalog_verified: item.catalog_verified === true,
    credential_verified: item.credential_verified === true,
    public_catalog: item.public_catalog === true,
    smart_routing_candidate: item.smart_routing_candidate === true,
    availability_scope: item.availability_scope || null,
    scope_verified: item.scope_verified === true,
    group_available: groupAvailable,
    billing_unit: price.billing_unit || null,
    unit_price: price.effective_price ?? null,
    // Compatibility is advisory for a manually selected model. Automatic
    // routing still filters its own candidates on the backend.
    selectable: true,
    incompatibility_reason: !groupAvailable ? `当前分组 ${group} 尚未确认` : null,
    warnings: [
      ...(capability.expensive_bypass ? ['expensive_bypass'] : []),
      ...(capability.duration_mode === 'fixed' ? ['fixed_duration_product'] : []),
      ...(contractStatus === 'missing' ? ['unknown_contract'] : []),
      ...(!groupAvailable ? ['group_unavailable'] : []),
    ],
    requires_explicit_confirmation: capability.expensive_bypass === true,
  }
}

export function projectVideoRoutingState(policy = {}) {
  const model = String(policy.video_model || '').trim()
  const declaredMode = String(policy.video_routing_mode || '').trim()
  return {
    mode: declaredMode === 'fixed' || (!declaredMode && model) ? 'fixed' : 'auto',
    model,
    group: String(policy.video_group || '').trim(),
    quality: String(policy.video_quality || 'balanced').trim() || 'balanced',
    configId: policy.video_config_id == null ? null : Number(policy.video_config_id),
  }
}

/**
 * Keep the settings dialog from presenting the persisted route as the draft
 * route while a different video configuration is being inspected.
 */
export function projectVideoModelDisplay({
  settingsVisible = false,
  draft = null,
  activePolicy = {},
  currentModel = '',
  catalogConfigId = null,
  catalog = [],
  catalogError = '',
} = {}) {
  const runtimeModel = String(currentModel || '').trim()
  if (!settingsVisible || !draft) return runtimeModel || '提交前自动选择'

  const selectedConfigId = Number(draft.video_config_id)
  const loadedConfigId = Number(catalogConfigId)
  const catalogReady = Number.isSafeInteger(selectedConfigId)
    && selectedConfigId > 0
    && selectedConfigId === loadedConfigId
    && Array.isArray(catalog)
    && catalog.length > 0
    && !String(catalogError || '').trim()
  if (!catalogReady) return '尚未选择（保存前需读取模型目录）'
  if (draft.video_routing_mode === 'fixed') return String(draft.video_model || '').trim() || '尚未选择'
  if (selectedConfigId !== Number(activePolicy.video_config_id)) return '按镜头自动选择（保存后生效）'
  return runtimeModel || '提交前自动选择'
}

export function projectVideoRoutingChanged(policy = {}, draft = {}) {
  const current = projectVideoRoutingState(policy)
  const nextMode = draft.video_routing_mode === 'fixed' ? 'fixed' : 'auto'
  return current.mode !== nextMode
    || current.model !== (nextMode === 'fixed' ? String(draft.video_model || '').trim() : '')
    || current.group !== String(draft.video_group || '').trim()
    || current.quality !== String(draft.video_quality || 'balanced').trim()
    || current.configId !== (draft.video_config_id == null ? null : Number(draft.video_config_id))
}

export function buildProjectVideoRoutingPayload(draft = {}, options = {}) {
  const mode = draft.video_routing_mode === 'fixed' ? 'fixed' : 'auto'
  return {
    scope: 'run',
    shot_id: options.shotId == null ? undefined : String(options.shotId),
    mode,
    model: mode === 'fixed' ? String(draft.video_model || '').trim() : '',
    group: String(draft.video_group || '').trim(),
    quality: String(draft.video_quality || 'balanced').trim() || 'balanced',
    config_id: draft.video_config_id == null ? undefined : Number(draft.video_config_id),
    confirm_expensive: options.confirmExpensive === true,
    expected_version: options.expectedVersion,
  }
}

export function shotVideoPrevisMode(routing = {}) {
  if (routing?.project?.director_mode === 'off') return 'skip'
  const candidates = [
    routing?.shot?.previs_mode_override,
    routing?.effective_route?.previs_mode,
    'auto',
  ]
  return candidates.find((value) => ['auto', 'force', 'skip'].includes(value)) || 'auto'
}

export function buildShotVideoRoutingPayload(routing = {}, draft = {}) {
  const mode = draft.mode === 'fixed' ? 'fixed' : 'inherit'
  const requestedPrevisMode = ['auto', 'force', 'skip'].includes(draft.previs_mode)
    ? draft.previs_mode
    : shotVideoPrevisMode(routing)
  const directorDisabled = routing?.project?.director_mode === 'off'
  return {
    scope: 'shot',
    shot_id: routing?.shot?.id == null ? undefined : String(routing.shot.id),
    config_id: routing?.project?.config_id == null ? undefined : Number(routing.project.config_id),
    mode,
    model: mode === 'fixed' ? String(draft.model || '').trim() : '',
    previs_mode: directorDisabled ? 'skip' : requestedPrevisMode,
    authorize_retry: draft.authorize_retry === true && Boolean(routing.failed_action),
    retry_reason: draft.authorize_retry === true ? String(draft.retry_reason || '').trim() : '',
    confirm_expensive: draft.confirm_expensive === true,
    expected_version: routing.run_version,
  }
}
