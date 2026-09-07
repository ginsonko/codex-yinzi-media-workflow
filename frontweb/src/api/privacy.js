import request from '@/utils/request'

export const privacyAPI = {
  list(params = {}) { return request.get('/privacy-derivations', { params }) },
  derive(body = {}) { return request.post('/privacy-derivations', body) },
  remove(id) { return request.delete(`/privacy-derivations/${id}`) },
}
