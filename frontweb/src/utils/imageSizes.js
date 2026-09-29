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
export function usesImageSizePresets(model) {
  return /^gpt-image-2(?:\.5)?$/i.test(String(model || '').trim())
}
export function imageSizeFor(model, ratio, tier, customSize = '') {
  if (!usesImageSizePresets(model)) return String(customSize || '').trim()
  return imageSizePresets[ratio]?.[tier] || ''
}
