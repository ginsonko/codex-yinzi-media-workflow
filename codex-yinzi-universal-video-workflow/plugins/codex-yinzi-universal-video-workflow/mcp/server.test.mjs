import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { after, before, test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverPath = path.join(here, 'server.mjs')

let apiServer
let apiBase
let state

function resetState(overrides = {}) {
  state = {
    imageSubmissions: 0,
    videoSubmissions: 0,
    patches: [],
    actions: [],
    reservedHash: null,
    publicConfig: { id: 2, service_type: 'image', provider: 'yinzi', model: ['gpt-image-2'], default_model: 'gpt-image-2', is_active: true, has_api_key: true, settings: '{}' },
    priceItems: [{ provider: 'yinzi', service_type: 'image', model: 'gpt-image-2', group_name: 'test-group', unit_price_usd: 0.07, source: 'mock-live-catalog', source_version: 'v1' }],
    imageCreate: { id: 41, task_id: 'task-41', status: 'pending' },
    generation: { id: 41, status: 'processing' },
    task: { id: 'task-41', status: 'processing' },
    videoConfig: { id: 12, service_type: 'video', provider: 'yinzi', api_protocol: 'yinzi', model: ['seedance-2.5-720p'], default_model: 'seedance-2.5-720p', endpoint: '/videos', is_active: true, has_api_key: true, settings: '{}' },
    videoCapabilities: { config_id: 12, service_type: 'video', models: [{ model: 'seedance-2.5-720p', source: 'builtin', contract_status: 'known', capability: { provider_contract: 'aizzz-video-v1', provider_create_path: '/videos', provider_query_path: '/videos/{taskId}', provider_content_path: '/videos/{taskId}/content', family: 'seedance2.5-reference', duration_mode: 'fixed', allowed_durations: [30], fixed_duration_seconds: 30, duration_min: 30, duration_max: 30, max_prompt_chars: 4000, max_images: 30, max_videos: 10, max_audios: 10, max_total_references: 50, resolution: '720p' } }] },
    modelDiscoveryCalls: [],
    structuredEvents: [],
    modelDiscovery: { snapshot_persisted: false, catalog: { video: [{ model: 'Seedance 2.5-720', endpoint_types: ['openai-video'], capabilities: { provider_contract: 'aizzz-video-v1', provider_create_path: '/videos', family: 'seedance2.5-reference', allowed_durations: [30], fixed_duration_seconds: 30, resolution: '720p' }, credential_verified: true, smart_routing_candidate: true, public_catalog: false, manual_only: false }] } },
    yinziCatalog: { source: 'https://yinziapi.top/api/pricing', pricing_version: 'video-price-v1', video: [{ model: 'Seedance 2.5-720', capabilities: { provider_contract: 'aizzz-video-v1', family: 'seedance2.5-reference', duration_mode: 'fixed', allowed_durations: [30], fixed_duration_seconds: 30, duration_min: 30, duration_max: 30, resolution: '720p' }, prices: [{ group: '限时特价即梦分组', billing_mode: 'fixed_price', billing_unit: 'per_request', effective_price: 3.5, currency: 'CNY' }] }] },
    videoCreate: { id: 51, task_id: 'task-51', provider_task_id: null, status: 'processing', generation_status: 'processing', download_status: 'pending', submission_status: 'not_sent' },
    videoGeneration: { id: 51, task_id: 'task-51', provider_task_id: 'provider-51', status: 'processing', generation_status: 'processing', download_status: 'pending', submission_status: 'accepted' },
    videoTask: { id: 'task-51', status: 'processing' },
    localVideo: Buffer.from('000000206674797069736f6d0000020069736f6d69736f3261766331', 'hex'),
    identity: { schema: 'yinzi.workflow-runtime-identity/v1', app_version: '0.1.4', source_revision: 'test-source', database: { fingerprint: 'test-db' }, orchestration_router: true, canonical: true },
    ...overrides,
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

before(async () => {
  apiServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const body = await readBody(req)
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200,{'content-type':'text/html'});return res.end('<div id="app"></div><script src="/assets/app.js"></script>') }
    if (req.method === 'GET' && url.pathname === '/assets/app.js') { res.writeHead(200,{'content-type':'application/javascript'});return res.end('export default 1') }
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { status: 'ok', app: 'mock-workflow', version: 'test' })
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/runtime-identity') {
      return json(res, 200, { success: true, data: state.identity })
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/orchestration-onboarding') {
      return json(res, 200, { success: true, data: { schema: 'yinzi.codex-video-onboarding/v1', connected: true, open_world: true, next_steps: ['在 Codex 中说需求'], active_config_counts: { text: 1, image: 1, video: 1 } } })
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/orchestration-sessions/s1/events') {
      state.structuredEvents.push(body)
      return json(res, 200, { success: true, data: { reused: state.structuredEvents.length > 1, event: { id: state.structuredEvents.length, event_type: body.event_type, payload: body.payload } } })
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/orchestration-sessions/__codex_capability_probe__/nodes/__probe__/actions/start') {
      return json(res, 404, { success: false, error: { code: 'ORCHESTRATION_NODE_NOT_FOUND', message: 'probe only' } })
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/settings/advanced/prices') {
      return json(res, 200, { success: true, data: { items: state.priceItems } })
    }
    if (req.method === 'GET' && /^\/api\/v1\/ai-configs\/\d+$/.test(url.pathname)) {
      const configId = Number(url.pathname.split('/').at(-1))
      if (configId === Number(state.publicConfig.id)) return json(res, 200, { success: true, data: state.publicConfig })
      if (configId === Number(state.videoConfig.id)) return json(res, 200, { success: true, data: state.videoConfig })
      return json(res, 404, { success: false, error: { message: '配置不存在', code: 'AI_CONFIG_NOT_FOUND' } })
    }
    if (req.method === 'GET' && /^\/api\/v1\/ai-configs\/\d+\/model-capabilities$/.test(url.pathname)) {
      const configId = Number(url.pathname.split('/').at(-2))
      if (configId === Number(state.videoConfig.id)) return json(res, 200, { success: true, data: state.videoCapabilities })
      return json(res, 404, { success: false, error: { message: '能力合同不存在', code: 'MODEL_CAPABILITIES_NOT_FOUND' } })
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/ai-configs/discover-models') {
      state.modelDiscoveryCalls.push(body)
      if (state.modelDiscoveryError) return json(res, state.modelDiscoveryError.status || 502, { success: false, error: { message: state.modelDiscoveryError.message } })
      return json(res, 200, { success: true, data: state.modelDiscovery })
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/ai-configs/yinzi/catalog') {
      return json(res, 200, { success: true, data: state.yinziCatalog })
    }
    if (req.method === 'POST' && /\/external-request$/.test(url.pathname)) {
      if (!state.reservedHash) {
        state.reservedHash = body.request_hash
        return json(res, 200, { success: true, data: { reserved: true, request_hash: body.request_hash, node: currentNode() } })
      }
      if (state.reservedHash === body.request_hash) {
        return json(res, 200, { success: true, data: { reserved: false, reused: true, reconciliation_required: true, request_hash: body.request_hash, node: currentNode() } })
      }
      return json(res, 409, { success: false, error: { message: 'external request hash conflict', code: 'REQUEST_HASH_CONFLICT' } })
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/images') {
      state.imageSubmissions += 1
      if (state.imageCreateError) return json(res, state.imageCreateError.status || 500, { success: false, error: { message: state.imageCreateError.message } })
      return json(res, 201, { success: true, data: state.imageCreate })
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/videos') {
      state.videoSubmissions += 1
      state.lastVideoBody = body
      if (state.videoCreateError) return json(res, state.videoCreateError.status || 500, { success: false, error: { message: state.videoCreateError.message } })
      return json(res, 201, { success: true, data: state.videoCreate })
    }
    if (req.method === 'PATCH' && /\/nodes\/(image|video)$/.test(url.pathname)) {
      state.patches.push(body)
      return json(res, 200, { success: true, data: { node: { ...currentNode(), ...body } } })
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/orchestration-sessions/s1') {
      return json(res, 200, { success: true, data: { nodes: [currentNode()] } })
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/images/41') {
      return json(res, 200, { success: true, data: state.generation })
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/videos') {
      return json(res, 200, { success: true, data: { items: state.videoList || [] } })
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/videos/51') {
      return json(res, 200, { success: true, data: state.videoGeneration })
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/videos/51/retry-download') {
      state.retryDownloads = (state.retryDownloads || 0) + 1
      if (state.videoAfterRetry) state.videoGeneration = state.videoAfterRetry
      return json(res, 200, { success: true, data: { video: state.videoGeneration } })
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/tasks/task-41') {
      return json(res, 200, { success: true, data: state.task })
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/tasks/task-51') {
      return json(res, 200, { success: true, data: state.videoTask })
    }
    if (req.method === 'GET' && url.pathname === '/static/media/videos/51.mp4') {
      res.writeHead(206, { 'content-type': 'video/mp4', 'content-length': state.localVideo.length })
      return res.end(state.localVideo)
    }
    if (req.method === 'POST' && /\/nodes\/(image|video)\/actions\/(complete|fail)$/.test(url.pathname)) {
      const action = url.pathname.endsWith('/complete') ? 'complete' : 'fail'
      state.actions.push({ action, body })
      return json(res, 200, { success: true, data: { node: { ...currentNode(), status: action === 'complete' ? 'succeeded' : 'failed' } } })
    }
    return json(res, 404, { success: false, error: { message: `${req.method} ${url.pathname} not mocked` } })
  })
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve))
  apiBase = `http://127.0.0.1:${apiServer.address().port}`
})

