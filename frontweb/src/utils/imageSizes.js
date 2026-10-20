export const imageSizePresets = {
  '1:1': { '1K': '1024x1024', '2K': '2048x2048', '4K': '2880x2880' },
  '3:2': { '1K': '1536x1024', '2K': '2160x1440', '4K': '3456x2304' },
  '16:9': { '1K': '1280x720', '2K': '2560x1440', '4K': '3840x2160' },
  '9:16': { '1K': '720x1280', '2K': '1440x2560', '4K': '2160x3840' },
  '4:3': { '1K': '1024x768', '2K': '2048x1536', '4K': '3200x2400' },
  '3:4': { '1K': '768x1024', '2K': '1536x2048', '4K': '2400x3200' },
  '21:9': { '1K': '1280x544', '2K': '2560x1088', '4K': '3840x1600' },
}

export const imageRatios = Object.keys(imageSizePresets)
export const imageTiers = ['1K', '2K', '4K']
// The sites route only these sizes for GPT Image 2 / 2.5, their variants and smart-image (backend imageSizePresets.js).
export function usesImageSizePresets(model) {
  const m = String(model || '').trim().toLowerCase().split('/').pop()
  return m === 'smart-image' || /^gpt-image-2(?:\.5)?(?:-[\w.-]+)?$/.test(m)
}
export function imageSizeFor(model, ratio, tier, customSize = '') {
  if (!usesImageSizePresets(model)) return String(customSize || '').trim()
  return imageSizePresets[ratio]?.[tier] || ''
}

const dims = size => size.split('x').map(Number)
function nearestRatio(r) {
  let best = '1:1', diff = Infinity
  for (const label of imageRatios) {
    const [w, h] = dims(imageSizePresets[label]['1K'])
    const d = Math.abs(Math.log(r) - Math.log(w / h))
    if (d < diff - 1e-9) { diff = d; best = label }
  }
  return best
}
function nearestTier(label, pixels) {
  let best = '2K', diff = Infinity
  for (const tier of imageTiers) {
    const [w, h] = dims(imageSizePresets[label][tier])
    const d = Math.abs(Math.log(pixels) - Math.log(w * h))
    if (d <= diff + 1e-9) { diff = d; best = tier }
  }
  return best
}
function parseRatio(value) {
  const m = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*[:/xX*]\s*(\d+(?:\.\d+)?)$/)
  const r = m ? Number(m[1]) / Number(m[2]) : 0
  return Number.isFinite(r) && r > 0 ? r : 0
}

// Same rule as backend imageSizePresets.snapImageSize: the preset closest to the request.
export function snapImageSize(size, aspectRatio) {
  const s = String(size || '').trim().toLowerCase().replace(/\s/g, '')
  const wh = s.match(/^(\d+)[x*×](\d+)$/)
  if (wh && Number(wh[1]) > 0 && Number(wh[2]) > 0) {
    const label = nearestRatio(Number(wh[1]) / Number(wh[2]))
    return imageSizePresets[label][nearestTier(label, Number(wh[1]) * Number(wh[2]))]
  }
  const ratio = parseRatio(aspectRatio)
  const tier = /^[124]k$/.test(s) ? s.toUpperCase() : ''
  if (!ratio && !tier) return ''
  return imageSizePresets[nearestRatio(ratio || 1)][tier || '2K']
}

/** "请求 1920×1920 → 实际提交 2048×2048" when preset snapping changes an explicit size, else ''. */
export function imageSizeSubmissionNote(model, size, aspectRatio) {
  const requested = String(size || '').trim()
  if (!requested || !usesImageSizePresets(model)) return ''
  const submitted = snapImageSize(requested, aspectRatio)
  const pretty = value => value.replace(/[x*]/gi, '×')
  if (!submitted || pretty(submitted) === pretty(requested.toLowerCase())) return ''
  return `请求 ${pretty(requested)} → 实际提交 ${pretty(submitted)}`
}
