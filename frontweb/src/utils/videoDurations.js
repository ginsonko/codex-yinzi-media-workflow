// Display-only hints for one video generation's duration. The backend's
// /ai-configs/:id/model-capabilities attaches `duration_info` to each model;
// missing data hides the hint and never blocks a submission.

export function isSmartVideoModel(model) {
  return String(model || '').trim().toLowerCase().split('/').pop() === 'smart-video'
}

export function findDurationInfo(models, model) {
  const target = String(model || '').trim().toLowerCase()
  if (!Array.isArray(models) || !target) return null
  return models.find(entry => String(entry?.model || '').trim().toLowerCase() === target)?.duration_info || null
}

export function formatDurationSupport(support, exceptSeconds) {
  return (Array.isArray(support) ? support : [])
    .filter(entry => entry.count > 0 && entry.seconds !== Number(exceptSeconds))
    .map(entry => `${entry.seconds} 秒 ${entry.count} 个`).join('、')
}

// A listed duration is exact; beyond the shortest/longest supported one there is no route; an unlisted value in between is unknown.
export function supportCountFor(support, seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || !Array.isArray(support) || !support.length) return null
  const listed = support.find(entry => entry.seconds === value)
  if (listed) return listed.count
  const available = support.filter(entry => entry.count > 0).map(entry => entry.seconds)
  if (!available.length) return 0
  return value > Math.max(...available) || value < Math.min(...available) ? 0 : null
}

function formatAllowed(info) {
  if (Array.isArray(info.durations) && info.durations.length) return `${info.durations.join(' / ')} 秒`
  if (info.duration_min != null && info.duration_max != null) return info.duration_min === info.duration_max ? `${info.duration_min} 秒` : `${info.duration_min}-${info.duration_max} 秒`
  if (info.duration_min != null) return `${info.duration_min} 秒以上`
  if (info.duration_max != null) return `${info.duration_max} 秒以内`
  return ''
}

function nearestAllowed(info, seconds) {
  if (Array.isArray(info.durations) && info.durations.length) {
    return info.durations.reduce((best, value) => {
      const d = Math.abs(value - seconds), bd = Math.abs(best - seconds)
      return d < bd || (d === bd && value > best) ? value : best
    }, info.durations[0])
  }
  return Math.min(info.duration_max ?? Infinity, Math.max(info.duration_min ?? 0, seconds))
}

/** `{ text, warning }` for the chosen duration, or null when nothing is known about the model. */
export function videoDurationHint(info, seconds, model) {
  const value = Number(seconds)
  if (!info || !Number.isFinite(value) || value <= 0) return null
  if (info.kind === 'smart' || Array.isArray(info.duration_support)) {
    const support = Array.isArray(info.duration_support) ? info.duration_support : []
    if (!support.some(entry => entry.count > 0)) return null
    const count = supportCountFor(support, value)
    const recommended = Number(info.recommended_duration)
    const advice = Number.isFinite(recommended) && recommended > 0 && recommended !== value ? `，建议 ${recommended} 秒` : ''
    const estimate = info.source === 'catalog_routes' ? '（按已保存的模型目录估算）' : ''
    if (count === 0) {
      return { warning: true, text: `当前 ${value} 秒：智能视频没有可用模型（${formatDurationSupport(support) || '暂无可用时长'}）${advice}。仍可提交，上游大概率会拒绝${estimate}` }
    }
    const others = formatDurationSupport(support, value)
    if (count === null) return { warning: false, text: `当前 ${value} 秒：智能视频可用时长 ${formatDurationSupport(support)}${advice}${estimate}` }
    return { warning: false, text: `当前 ${value} 秒：智能视频可用 ${count} 个模型${others ? `（${others}）` : ''}${advice}${estimate}` }
  }
  const allowed = formatAllowed(info)
  if (!allowed) return null
  const name = String(model || '').trim() || '当前模型'
  const accepted = Array.isArray(info.durations) && info.durations.length
    ? info.durations.includes(value)
    : (info.duration_min == null || value >= info.duration_min) && (info.duration_max == null || value <= info.duration_max)
  if (accepted) return { warning: false, text: `当前 ${value} 秒：${name} 单次生成支持 ${allowed}` }
  return { warning: true, text: `当前 ${value} 秒：${name} 单次生成只支持 ${allowed}，建议 ${nearestAllowed(info, value)} 秒。仍可提交，由上游决定` }
}