after(async () => {
  await new Promise((resolve) => apiServer.close(resolve))
})

function currentNode() {
  const last = state.patches.at(-1) || {}
  return {
    id: 'node-1',
    node_key: state.nodeKey || 'image',
    request_hash: state.reservedHash,
    progress: last.progress || (state.reservedHash ? { submission_state: 'submitting' } : {}),
    output_refs: last.output_refs || [],
    decision: last.decision || {},
  }
}

function makeClient(overrides = {}) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, YINZI_WORKFLOW_URL: apiBase, ...overrides },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let buffer = ''
  let nextId = 1
  const pending = new Map()
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n')
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      const message = JSON.parse(line)
      const waiter = pending.get(message.id)
      if (waiter) { pending.delete(message.id); waiter.resolve(message) }
    }
  })
  function request(method, params = {}) {
    const id = nextId++
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)) }, 5000)
      pending.set(id, { resolve: (message) => { clearTimeout(timer); resolve(message) } })
    })
  }
  return {
    child,
    request,
    call: async (name, args) => {
      const message = await request('tools/call', { name, arguments: args })
      const result = message.result
      return { ...result, data: JSON.parse(result.content[0].text) }
    },
    close: () => { child.stdin.end(); child.kill() },
  }
}

test('auto-discovers an orchestration-capable local instance when the default port is an older healthy API', async () => {
  resetState()
  const client = makeClient({
    YINZI_WORKFLOW_URL: '',
    YINZI_WORKFLOW_CANDIDATE_URLS: `http://127.0.0.1:1,${apiBase}`,
  })
  try {
    const result = await client.call('workflow_health', {})
    assert.equal(result.isError, false)
    assert.equal(result.data.status, 'ok')
    assert.equal(result.data.api_base, apiBase)
    assert.deepEqual(result.data.runtime_identity, state.identity)
  } finally { client.close() }
})

