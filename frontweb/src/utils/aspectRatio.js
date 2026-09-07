export const PRODUCTION_ASPECT_RATIOS = Object.freeze([
  Object.freeze({ value: '16:9', label: '横屏 16:9', ratio: 16 / 9, orientation: 'landscape' }),
  Object.freeze({ value: '9:16', label: '竖屏 9:16', ratio: 9 / 16, orientation: 'portrait' }),
  Object.freeze({ value: '1:1', label: '方形 1:1', ratio: 1, orientation: 'square' }),
  Object.freeze({ value: '4:3', label: '横屏 4:3', ratio: 4 / 3, orientation: 'landscape' }),
  Object.freeze({ value: '21:9', label: '超宽屏 21:9', ratio: 21 / 9, orientation: 'landscape' }),
])

const BY_VALUE = new Map(PRODUCTION_ASPECT_RATIOS.map((item) => [item.value, item]))

export function normalizeProductionAspectRatio(value, fallback = '16:9') {
  const normalized = String(value || '').trim().replace(/\uFF1A/g, ':')
  if (BY_VALUE.has(normalized)) return normalized
  return BY_VALUE.has(fallback) ? fallback : '16:9'
}

export function productionAspectSpec(value, fallback = '16:9') {
  return BY_VALUE.get(normalizeProductionAspectRatio(value, fallback))
}

export function productionAspectCss(value) {
  const spec = productionAspectSpec(value)
  return `${spec.value.replace(':', ' / ')}`
}

export function productionAspectMismatch(runValue, projectValue) {
  return normalizeProductionAspectRatio(runValue) !== normalizeProductionAspectRatio(projectValue)
}
