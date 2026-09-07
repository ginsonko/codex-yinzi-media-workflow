export function resolveCreationTemplate({ routeTemplateId = '', restoredDraft = null, globalTemplateId = '' } = {}) {
  const routeValue = String(routeTemplateId || '').trim()
  if (routeValue && routeValue !== 'free') return routeValue
  if (restoredDraft && Object.prototype.hasOwnProperty.call(restoredDraft, 'templateId')) {
    const draftValue = String(restoredDraft.templateId || '').trim()
    return draftValue === 'free' ? '' : draftValue
  }
  const globalValue = String(globalTemplateId || '').trim()
  return globalValue && globalValue !== 'free' ? globalValue : ''
}
