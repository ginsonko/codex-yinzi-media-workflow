const TERMINAL = new Set(['succeeded', 'completed', 'partial', 'failed', 'cancelled'])
const STAGES = { analysis: '正在分析', prepare: '准备素材', create: '正在创作', edit: '正在编辑', qa: '正在验收', deliver: '正在交付' }

export function selectExecutionActivity(nodes = []) {
  const active = (Array.isArray(nodes) ? nodes : []).filter(node => node.active !== false && !TERMINAL.has(node.status) && node.status !== 'skipped')
    .sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0))
  const isUnknown = node => ['uncertain', 'ambiguous'].includes(node.progress?.submission_state) || node.progress?.state === 'provider_unknown'
  const unknown = active.filter(isUnknown)
  const backend = active.find(node => node.status === 'running' && !isUnknown(node) && ['provider_processing', 'provider_ack', 'local_task_created', 'downloading'].includes(node.progress?.state))
  return { backend, unknown, current: backend || unknown[0] || active.find(node => node.status === 'running') || null }
}

export function describeWorkActivity(session = {}, nodes = [], now = Date.now()) {
  const activity = session.source_context?.activity || {}
  const finished = TERMINAL.has(session.status)
  const timestamp = activity.updated_at || null
  const age = now - Date.parse(timestamp || '')
  const stale = !finished && (!Number.isFinite(age) || age > 90000)
  const { backend, unknown } = selectExecutionActivity(nodes)
  const base = { finished, timestamp, stale, needsUser: activity.needs_user === true, next: activity.next_action || '等待下一次进展回报', message: activity.message || '已接收需求，等待下一次进展回报' }

  if (finished) return { ...base, label: session.source_context?.intent === 'analyze' ? '分析已结束' : '任务已结束' }
  if (session.status === 'paused') return { ...base, label: '后续步骤已暂停', message: '任务已暂停，已提交的模型请求仍保留原有查询和下载记录。', next: '恢复任务后继续后续步骤' }
  if (backend) return { ...base, label: backend.progress?.state === 'downloading' ? '正在下载结果' : backend.progress?.state === 'provider_processing' ? '模型处理中' : '后台任务待回执', message: backend.progress?.message || '后台正在处理已提交任务', next: '等待原任务结果，完成后检查素材', notice: unknown.length ? `另有 ${unknown.length} 笔提交结果待核对，原记录保留，只查询原请求；它们不影响当前任务继续处理。` : null }
  if (unknown.length) return { ...base, label: '提交结果待核对', message: unknown[0].progress?.message || unknown[0].error?.message || '上游是否受理尚不明确，原请求已保留。', next: '核对原请求记录，避免重复提交' }
  if (base.needsUser) return { ...base, label: '等待补充信息' }
  if (activity.state === 'waiting') return { ...base, label: '等待中' }
  if (stale) return { ...base, label: '暂未收到新进展', message: '尚无新的执行回报，下面保留最近一次记录。', lastMessage: activity.message, next: '查看 Codex 对话的执行状态，已有任务记录和素材仍保留' }
  return { ...base, label: STAGES[activity.stage] || '正在准备' }
}
