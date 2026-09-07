export const REQUIRED_AI_SERVICES = Object.freeze([
  Object.freeze({ type: 'text', label: '文本模型', purpose: '生成剧本、资产描述和分镜脚本' }),
  Object.freeze({ type: 'image', label: '资源生图', purpose: '生成角色、场景和道具图' }),
  Object.freeze({ type: 'storyboard_image', label: '分镜生图', purpose: '生成每个镜头的参考图' }),
  Object.freeze({ type: 'video', label: '视频模型', purpose: '生成最终视频片段' }),
])

export const OPTIONAL_AI_SERVICES = Object.freeze([
  Object.freeze({ type: 'tts', label: '旁白语音', purpose: '在最终剪辑阶段合成旁白' }),
])

function hasModel(config) {
  if (String(config?.default_model || '').trim()) return true
  if (Array.isArray(config?.model)) {
    return config.model.some((model) => String(model || '').trim())
  }
  return Boolean(String(config?.model || '').trim())
}

export function isConfiguredDefault(config) {
  return Boolean(
    config
    && config.is_default
    && config.is_active !== false
    && String(config.base_url || '').trim()
    && config.has_api_key
    && hasModel(config)
  )
}

function missingReason(candidates) {
  if (!candidates.length) return '尚未添加配置'
  const enabled = candidates.filter((config) => config.is_active !== false)
  if (!enabled.length) return '配置已停用'
  const defaults = enabled.filter((config) => config.is_default)
  if (!defaults.length) return '尚未设为默认配置'
  const config = defaults[0]
  if (!String(config.base_url || '').trim()) return '缺少 Base URL'
  if (!config.has_api_key) return '缺少 API Key'
  if (!hasModel(config)) return '缺少默认模型'
  return '配置不完整'
}

function serviceState(configs, definition) {
  const candidates = configs.filter((config) => config?.service_type === definition.type)
  const config = candidates.find(isConfiguredDefault) || null
  return {
    ...definition,
    ready: Boolean(config),
    reason: config ? '已配置' : missingReason(candidates),
    config,
  }
}

export function getConfigReadiness(configs) {
  const safeConfigs = Array.isArray(configs) ? configs : []
  const required = REQUIRED_AI_SERVICES.map((definition) => serviceState(safeConfigs, definition))
  const optional = OPTIONAL_AI_SERVICES.map((definition) => serviceState(safeConfigs, definition))
  const readyCount = required.filter((item) => item.ready).length
  const missing = required.filter((item) => !item.ready)
  return {
    required,
    optional,
    readyCount,
    total: required.length,
    missing,
    isReady: missing.length === 0,
  }
}