test('preserves an explicitly pinned URL instead of using candidate discovery', async () => {
  resetState()
  const client = makeClient({ YINZI_WORKFLOW_URL: apiBase, YINZI_WORKFLOW_CANDIDATE_URLS: 'http://127.0.0.1:1' })
  try {
    const result = await client.call('workflow_health', {})
    assert.equal(result.isError, false)
    assert.equal(result.data.status, 'ok')
    assert.equal(result.data.api_base, apiBase)
    assert.deepEqual(result.data.runtime_identity, state.identity)
  } finally { client.close() }
})

test('fails closed when candidate runtimes expose conflicting identities', async () => {
  resetState()
  const other = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok' })
    if (req.method === 'GET' && url.pathname === '/api/v1/runtime-identity') return json(res, 200, { success: true, data: { ...state.identity, source_revision: 'different-source', database: { fingerprint: 'different-db' } } })
    if (req.method === 'POST' && url.pathname.includes('/orchestration-sessions/')) return json(res, 404, { success: false, error: { code: 'ORCHESTRATION_NODE_NOT_FOUND' } })
    return json(res, 404, { success: false, error: { message: 'not mocked' } })
  })
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve))
  const otherBase = `http://127.0.0.1:${other.address().port}`
  const client = makeClient({ YINZI_WORKFLOW_URL: '', YINZI_WORKFLOW_CANDIDATE_URLS: `${otherBase},${apiBase}` })
  try {
    const result = await client.call('workflow_health', {})
    assert.equal(result.isError, true)
    assert.match(result.data.message, /多个不一致的本地工作流实例/)
    assert.match(result.data.message, /YINZI_WORKFLOW_URL/)
  } finally {
    client.close()
    await new Promise((resolve) => other.close(resolve))
  }
})

function imageArgs(overrides = {}) {
  return {
    session_id: 's1', node_key: 'image', idempotency_key: 'stable-image-v1', confirmed_paid_action: true,
    image_config_id: 2, provider: 'yinzi', model: 'gpt-image-2', group_name: 'test-group',
    prompt: 'A truthful product reference image', max_unit_price_usd: 0.07,
    ...overrides,
  }
}

function videoArgs(overrides = {}) {
  return {
    session_id: 's1', node_key: 'video', idempotency_key: 'stable-video-v1', confirmed_paid_action: true,
    video_config_id: 12, provider: 'yinzi', model: 'seedance-2.5-720p', group_name: '限时特价即梦分组',
    prompt: 'A small silver product turns slowly on a clean studio table. Keep identity and shape consistent.',
    duration: 30, aspect_ratio: '9:16', resolution: '720p', max_cost_cny: 3.5,
    ...overrides,
  }
}

test('MCP initializes and advertises the guarded image and video tools', async () => {
  resetState()
  const client = makeClient()
  try {
    const init = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    assert.equal(init.result.serverInfo.name, 'yinzi-video-workflow')
    const listed = await client.request('tools/list')
    const names = listed.result.tools.map((tool) => tool.name)
    assert.ok(names.includes('generate_image_once'))
    assert.ok(names.includes('reconcile_image'))
    assert.ok(names.includes('generate_video_once'))
    assert.ok(names.includes('reconcile_video'))
    assert.ok(names.includes('open_workflow'))
    assert.ok(names.includes('record_event'))
  } finally { client.close() }
})

test('open_workflow returns the local UI entry and record_event uses the structured event route', async () => {
  resetState()
  const client = makeClient()
  try {
    const opened = await client.call('open_workflow', {open_browser:false})
    assert.equal(opened.isError, false)
    assert.equal(opened.data.frontend_url, `${apiBase}/`)
    assert.equal(opened.data.onboarding.connected, true)
    const recorded = await client.call('record_event', { session_id: 's1', event_type: 'decision', event_idempotency_key: 'd-1', payload: { summary: '复用已有片段' } })
    assert.equal(recorded.isError, false)
    assert.equal(recorded.data.event.event_type, 'decision')
    assert.equal(state.structuredEvents.length, 1)
  } finally { client.close() }
})

test('unconfirmed paid generation is rejected before any network submission', async () => {
  resetState()
  const client = makeClient()
  try {
    const result = await client.call('generate_image_once', imageArgs({ confirmed_paid_action: false }))
    assert.equal(result.isError, true)
    assert.match(result.data.message, /confirmed_paid_action/)
    assert.equal(state.imageSubmissions, 0)
    assert.equal(state.reservedHash, null)
  } finally { client.close() }
})

test('missing live price and price above authorization both stop before reservation', async () => {
  for (const scenario of [
    { priceItems: [], expected: /没有可验证实时价格/ },
    { priceItems: [{ provider: 'yinzi', service_type: 'image', model: 'gpt-image-2', group_name: 'test-group', unit_price_usd: 0.08 }], expected: /超过本次授权上限/ },
  ]) {
    resetState({ priceItems: scenario.priceItems })
    const client = makeClient()
    try {
      const result = await client.call('generate_image_once', imageArgs())
      assert.equal(result.isError, true)
      assert.match(result.data.message, scenario.expected)
      assert.equal(state.imageSubmissions, 0)
      assert.equal(state.reservedHash, null)
    } finally { client.close() }
  }
})

