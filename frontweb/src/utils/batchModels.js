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
      defaultForConfig: model === (models.includes(config.default_model) ? config.default_model : models[0]),
      preferred: Boolean(config.is_default) && model === (models.includes(config.default_model) ? config.default_model : models[0]),
    }))
  }).sort((a, b) => Number(b.preferred) - Number(a.preferred))
}

export function batchDefaultModelOption(options) {
  return options.find(option => option.preferred) || options.find(option => option.defaultForConfig) || options[0]
}

export function batchModelSelection(value, options, kind) {
  if (!value) value = batchDefaultModelOption(options)?.value
  if (!value) return {}
  const selected = options.find(option => option.value === value)
  // A manually entered model stays available without requiring discovery.
  if (!selected) {
    // A restored selection retains its credential even when discovery is offline.
    try {
      const pair = JSON.parse(String(value))
      if (Array.isArray(pair) && pair.length === 2 && Number.isSafeInteger(pair[0]) && pair[0] > 0 && typeof pair[1] === 'string' && pair[1].trim()) {
        return { model: pair[1], [kind === 'video' ? 'video_config_id' : 'image_config_id']: pair[0] }
      }
    } catch {}
    return { model: String(value) }
  }
  return { model: selected.model, provider: selected.provider, [kind === 'video' ? 'video_config_id' : 'image_config_id']: selected.config_id }
}
