import request from '@/utils/request'

export const templatesAPI = {
  list(params = {}) { return request.get('/templates', { params }) },
  get(id) { return request.get(`/templates/${id}`) },
}
