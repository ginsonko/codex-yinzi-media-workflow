import request from '@/utils/request'

const base = '/media-supervisors'
export default {
  list(params = {}) { return request.get(base, { params }) },
  create(body) { return request.post(base, body) },
  update(id, body) { return request.put(`${base}/${encodeURIComponent(id)}`, body) },
  remove(id, revision) { return request.delete(`${base}/${encodeURIComponent(id)}`, { data: { expected_revision: revision } }) },
  restore(id, revision) { return request.post(`${base}/${encodeURIComponent(id)}/restore`, { expected_revision: revision }) },
  export(params = {}) { return request.get(`${base}/export`, { params }) },
  import(body) { return request.post(`${base}/import`, body) },
  recommend(user_goal) { return request.post(`${base}/recommend`, { user_goal }) },
  context(id) { return request.get(`/orchestration-sessions/${encodeURIComponent(id)}/supervisor`) },
  choose(id, body) { return request.put(`/orchestration-sessions/${encodeURIComponent(id)}/supervisor`, body) },
  review(id, body) { return request.post(`/orchestration-sessions/${encodeURIComponent(id)}/supervisor/reviews`, body) },
}
