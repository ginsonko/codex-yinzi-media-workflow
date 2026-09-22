import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createResearchClient, requestKey, queryFor, platformReadyToResume, resolveResearchJob } from '../src/api/productResearch.js'

test('older deep-linked study is fetched exactly instead of replaced with newest job', async () => {
  const requested = [], old = { id: 'older', query: { product: '鞋' } }
  const client = { request: async path => { requested.push(path); return { job: old } } }
  assert.equal(await resolveResearchJob(client, [{ id: 'latest' }], 'older', true), old)
  assert.deepEqual(requested, ['/older']); assert.equal(await resolveResearchJob(client, [], null, false), null)
  assert.deepEqual(queryFor({ product: '鞋', platforms: ['douyin'], region: '', period: 'saved', savedRange: { since: '2026-01-01', until: '2026-01-20' } }), { product: '鞋', platforms: ['douyin'], since: '2026-01-01', until: '2026-01-20' })
})
test('lost-response retry reuses the same key; changed request gets a new key', async () => {
  const data = new Map(); const storage = { getItem: key => data.get(key), setItem: (k, v) => data.set(k, v) }
  const body = { product: '毛衣' }, first = await requestKey(body, storage)
  assert.equal(await requestKey(body, storage), first)
  assert.notEqual(await requestKey({ product: '鞋' }, storage), first)
  assert.ok(!data.get('yinzi-research-pending').includes('鞋'))
})
test('dates and regions remain requested filters; all dates never silently adds a period', () => {
  assert.deepEqual(queryFor({ product: ' 毛衣 ', platforms: ['douyin'], region: '', period: 'all' }), { product: '毛衣', platforms: ['douyin'] })
  const q = queryFor({ product: '毛衣', platforms: ['douyin'], region: ' 美国 ', period: '7' }, new Date('2026-09-22T01:00:00Z'))
  assert.equal(q.since, '2026-09-15'); assert.equal(q.until, '2026-09-22'); assert.equal(q.region, '美国')
})
test('client serializes data, propagates actionable server errors and aborts on unmount', async () => {
  let options
  const c = createResearchClient(async (_, init) => { options = init; return { ok: true, json: async () => ({ success: true, data: { id: 'ok' } }) } })
  assert.equal((await c.request('', 'POST', { request_key: 'stable' })).id, 'ok'); assert.equal(JSON.parse(options.body).request_key, 'stable'); assert.equal(options.credentials, 'same-origin')
  const bad = createResearchClient(async () => ({ ok: false, json: async () => ({ success: false, error: { code: 'PLATFORM_BUSY', message: '平台正在使用' } }) }))
  await assert.rejects(bad.request(), { message: '平台正在使用', code: 'PLATFORM_BUSY' })
  const slow = createResearchClient((_, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error(), { name: 'AbortError' })))))
  const pending = slow.request(); slow.dispose(); await assert.rejects(pending, /连接超时/); await assert.rejects(slow.request(), /页面已关闭/)
})

test('successful login resumes only the current blocked platform, never cancelled or active research', () => {
  const job = { state: 'needs_action', active: false, platforms: [{ id: 'douyin', status: 'verification_required' }, { id: 'bilibili', status: 'collected' }, { id: 'tiktok', status: 'rate_limited' }] }
  assert.equal(platformReadyToResume(job, 'douyin'), true)
  for (const id of ['bilibili', 'tiktok', 'youtube']) assert.equal(platformReadyToResume(job, id), false)
  assert.equal(platformReadyToResume({ ...job, active: true }, 'douyin'), false)
  assert.equal(platformReadyToResume({ ...job, state: 'cancelled' }, 'douyin'), false)
  assert.equal(platformReadyToResume(null, 'douyin'), false)
})
