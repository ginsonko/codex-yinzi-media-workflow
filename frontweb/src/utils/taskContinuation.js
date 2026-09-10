const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function codexTaskLink(session = {}) {
  const id = session.source_context?.codex_thread_id
  return typeof id === 'string' && UUID.test(id) ? `codex://threads/${id}` : null
}

export function taskContinuationPrompt(session = {}) {
  if (typeof session.id !== 'string' || !UUID.test(session.id)) return ''
  return `请继续银子媒体工作流中的原任务 ${session.id}。先通过工作流工具读取这个任务的目标、计划、素材、执行回执和检查点，恢复尚未完成的工作。沿用已保存的要求、配置和预算；复用已有素材及完成结果。已有请求的受理或结果不明确时只核对原请求，不重复提交。请说明当前实际正在做什么、下一步是什么，并持续把进展写回这个原任务。`
}
