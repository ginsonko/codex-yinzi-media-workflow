import { artifactMediaUrl } from './mediaUrl.js'
import { selectExecutionActivity } from './workActivity.js'

const MEDIA_TYPES = Object.freeze({ image: '图片', video: '视频', audio: '音频', model: '3D模型', glb: '3D模型', scene: '3D场景' })

export function mediaTypeLabel(type) {
  const value = String(type || '').toLowerCase()
  return MEDIA_TYPES[value] || '文件'
}

export function normalizeArtifact(item = {}, index = 0) {
  const rawType = String(item.type || item.media_type || item.kind || item.mime_type || '').toLowerCase()
  const type = rawType.startsWith('image/') ? 'image' : rawType.startsWith('video/') ? 'video' : rawType.startsWith('audio/') ? 'audio' : rawType.includes('gltf') || rawType.includes('glb') ? 'glb' : rawType
  const url = artifactMediaUrl(item) || null
  const downloadUrl = item.download_url || item.downloadUrl || url
  return {
    ...item,
    id: item.id || item.artifact_id || `artifact-${index}-${encodeURIComponent(item.title || item.name || type || 'file').slice(0, 36)}`,
    type: type || 'file',
    title: item.title || item.name || '未命名成果',
    url,
    download_url: downloadUrl,
    status: item.status || 'ready',
  }
}

export function normalizeArtifacts(items) {
  return Array.isArray(items) ? items.map(normalizeArtifact) : []
}

export function artifactReviewLabel(item = {}) {
  const verdict = item.validation?.content_review?.verdict
  if (verdict === 'needs_changes' || item.status === 'rejected') return '需要修改'
  if (verdict === 'accepted') return '内容已核对'
  return ({ review_required: '待核对内容', validated: '文件检查通过', failed: '失败' })[item.status] || '可查看'
}

export function artifactPlayable(artifact) {
  return Boolean(artifact?.url) && ['image', 'video', 'audio', 'model', 'glb', 'scene'].includes(String(artifact.type).toLowerCase())
}

export function progressFromNodes(nodes = []) {
  const list = Array.isArray(nodes) ? nodes.filter(node => node?.active !== false) : []
  const done = list.filter((node) => ['succeeded', 'skipped'].includes(node?.status)).length
  const running = selectExecutionActivity(list).current
  const failed = list.find((node) => ['failed', 'partial'].includes(node?.status))
  return {
    total: list.length,
    done,
    percent: list.length ? Math.round((done / list.length) * 100) : null,
    current: running || failed || list.find((node) => ['ready', 'waiting_confirmation'].includes(node?.status)) || null,
  }
}

export function sessionProgress(session = {}, nodes = []) {
  const progress = progressFromNodes(nodes)
  const terminal = ['succeeded', 'partial', 'failed', 'cancelled'].includes(String(session.status || '').toLowerCase())
  if (terminal && progress.total) return { ...progress, done: progress.total, percent: 100, current: null }
  return progress
}

export function deliveryTone(status) {
  if (['completed', 'delivered', 'verified', 'succeeded'].includes(String(status).toLowerCase())) return 'success'
  if (['failed', 'blocked'].includes(String(status).toLowerCase())) return 'danger'
  if (['partial', 'pending_review', 'waiting'].includes(String(status).toLowerCase())) return 'warning'
  return 'muted'
}

export function deliveryLabel(status) {
  return ({ completed: '已交付', delivered: '已交付', validated: '已核验', verified: '已核验', succeeded: '已完成', ready: '待交付', pending_review: '等待检查', partial: '部分交付', failed: '交付失败', blocked: '暂时阻塞', waiting: '等待产物' })[String(status || '').toLowerCase()] || '尚未交付'
}
