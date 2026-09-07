import request from '@/utils/request'

export const mediaBatchAPI = {
  list(params = {}) { return request.get('/media-batches', { params, suppressGlobalError: true, timeout: 10000 }) },
  create(body) { return request.post('/media-batches', body) },
  get(id, params = {}) { return request.get('/media-batches/' + encodeURIComponent(id), { params, suppressGlobalError: true, timeout: 10000 }) },
  pause(id) { return request.post('/media-batches/' + encodeURIComponent(id) + '/pause') },
  resume(id) { return request.post('/media-batches/' + encodeURIComponent(id) + '/resume') },
  retry(id, itemId) { return request.post('/media-batches/' + encodeURIComponent(id) + '/items/' + encodeURIComponent(itemId) + '/retry') },
}
export default mediaBatchAPI
