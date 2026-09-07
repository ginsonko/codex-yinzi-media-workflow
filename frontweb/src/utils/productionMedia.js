import { normalizeLocalMediaUrl } from './mediaUrl.js'

export const PRODUCTION_MEDIA_STAGES = Object.freeze([
  { value: 'all', label: '全部阶段' },
  { value: 'asset_images', label: '资源图' },
  { value: 'storyboard_images', label: '分镜图' },
  { value: 'director_preview', label: '3D 预演' },
  { value: 'shot_video', label: '镜头视频' },
  { value: 'final_edit', label: '旁白与成片' },
])

const STAGE_LABELS = Object.freeze(Object.fromEntries(
  PRODUCTION_MEDIA_STAGES.map((item) => [item.value, item.label])
))

export function productionStageLabel(stage) {
  return STAGE_LABELS[stage] || stage || '生产资产'
}

export function productionMediaUrl(item) {
  if (!item || item.available === false) return ''
  if (item.media_url) return normalizeLocalMediaUrl(item.media_url)
  const mediaPath = String(item.media_path || '').trim().replace(/\\/g, '/').replace(/^\/+/, '')
  return mediaPath ? `/static/${mediaPath}` : ''
}

export function productionMediaName(item) {
  if (item?.title) return item.title
  const path = String(item?.media_path || '').replace(/\\/g, '/')
  return path.split('/').pop() || '未命名生产资产'
}

export function mapLatestFinalsByDrama(items = []) {
  const result = new Map()
  for (const item of items) {
    const dramaId = Number(item?.drama_id)
    if (!Number.isInteger(dramaId) || result.has(dramaId)) continue
    if (item.stage !== 'final_edit' || item.kind !== 'final_video' || item.media_type !== 'video') continue
    result.set(dramaId, item)
  }
  return result
}

export function isCrossProjectMedia(item, targetDramaId) {
  const source = Number(item?.drama_id)
  const target = Number(targetDramaId)
  return Number.isInteger(source) && Number.isInteger(target) && source !== target
}

export function reusableMaterializeBody(item, targetDramaId) {
  return isCrossProjectMedia(item, targetDramaId) ? { allow_cross_project: true } : {}
}

export function normalizeUploadedMedia(item) {
  const sourceUrl = item?.url || item?.image_url || item?.video_url || ''
  const localPath = item?.local_path || item?.image_local_path || item?.video_local_path || ''
  const extensionPath = `${localPath || sourceUrl}`.split(/[?#]/, 1)[0]
  const type = item?.type === 'video' || /\.(mp4|webm|mov|m4v)$/i.test(extensionPath)
    ? 'video'
    : item?.type === 'audio' || /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(extensionPath)
      ? 'audio'
      : 'image'
  return {
    ...item,
    library_source: 'upload',
    type,
    name: item?.name || item?.filename || extensionPath.replace(/\\/g, '/').split('/').pop() || '未命名素材',
  }
}

export function normalizeProductionMedia(item) {
  return {
    ...item,
    id: `production-${item.artifact_id}`,
    library_source: 'production',
    type: item.media_type || 'video',
    name: productionMediaName(item),
    url: productionMediaUrl(item),
    read_only: true,
  }
}