test('Yinzi image uses the live CNY catalog with a dynamically selected config id', async () => {
  resetState({
    publicConfig: { id: 10, service_type: 'image', provider: 'yinzi', model: ['gpt-image-2'], default_model: 'gpt-image-2', is_active: true, has_api_key: true, settings: JSON.stringify({ group_name: '特价生图分组-1分/张' }) },
    priceItems: [],
    yinziCatalog: {
      source: 'mock-yinzi-live', pricing_version: 'image-v2',
      image: [{ model: 'gpt-image-2', prices: [
        { group: '特价生图分组-1分/张', billing_mode: 'fixed_price', billing_unit: 'per_request', effective_price: 0.01, currency: 'CNY' },
        { group: '4K绘图专用分组(按次计价不参与智能路由)', billing_mode: 'fixed_price', billing_unit: 'per_request', effective_price: 0.18, currency: 'CNY' },
      ] }],
    },
  })
  const client = makeClient()
  try {
    const result = await client.call('generate_image_once', imageArgs({
      image_config_id: 10, group_name: '特价生图分组-1分/张', max_unit_price_usd: undefined, max_unit_price_cny: 0.02,
      idempotency_key: 'live-cny-image-v2',
    }))
    assert.equal(result.isError, false)
    assert.equal(result.data.submitted, true)
    assert.equal(result.data.native_currency, 'CNY')
    assert.equal(result.data.estimated_cost_native, 0.01)
    assert.equal(result.data.pricing_source, 'mock-yinzi-live')
    assert.equal(state.imageSubmissions, 1)
    const reserveDecision = state.patches.find((item) => item.decision?.idempotency_key === 'live-cny-image-v2')
    assert.equal(reserveDecision.decision.price_ceiling_basis, 'CNY_explicit')
  } finally { client.close() }
})

test('a reachable Yinzi image catalog without the requested model never falls back to stale local prices', async () => {
  resetState({
    publicConfig: { id: 10, service_type: 'image', provider: 'yinzi', model: ['gpt-image-2'], default_model: 'gpt-image-2', is_active: true, has_api_key: true, settings: '{}' },
    priceItems: [{ provider: 'yinzi', service_type: 'image', model: 'gpt-image-2', group_name: 'stale', unit_price_usd: 0.001 }],
    yinziCatalog: { source: 'mock-yinzi-live', pricing_version: 'image-v3', image: [{ model: 'another-image-model', prices: [{ group: 'stale', billing_mode: 'fixed_price', billing_unit: 'per_request', effective_price: 0.001, currency: 'CNY' }] }] },
  })
  const client = makeClient()
  try {
    const result = await client.call('generate_image_once', imageArgs({ image_config_id: 10, group_name: '', max_unit_price_usd: 0.1, idempotency_key: 'missing-live-image-v3' }))
    assert.equal(result.isError, true)
    assert.match(result.data.message, /没有可验证实时价格/)
    assert.equal(state.imageSubmissions, 0)
    assert.equal(state.reservedHash, null)
  } finally { client.close() }
})

test('the locked public config must match provider, model, service, active state, and saved credential', async () => {
  const scenarios = [
    { patch: { provider: 'other' }, expected: /provider/ },
    { patch: { model: ['other'], default_model: 'other' }, expected: /不包含请求模型/ },
    { patch: { service_type: 'text' }, expected: /不是图片服务/ },
    { patch: { is_active: false }, expected: /未启用/ },
    { patch: { has_api_key: false }, expected: /没有已保存凭据/ },
  ]
  for (const scenario of scenarios) {
    resetState({ publicConfig: { ...state?.publicConfig, id: 2, service_type: 'image', provider: 'yinzi', model: ['gpt-image-2'], default_model: 'gpt-image-2', is_active: true, has_api_key: true, settings: '{}', ...scenario.patch } })
    const client = makeClient()
    try {
      const result = await client.call('generate_image_once', imageArgs())
      assert.equal(result.isError, true)
      assert.match(result.data.message, scenario.expected)
      assert.equal(state.imageSubmissions, 0)
      assert.equal(state.reservedHash, null)
    } finally { client.close() }
  }
})

test('an unverified config group uses the worst catalog price, never a caller-selected cheap price', async () => {
  resetState({ priceItems: [
    { provider: 'yinzi', service_type: 'image', model: 'gpt-image-2', group_name: 'cheap', unit_price_usd: 0.01, source: 'mock', source_version: 'v2' },
    { provider: 'yinzi', service_type: 'image', model: 'gpt-image-2', group_name: 'expensive', unit_price_usd: 0.25, source: 'mock', source_version: 'v2' },
  ] })
  const client = makeClient()
  try {
    const blocked = await client.call('generate_image_once', imageArgs({ group_name: 'cheap', max_unit_price_usd: 0.07 }))
    assert.equal(blocked.isError, true)
    assert.match(blocked.data.message, /0.25 USD/)
    assert.equal(state.imageSubmissions, 0)
  } finally { client.close() }

  resetState({ priceItems: [
    { provider: 'yinzi', service_type: 'image', model: 'gpt-image-2', group_name: 'cheap', unit_price_usd: 0.01, source: 'mock', source_version: 'v2' },
    { provider: 'yinzi', service_type: 'image', model: 'gpt-image-2', group_name: 'expensive', unit_price_usd: 0.25, source: 'mock', source_version: 'v2' },
  ] })
  const second = makeClient()
  try {
    const accepted = await second.call('generate_image_once', imageArgs({ group_name: 'cheap', max_unit_price_usd: 0.25 }))
    assert.equal(accepted.isError, false)
    assert.equal(accepted.data.pricing_basis, 'unverified_config_group_worst_case')
    assert.equal(accepted.data.estimated_cost_usd, 0.25)
    assert.equal(state.imageSubmissions, 1)
  } finally { second.close() }
})

