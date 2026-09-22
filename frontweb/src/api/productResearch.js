export function createResearchClient(fetcher = fetch, timeoutMs = 30000) {
  const controllers = new Set()
  let disposed = false
  async function request(suffix = '', method = 'GET', body) {
    if (disposed) throw new Error('研究页面已关闭')
    const controller = new AbortController()
    controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetcher('/api/v1/research/jobs' + suffix, {
        method, credentials: 'same-origin', signal: controller.signal,
        ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
      })
      const result = await response.json().catch(() => null)
      if (!response.ok || !result?.success) throw Object.assign(new Error(result?.error?.message || (response.status === 404 ? '研究接口尚未启动，请更新并重启工作流后重试。' : '暂时无法读取研究任务，请重试。')), { code: result?.error?.code })
      return result.data
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('连接超时；资料保存在本机，可刷新进度或用相同内容再次开始。')
      throw error
    } finally { clearTimeout(timeout); controllers.delete(controller) }
  }
  return { request, dispose() { disposed = true; controllers.forEach(c => c.abort()); controllers.clear() } }
}

export async function requestKey(body, storage = localStorage) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)))
  const signature = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
  let prior
  try { prior = JSON.parse(storage.getItem('yinzi-research-pending')) } catch { /* Storage may be disabled. */ }
  if (prior?.signature === signature && typeof prior.key === 'string') return prior.key
  const key = crypto.randomUUID()
  try { storage.setItem('yinzi-research-pending', JSON.stringify({ signature, key })) } catch { /* Server still retains the job. */ }
  return key
}

export function queryFor({ product, platforms, region, period, savedRange }, now = new Date()) {
  const query = { product: product.trim(), platforms, ...(region.trim() ? { region: region.trim() } : {}) }
  if (period === 'saved') {
    if (savedRange?.since) query.since = savedRange.since
    if (savedRange?.until) query.until = savedRange.until
  } else if (period !== 'all') {
    const since = new Date(now); since.setUTCDate(since.getUTCDate() - Number(period))
    query.since = since.toISOString().slice(0, 10)
    query.until = now.toISOString().slice(0, 10)
  }
  return query
}

// Deep links must remain valid after the job leaves the 50 most recent jobs.
export async function resolveResearchJob(client, items, id, restoreLatest) {
  if (id) return items.find(job => job.id === id) || (await client.request('/' + encodeURIComponent(id))).job
  return restoreLatest ? items[0] || null : null
}

export function platformReadyToResume(job, platform) {
  return Boolean(job && !job.active && !['cancelled', 'cancelling'].includes(job.state)
    && job.platforms?.some(p => p.id === platform && ['verification_required', 'access_required'].includes(p.status)))
}
