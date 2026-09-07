export function preferredConfigModel(config = {}) {
  const preferred = String(config.default_model || '').trim()
  if (preferred) return preferred
  const models = Array.isArray(config.model) ? config.model : []
  return String(models[0] || '').trim()
}

export function buildSavedConfigTestRequest(config = {}) {
  const id = Number(config.id)
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('配置 ID 无效，请刷新配置列表后重试')
  return { config_id: id }
}

export function buildDraftConfigTestRequest(form = {}, configId = null) {
  const models = Array.isArray(form.model)
    ? form.model
    : String(form.modelText || form.model || '')
      .split(/[\n,，]/)
      .map((item) => item.trim())
      .filter(Boolean)
  const preferred = String(form.default_model || '').trim()
  const draft = {
    base_url: String(form.base_url || '').trim(),
    provider: String(form.provider || '').trim(),
    api_protocol: String(form.api_protocol || '').trim(),
    endpoint: String(form.endpoint || '').trim(),
    service_type: String(form.service_type || '').trim(),
    model: models,
    default_model: preferred || String(models[0] || '').trim(),
  }
  if (Object.hasOwn(form, 'settings')) draft.settings = form.settings
  const apiKey = String(form.api_key || '').trim()
  if (apiKey) draft.api_key = apiKey
  const id = Number(configId)
  return {
    ...(Number.isSafeInteger(id) && id > 0 ? { config_id: id } : {}),
    draft,
  }
}

export function configTestSuccessCopy(result = {}) {
  if (result.probe === 'minimal_text_response') {
    return '文本接口已正常响应；测试只请求极少文本，未生成图片、视频或音频。'
  }
  if (result.authenticated) return '连接与凭据验证成功，测试未生成图片、视频或音频。'
  return '服务地址已连通；该提供商没有可用的只读鉴权端点，因此未执行付费生成。'
}
