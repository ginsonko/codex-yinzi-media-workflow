import request from '@/utils/request'
const base = '/creation-canvases'
const at = id => `${base}/${encodeURIComponent(id)}`
export const canvasAPI = {
  list: () => request.get(base),
  create: body => request.post(base, body),
  get: id => request.get(at(id), { suppressGlobalError: true }),
  configure: (id, body) => request.patch(at(id), body),
  operations: (id, body) => request.post(`${at(id)}/operations`, body),
  submit: (id, action, body) => request.post(`${at(id)}/${action}`, body),
  messages: (id, after = 0) => request.get(`${at(id)}/messages`, { params: { after, limit: 200 }, suppressGlobalError: true }),
  stop: (id, runId) => request.post(`${at(id)}/runs/${encodeURIComponent(runId)}/stop`, {}),
  control: (id, jobId, action) => request.post(`${at(id)}/jobs/${encodeURIComponent(jobId)}/${action}`, {}),
  inspect: (id, nodeId) => request.post(`${at(id)}/nodes/${encodeURIComponent(nodeId)}/inspect`, {}),
}
