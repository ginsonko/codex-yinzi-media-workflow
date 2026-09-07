export const WORKFLOW_REFERENCE_LIMITS = Object.freeze({ images: 4, videos: 3, audios: 1 })

const AUTOLINK_STATUS = Object.freeze({
  matched: { label: '已精确引用', tone: 'success' },
  missing_asset_definition: { label: '缺少资产设定', tone: 'warning' },
  ambiguous_asset_definition: { label: '存在同名冲突', tone: 'warning' },
  missing_approved_image: { label: '缺少已确认资源图', tone: 'warning' },
  omitted_by_capacity: { label: '超出本镜头容量', tone: 'warning' },
})

const REFERENCE_SOURCE_LABELS = Object.freeze({
  strict_first_frame: '严格首帧',
  storyboard: '当前分镜图',
  asset: '镜头点名资产 · 名称精确匹配',
  continuity_in: '上一镜已确认视频',
  director: '3D 导演台预演',
  upload: '用户上传',
  reused: '素材库复用',
})

export function normalizeWorkflowReferences(value) {
  return {
    images: Array.isArray(value?.images) ? value.images : [],
    videos: Array.isArray(value?.videos) ? value.videos : [],
    audios: Array.isArray(value?.audios) ? value.audios : [],
  }
}

export function mergeWorkflowReferences(currentValue, suggestedValue) {
  const current = normalizeWorkflowReferences(currentValue)
  const suggested = normalizeWorkflowReferences(suggestedValue)
  const result = {}
  for (const [type, limit] of Object.entries(WORKFLOW_REFERENCE_LIMITS)) {
    const merged = []
    for (const item of [...current[type], ...suggested[type]]) {
      const path = typeof item === 'string' ? item : item?.path
      if (!path || merged.some((entry) => entry.path === path)) continue
      merged.push(typeof item === 'string'
        ? { path, label: String(path).split(/[\\/]/).pop() || '参考媒体', source: 'upload' }
        : item)
    }
    result[type] = merged.slice(0, limit)
  }
  return result
}

export function autoLinkStatusMeta(status) {
  return AUTOLINK_STATUS[status] || { label: status || '未知状态', tone: 'warning' }
}

export function referenceSourceLabel(item) {
  if (item?.source === 'asset' && item.asset_name) return `${item.asset_name} · 名称精确匹配`
  return REFERENCE_SOURCE_LABELS[item?.source] || item?.source || '手动参考'
}

export function selectedAutoLinkDependencyIds(content) {
  const selectedImageArtifactIds = new Set((content?.images || [])
    .map((item) => Number(item?.artifact_id))
    .filter(Number.isInteger))
  return [...new Set((content?.autolink_receipt?.items || [])
    .filter((item) => item?.status === 'matched' && selectedImageArtifactIds.has(Number(item.image_artifact_id)))
    .flatMap((item) => [item.definition_artifact_id, item.image_artifact_id])
    .map(Number)
    .filter(Number.isInteger))]
}

export function buildReferenceAutoLinkView(content, options = {}) {
  const receipt = content?.autolink_receipt
  const hasReceipt = Boolean(receipt && Array.isArray(receipt.items))
  const items = hasReceipt
    ? receipt.items.map((item) => ({ ...item, status_meta: autoLinkStatusMeta(item.status) }))
    : []
  const matchedCount = items.filter((item) => item.status === 'matched').length
  const warningCount = items.length - matchedCount
  const capacity = hasReceipt ? (receipt.capacity || {}) : {}
  const origin = options.dirty
    ? 'dirty'
    : (content?.bundle_origin || (hasReceipt ? 'automatic_suggestion' : 'legacy'))
  const originMeta = ({
    dirty: { label: '尚未保存的用户修改', detail: '当前清单已经变更；保存后会成为新的用户修订。' },
    automatic_suggestion: { label: '系统自动建议', detail: '只按本镜头明确点名的资产进行精确匹配。' },
    manual_revision: { label: '用户修订', detail: '自动建议已由用户调整，当前清单以这个修订为准。' },
    manual: { label: '手动构建', detail: '这个参考包由用户从空白清单开始构建。' },
    legacy: { label: '旧版或手动参考包', detail: '没有自动引用回执，但现有审批结果仍然有效。' },
  })[origin] || { label: '参考包', detail: '' }

  let summaryText = originMeta.detail
  if (hasReceipt && !items.length) {
    summaryText = '本镜头没有点名角色、场景或道具，因此系统没有用其它资产补满空位。'
  } else if (hasReceipt) {
    const receiptSummary = `${matchedCount} / ${items.length} 个点名资产已精确匹配${warningCount ? `，${warningCount} 项需要注意` : '，没有发现缺失'}`
    summaryText = ['manual_revision', 'dirty'].includes(origin)
      ? `自动建议记录：${receiptSummary}；当前实际清单已由用户修改，以下方文件为准。`
      : `${receiptSummary}。`
  }
  const providerLimit = Number(capacity.provider_image_limit)
  const mandatoryCount = Number(capacity.mandatory_image_count)
  const assetSlots = Number(capacity.asset_slot_limit)
  const capacityText = [providerLimit, mandatoryCount, assetSlots].every(Number.isFinite)
    ? `模型图上限 ${providerLimit}；分镜/首帧占 ${mandatoryCount}；点名资产可用 ${assetSlots} 格`
    : ''

  return {
    hasReceipt,
    items,
    matchedCount,
    warningCount,
    origin,
    originLabel: originMeta.label,
    originDetail: originMeta.detail,
    summaryText,
    capacityText,
  }
}
