// Keep each model tied to its saved configuration; identical model names may
// use different sites, keys, or prices.
export function batchModelOptions(configs = []) {
  return configs.flatMap(config => {
    if (config.is_active === false || config.is_active === 0) return []
    let models = config.model
    if (typeof models === 'string') {
      try { const parsed = JSON.parse(models); models = Array.isArray(parsed) ? parsed : [models] } catch { models = [models] }
    }
    models = [...new Set([...(Array.isArray(models) ? models : []), config.default_model].filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))]
    return models.map(model => ({
      value: JSON.stringify([config.id, model]), model, config_id: config.id,
      provider: config.provider,
      label: `${model} · ${config.name || config.provider || '已保存配置'}${model === config.default_model ? '（默认）' : ''}`,
      preferred: Boolean(config.is_default) && model === config.default_model,
    }))
  }).sort((a, b) => Number(b.preferred) - Number(a.preferred))
}

export function batchModelSelection(value, options, kind) {
  if (!value) return {}
  const selected = options.find(option => option.value === value)
  // A manually entered model stays available without requiring discovery.
  if (!selected) return { model: String(value) }
  return { model: selected.model, provider: selected.provider, [kind === 'video' ? 'video_config_id' : 'image_config_id']: selected.config_id }
}