test('a verified config group must match the request and its exact live price', async () => {
  resetState({
    publicConfig: { id: 2, service_type: 'image', provider: 'yinzi', model: ['gpt-image-2'], default_model: 'gpt-image-2', is_active: true, has_api_key: true, settings: JSON.stringify({ group_name: 'bound-group' }) },
    priceItems: [{ provider: 'yinzi', service_type: 'image', model: 'gpt-image-2', group_name: 'bound-group', unit_price_usd: 0.04, source: 'mock', source_version: 'v3' }],
  })
  const client = makeClient()
  try {
    const mismatch = await client.call('generate_image_once', imageArgs({ group_name: 'other-group' }))
    assert.equal(mismatch.isError, true)
    assert.match(mismatch.data.message, /分组不一致/)
    assert.equal(state.imageSubmissions, 0)
  } finally { client.close() }

  resetState({
    publicConfig: { id: 2, service_type: 'image', provider: 'yinzi', model: ['gpt-image-2'], default_model: 'gpt-image-2', is_active: true, has_api_key: true, settings: JSON.stringify({ group_name: 'bound-group' }) },
    priceItems: [{ provider: 'yinzi', service_type: 'image', model: 'gpt-image-2', group_name: 'bound-group', unit_price_usd: 0.04, source: 'mock', source_version: 'v3' }],
  })
  const second = makeClient()
  try {
    const accepted = await second.call('generate_image_once', imageArgs({ group_name: 'bound-group' }))
    assert.equal(accepted.isError, false)
    assert.equal(accepted.data.pricing_basis, 'verified_config_group')
    assert.equal(accepted.data.estimated_cost_usd, 0.04)
  } finally { second.close() }
})

test('a stable request is submitted once and a duplicate only asks for reconciliation', async () => {
  resetState()
  const client = makeClient()
  try {
    const first = await client.call('generate_image_once', imageArgs())
    assert.equal(first.isError, false)
    assert.equal(first.data.submitted, true)
    assert.equal(first.data.task_id, 'task-41')
    assert.equal(state.imageSubmissions, 1)
    const duplicate = await client.call('generate_image_once', imageArgs())
    assert.equal(duplicate.isError, false)
    assert.equal(duplicate.data.submitted, false)
    assert.equal(duplicate.data.reconciliation_required, true)
    assert.equal(state.imageSubmissions, 1)
  } finally { client.close() }
})

test('a changed request conflicts with the reserved hash and is never submitted', async () => {
  resetState()
  const client = makeClient()
  try {
    const first = await client.call('generate_image_once', imageArgs())
    assert.equal(first.isError, false)
    const conflict = await client.call('generate_image_once', imageArgs({ prompt: 'A materially changed prompt' }))
    assert.equal(conflict.isError, true)
    assert.match(conflict.data.message, /hash conflict/)
    assert.equal(state.imageSubmissions, 1)
  } finally { client.close() }
})

test('ambiguous create result remains uncertain and is not automatically resubmitted', async () => {
  resetState({ imageCreateError: { status: 504, message: 'upstream timeout' } })
  const client = makeClient()
  try {
    const first = await client.call('generate_image_once', imageArgs())
    assert.equal(first.isError, true)
    assert.equal(state.imageSubmissions, 1)
    assert.equal(state.patches.at(-1).progress.submission_state, 'uncertain')
    const duplicate = await client.call('generate_image_once', imageArgs())
    assert.equal(duplicate.isError, false)
    assert.equal(duplicate.data.submitted, false)
    assert.equal(state.imageSubmissions, 1)
  } finally { client.close() }
})

test('reconciliation preserves unresolved, pending, succeeded, and failed truth', async () => {
  resetState()
  let client = makeClient()
  try {
    const unresolved = await client.call('reconcile_image', { session_id: 's1', node_key: 'image' })
    assert.equal(unresolved.data.outcome, 'unresolved')
  } finally { client.close() }

  resetState({ reservedHash: 'known', generation: { id: 41, status: 'processing' }, task: { id: 'task-41', status: 'processing' } })
  state.patches.push({ output_refs: [{ type: 'image_generation', id: '41' }, { type: 'async_task', id: 'task-41' }] })
  client = makeClient()
  try {
    const pending = await client.call('reconcile_image', { session_id: 's1', node_key: 'image' })
    assert.equal(pending.data.outcome, 'pending')
  } finally { client.close() }

  resetState({ reservedHash: 'known', generation: { id: 41, status: 'completed', local_path: 'media/images/41.png' }, task: { id: 'task-41', status: 'completed' } })
  state.patches.push({ output_refs: [{ type: 'image_generation', id: '41' }, { type: 'async_task', id: 'task-41' }] })
  client = makeClient()
  try {
    const succeeded = await client.call('reconcile_image', { session_id: 's1', node_key: 'image' })
    assert.equal(succeeded.data.outcome, 'succeeded')
    assert.equal(state.actions.at(-1).action, 'complete')
  } finally { client.close() }

  resetState({ reservedHash: 'known', generation: { id: 41, status: 'failed', error_msg: 'provider rejected' }, task: { id: 'task-41', status: 'failed' } })
  state.patches.push({ output_refs: [{ type: 'image_generation', id: '41' }, { type: 'async_task', id: 'task-41' }] })
  client = makeClient()
  try {
    const failed = await client.call('reconcile_image', { session_id: 's1', node_key: 'image' })
    assert.equal(failed.data.outcome, 'failed')
    assert.equal(state.actions.at(-1).action, 'fail')
    assert.match(state.actions.at(-1).body.message, /provider rejected/)
  } finally { client.close() }
})

