const ACTIVE_SESSIONS = new Set(['draft', 'running', 'planned', 'waiting_confirmation', 'paused'])
const ACTIVE_BATCHES = new Set(['queued', 'running', 'paused', 'needs_review'])
const list = value => Array.isArray(value) ? value : []

export function selectDashboardBatch(batches = []) {
  return list(batches).find(item => ACTIVE_BATCHES.has(item.status)) || null
}

export function selectDashboardSession(sessions = [], batches = []) {
  const current = list(sessions).find(item => ACTIVE_SESSIONS.has(item.status))
  const batch = selectDashboardBatch(batches)
  if (batch && (!current || Date.parse(batch.created_at) > Date.parse(current.created_at))) return null
  return current || list(sessions).find(item => item.source_context?.analysis_report) || null
}

export function dashboardDetailTargets(sessions = [], batches = [], limit = 6) {
  const current = selectDashboardSession(sessions, batches)
  const ordered = current ? [current, ...list(sessions).filter(item => item.id !== current.id)] : list(sessions)
  return ordered.slice(0, limit)
}

export function dashboardBundle(session, bundles = []) {
  if (!session?.id) return null
  return list(bundles).find(item => item.session?.id === session.id) || null
}

export function dashboardBatchMessage(batch = {}) {
  if (batch.status === 'paused') return '后续提交已暂停，已提交的任务保留原有查询和结果记录。'
  if (batch.status === 'needs_review') return '有结果需要核对，请打开批次查看原因和恢复操作。'
  if (batch.status === 'queued') return '任务已进入队列，等待后台开始处理。'
  if (batch.status === 'running') return '后台正在处理，可离开本页；进度和结果会保留。'
  return '处理记录已保存，可打开批次查看结果。'
}
