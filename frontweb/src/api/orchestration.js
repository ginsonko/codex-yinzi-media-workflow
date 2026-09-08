import request from '@/utils/request'

export const orchestrationAPI = {
  preferences() { return request.get('/creative-preferences', { suppressGlobalError: true }) },
  savePreferences(body) { return request.put('/creative-preferences', body, { suppressGlobalError: true }) },
  runtimeIdentity() { return request.get('/runtime-identity', { suppressGlobalError: true, timeout: 5000 }) },
  createDesktopShortcut() { return request.post('/runtime/desktop-shortcut', {}, { timeout: 15000 }) },
  onboarding() { return request.get('/orchestration-onboarding') },
  modules(params = {}) { return request.get('/orchestration-modules', { params }) },
  registerModule(body) { return request.post('/orchestration-modules', body) },
  importModules(body) { return request.post('/orchestration-modules/import', body) },
  exportModules(params = {}) { return request.get('/orchestration-modules/export', { params }) },
  updateModule(id, body) { return request.put(`/orchestration-modules/${encodeURIComponent(id)}`, body) },
  deleteModule(id) { return request.delete(`/orchestration-modules/${encodeURIComponent(id)}`) },
  module(id) { return request.get(`/orchestration-modules/${encodeURIComponent(id)}`) },
  componentProfile() { return request.get('/media-components/profile', { suppressGlobalError: true }) },
  componentState(id) { return request.get(`/media-components/${encodeURIComponent(id)}`, { suppressGlobalError: true }) },
  ensureComponent(manifest, config = {}) { return request.post('/media-components/ensure', manifest, { ...config, timeout: config.timeout || 120000 }) },
  sessions(params = {}) { return request.get('/orchestration-sessions', { params, suppressGlobalError: true, timeout: 10000 }) },
  create(body) { return request.post('/orchestration-sessions', body) },
  // Detail reads are rendered in the workspace. Suppress the global toast so
  // a stale/cleaned task URL can show one actionable empty state instead of a
  // generic error popup that makes the whole console look blocked.
  get(id, params = {}) { return request.get(`/orchestration-sessions/${id}`, { params, suppressGlobalError: true, timeout: 10000 }) },
  update(id, body) { return request.patch(`/orchestration-sessions/${id}`, body) },
  submitPlan(id, body) { return request.put(`/orchestration-sessions/${id}/plan`, body) },
  confirm(id, body = {}) { return request.post(`/orchestration-sessions/${id}/confirm`, body) },
  start(id, body = {}) { return request.post(`/orchestration-sessions/${id}/start`, body) },
  blenderJobs(id, params = {}) { return request.get(`/orchestration-sessions/${id}/blender/jobs`, { params, suppressGlobalError: true }) },
  blenderJob(id, jobId) { return request.get(`/orchestration-sessions/${id}/blender/jobs/${jobId}`, { suppressGlobalError: true }) },
  blenderRender(id, nodeKey, body = {}) { return request.post(`/orchestration-sessions/${id}/nodes/${encodeURIComponent(nodeKey)}/blender/render`, body, { timeout: 30000 }) },
  blenderResume(id, jobId, body = {}) { return request.post(`/orchestration-sessions/${id}/blender/jobs/${jobId}/resume`, body, { timeout: 30000 }) },
  blenderCancel(id, jobId, body = {}) { return request.post(`/orchestration-sessions/${id}/blender/jobs/${jobId}/cancel`, body) },
  updateNode(id, nodeId, body) { return request.patch(`/orchestration-sessions/${id}/nodes/${nodeId}`, body) },
  retryNode(id, nodeId, body = {}) { return request.post(`/orchestration-sessions/${id}/nodes/${nodeId}/retry`, body) },
  nodeAction(id, nodeId, action, body = {}) { return request.post(`/orchestration-sessions/${id}/nodes/${nodeId}/actions/${action}`, body) },
  pause(id, body = {}) { return request.post(`/orchestration-sessions/${id}/pause`, body) },
  resume(id, body = {}) { return request.post(`/orchestration-sessions/${id}/resume`, body) },
  checkpoint(id, body = {}) { return request.post(`/orchestration-sessions/${id}/checkpoint`, body) },
  export(id) { return request.get(`/orchestration-sessions/${id}/export`) },
  recordEvent(id, body) { return request.post(`/orchestration-sessions/${id}/events`, body) },
  artifacts(id, params = {}) { return request.get(`/orchestration-sessions/${id}/artifacts`, { params, suppressGlobalError: true }) },
  delivery(id) { return request.get(`/orchestration-sessions/${id}/delivery`, { suppressGlobalError: true }) },
  feedback(id, body) { return request.post(`/orchestration-sessions/${id}/feedback`, body) },
}

export default orchestrationAPI