test('unconfirmed video generation and invalid locked configs stop before reservation and submission', async () => {
  const scenarios = [
    { args: { confirmed_paid_action: false }, expected: /confirmed_paid_action/ },
    { patch: { service_type: 'text' }, expected: /不是视频服务/ },
    { patch: { provider: 'other' }, expected: /provider/ },
    { patch: { model: ['other'], default_model: 'other' }, expected: /不包含请求视频模型/ },
    { patch: { is_active: false }, expected: /未启用/ },
    { patch: { has_api_key: false }, expected: /没有已保存凭据/ },
    { patch: { api_protocol: 'openai-video' }, expected: /协议不是 yinzi/ },
  ]
  for (const scenario of scenarios) {
    resetState({ nodeKey: 'video' })
    if (scenario.patch) state.videoConfig = { ...state.videoConfig, ...scenario.patch }
    const client = makeClient()
    try {
      const result = await client.call('generate_video_once', videoArgs(scenario.args))
      assert.equal(result.isError, true)
      assert.match(result.data.message, scenario.expected)
      assert.equal(state.videoSubmissions, 0)
      assert.equal(state.reservedHash, null)
    } finally { client.close() }
  }
})

test('video capability, duration, resolution, reference count, and prompt limits are enforced before paid submission', async () => {
  const scenarios = [
    { mutate: () => { state.videoCapabilities.models[0].contract_status = 'missing'; state.videoCapabilities.models[0].capability = null }, expected: /没有可验证能力合同/ },
    { args: { duration: 15 }, expected: /请求时长 15 秒不符合/ },
    { args: { resolution: '1080p' }, expected: /分辨率/ },
    { args: { reference_image_urls: Array.from({ length: 31 }, (_, index) => `https:\/\/example.invalid\/${index}.png`) }, expected: /图片数量 31/ },
    { args: { prompt: 'x'.repeat(4001) }, expected: /提示词超过/ },
  ]
  for (const scenario of scenarios) {
    resetState({ nodeKey: 'video' })
    scenario.mutate?.()
    const client = makeClient()
    try {
      const result = await client.call('generate_video_once', videoArgs(scenario.args))
      assert.equal(result.isError, true)
      assert.match(result.data.message, scenario.expected)
      assert.equal(state.videoSubmissions, 0)
      assert.equal(state.reservedHash, null)
    } finally { client.close() }
  }
})

test('video price must use a proven exact capability-family alias and remain within the CNY authorization', async () => {
  const scenarios = [
    { mutate: () => { state.yinziCatalog.video = [] }, expected: /没有与锁定模型同名或具有同一精确能力合同/ },
    { mutate: () => { state.yinziCatalog.video[0].capabilities.family = 'different-family' }, expected: /没有与锁定模型同名或具有同一精确能力合同/ },
    { mutate: () => { state.yinziCatalog.video[0].capabilities.resolution = '1080p' }, expected: /没有与锁定模型同名或具有同一精确能力合同/ },
    { mutate: () => { state.yinziCatalog.video[0].prices[0].currency = 'USD' }, expected: /没有可验证的 CNY/ },
    { mutate: () => { state.yinziCatalog.video[0].prices[0].billing_unit = 'per_minute' }, expected: /没有可验证的 CNY/ },
    { mutate: () => { state.yinziCatalog.video[0].prices[0].effective_price = 3.6 }, expected: /超过本次授权上限/ },
  ]
  for (const scenario of scenarios) {
    resetState({ nodeKey: 'video' })
    scenario.mutate?.()
    const client = makeClient()
    try {
      const result = await client.call('generate_video_once', videoArgs(scenario.args))
      assert.equal(result.isError, true)
      assert.match(result.data.message, scenario.expected)
      assert.equal(state.videoSubmissions, 0)
      assert.equal(state.reservedHash, null)
    } finally { client.close() }
  }
})

test('guarded video preflight requires a no-persist key-scoped video offer before reservation', async () => {
  const scenarios = [
    {
      mutate: () => { state.modelDiscovery.catalog.video = [] },
      expected: /当前 Key 的实时目录未发现可用视频模型/,
    },
    {
      mutate: () => { state.modelDiscovery.catalog.video[0] = { ...state.modelDiscovery.catalog.video[0], credential_verified: false, smart_routing_candidate: false, public_catalog: true, manual_only: true } },
      expected: /公开报价不代表这个 Key 已有视频权限/,
    },
    {
      mutate: () => { state.modelDiscovery.snapshot_persisted = true },
      expected: /未能证明为无副作用读取/,
    },
    {
      mutate: () => { state.modelDiscoveryError = { status: 502, message: 'credential catalog unavailable' } },
      expected: /视频模型目录读取失败.*credential catalog unavailable/,
    },
  ]
  for (const scenario of scenarios) {
    resetState({ nodeKey: 'video' })
    scenario.mutate()
    const client = makeClient()
    try {
      const result = await client.call('generate_video_once', videoArgs())
      assert.equal(result.isError, true)
      assert.match(result.data.message, scenario.expected)
      assert.equal(state.reservedHash, null)
      assert.equal(state.videoSubmissions, 0)
      assert.equal(state.modelDiscoveryCalls.length, 1)
      assert.deepEqual(state.modelDiscoveryCalls[0], { config_id: 12, service_type: 'video', persist_snapshot: false })
    } finally { client.close() }
  }
})

test('guarded video preflight accepts an exact key-scoped capability alias', async () => {
  resetState({ nodeKey: 'video' })
  state.modelDiscovery.catalog.video[0].model = 'provider-seedance-25-alias'
  const client = makeClient()
  try {
    const result = await client.call('generate_video_once', videoArgs())
    assert.equal(result.isError, false)
    assert.equal(result.data.submitted, true)
    assert.equal(state.modelDiscoveryCalls.length, 1)
    assert.equal(state.videoSubmissions, 1)
  } finally { client.close() }
})

