import request from '@/utils/request'
export const seriesGroupsAPI = {
  list(params = {}) { return request.get('/series-groups', { params }) },
  create(body = {}) { return request.post('/series-groups', body) },
  get(id) { return request.get(`/series-groups/${id}`) },
  addEpisode(id, body = {}) { return request.post(`/series-groups/${id}/episodes`, body) },
  assets(id, params = {}) { return request.get(`/series-groups/${id}/assets`, { params }) },
  upsertAsset(id, body = {}) { return request.post(`/series-groups/${id}/assets`, body) },
  reuse(id, body = {}) { return request.post(`/series-groups/${id}/reuse`, body) },
  fork(id, body = {}) { return request.post(`/series-groups/${id}/fork`, body) },
}
