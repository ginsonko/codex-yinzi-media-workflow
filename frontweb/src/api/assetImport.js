import request from '@/utils/request'
export const assetImportAPI = {
  list(params = {}) { return request.get('/asset-import-sessions', { params }) },
  create(body = {}) { return request.post('/asset-import-sessions', body) },
  get(id) { return request.get(`/asset-import-sessions/${id}`) },
  upload(id, form, config = {}) { return request.post(`/asset-import-sessions/${id}/upload`, form, { ...config, headers: { ...(config.headers || {}), 'Content-Type': 'multipart/form-data' } }) },
  scan(id, body = {}, config = {}) { return request.post(`/asset-import-sessions/${id}/scan`, body, config) },
  reorganize(id, body = {}) { return request.post(`/asset-import-sessions/${id}/reorganize`, body) },
  updatePlan(id, body = {}) { return request.patch(`/asset-import-sessions/${id}/plan`, body) },
  plan(id) { return request.get(`/asset-import-sessions/${id}/plan`) },
  apply(id, body = {}) { return request.post(`/asset-import-sessions/${id}/apply`, body) },
  rollback(id) { return request.post(`/asset-import-sessions/${id}/rollback`) },
}