test('an unbound smart-routing config uses the worst proven video price instead of trusting a caller-selected group', async () => {
  resetState({ nodeKey: 'video' })
  state.yinziCatalog.video[0].prices = [
    { group: 'cheap', billing_mode: 'fixed_price', billing_unit: 'per_request', effective_price: 1, currency: 'CNY' },
    { group: 'expensive', billing_mode: 'fixed_price', billing_unit: 'per_request', effective_price: 4, currency: 'CNY' },
  ]
  const client = makeClient()
  try {
    const result = await client.call('generate_video_once', videoArgs({ group_name: 'cheap', max_cost_cny: 3.5 }))
    assert.equal(result.isError, true)
    assert.match(result.data.message, /4 CNY/)
    assert.equal(state.videoSubmissions, 0)
  } finally { client.close() }
})

test('per-second video prices use worst-case duration exposure and never masquerade as per-request', async () => {
  resetState({ nodeKey: 'video' })
  state.yinziCatalog.video[0].prices[0] = { group: '限时特价即梦分组', billing_mode: 'fixed_price', billing_unit: 'per_second', effective_price: 0.12, currency: 'CNY' }
  const blocked = makeClient()
  try {
    const result = await blocked.call('generate_video_once', videoArgs({ max_cost_cny: 3.5 }))
    assert.equal(result.isError, true)
    assert.match(result.data.message, /3.5999999999999996 CNY|3.6 CNY/)
    assert.equal(state.videoSubmissions, 0)
  } finally { blocked.close() }
})

test('guarded video submission uses the locked request model, submits once, and duplicate only reconciles', async () => {
  resetState({ nodeKey: 'video' })
  const client = makeClient()
  try {
    const first = await client.call('generate_video_once', videoArgs())
    assert.equal(first.isError, false)
    assert.equal(first.data.submitted, true)
    assert.equal(first.data.generation_id, 51)
    assert.equal(first.data.task_id, 'task-51')
    assert.equal(first.data.estimated_cost_cny, 3.5)
    assert.equal(first.data.pricing_model, 'Seedance 2.5-720')
    assert.equal(state.lastVideoBody.model, 'seedance-2.5-720p')
    assert.equal(state.lastVideoBody.duration, 30)
    assert.equal(state.videoSubmissions, 1)
    const duplicate = await client.call('generate_video_once', videoArgs())
    assert.equal(duplicate.isError, false)
    assert.equal(duplicate.data.submitted, false)
    assert.equal(duplicate.data.reconciliation_required, true)
    assert.equal(state.videoSubmissions, 1)
  } finally { client.close() }
})

test('changed video request hash conflicts and an ambiguous create result is never automatically resubmitted', async () => {
  resetState({ nodeKey: 'video' })
  let client = makeClient()
  try {
    const first = await client.call('generate_video_once', videoArgs())
    assert.equal(first.isError, false)
    const conflict = await client.call('generate_video_once', videoArgs({ prompt: 'A materially changed video prompt' }))
    assert.equal(conflict.isError, true)
    assert.match(conflict.data.message, /hash conflict/)
    assert.equal(state.videoSubmissions, 1)
  } finally { client.close() }

  resetState({ nodeKey: 'video', videoCreateError: { status: 504, message: 'upstream timeout after transport' } })
  client = makeClient()
  try {
    const first = await client.call('generate_video_once', videoArgs())
    assert.equal(first.isError, true)
    assert.equal(state.videoSubmissions, 1)
    assert.equal(state.patches.at(-1).progress.submission_state, 'uncertain')
    const duplicate = await client.call('generate_video_once', videoArgs())
    assert.equal(duplicate.isError, false)
    assert.equal(duplicate.data.submitted, false)
    assert.equal(state.videoSubmissions, 1)
  } finally { client.close() }
})

test('guarded video request and receipts reject or redact secrets', async () => {
  resetState({ nodeKey: 'video' })
  const client = makeClient()
  try {
    const result = await client.call('generate_video_once', videoArgs({ prompt: 'never store sk-thisisatestcredential123456789' }))
    assert.equal(result.isError, true)
    assert.match(result.data.message, /疑似 API Key/)
    assert.doesNotMatch(JSON.stringify(result.data), /sk-thisisatestcredential/)
    assert.equal(state.videoSubmissions, 0)
  } finally { client.close() }
})

