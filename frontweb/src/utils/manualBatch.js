import { batchModelSelection, batchDefaultModelOption } from './batchModels.js'
import { imageSizeFor } from './imageSizes.js'

export const referenceKinds = ['image', 'video', 'audio']
export function newManualItem(source = {}) {
  return { id: crypto.randomUUID(), prompt: '', model: '', aspect_ratio: '', image_tier: '', size: '', duration: null, resolution: '',
    ...source, references: (source.references || []).map(ref => ({ ...ref, id: crypto.randomUUID() })) }
}
export function cloneManualItem(source) {
  return newManualItem({ ...source, id: crypto.randomUUID() })
}
export function referenceValue(ref) { return ref.local_path || ref.url || '' }
export function manualProtocol(selection, options, states) {
  const option = options.find(row => row.value === selection) || (!selection ? batchDefaultModelOption(options) : null)
  return (states[option?.config_id] || []).find(row => row.model === option?.model)?.protocol || null
}
export function manualItemRequest(item, kind, defaults, options) {
  const refs = item.references || []
  const images = refs.filter(r => r.type === 'image' && (kind === 'image' || !r.role || r.role === 'reference')).map(referenceValue)
  const selection = batchModelSelection(item.model || defaults.model, options, kind)
  const aspectRatio = item.aspect_ratio || defaults.settings.aspect_ratio
  const request = { ...selection,
    prompt: item.prompt.trim(), aspect_ratio: aspectRatio,
    [kind === 'image' ? 'reference_images' : 'reference_image_urls']: images }
  if (kind === 'image') {
    const size = imageSizeFor(selection.model, aspectRatio, item.image_tier || defaults.settings.image_tier || '2K', item.size || defaults.settings.size)
    if (size) request.size = size
  }
  if (kind === 'video') {
    request.duration = item.duration ?? defaults.settings.duration
    if (item.resolution) request.resolution = item.resolution
    for (const type of ['video', 'audio']) request[`reference_${type}_urls`] = refs.filter(r => r.type === type).map(referenceValue)
    for (const role of ['first_frame', 'last_frame']) {
      const ref = refs.find(r => r.type === 'image' && r.role === role)
      if (ref) request[`${role}_url`] = referenceValue(ref)
    }
  }
  return request
}
export function manualItemIssue(item, kind) {
  const refs = (item.references || []).filter(r => kind === 'video' || r.type === 'image')
  if (refs.some(r => r.status === 'uploading')) return '参考素材正在上传，完成后即可生成'
  if (refs.some(r => r.status !== 'ready' || !referenceValue(r))) return '有参考素材未上传成功，请重试、重新选择或移除'
  if (kind === 'video' && ['first_frame', 'last_frame'].some(role => refs.filter(r => r.role === role).length > 1)) return '首帧、尾帧分别只能指定一张；其余图片可设为普通参考'
  if (!item.prompt.trim() && !refs.length) return '填写提示词或添加参考素材即可生成'
  return ''
}
export function persistedManualDraft(items) {
  return items.map(item => ({ ...item, references: item.references.map(({ file, progress, ...ref }) => ({ ...ref,
    status: ref.status === 'uploading' ? 'interrupted' : ref.status,
    ...(ref.status === 'uploading' ? { error: '上传已中断，请重新选择这个文件' } : {}) })) }))
}
export function restoreManualDraft(raw) {
  try {
    const items = JSON.parse(raw)
    if (!Array.isArray(items) || !items.length) return [newManualItem()]
    const restored = items.filter(item => item && typeof item.prompt === 'string' && Array.isArray(item.references))
      .map(item => ({ ...newManualItem(), ...item, references: item.references.map(ref => ({ ...ref,
        status: ref.status === 'ready' && referenceValue(ref) ? 'ready' : 'interrupted',
        ...(ref.status !== 'ready' ? { error: '请重新选择文件，已上传成功的素材仍保留' } : {}) })) }))
    return restored.length ? restored : [newManualItem()]
  } catch { return [newManualItem()] }
}

// Capability metadata is advisory. The selected credential's effective contract
// always precedes the public catalog; never borrow another site's contract.
export function manualCapability(selection, options, states, catalog) {
  const option = options.find(row => row.value === selection) || (!selection ? batchDefaultModelOption(options) : null)
  const model = option?.model || selection
  const local = (states[option?.config_id] || []).find(row => row.model === model)
  if (local?.capability || local?.override) return { ...(local.capability || {}), ...(local.override || {}) }
  if (option) return null
  return (catalog || []).find(row => row.model === model)?.capabilities || null
}
export function capabilityNotes(capability, item) {
  if (!capability) return ['模型能力信息暂未取得，可继续填写；实际支持范围以上游响应为准。']
  const names = { image: '图片', video: '视频', audio: '音频' }
  const notes = referenceKinds.map(type => {
    const max = capability[`max_${type === 'image' ? 'images' : type === 'video' ? 'videos' : 'audios'}`]
    const count = item.references.filter(r => r.type === type).length
    return `${names[type]}：${max == null ? '数量待确认' : max === 0 ? '目录标注不支持' : `最多 ${max} 个`}${count ? `（已添加 ${count}）` : ''}`
  })
  if (capability.allowed_durations?.length) notes.push(`时长：${capability.allowed_durations.join(' / ')} 秒`)
  else if (capability.fixed_duration_seconds) notes.push(`固定时长：${capability.fixed_duration_seconds} 秒`)
  else if (capability.duration_min != null || capability.duration_max != null) notes.push(`时长：${capability.duration_min ?? '?'}–${capability.duration_max ?? '?'} 秒`)
  if (capability.resolution) notes.push(`分辨率：${capability.resolution}`)
  if (capability.max_total_references != null) notes.push(`参考素材合计最多 ${capability.max_total_references} 个`)
  if (capability.max_reference_video_seconds_total > 0) notes.push(`参考视频合计最长 ${capability.max_reference_video_seconds_total} 秒`)
  if (capability.roles?.image) notes.push(`图片用途：${capability.roles.image.map(role => ({ reference: '普通参考', first_frame: '首帧', last_frame: '尾帧' })[role] || role).join('、') || '目录未标注支持'}`)
  if (capability.roles?.image && item.references.some(ref => ['first_frame','last_frame'].includes(ref.role) && !capability.roles.image.includes(ref.role))) notes.push('目录未标注严格首尾帧支持；适配器会改用普通参考并补充开场／收尾提示，不保证精准锁帧。')
  return notes
}
