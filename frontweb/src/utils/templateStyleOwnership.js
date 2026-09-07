export function isSystemManagedTemplateStyle(style, templates = [], baseStyle = '') {
  const value = String(style || '')
  if (!value || value === String(baseStyle || '')) return true
  return (Array.isArray(templates) ? templates : []).some((item) => value === String(item?.defaults?.style || ''))
}

export function resolveTemplateStyle({ currentStyle, targetStyle, templates = [], baseStyle = '' } = {}) {
  if (!targetStyle) return currentStyle
  return isSystemManagedTemplateStyle(currentStyle, templates, baseStyle) ? targetStyle : currentStyle
}
