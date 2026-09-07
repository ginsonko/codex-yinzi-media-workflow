import request from '@/utils/request'

export const productionAPI = {
  graph() {
    return request.get('/production-graph')
  },
  blenderCapability() {
    return request.get('/production-director/blender/capability')
  },
  renderBlenderScene(body) {
    return request.post('/production-director/blender/render', body, { timeout: 600000 })
  },
  listRuns(params = {}) {
    return request.get('/production-runs', { params })
  },
  productionMedia(params = {}) {
    return request.get('/production-media', { params })
  },
  createRun(body) {
    return request.post('/production-runs', body)
  },
  getRun(id) {
    return request.get(`/production-runs/${id}`)
  },
  costs(id, params = {}) {
    return request.get(`/production-runs/${id}/costs`, { params })
  },
  getVideoRouting(id, params = {}) {
    return request.get(`/production-runs/${id}/video-routing`, { params })
  },
  updateVideoRouting(id, body) {
    return request.patch(`/production-runs/${id}/video-routing`, body)
  },
  updateRun(id, body) {
    return request.patch(`/production-runs/${id}`, body)
  },
  preflight(id, body = {}) {
    return request.post(`/production-runs/${id}/preflight`, body)
  },
  start(id, body = {}) {
    return request.post(`/production-runs/${id}/start`, body)
  },
  advance(id, body = {}) {
    return request.post(`/production-runs/${id}/advance`, body)
  },
  rebuildFinalEdit(id, body = {}) {
    return request.post(`/production-runs/${id}/final-edit/rebuild`, body)
  },
  pause(id, body = {}) {
    return request.post(`/production-runs/${id}/pause`, body)
  },
  resume(id, body = {}) {
    return request.post(`/production-runs/${id}/resume`, body)
  },
  retry(id, body) {
    return request.post(`/production-runs/${id}/retry`, body)
  },
  reconcileAction(id, actionId, body = {}) {
    return request.post(`/production-runs/${id}/actions/${actionId}/reconcile`, body)
  },
  recoverStoryboard(id, body = {}) {
    return request.post(`/production-runs/${id}/recover-storyboard`, body)
  },
  skipDirector(id, shotId, body = {}) {
    return request.post(`/production-runs/${id}/shots/${shotId}/skip-director`, body)
  },
  disableDirector(id, body = {}) {
    return request.post(`/production-runs/${id}/director/disable`, body)
  },
  skipShot(id, shotId, body = {}) {
    return request.post(`/production-runs/${id}/shots/${shotId}/skip`, body)
  },
  restoreShot(id, shotId, body = {}) {
    return request.post(`/production-runs/${id}/shots/${shotId}/restore`, body)
  },
  reviseShot(id, shotId, body = {}) {
    return request.post(`/production-runs/${id}/shots/${shotId}/revise`, body)
  },
  splitShot(id, shotId, body = {}) {
    return request.post(`/production-runs/${id}/shots/${shotId}/split`, body)
  },
  pickupShot(id, body = {}) {
    return request.post(`/production-runs/${id}/shots/pickup`, body)
  },
  cancel(id, body = {}) {
    return request.post(`/production-runs/${id}/cancel`, body)
  },
  detach(id, body = {}) {
    return request.post(`/production-runs/${id}/detach`, body)
  },
  cancelAction(id, body = {}) {
    return request.post(`/production-runs/${id}/cancel-action`, body)
  },
  cancelLocal(id, body = {}) {
    return request.post(`/production-runs/${id}/cancel-local`, body)
  },
  cancelProvider(id, body = {}) {
    return request.post(`/production-runs/${id}/cancel-provider`, body)
  },
  transition(id, body) {
    return request.post(`/production-runs/${id}/transition`, body)
  },
  returnToStage(id, body) {
    return request.post(`/production-runs/${id}/return`, body)
  },
  clientResult(id, body) {
    return request.post(`/production-runs/${id}/client-result`, body)
  },
  listArtifacts(id, params = {}) {
    return request.get(`/production-runs/${id}/artifacts`, { params })
  },
  reusableMedia(id, params = {}) {
    return request.get(`/production-runs/${id}/reusable-media`, { params })
  },
  materializeReusableMedia(id, artifactId, body = {}) {
    return request.post(`/production-runs/${id}/reusable-media/${artifactId}/materialize`, body)
  },
  addArtifact(id, body) {
    return request.post(`/production-runs/${id}/artifacts`, body)
  },
  updateArtifact(id, body) {
    return request.patch(`/production-artifacts/${id}`, body)
  },
  reviewArtifact(id, body) {
    return request.post(`/production-artifacts/${id}/review`, body)
  },
  excludeArtifact(id, body = {}) {
    return request.post(`/production-artifacts/${id}/exclude`, body)
  },
  restoreArtifact(id, body = {}) {
    return request.post(`/production-artifacts/${id}/restore`, body)
  },
  confirmDirectClip(id, body = {}) {
    return request.post(`/production-artifacts/${id}/confirm-direct-clip`, body)
  },
  updateDirectClip(id, body = {}) {
    return request.patch(`/production-artifacts/${id}/direct-clip`, body)
  },
  suggestArtifact(id, body = {}) {
    return request.post(`/production-artifacts/${id}/suggest`, body)
  },
  assist(body) {
    return request.post('/production-assist', body)
  },
  events(id, params = {}) {
    return request.get(`/production-runs/${id}/events`, { params })
  },
  reviews(id, params = {}) {
    return request.get(`/production-runs/${id}/reviews`, { params })
  },
  actions(id, params = {}) {
    return request.get(`/production-runs/${id}/actions`, { params })
  },
  exportRun(id) {
    return request.post(`/production-runs/${id}/export`)
  },
  zipRun(id) {
    return request.post(`/production-runs/${id}/export.zip`)
  },
}
