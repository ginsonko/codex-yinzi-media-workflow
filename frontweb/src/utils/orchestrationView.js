export const STATUS_LABELS = Object.freeze({
  draft: '等待 Codex 规划',
  waiting_confirmation: '等待确认计划',
  planned: '计划已确认',
  running: '执行中',
  paused: '已暂停',
  succeeded: '已完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
  pending: '等待依赖',
  ready: '可以执行',
  waiting_confirmation_node: '等待确认',
  skipped: '已跳过',
})

export function statusLabel(status, node = false) {
  if (node && status === 'waiting_confirmation') return STATUS_LABELS.waiting_confirmation_node
  return STATUS_LABELS[status] || status || '未知'
}

export function statusTone(status) {
  if (['succeeded'].includes(status)) return 'success'
  if (['running', 'ready', 'planned'].includes(status)) return 'active'
  if (['failed', 'cancelled'].includes(status)) return 'danger'
  if (['partial', 'waiting_confirmation'].includes(status)) return 'warning'
  if (['paused', 'skipped'].includes(status)) return 'muted'
  return 'neutral'
}

export function progressLabel(node) {
  const progress = node?.progress || {}
  if (progress.message) return progress.message
  if (progress.state === 'provider_ack') return '服务商已接收，等待真实状态'
  if (progress.state === 'local_started') return '本地执行器已开始'
  if (node?.status === 'running') return '正在执行；没有真实进度时不显示虚假百分比'
  if (node?.status === 'pending') return `等待：${(node.depends_on || []).join('、') || '尚未启动'}`
  return ''
}

export function moduleAvailabilityLabel(node) {
  return ({ integrated: '已集成', bridge: '由 Codex/现有接口执行', advisory: '提案与沙盒阶段', unknown: '未知模块，允许人工处理' })[node?.module_contract_status] || '未登记'
}

export function latestReceipt(bundle, nodeId) {
  return [...(bundle?.receipts || [])].reverse().find((item) => item.node_id === nodeId) || null
}

/** Normalize serialized retryability without relying on JavaScript truthiness. */
export function normalizeRetryability(receipt) {
  const value = receipt?.retryable
  if (value === true || value === false) return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
    if (normalized === 'unknown') return 'unknown'
  }
  return 'unknown'
}

function hasConfigurationAction(receipt) {
  const actions = Array.isArray(receipt?.next_actions) ? receipt.next_actions : []
  return actions.some((action) => /^(replace_with_(?:video|image|text)_enabled_key|repair_.*(?:router|route|config)|configure_|reconnect_(?:provider|account))/i.test(String(action || '')))
}

/** Convert structured failure evidence into actionable, truthful UI guidance. */
export function providerFailureGuidance(node, receipt) {
  if (!['failed', 'partial'].includes(node?.status) || !receipt) return null
  const retryable = normalizeRetryability(receipt)
  const category = String(receipt.normalized_category || '').trim().toLowerCase()
  const videoRouteMissing = category === 'provider_route_contract_missing'
  const configurationMissing = videoRouteMissing
    || category === 'configuration_required'
    || hasConfigurationAction(receipt)

  if (configurationMissing) {
    return {
      kind: 'configuration_required',
      title: videoRouteMissing ? '当前视频配置没有可用路由' : '当前步骤需要补全配置',
      summary: '已保存这次失败和原任务。先补全当前步骤所需的配置，再沿原任务继续。',
      steps: [
        '打开“模型与 Key”，检查对应类型的 URL、分组 Key 和模型',
        videoRouteMissing ? '可让 Codex 根据原始错误修复或更换已配置路由；目录未列出模型不等于不能使用' : '也可以把原任务交给 Codex，继续处理缺少的配置',
        '保留当前任务、已完成的素材和回执，修复后从原步骤继续',
      ],
      action: 'open_ai_config',
      direct_retry_allowed: false,
    }
  }

  if (retryable === true) {
    return {
      kind: 'retryable',
      title: '可以准备重试当前步骤',
      summary: '当前回执标记为可重试。准备重试会恢复节点的待执行状态，由 Codex 或对应执行器接手；实际提交后才会开始处理。',
      steps: ['点击“准备重试”保留原任务并重新打开这个步骤', '让 Codex 继续原任务；如果实际需要重新生成，将沿用已有授权和预算'],
      action: null,
      direct_retry_allowed: true,
    }
  }

  if (retryable === false) {
    return {
      kind: 'not_retryable',
      title: '当前回执标记为不可直接重试',
      summary: '原地重试没有明确收益；请查看技术信息、编辑节点或跳过后继续其它工作。',
      steps: ['查看原始错误代码和尝试范围', '必要时编辑节点或修复外部配置，再建立新的授权任务'],
      action: null,
      direct_retry_allowed: false,
    }
  }

  return {
    kind: 'manual_review',
    title: '是否重试需要人工判断',
    summary: '需要人工判断：系统没有足够证据安全地自动重试；原始错误仍保留，你可以查看、编辑、跳过或人工接管。',
    steps: ['先查看技术信息和原始回执', '确认不会重复提交后，再由人工决定后续动作'],
    action: null,
    direct_retry_allowed: false,
  }
}

export function canDirectlyRetryNode(node, receipt) {
  return Boolean(providerFailureGuidance(node, receipt)?.direct_retry_allowed)
}

export function nodeNextActions(node, receipt) {
  const actions = []
  if (canDirectlyRetryNode(node, receipt)) actions.push('retry')
  if (['pending', 'ready', 'waiting_confirmation', 'failed', 'partial'].includes(node.status)) actions.push('skip')
  if (receipt?.next_actions?.includes('manual')) actions.push('manual')
  return [...new Set(actions)]
}

export function summarizeCounts(counts = {}) {
  const all = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0)
  const done = ['succeeded', 'skipped', 'partial', 'failed', 'cancelled'].reduce((sum,key) => sum + Number(counts[key] || 0), 0)
  return { all, done, percent: all ? Math.round((done / all) * 100) : 0 }
}

export function formatBudgetTruth(budget = {}) {
  const rawAmount = budget.maximum ?? budget.max_cost_usd
  if (rawAmount == null || rawAmount === '') return '未设置费用上限；付费节点仍需明确授权'
  const amount = Number(rawAmount)
  const currency = String(budget.currency || (budget.maximum != null ? 'CNY' : 'USD')).toUpperCase()
  if (!Number.isFinite(amount)) return '预算格式无法识别；付费节点仍需明确授权'
  if (amount === 0) return `预算上限 0 ${currency}；禁止付费调用`
  if (amount > 0) return `预算上限 ${amount.toFixed(2)} ${currency}`
  return '预算不能为负数；付费节点仍需明确授权'
}
