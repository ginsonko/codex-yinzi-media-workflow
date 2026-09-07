const EXTENSION_MEDIA_TYPES = Object.freeze({
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', avif: 'image',
  mp4: 'video', mov: 'video', m4v: 'video', webm: 'video', mkv: 'video', avi: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', flac: 'audio', weba: 'audio',
})

const COUNT_KEYS = Object.freeze({ image: 'images', video: 'videos', audio: 'audios' })
const BYTE_KEYS = Object.freeze({ image: 'max_image_bytes', video: 'max_video_bytes', audio: 'max_audio_bytes' })

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function workflowFileMediaType(file = {}) {
  const mimeType = String(file.type || file.mime_type || '').trim().toLowerCase()
  const mimeFamily = mimeType.split('/')[0]
  if (['image', 'video', 'audio'].includes(mimeFamily)) return mimeFamily
  const name = String(file.name || file.filename || file.path || '')
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  return EXTENSION_MEDIA_TYPES[extension] || 'unknown'
}

export function workflowUploadLimits(capability = {}, defaults = {}) {
  const counts = capability.limits || capability.counts || {}
  const constraints = capability.media_constraints || capability.constraints || capability
  return {
    counts: {
      image: finiteNumber(counts.images ?? capability.max_images),
      video: finiteNumber(counts.videos ?? capability.max_videos),
      audio: finiteNumber(counts.audios ?? capability.max_audios),
    },
    maxBytes: {
      image: finiteNumber(constraints.max_image_bytes ?? defaults.max_image_bytes),
      video: finiteNumber(constraints.max_video_bytes ?? defaults.max_video_bytes),
      audio: finiteNumber(constraints.max_audio_bytes ?? defaults.max_audio_bytes),
    },
    maxTotalReferences: finiteNumber(constraints.max_total_references),
    maxReferenceVideoSeconds: finiteNumber(constraints.max_reference_video_seconds_total),
    contractStatus: String(constraints.contract_status || capability.contract_status || 'unknown'),
  }
}

export async function sha256WorkflowFile(file, cryptoImpl = globalThis.crypto) {
  if (!file?.arrayBuffer) throw new Error('当前文件对象不支持内容哈希')
  if (!cryptoImpl?.subtle?.digest) throw new Error('当前运行环境不支持 SHA-256')
  const digest = await cryptoImpl.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function probeWorkflowVideoDuration(file, options = {}) {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return Promise.resolve(null)
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 12000)
  return new Promise((resolve) => {
    const video = document.createElement('video')
    const objectUrl = URL.createObjectURL(file)
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      video.removeAttribute('src')
      video.load?.()
      URL.revokeObjectURL(objectUrl)
      resolve(Number.isFinite(Number(value)) ? Number(value) : null)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    video.preload = 'metadata'
    video.onloadedmetadata = () => finish(video.duration)
    video.onerror = () => finish(null)
    video.src = objectUrl
  })
}

export async function describeWorkflowFile(file, options = {}) {
  const mediaType = workflowFileMediaType(file)
  let sha256 = null
  let hashError = null
  try {
    sha256 = await (options.hashFile || sha256WorkflowFile)(file)
  } catch (error) {
    hashError = error.message || '无法计算文件哈希'
  }
  let durationSeconds = null
  let durationError = null
  if (mediaType === 'video') {
    try {
      durationSeconds = await (options.probeVideoDuration || probeWorkflowVideoDuration)(file)
    } catch (error) {
      durationError = error.message || '无法读取视频时长'
    }
  }
  return {
    file,
    name: String(file?.name || '未命名文件'),
    size: Number(file?.size || 0),
    mimeType: String(file?.type || ''),
    mediaType,
    sha256,
    hashError,
    durationSeconds: finiteNumber(durationSeconds),
    durationError,
  }
}

