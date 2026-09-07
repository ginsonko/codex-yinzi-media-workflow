import request from '@/utils/request'

export const aiAPI = {
  list(serviceType) {
    return request.get('/ai-configs', { params: serviceType ? { service_type: serviceType } : {} })
  },
  candidates(serviceType = 'text') {
    return request.get('/ai-configs/candidates', { params: { service_type: serviceType } })
  },
  get(id) {
    return request.get(`/ai-configs/${id}`)
  },
  getModelCapabilities(id) {
    return request.get(`/ai-configs/${id}/model-capabilities`)
  },
  updateModelCapabilities(id, body) {
    return request.put(`/ai-configs/${id}/model-capabilities`, body)
  },
  create(body) {
    return request.post('/ai-configs', body)
  },
  update(id, body) {
    return request.put(`/ai-configs/${id}`, body)
  },
  delete(id) {
    return request.delete(`/ai-configs/${id}`)
  },
  testConnection(body, options = {}) {
    return request.post('/ai-configs/test', body, {
      suppressGlobalError: options.suppressGlobalError === true,
    })
  },
  discoverModels(body, options = {}) {
    return request.post('/ai-configs/discover-models', body, {
      suppressGlobalError: options.suppressGlobalError === true,
    })
  },
  /** 即梦2角色认证：GET /api/business/v1/assets（body: base_url, api_key, limit?, cursor?） */
  listJimeng2MaterialAssets(body) {
    return request.post('/ai-configs/jimeng2-list-assets', body)
  },
  /** ModelArk 私有资产库：action + payload，见 AI 配置页 SD2 资产管理 */
  modelArkAsset(body) {
    return request.post('/ai-configs/model-ark-asset', body)
  },
  getVendorLock() {
    return request.get('/ai-configs/vendor-lock')
  },
  bulkUpdateKey(apiKey) {
    return request.put('/ai-configs/bulk-update-key', { api_key: apiKey })
  },
  getYinziCatalog() {
    return request.get('/ai-configs/yinzi/catalog')
  },
  getDistributionProfile(profile) {
    return request.get('/ai-configs/distribution-profile', {
      params: profile ? { profile } : undefined,
    })
  },
  setupYinzi(body, options = {}) {
    return request.post('/ai-configs/yinzi/setup', body, {
      suppressGlobalError: options.suppressGlobalError === true,
    })
  },
  setupImageYinzi(body, options = {}) {
    return request.post('/ai-configs/image-yinzi/setup', body, {
      suppressGlobalError: options.suppressGlobalError === true,
    })
  },
  setupLaoli(body, options = {}) {
    return request.post('/ai-configs/laoli/setup', body, {
      suppressGlobalError: options.suppressGlobalError === true,
    })
  },
  previewYinzi(body, options = {}) {
    return request.post('/ai-configs/yinzi/preview', body, {
      suppressGlobalError: options.suppressGlobalError === true,
    })
  }
}
