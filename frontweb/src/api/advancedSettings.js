import request from '@/utils/request'

export const advancedSettingsAPI = {
  summary() {
    return request.get('/settings/advanced/summary')
  },
  listPrompts() {
    return request.get('/settings/advanced/prompts')
  },
  updatePrompt(promptId, content) {
    return request.put(`/settings/advanced/prompts/${encodeURIComponent(promptId)}`, { content })
  },
  resetPrompt(promptId) {
    return request.delete(`/settings/advanced/prompts/${encodeURIComponent(promptId)}`)
  },
  exportPrompts() {
    return request.post('/settings/advanced/prompts/export')
  },
  previewPromptImport(bundle) {
    return request.post('/settings/advanced/prompts/preview-import', bundle)
  },
  applyPromptImport(bundle) {
    return request.post('/settings/advanced/prompts/apply-import', bundle)
  },
  listPrices(params = {}) {
    return request.get('/settings/advanced/prices', { params })
  },
  upsertPrice(price) {
    return request.put('/settings/advanced/prices', price)
  },
  syncYinziPrices() {
    return request.post('/settings/advanced/prices/yinzi/sync')
  },
  getBudgetDefaults() {
    return request.get('/settings/advanced/budget-defaults')
  },
  updateBudgetDefaults(budget) {
    return request.put('/settings/advanced/budget-defaults', budget)
  },
  getAutomationPreferences() {
    return request.get('/settings/advanced/automation-preferences')
  },
  updateAutomationPreferences(preferences) {
    return request.put('/settings/advanced/automation-preferences', preferences)
  },
  exportBundle(options = {}) {
    return request.post('/settings/advanced/config-bundles/export', options)
  },
  previewBundle(bundle) {
    return request.post('/settings/advanced/config-bundles/preview', bundle)
  },
  applyBundle(token) {
    return request.post('/settings/advanced/config-bundles/apply', { token })
  },
  listBackups(params = {}) {
    return request.get('/settings/advanced/backups', { params })
  },
  createBackup(body = {}) {
    return request.post('/settings/advanced/backups', body)
  },
  previewRollback(id) {
    return request.post(`/settings/advanced/backups/${id}/preview-rollback`)
  },
  rollback(id, token) {
    return request.post(`/settings/advanced/backups/${id}/rollback`, { token })
  },
}