export function preflightWorkflowFiles(descriptors = [], options = {}) {
  const expectedMediaType = options.expectedMediaType || null
  const limits = workflowUploadLimits(options.capability || {}, options.defaults || {})
  const currentItems = Array.isArray(options.currentItems) ? options.currentItems : []
  const allowRepeatedContent = options.allowRepeatedContent === true
  const existingHashes = new Set(currentItems.map((item) => item.sha256 || item.content_hash).filter(Boolean))
  const acceptedHashes = new Set()
  const currentCounts = { image: 0, video: 0, audio: 0 }
  let currentVideoSeconds = 0
  let existingVideoDurationUnknown = false
  for (const item of currentItems) {
    const mediaType = workflowFileMediaType(item)
    if (currentCounts[mediaType] != null) currentCounts[mediaType] += 1
    if (mediaType === 'video') {
      const duration = finiteNumber(item.duration_seconds ?? item.durationSeconds ?? item.source_duration_seconds)
      if (duration == null) existingVideoDurationUnknown = true
      else currentVideoSeconds += duration
    }
  }

  const acceptedCounts = { image: 0, video: 0, audio: 0 }
  let acceptedVideoSeconds = 0
  let acceptedTotal = 0
  const results = descriptors.map((descriptor, index) => {
    const errors = []
    const warnings = []
    const mediaType = descriptor.mediaType || workflowFileMediaType(descriptor.file || descriptor)
    if (mediaType === 'unknown') errors.push('无法识别文件类型')
    if (expectedMediaType && mediaType !== expectedMediaType) errors.push(`此处只接受${expectedMediaType === 'image' ? '图片' : expectedMediaType === 'video' ? '视频' : '音频'}文件`)
    const maxBytes = limits.maxBytes[mediaType]
    if (maxBytes != null && Number(descriptor.size || 0) > maxBytes) errors.push(`文件大小超过 ${(maxBytes / 1024 / 1024).toFixed(0)} MB 上限`)
    const hash = descriptor.sha256 || null
    if (!allowRepeatedContent && hash && (existingHashes.has(hash) || acceptedHashes.has(hash))) errors.push('相同内容已经存在，无需重复添加')
    const enforceContractLimits = options.enforceContractLimits !== false
    const countLimit = limits.counts[mediaType]
    if (enforceContractLimits && countLimit != null && currentCounts[mediaType] + acceptedCounts[mediaType] >= countLimit) errors.push('已达到当前模型的此类参考媒体数量上限')
    const maxFiles = finiteNumber(options.maxFiles)
    if (enforceContractLimits && maxFiles != null && acceptedTotal >= maxFiles) errors.push('文件数量超过当前可分配目标或剩余槽位')
    if (enforceContractLimits && limits.maxTotalReferences != null && currentItems.length + acceptedTotal >= limits.maxTotalReferences) errors.push('已达到当前模型的参考媒体总数上限')
    if (enforceContractLimits && mediaType === 'video' && limits.maxReferenceVideoSeconds != null) {
      if (descriptor.durationSeconds == null || existingVideoDurationUnknown) warnings.push('无法完整读取参考视频总时长，上传后仍会由服务端复核')
      else if (currentVideoSeconds + acceptedVideoSeconds + descriptor.durationSeconds > limits.maxReferenceVideoSeconds) {
        errors.push(`参考视频总时长超过 ${limits.maxReferenceVideoSeconds} 秒上限`)
      }
    }
    if (descriptor.hashError) warnings.push(`未能计算内容哈希：${descriptor.hashError}`)
    if (descriptor.durationError) warnings.push(`未能读取视频时长：${descriptor.durationError}`)
    if (limits.contractStatus !== 'known') warnings.push('部分模型能力尚未确认，服务端会在提交前再次校验')
    if (!errors.length) {
      acceptedCounts[mediaType] += 1
      acceptedTotal += 1
      if (hash) acceptedHashes.add(hash)
      if (mediaType === 'video' && descriptor.durationSeconds != null) acceptedVideoSeconds += descriptor.durationSeconds
    }
    return { ...descriptor, index, accepted: errors.length === 0, errors, warnings }
  })
  return { results, limits }
}

export function workflowUploadCountKey(mediaType) {
  return COUNT_KEYS[mediaType] || null
}

export function workflowUploadByteKey(mediaType) {
  return BYTE_KEYS[mediaType] || null
}