test('video reconciliation preserves unresolved, pending, provider-completed download, success, failure, and download recovery truth', async () => {
  resetState({ nodeKey: 'video' })
  let client = makeClient()
  try {
    const unresolved = await client.call('reconcile_video', { session_id: 's1', node_key: 'video' })
    assert.equal(unresolved.data.outcome, 'unresolved')
  } finally { client.close() }

  resetState({ nodeKey: 'video', reservedHash: 'known' })
  state.patches.push({ output_refs: [{ type: 'video_generation', id: '51' }, { type: 'async_task', id: 'task-51' }] })
  client = makeClient()
  try {
    const pending = await client.call('reconcile_video', { session_id: 's1', node_key: 'video' })
    assert.equal(pending.data.outcome, 'pending')
  } finally { client.close() }

  resetState({ nodeKey: 'video', reservedHash: 'known', videoGeneration: { id: 51, task_id: 'task-51', provider_task_id: 'provider-51', status: 'completed', generation_status: 'completed', download_status: 'processing', submission_status: 'accepted' }, videoTask: { id: 'task-51', status: 'processing' } })
  state.patches.push({ output_refs: [{ type: 'video_generation', id: '51' }, { type: 'async_task', id: 'task-51' }] })
  client = makeClient()
  try {
    const downloading = await client.call('reconcile_video', { session_id: 's1', node_key: 'video' })
    assert.equal(downloading.data.outcome, 'provider_completed_downloading')
    assert.equal(state.actions.length, 0)
  } finally { client.close() }

  resetState({ nodeKey: 'video', reservedHash: 'known', videoGeneration: { id: 51, task_id: 'task-51', provider_task_id: 'provider-51', status: 'completed', generation_status: 'completed', download_status: 'completed', submission_status: 'accepted', local_path: 'media/videos/51.mp4' }, videoTask: { id: 'task-51', status: 'completed' } })
  state.patches.push({ output_refs: [{ type: 'video_generation', id: '51' }, { type: 'async_task', id: 'task-51' }] })
  client = makeClient()
  try {
    const succeeded = await client.call('reconcile_video', { session_id: 's1', node_key: 'video' })
    assert.equal(succeeded.data.outcome, 'succeeded')
    assert.equal(succeeded.data.media_probe.ok, true)
    assert.equal(state.actions.at(-1).action, 'complete')
  } finally { client.close() }

  resetState({ nodeKey: 'video', reservedHash: 'known', videoGeneration: { id: 51, task_id: 'task-51', status: 'failed', generation_status: 'failed', download_status: 'pending', submission_status: 'rejected', error_msg: 'provider rejected parameters' }, videoTask: { id: 'task-51', status: 'failed', error: 'provider rejected parameters' } })
  state.patches.push({ output_refs: [{ type: 'video_generation', id: '51' }, { type: 'async_task', id: 'task-51' }] })
  client = makeClient()
  try {
    const failed = await client.call('reconcile_video', { session_id: 's1', node_key: 'video' })
    assert.equal(failed.data.outcome, 'failed')
    assert.equal(state.actions.at(-1).action, 'fail')
    assert.equal(state.actions.at(-1).body.retryable, 'true')
  } finally { client.close() }

  resetState({ nodeKey: 'video', reservedHash: 'known', videoGeneration: { id: 51, task_id: 'task-51', provider_task_id: 'provider-51', status: 'completed', generation_status: 'completed', download_status: 'failed', submission_status: 'accepted', download_error: 'disk temporarily unavailable' }, videoAfterRetry: { id: 51, task_id: 'task-51', provider_task_id: 'provider-51', status: 'completed', generation_status: 'completed', download_status: 'completed', submission_status: 'accepted', local_path: 'media/videos/51.mp4' }, videoTask: { id: 'task-51', status: 'completed' } })
  state.patches.push({ output_refs: [{ type: 'video_generation', id: '51' }, { type: 'async_task', id: 'task-51' }] })
  client = makeClient()
  try {
    const recovered = await client.call('reconcile_video', { session_id: 's1', node_key: 'video', retry_download: true })
    assert.equal(recovered.data.outcome, 'succeeded')
    assert.equal(state.retryDownloads, 1)
    assert.equal(state.videoSubmissions, 0)
  } finally { client.close() }
})

test('video reconciliation can recover the original generation by request hash without creating another task', async () => {
  resetState({ nodeKey: 'video', reservedHash: 'known', videoList: [{ id: 51, task_id: 'task-51', provider_task_id: 'provider-51', status: 'processing', generation_status: 'processing', download_status: 'pending', submission_status: 'accepted', prompt_contract: { orchestration_request_hash: 'known' } }] })
  const client = makeClient()
  try {
    const result = await client.call('reconcile_video', { session_id: 's1', node_key: 'video' })
    assert.equal(result.data.outcome, 'pending')
    assert.equal(state.patches.at(-1).progress.generation_id, 51)
    assert.equal(state.videoSubmissions, 0)
  } finally { client.close() }
})

test('video reconciliation does not mistake a recovered local record for provider acceptance', async () => {
  resetState({ nodeKey: 'video', reservedHash: 'known', videoList: [{ id: 51, task_id: 'task-51', provider_task_id: null, status: 'processing', generation_status: 'processing', download_status: 'pending', submission_status: 'not_sent', prompt_contract: { orchestration_request_hash: 'known' } }] })
  const client = makeClient()
  try {
    const result = await client.call('reconcile_video', { session_id: 's1', node_key: 'video' })
    assert.equal(result.data.outcome, 'pending')
    assert.equal(state.patches[0].progress.state, 'reconciled_record')
    assert.equal(state.patches[0].progress.submission_state, 'local_created')
    assert.match(state.patches[0].progress.message, /本地视频记录.*等待供应商受理证据/)
    assert.equal(state.videoSubmissions, 0)
  } finally { client.close() }
})

test('video reconciliation accepts a recovered record only when a provider task proves acceptance', async () => {
  resetState({ nodeKey: 'video', reservedHash: 'known', videoList: [{ id: 51, task_id: 'task-51', provider_task_id: 'provider-51', status: 'processing', generation_status: 'processing', download_status: 'pending', submission_status: 'not_sent', prompt_contract: { orchestration_request_hash: 'known' } }] })
  const client = makeClient()
  try {
    const result = await client.call('reconcile_video', { session_id: 's1', node_key: 'video' })
    assert.equal(result.data.outcome, 'pending')
    assert.equal(state.patches[0].progress.submission_state, 'accepted')
    assert.equal(state.patches[0].progress.provider_task_id, 'provider-51')
    assert.match(state.patches[0].progress.message, /供应商受理证据/)
    assert.equal(state.videoSubmissions, 0)
  } finally { client.close() }
})

test('video reconciliation preserves ambiguous provider acceptance as uncertain and never resubmits', async () => {
  resetState({ nodeKey: 'video', reservedHash: 'known', videoList: [{ id: 51, task_id: 'task-51', provider_task_id: null, status: 'processing', generation_status: 'processing', download_status: 'pending', submission_status: 'ambiguous', prompt_contract: { orchestration_request_hash: 'known' } }] })
  const client = makeClient()
  try {
    const result = await client.call('reconcile_video', { session_id: 's1', node_key: 'video' })
    assert.equal(result.data.outcome, 'unresolved')
    assert.equal(state.patches[0].progress.submission_state, 'uncertain')
    assert.match(state.patches[0].progress.message, /是否受理仍不明确/)
    assert.equal(state.videoSubmissions, 0)
  } finally { client.close() }
})
