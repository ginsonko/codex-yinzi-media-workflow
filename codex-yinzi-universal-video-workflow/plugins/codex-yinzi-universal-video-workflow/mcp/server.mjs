#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import readline from 'node:readline'
import { readRegistry, localOrigin, verifyUi, openBrowser } from '../scripts/runtime-state.mjs'

const execFileAsync = promisify(execFile)

const EXPLICIT_API_BASE = String(process.env.YINZI_WORKFLOW_URL || '').trim().replace(/\/+$/, '')
const DEFAULT_CANDIDATE_PORTS = '5683,5679,5680,5682'
const CANDIDATE_URLS = String(process.env.YINZI_WORKFLOW_CANDIDATE_URLS || '')
  .split(',')
  .map((value) => value.trim().replace(/\/+$/, ''))
  .filter(Boolean)
const API_CANDIDATES = CANDIDATE_URLS.length
  ? CANDIDATE_URLS
  : String(process.env.YINZI_WORKFLOW_CANDIDATE_PORTS || DEFAULT_CANDIDATE_PORTS)
    .split(',')
    .map((value) => value.trim())
    .filter((value) => /^\d{1,5}$/.test(value))
    .map((port) => `http://127.0.0.1:${port}`)
const DISCOVERY_PROBE_TIMEOUT_MS = Math.min(Math.max(Number(process.env.YINZI_WORKFLOW_PROBE_TIMEOUT_MS) || 1100, 250), 3000)
let activeApiBase = EXPLICIT_API_BASE || null
let apiDiscoveryPromise = null
const DEFAULT_LIMITS = Object.freeze({ max_files: 2000, max_bytes: 4 * 1024 * 1024 * 1024, max_depth: 12, hash_max_bytes: 64 * 1024 * 1024 })
const SECRET_KEYS = new Set(['api_key', 'apikey', 'authorization', 'access_token', 'refresh_token', 'password', 'secret', 'client_secret', 'credential'])
const MEDIA = new Map([
  ['.png', 'image'], ['.jpg', 'image'], ['.jpeg', 'image'], ['.webp', 'image'], ['.gif', 'image'], ['.bmp', 'image'],
  ['.mp4', 'video'], ['.mov', 'video'], ['.mkv', 'video'], ['.webm', 'video'], ['.avi', 'video'], ['.m4v', 'video'],
  ['.mp3', 'audio'], ['.wav', 'audio'], ['.m4a', 'audio'], ['.aac', 'audio'], ['.flac', 'audio'], ['.ogg', 'audio'],
  ['.txt', 'document'], ['.md', 'document'], ['.pdf', 'document'], ['.docx', 'document'], ['.csv', 'document'], ['.json', 'document'], ['.srt', 'subtitle'], ['.vtt', 'subtitle'],
])

function textResult(data, isError = false) {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }], isError }
}

function redactString(value) {
  return String(value)
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, 'Bearer ***')
}

function sanitize(value, depth = 0) {
  if (depth > 12) return '[truncated]'
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.slice(0, 3000).map((item) => sanitize(item, depth + 1))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : sanitize(item, depth + 1)]))
  }
  return String(value)
}

function rejectSecrets(value, at = '$') {
  if (typeof value === 'string' && /\bsk-[A-Za-z0-9_-]{12,}\b/.test(value)) throw new Error(`拒绝把疑似 API Key 写入编排数据：${at}`)
  if (Array.isArray(value)) return value.forEach((item, index) => rejectSecrets(item, `${at}[${index}]`))
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.has(key.toLowerCase())) throw new Error(`拒绝密钥字段：${at}.${key}`)
    rejectSecrets(item, `${at}.${key}`)
  }
}

async function readJsonResponse(request) {
  const response = await request
  const payload = await response.json().catch(() => ({}))
  return { response, payload }
}

async function probeCandidate(base, timeout = DISCOVERY_PROBE_TIMEOUT_MS) {
  const errors = []
  // A POST against a sentinel action distinguishes the orchestration router
  // from an older/other healthy API instance without creating any state: the
  // current service resolves the missing session before any write, returning
  // ORCHESTRATION_NOT_FOUND; an older service falls through to its 404 catchall.
  const [healthResult, identityResult, routeResult] = await Promise.allSettled([
    readJsonResponse(fetch(`${base}/health`, { signal: AbortSignal.timeout(timeout) })),
    readJsonResponse(fetch(`${base}/api/v1/runtime-identity`, { signal: AbortSignal.timeout(timeout) })),
    readJsonResponse(fetch(`${base}/api/v1/orchestration-sessions/__codex_capability_probe__/nodes/__probe__/actions/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(timeout),
    })),
  ])
  let identity = null
  if (healthResult.status === 'rejected') errors.push(`health ${healthResult.reason?.message || '探测失败'}`)
  else if (!healthResult.value.response.ok) errors.push(`health HTTP ${healthResult.value.response.status}`)
  else if (healthResult.value.payload?.status !== 'ok') errors.push('health 未返回 status=ok')
  if (identityResult.status === 'rejected') errors.push(`运行时身份 ${identityResult.reason?.message || '探测失败'}`)
  else {
    identity = identityResult.value.payload?.data ?? identityResult.value.payload
    if (!identityResult.value.response.ok || !identity?.schema || identity?.orchestration_router !== true) {
      errors.push(`运行时身份未通过（HTTP ${identityResult.value.response.status}）`)
    }
  }
  if (routeResult.status === 'rejected') errors.push(`编排路由探针 ${routeResult.reason?.message || '探测失败'}`)
  else if (routeResult.value.response.status !== 404 || !['ORCHESTRATION_NOT_FOUND', 'ORCHESTRATION_NODE_NOT_FOUND'].includes(routeResult.value.payload?.error?.code)) {
    errors.push(`编排路由探针未通过（HTTP ${routeResult.value.response.status}）`)
  }
  return errors.length ? { ok: false, errors } : { ok: true, identity }
}

function identityKey(identity) {
  return [identity?.schema, identity?.app_version, identity?.source_revision, identity?.database?.fingerprint, identity?.orchestration_router].map((value) => String(value ?? 'unknown')).join('|')
}

async function resolveApiBase() {
  if (activeApiBase && EXPLICIT_API_BASE) {
    if (!apiDiscoveryPromise) {
      apiDiscoveryPromise = (async () => {
        const result = await probeCandidate(activeApiBase)
        if (!result.ok) {
          const error = new Error(`指定的工作流服务不具备当前 Codex 编排能力：${JSON.stringify(result.errors)}；请重启对应后端或更换 YINZI_WORKFLOW_URL`)
          error.code = 'PINNED_RUNTIME_INCOMPATIBLE'
          error.details = { candidate: activeApiBase, errors: result.errors, hint: 'YINZI_WORKFLOW_URL' }
          throw error
        }
        return activeApiBase
      })()
    }
    return apiDiscoveryPromise
  }
  if (activeApiBase) return activeApiBase
  if (!apiDiscoveryPromise) {
    apiDiscoveryPromise = (async () => {
      const registered = await readRegistry()
      if (registered?.api_base && !CANDIDATE_URLS.length && !process.env.YINZI_WORKFLOW_CANDIDATE_PORTS) {
        const result = await probeCandidate(localOrigin(registered.api_base))
        if (result.ok && registered.database_fingerprint === result.identity?.database?.fingerprint) { activeApiBase = registered.api_base; return activeApiBase }
      }
      const results = await Promise.all(API_CANDIDATES.map(async (candidate) => ({ candidate, result: await probeCandidate(candidate) })))
      const checked = results.map(({ candidate, result }) => ({ candidate, errors: result.errors || [] }))
      const available = results
        .filter(({ result }) => result.ok)
        .map(({ candidate, result }) => ({ candidate, identity: result.identity, identity_key: identityKey(result.identity) }))
      if (!available.length) {
        const error = new Error(`未找到可用的 Codex 编排服务。已探测：${JSON.stringify(checked)}；请启动工作流后端，或设置 YINZI_WORKFLOW_URL 指向正确实例`)
        error.details = { candidates: checked, hint: 'YINZI_WORKFLOW_URL' }
        throw error
      }
      const canonical = available.filter((item) => item.identity?.canonical === true)
      const pool = canonical.length ? canonical : available
      const groups = [...new Set(pool.map((item) => item.identity_key))]
      if (groups.length > 1) {
        const error = new Error(`检测到多个不一致的本地工作流实例，已停止自动选择以避免任务分叉。请设置 YINZI_WORKFLOW_URL 固定正确实例。候选：${JSON.stringify(pool.map(({ candidate, identity }) => ({ candidate, identity })))}`)
        error.code = 'SPLIT_BRAIN_RUNTIME'
        error.details = { candidates: pool, hint: 'YINZI_WORKFLOW_URL' }
        throw error
      }
      activeApiBase = pool[0].candidate
      return activeApiBase
    })()
  }
  return apiDiscoveryPromise
}

async function api(method, route, body, timeout = 30000) {
  rejectSecrets(body)
  const base = await resolveApiBase()
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const raw = await response.text()
  let payload
  try { payload = raw ? JSON.parse(raw) : null } catch { payload = { raw: redactString(raw) } }
  if (!response.ok || payload?.success === false) {
    const detail = sanitize(payload?.error || payload || { message: response.statusText })
    const error = new Error(detail?.message || `本地工作流返回 HTTP ${response.status}`)
    error.details = { http_status: response.status, error: detail }
    throw error
  }
  return sanitize(payload?.data ?? payload)
}

async function workflowHealth() {
  const base = await resolveApiBase()
  const [health, identity] = await Promise.all([
    api('GET', '/health'),
    api('GET', '/api/v1/runtime-identity'),
  ])
  return {
    ...health,
    api_base: base,
    runtime_identity: identity,
  }
}

async function launchLocalRuntime() {
  const launcher = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'runtime-launcher.mjs')
  try {
    const { stdout } = await execFileAsync(process.execPath, [launcher, 'ensure', '--build', '--json'], {
      cwd: path.dirname(launcher),
      env: process.env,
      timeout: 240000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    })
    const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}'
    const result = JSON.parse(line)
    if (!result.ok && result.error) throw new Error(result.error)
    return result
  } catch (error) {
    const detail = error?.stderr || error?.message || String(error)
    const wrapped = new Error(`工作流界面尚未启动：${redactString(detail)}。请安装桌面包，或配置 YINZI_WORKFLOW_PROJECT_ROOT 后重试。`)
    wrapped.code = 'RUNTIME_LAUNCH_FAILED'
    wrapped.cause = error
    throw wrapped
  }
}

async function sha256File(file, size, maxBytes) {
  if (size > maxBytes) return { sha256: null, hash_status: 'skipped_size_limit' }
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  return { sha256: hash.digest('hex'), hash_status: 'complete' }
}

async function scanAssets(args) {
  const requested = Array.isArray(args.paths) ? args.paths : [args.path]
  const roots = requested.filter(Boolean).map((item) => path.resolve(String(item)))
  if (!roots.length) throw new Error('至少提供一个已获用户授权的文件或文件夹路径')
  const limits = {
    max_files: Math.min(Math.max(Number(args.max_files) || DEFAULT_LIMITS.max_files, 1), 10000),
    max_bytes: Math.min(Math.max(Number(args.max_bytes) || DEFAULT_LIMITS.max_bytes, 1), 50 * 1024 * 1024 * 1024),
    max_depth: Math.min(Math.max(Number(args.max_depth) || DEFAULT_LIMITS.max_depth, 0), 32),
    hash_max_bytes: Math.min(Math.max(Number(args.hash_max_bytes) || DEFAULT_LIMITS.hash_max_bytes, 0), 1024 * 1024 * 1024),
  }
  const files = []
  const errors = []
  let totalBytes = 0
  let truncated = false

  async function visit(target, root, depth) {
    if (truncated) return
    let info
    try { info = await stat(target) } catch (error) { errors.push({ path: redactString(target), message: error.message }); return }
    if (info.isSymbolicLink?.()) { errors.push({ path: redactString(target), message: '跳过符号链接' }); return }
    if (info.isDirectory()) {
      if (depth > limits.max_depth) { errors.push({ path: redactString(target), message: '超过目录深度上限' }); return }
      let entries
      try { entries = await readdir(target, { withFileTypes: true }) } catch (error) { errors.push({ path: redactString(target), message: error.message }); return }
      entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      for (const entry of entries) {
        if (entry.isSymbolicLink()) { errors.push({ path: redactString(path.join(target, entry.name)), message: '跳过符号链接' }); continue }
        await visit(path.join(target, entry.name), root, depth + 1)
        if (truncated) break
      }
      return
    }
    if (!info.isFile()) return
    if (files.length >= limits.max_files || totalBytes + info.size > limits.max_bytes) { truncated = true; return }
    totalBytes += info.size
    const relative = path.relative(root, target) || path.basename(target)
    const hashed = await sha256File(target, info.size, limits.hash_max_bytes)
    files.push({
      id: `sha256:${hashed.sha256 || createHash('sha256').update(`${target}\0${info.size}\0${info.mtimeMs}`).digest('hex')}`,
      relative_path: redactString(relative),
      absolute_path: args.include_absolute_paths === true ? redactString(target) : undefined,
      name: redactString(path.basename(target)),
      extension: path.extname(target).toLowerCase(),
      media_type: MEDIA.get(path.extname(target).toLowerCase()) || 'unknown',
      size_bytes: info.size,
      modified_at: info.mtime.toISOString(),
      ...hashed,
    })
  }

  for (const root of roots) await visit(root, root, 0)
  const inventory = {
    schema: 'yinzi.asset-inventory/v1',
    scanned_at: new Date().toISOString(),
    roots: roots.map((item) => args.include_absolute_paths === true ? redactString(item) : path.basename(item)),
    limits,
    outcome: truncated || errors.length ? 'partial' : 'success',
    truncated,
    file_count: files.length,
    total_bytes: totalBytes,
    by_type: Object.fromEntries([...new Set(files.map((item) => item.media_type))].map((type) => [type, files.filter((item) => item.media_type === type).length])),
    errors: errors.slice(0, 200),
    files,
  }
  if (args.session_id && args.node_key) {
    const node = await api('POST', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/nodes/${encodeURIComponent(args.node_key)}/actions/start`, {
      actor: 'codex', force: Boolean(args.force), progress: { state: 'local_started', message: '正在进行有界本地素材扫描' },
    })
    const inventoryHash = createHash('sha256').update(JSON.stringify(inventory)).digest('hex')
    const completed = await api('POST', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/nodes/${encodeURIComponent(args.node_key)}/actions/complete`, {
      actor: 'codex', partial: inventory.outcome === 'partial', message: inventory.outcome === 'partial' ? '素材扫描部分完成，存在明确上限或读取错误' : '素材扫描完成',
      output_refs: [{ type: 'asset_inventory', id: `inventory:${inventoryHash}`, sha256: inventoryHash, role: 'bounded_scan', title: `${files.length} 个文件` }],
      progress: { state: 'completed', message: `已扫描 ${files.length} 个文件`, inventory_summary: { file_count: files.length, total_bytes: totalBytes, by_type: inventory.by_type, truncated } },
      decision: { scan_limits: limits, scan_errors: errors.slice(0, 20) },
    })
    inventory.orchestration = { started_node: node.node?.id, completed_node: completed.node?.id, session_status: completed.bundle?.session?.status }
  }
  return inventory
}

const SAFE_GET = [
  /^\/api\/v1\/(production-runs|asset-import-sessions)(\/[^/?]+(?:\/(costs|video-routing|artifacts|reusable-media|events|reviews|actions))?)?(\?.*)?$/,
  /^\/api\/v1\/images\/[^/?]+(\?.*)?$/,
  /^\/api\/v1\/tasks\/[^/?]+(\?.*)?$/,
  /^\/api\/v1\/settings\/advanced\/prices(\?.*)?$/,
  /^\/api\/v1\/ai-configs(\?.*)?$/,
]
const SAFE_MUTATION = [
  /^\/api\/v1\/production-runs(?:\/[^/?]+(?:\/(?:preflight|start|advance|retry|pause|resume|detach|cancel-local|cancel-provider|final-edit\/rebuild|export|export\.zip|actions\/[^/]+\/reconcile|shots\/[^/]+\/(?:skip|restore|revise|split)))?)?$/,
  /^\/api\/v1\/asset-import-sessions(?:\/[^/?]+(?:\/(?:scan|reorganize|apply|rollback|plan))?)?$/,
  /^\/api\/v1\/images$/,
]

function assertBridgeRoute(method, route) {
  const cleanMethod = String(method || 'GET').toUpperCase()
  if (!String(route || '').startsWith('/api/v1/')) throw new Error('只允许调用本机 /api/v1 工作流接口')
  if (/ai-config|api-key|settings|prompt-overrides/i.test(route)) throw new Error('该工具不读取或修改密钥/全局配置')
  const allowed = cleanMethod === 'GET' ? SAFE_GET.some((rx) => rx.test(route)) : SAFE_MUTATION.some((rx) => rx.test(route))
  if (!allowed) throw new Error(`未开放此桥接路由：${cleanMethod} ${route}`)
  return cleanMethod
}

async function workflowBridge(args) {
  const method = assertBridgeRoute(args.method, args.path)
  if (method !== 'GET' && (!args.session_id || !args.node_key)) throw new Error('有副作用的旧工作流调用必须绑定 session_id 和 node_key')
  if (args.paid === true && args.reconcile !== true) await paidAuthorization(args)
  if (method === 'GET') return api(method, args.path, undefined, Number(args.timeout_ms) || 30000)

  const bundle = await api('GET', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}?include_inactive=true&event_limit=50`)
  const node = bundle.nodes?.find((item) => item.node_key === args.node_key || item.id === args.node_key)
  if (!node) throw new Error('找不到与旧工作流调用绑定的编排节点')
  const requestHash = createHash('sha256').update(JSON.stringify({ method, path: args.path, body: sanitize(args.body || {}), idempotency_key: args.idempotency_key || null })).digest('hex')
  const priorState = node.progress?.submission_state
  if (node.request_hash && node.request_hash === requestHash && ['submitting', 'accepted', 'uncertain', 'settled'].includes(priorState) && args.reconcile !== true) {
    throw new Error(`同一请求已经处于 ${priorState}；请查询或 reconcile 现有任务，不要重复提交`)
  }
  await api('POST', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/nodes/${encodeURIComponent(node.id)}/actions/start`, {
    actor: 'codex', force: Boolean(args.force), request_hash: requestHash,
    progress: { state: 'local_started', submission_state: 'submitting', message: '正在调用已关联的本地工作流执行器' },
    decision: { bridge_method: method, bridge_path: args.path, paid: Boolean(args.paid), idempotency_key: args.idempotency_key || null },
  })
  try {
    const result = await api(method, args.path, args.body || {}, Number(args.timeout_ms) || 120000)
    const correlation = result?.task_id || result?.id || result?.run?.id || result?.session?.id || null
    const updated = await api('PATCH', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/nodes/${encodeURIComponent(node.id)}`, {
      actor: 'codex', request_hash: requestHash,
      progress: { state: 'provider_ack', submission_state: correlation ? 'accepted' : 'settled', message: correlation ? '本地执行器已返回任务标识' : '本地执行器已完成同步响应', correlation_id: correlation },
      output_refs: correlation ? [{ type: 'workflow_result', id: String(correlation), role: 'executor_receipt' }] : [],
      decision: { bridge_method: method, bridge_path: args.path, paid: Boolean(args.paid), response_summary: sanitize(result) },
    })
    return { request_hash: requestHash, correlation_id: correlation, result, node: updated.node }
  } catch (error) {
    await api('PATCH', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/nodes/${encodeURIComponent(node.id)}`, {
      actor: 'codex', request_hash: requestHash,
      progress: { state: 'provider_unknown', submission_state: 'uncertain', message: '调用未得到可确认结果；先查询恢复，不要直接重发' },
      error: { code: 'BRIDGE_RESULT_UNCERTAIN', message: error.message, retryable: 'unknown', next_actions: ['reconcile', 'inspect', 'manual'] },
    })
    throw error
  }
}

function parseSettings(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try { return JSON.parse(String(value)) } catch { return {} }
}

function exactModelName(value) {
  return String(value || '').trim().toLowerCase()
}

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function capabilityAllowsDuration(capability, requestedDuration) {
  const duration = finiteNumber(requestedDuration)
  if (duration == null || duration <= 0) return false
  const allowed = Array.isArray(capability?.allowed_durations)
    ? capability.allowed_durations.map(Number).filter(Number.isFinite)
    : []
  if (allowed.length) return allowed.includes(duration)
  if (capability?.duration_mode === 'fixed') {
    return duration === Number(capability.fixed_duration_seconds ?? capability.duration_min)
  }
  const minimum = finiteNumber(capability?.duration_min)
  const maximum = finiteNumber(capability?.duration_max)
  if (minimum != null && duration < minimum) return false
  if (maximum != null && duration > maximum) return false
  return minimum != null || maximum != null
}

function sameProvenVideoOffer(requestedModel, capability, catalogItem) {
  if (exactModelName(catalogItem?.model) === exactModelName(requestedModel)) return true
  const offered = catalogItem?.capabilities
  if (!capability?.family || !offered?.family || capability.family !== offered.family) return false
  if (String(capability.resolution || '') !== String(offered.resolution || '')) return false
  if (String(capability.provider_contract || '') !== String(offered.provider_contract || '')) return false
  const requestedAllowed = Array.isArray(capability.allowed_durations) ? capability.allowed_durations.map(Number).sort((a, b) => a - b) : []
  const offeredAllowed = Array.isArray(offered.allowed_durations) ? offered.allowed_durations.map(Number).sort((a, b) => a - b) : []
  return JSON.stringify(requestedAllowed) === JSON.stringify(offeredAllowed)
    && Number(capability.fixed_duration_seconds || 0) === Number(offered.fixed_duration_seconds || 0)
}

async function paidAuthorization(args) {
  if (!args.idempotency_key) throw new Error('付费调用需要稳定 idempotency_key')
  const preferences = await api('GET', '/api/v1/creative-preferences')
  if (args.confirmed_paid_action !== true && preferences?.unattended_mode !== true) throw new Error('请依据已有用户授权设置 confirmed_paid_action=true，或由用户开启挂机模式')
  return { unattended: preferences?.unattended_mode === true, source: preferences?.unattended_mode === true ? 'unattended_mode' : 'existing_user_authorization' }
}

function priceExposureCny(price, duration) {
  const unitPrice = finiteNumber(price?.effective_price)
  if (unitPrice == null || unitPrice < 0) return null
  const unit = String(price?.billing_unit || '').trim().toLowerCase()
  if (unit === 'per_request' || unit === 'fixed_duration') return unitPrice
  if (unit === 'per_second') return unitPrice * Number(duration)
  return null
}

function mergeOutputRefs(existing = [], additions = []) {
  const merged = []
  const seen = new Set()
  for (const item of [...existing, ...additions]) {
    if (!item || item.id == null || !item.type) continue
    const key = `${item.type}:${item.id}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(item)
  }
  return merged
}

async function loadGuardedVideoContract(args, video, authorization) {
  const publicConfig = await api('GET', `/api/v1/ai-configs/${encodeURIComponent(video.video_config_id)}`)
  const configuredModels = Array.isArray(publicConfig?.model)
    ? publicConfig.model.map(String)
    : [publicConfig?.model].filter(Boolean).map(String)
  const publicModels = [...configuredModels, String(publicConfig?.default_model || '')].filter(Boolean)
  if (String(publicConfig?.service_type || '') !== 'video') throw new Error('锁定配置不是视频服务，已在付费提交前停止')
  if (String(publicConfig?.provider || '') !== video.provider) throw new Error('锁定配置的 provider 与请求不一致，已在付费提交前停止')
  if (!publicModels.some((item) => exactModelName(item) === exactModelName(video.model))) throw new Error('锁定配置不包含请求视频模型，已在付费提交前停止')
  if (publicConfig?.is_active === false || publicConfig?.is_enabled === false) throw new Error('锁定视频配置当前未启用，已在付费提交前停止')
  if (publicConfig?.has_api_key !== true) throw new Error('锁定视频配置没有已保存凭据，已在付费提交前停止')
  const diagnostics = []
  const capabilityStates = await api('GET', `/api/v1/ai-configs/${encodeURIComponent(video.video_config_id)}/model-capabilities`).catch(error => {
    diagnostics.push({ source: 'capabilities', message: error.message }); return {}
  })
  const state = (Array.isArray(capabilityStates?.models) ? capabilityStates.models : [])
    .find((item) => exactModelName(item.model) === exactModelName(video.model))
  const capability = state?.capability || {}
  if (!state?.capability) diagnostics.push({ source: 'capabilities', message: '模型能力尚未登记，使用指定模型和请求参数' })
  if (video.contract_validation_mode === 'strict' && state?.capability) {
  if (!capabilityAllowsDuration(capability, video.duration)) {
    const allowed = capability.allowed_durations?.length
      ? capability.allowed_durations.join('/')
      : capability.duration_mode === 'fixed'
        ? String(capability.fixed_duration_seconds || capability.duration_min)
        : `${capability.duration_min ?? '?'}-${capability.duration_max ?? '?'}`
    throw new Error(`请求时长 ${video.duration} 秒不符合锁定能力合同（允许 ${allowed} 秒），未提交`)
  }
  if (capability.provider_create_path && capability.provider_create_path !== '/videos') throw new Error('能力合同的创建路径不是 /videos，已在付费提交前停止')
  if (video.resolution && capability.resolution && String(video.resolution).toLowerCase() !== String(capability.resolution).toLowerCase()) throw new Error('请求分辨率与锁定能力合同不一致，已在付费提交前停止')
  if (capability.max_prompt_chars && video.prompt.length > Number(capability.max_prompt_chars)) throw new Error(`视频提示词超过模型合同上限 ${capability.max_prompt_chars} 字符，未提交`)

  const imageCount = (video.image_url ? 1 : 0) + (video.first_frame_url ? 1 : 0) + (video.last_frame_url ? 1 : 0) + (video.reference_image_urls?.length || 0)
  const videoCount = video.reference_video_urls?.length || 0
  const audioCount = video.reference_audio_urls?.length || 0
  const totalCount = imageCount + videoCount + audioCount
  for (const [label, actual, maximum] of [
    ['图片', imageCount, capability.max_images], ['参考视频', videoCount, capability.max_videos], ['参考音频', audioCount, capability.max_audios], ['全部参考素材', totalCount, capability.max_total_references],
  ]) {
    if (finiteNumber(maximum) != null && actual > Number(maximum)) throw new Error(`${label}数量 ${actual} 超过锁定能力合同上限 ${maximum}，未提交`)
  }

  }

  // Public prices inform the estimate; they do not establish or deny Key access.
  const catalog = video.provider === 'yinzi' ? await api('GET', '/api/v1/ai-configs/yinzi/catalog', undefined, Number(args.catalog_timeout_ms) || 30000).catch(error => {
    diagnostics.push({ source: 'pricing', message: error.message }); return {}
  }) : {}
  const hasCeiling = args.max_cost_cny != null
  if (hasCeiling && (typeof args.max_cost_cny !== 'number' || !Number.isFinite(args.max_cost_cny) || args.max_cost_cny < 0)) throw new Error('max_cost_cny 必须是非负有限数字')
  if (!hasCeiling && !authorization.unattended) throw new Error('请提供已授权的 max_cost_cny，或在用户授权自主花费后开启挂机模式')
  const offeredModels = (Array.isArray(catalog?.video) ? catalog.video : []).filter((item) => sameProvenVideoOffer(video.model, capability, item))
  if (!offeredModels.length && hasCeiling) throw new Error('当前实时目录中没有与锁定模型同名或具有同一精确能力合同的价格项，无法核对指定预算，未提交')
  const requestedGroup = String(args.group_name || '').trim()
  const prices = offeredModels.flatMap((item) => (Array.isArray(item.prices) ? item.prices : []).map((price) => ({ ...price, catalog_model: item.model })))
    .filter((price) => String(price.currency || '').toUpperCase() === 'CNY' && priceExposureCny(price, video.duration) != null)
  const settings = parseSettings(publicConfig?.settings)
  const configuredGroup = String(settings.group_name || settings.group || publicConfig?.group_name || '').trim()
  if (configuredGroup && requestedGroup && configuredGroup !== requestedGroup) throw new Error('请求分组与锁定配置中可验证的分组不一致，已在付费提交前停止')
  const matching = configuredGroup ? prices.filter((price) => String(price.group || '') === configuredGroup) : prices
  if (!matching.length && hasCeiling) throw new Error(configuredGroup ? '锁定配置分组没有可验证的当前 CNY 视频价格，无法核对指定预算' : '当前锁定视频模型没有可验证的 CNY 价格，无法核对指定预算')
  const selectedPrice = matching.length ? matching.reduce((highest, price) => priceExposureCny(price, video.duration) > priceExposureCny(highest, video.duration) ? price : highest) : {}
  const estimatedCostCny = priceExposureCny(selectedPrice, video.duration)
  if (hasCeiling && estimatedCostCny > args.max_cost_cny) throw new Error(`当前最坏成本 ${estimatedCostCny} CNY 超过本次授权上限 ${args.max_cost_cny} CNY，未提交`)
  return {
    publicConfig, capability, capabilityState: state || { source: 'unknown', contract_status: 'unknown' }, diagnostics, catalog, selectedPrice, estimatedCostCny,
    configuredGroup: configuredGroup || null, requestedGroup: requestedGroup || null,
    catalogModels: [...new Set(matching.map((item) => item.catalog_model))],
  }
}

async function generateVideo(args) {
  if (!args.session_id || !args.node_key) throw new Error('视频生成必须绑定 session_id 和 node_key')
  if (!args.idempotency_key) throw new Error('视频生成需要稳定 idempotency_key')
  const video = {
    prompt: String(args.prompt || '').trim(), model: String(args.model || '').trim(), provider: String(args.provider || '').trim(),
    video_config_id: Number(args.video_config_id), drama_id: Number(args.drama_id) || 0,
    storyboard_id: args.storyboard_id == null ? undefined : Number(args.storyboard_id),
    duration: Number(args.duration), aspect_ratio: args.aspect_ratio || undefined, resolution: args.resolution || undefined,
    image_url: args.image_url || undefined, first_frame_url: args.first_frame_url || undefined, last_frame_url: args.last_frame_url || undefined,
    reference_image_urls: Array.isArray(args.reference_image_urls) ? args.reference_image_urls : undefined,
    reference_video_urls: Array.isArray(args.reference_video_urls) ? args.reference_video_urls : undefined,
    reference_audio_urls: Array.isArray(args.reference_audio_urls) ? args.reference_audio_urls : undefined,
    camera_fixed: args.camera_fixed == null ? undefined : Boolean(args.camera_fixed),
    watermark: args.watermark == null ? false : Boolean(args.watermark),
    contract_validation_mode: args.contract_validation_mode || 'advisory',
  }
  if (!video.prompt) throw new Error('视频生成缺少 prompt')
  if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('视频时长必须为正数')
  if (!video.model || !video.provider || !Number.isInteger(video.video_config_id) || video.video_config_id <= 0) throw new Error('视频生成必须锁定 model、provider 和 video_config_id，避免改配置后仍误用旧模型')
  rejectSecrets(video)
  const requestHash = createHash('sha256').update(JSON.stringify(sanitize({ video, idempotency_key: args.idempotency_key }))).digest('hex')
  const existingBundle = await api('GET', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}?include_inactive=true&event_limit=50`)
  const existingNode = existingBundle.nodes?.find((item) => item.node_key === args.node_key || item.id === args.node_key)
  if (!existingNode) throw new Error('找不到视频生成编排节点')
  if (existingNode.request_hash === requestHash) {
    return { submitted: false, reused: true, reconciliation_required: true, request_hash: requestHash, node: existingNode }
  }
  const authorization = await paidAuthorization(args)
  const contract = await loadGuardedVideoContract(args, video, authorization)
  video.prompt_contract = {
    ...(args.prompt_contract && typeof args.prompt_contract === 'object' ? sanitize(args.prompt_contract) : {}),
    schema: 'yinzi.codex-video-request/v1', orchestration_request_hash: requestHash,
  }
  const pricingSnapshot = sanitize({
    source: contract.catalog.source, pricing_version: contract.catalog.pricing_version, catalog_models: contract.catalogModels,
    price: contract.selectedPrice, estimated_cost_cny: contract.estimatedCostCny,
  })
  const capabilitySnapshot = sanitize({ source: contract.capabilityState.source, contract_status: contract.capabilityState.contract_status, capability: contract.capability })
  const reserve = await api('POST', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/nodes/${encodeURIComponent(args.node_key)}/external-request`, {
    actor: 'codex', request_hash: requestHash, message: '正在提交一次受预算和幂等保护的视频生成请求',
    progress: { state: 'local_started', submission_state: 'submitting', message: '已锁定配置、模型、能力、价格和请求哈希；正在创建本地视频任务' },
    decision: {
      paid: true, idempotency_key: args.idempotency_key, provider: video.provider, model: video.model, video_config_id: video.video_config_id,
      configured_group: contract.configuredGroup, requested_group: contract.requestedGroup, pricing_snapshot: pricingSnapshot,
      capability_snapshot: capabilitySnapshot, authorization_source: authorization.source, diagnostics: contract.diagnostics, maximum_cost_cny: args.max_cost_cny ?? null, request: sanitize(video),
    },
  })
  if (!reserve.reserved) return { submitted: false, reused: true, reconciliation_required: true, request_hash: requestHash, node: reserve.node }
  try {
    const result = await api('POST', '/api/v1/videos', video, Number(args.timeout_ms) || 30000)
    const taskId = result?.task_id || null
    const generationId = result?.id || null
    const providerTaskId = result?.provider_task_id || null
    const providerSubmissionStatus = String(result?.submission_status || 'not_sent').toLowerCase()
    const submissionState = providerTaskId || providerSubmissionStatus === 'accepted'
      ? 'accepted'
      : providerSubmissionStatus === 'ambiguous'
        ? 'uncertain'
        : 'submitting'
    const outputRefs = mergeOutputRefs(reserve.node?.output_refs || [], [
      ...(generationId ? [{ type: 'video_generation', id: String(generationId), role: 'generation_record' }] : []),
      ...(taskId ? [{ type: 'async_task', id: String(taskId), role: 'local_task' }] : []),
      ...(providerTaskId ? [{ type: 'provider_video_task', id: String(providerTaskId), role: 'provider_task' }] : []),
    ])
    const updated = await api('PATCH', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/nodes/${encodeURIComponent(args.node_key)}`, {
      actor: 'codex', request_hash: requestHash, output_refs: outputRefs,
      progress: {
        state: 'local_task_created', submission_state: submissionState, message: generationId
          ? '本地视频任务已创建；供应商是否受理、生成和下载状态将分别对账'
          : '本地创建响应缺少 generation_id；按请求哈希查询对账，禁止重发',
        correlation_id: taskId, generation_id: generationId, provider_task_id: providerTaskId,
        provider_submission_status: providerSubmissionStatus,
      },
      decision: {
        ...(reserve.node?.decision || {}), paid: true, idempotency_key: args.idempotency_key, provider: video.provider, model: video.model,
        video_config_id: video.video_config_id, configured_group: contract.configuredGroup, requested_group: contract.requestedGroup,
        pricing_snapshot: pricingSnapshot, capability_snapshot: capabilitySnapshot, authorization_source: authorization.source, diagnostics: contract.diagnostics, maximum_cost_cny: args.max_cost_cny ?? null, request: sanitize(video), response_summary: sanitize(result),
      },
    })
    return {
      submitted: true, request_hash: requestHash, generation_id: generationId, task_id: taskId, provider_task_id: providerTaskId,
      provider_submission_status: providerSubmissionStatus, estimated_cost_cny: contract.estimatedCostCny,
      pricing_source: contract.catalog.source, pricing_version: contract.catalog.pricing_version,
      pricing_model: contract.selectedPrice.catalog_model, pricing_group: contract.selectedPrice.group,
      node: updated.node,
    }
  } catch (error) {
    await api('PATCH', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/nodes/${encodeURIComponent(args.node_key)}`, {
      actor: 'codex', request_hash: requestHash,
      progress: { state: 'provider_unknown', submission_state: 'uncertain', message: '视频创建响应不明确；只按请求哈希查询现有记录，禁止直接重发' },
      error: { code: 'VIDEO_CREATE_AMBIGUOUS', message: error.message, retryable: 'unknown', next_actions: ['reconcile_video', 'inspect', 'manual'] },
    })
    throw error
  }
}

async function findVideoByRequestHash(requestHash) {
  if (!requestHash) return null
  for (let page = 1; page <= 10; page += 1) {
    const listing = await api('GET', `/api/v1/videos?page=${page}&page_size=100`)
    const items = Array.isArray(listing?.items) ? listing.items : Array.isArray(listing) ? listing : []
    const found = items.find((item) => item?.prompt_contract?.orchestration_request_hash === requestHash)
    if (found) return found
    if (items.length < 100) break
  }
  return null
}

async function probeLocalVideoArtifact(generation) {
  const localPath = String(generation?.local_path || '').trim()
  if (!localPath) return { ok: false, reason: 'local_path_missing' }
  const base = await resolveApiBase()
  const candidate = /^https?:\/\//i.test(localPath)
    ? localPath
    : `${base}/static/${localPath.replace(/^[/\\]+/, '').replace(/\\/g, '/')}`
  try {
    const response = await fetch(candidate, { headers: { range: 'bytes=0-1023' }, signal: AbortSignal.timeout(10000) })
    const bytes = response.ok || response.status === 206 ? (await response.arrayBuffer()).byteLength : 0
    return {
      ok: (response.ok || response.status === 206) && bytes > 0,
      http_status: response.status, bytes_probed: bytes,
      content_type: response.headers.get('content-type') || null,
      content_length: finiteNumber(response.headers.get('content-length')),
      source: 'local_workflow_static',
    }
  } catch (error) {
    return { ok: false, reason: 'local_media_probe_failed', message: redactString(error.message) }
  }
}

async function reconcileVideo(args) {
  if (!args.session_id || !args.node_key) throw new Error('视频对账必须绑定 session_id 和 node_key')
  const bundle = await api('GET', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}?include_inactive=true&event_limit=200`)
  const node = bundle.nodes?.find((item) => item.node_key === args.node_key || item.id === args.node_key)
  if (!node) throw new Error('找不到视频生成编排节点')
  let generationId = args.generation_id || (node.output_refs || []).find((item) => item.type === 'video_generation')?.id
  let taskId = args.task_id || (node.output_refs || []).find((item) => item.type === 'async_task')?.id
  let generation = generationId ? await api('GET', `/api/v1/videos/${encodeURIComponent(generationId)}`) : await findVideoByRequestHash(node.request_hash)
  if (generation && !generationId) generationId = generation.id
  if (generation && !taskId) taskId = generation.task_id || null
  if (!generation && !taskId) return { outcome: 'unresolved', message: '没有找到 generation_id、task_id 或同 request_hash 的视频记录；保持 uncertain，不重发', node }
  let task = taskId ? await api('GET', `/api/v1/tasks/${encodeURIComponent(taskId)}`) : null
  if (!generation && generationId) generation = await api('GET', `/api/v1/videos/${encodeURIComponent(generationId)}`)
  let outputRefs = mergeOutputRefs(node.output_refs || [], [
    ...(generationId ? [{ type: 'video_generation', id: String(generationId), role: 'generation_record' }] : []),
    ...(taskId ? [{ type: 'async_task', id: String(taskId), role: 'local_task' }] : []),
    ...(generation?.provider_task_id ? [{ type: 'provider_video_task', id: String(generation.provider_task_id), role: 'provider_task' }] : []),
  ])
  if (JSON.stringify(outputRefs) !== JSON.stringify(node.output_refs || [])) {
    const providerSubmission = String(generation?.submission_status || '').toLowerCase()
    const hasProviderTask = Boolean(String(generation?.provider_task_id || '').trim())
    let submissionState = 'local_created'
    let message = '已按 request_hash 找回本地视频记录；等待供应商受理证据，继续查询而不重发'
    if (hasProviderTask || providerSubmission === 'accepted') {
      submissionState = 'accepted'
      message = '已按 request_hash 找回原视频记录和供应商受理证据，继续对账而不重发'
    } else if (providerSubmission === 'ambiguous') {
      submissionState = 'uncertain'
      message = '已找回本地视频记录，但供应商是否受理仍不明确；只继续查询，禁止重发'
    } else if (providerSubmission === 'rejected') {
      submissionState = 'rejected'
      message = '已找回本地视频记录，并确认供应商未受理；保留失败证据，不自动重发'
    }
    const linked = await api('PATCH', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/nodes/${encodeURIComponent(args.node_key)}`, {
      actor: 'codex', request_hash: node.request_hash, output_refs: outputRefs,
      progress: { ...(node.progress || {}), state: 'reconciled_record', submission_state: submissionState, message, generation_id: generationId, correlation_id: taskId, provider_task_id: generation?.provider_task_id || null, provider_submission_status: providerSubmission || null },
    })
    Object.assign(node, linked.node)
  }

  let generationStatus = String(generation?.generation_status || generation?.status || task?.status || '').toLowerCase()
  let downloadStatus = String(generation?.download_status || '').toLowerCase()
  if (generationStatus === 'completed' && downloadStatus === 'failed' && args.retry_download === true && generationId) {
    await api('POST', `/api/v1/videos/${encodeURIComponent(generationId)}/retry-download`, {}, Number(args.timeout_ms) || 120000)
    generation = await api('GET', `/api/v1/videos/${encodeURIComponent(generationId)}`)
    task = taskId ? await api('GET', `/api/v1/tasks/${encodeURIComponent(taskId)}`) : task
    generationStatus = String(generation?.generation_status || generation?.status || task?.status || '').toLowerCase()
    downloadStatus = String(generation?.download_status || '').toLowerCase()
  }
  const providerSubmission = String(generation?.submission_status || '').toLowerCase()
  if (generationStatus === 'completed') {
    if (downloadStatus === 'failed') {
      const message = generation?.download_error || generation?.error_msg || '上游视频已完成，但本地下载失败'
      const updated = await api('PATCH', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/nodes/${encodeURIComponent(args.node_key)}`, {
        actor: 'codex', request_hash: node.request_hash, output_refs: outputRefs,
        progress: { state: 'download_failed', submission_state: 'accepted', message, generation_id: generationId, correlation_id: taskId, provider_task_id: generation?.provider_task_id || null },
        error: { code: 'VIDEO_DOWNLOAD_FAILED', message, retryable: true, next_actions: ['reconcile_video retry_download=true', 'inspect', 'manual'] },
        decision: { ...(node.decision || {}), provider_result: sanitize({ generation, task }), cost_outcome: 'provider_completed_billing_expected_download_recoverable' },
      })
      return { outcome: 'download_failed', generation, task, node: updated.node }
    }
    const mediaProbe = await probeLocalVideoArtifact(generation)
    if (!mediaProbe.ok) {
      const updated = await api('PATCH', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/nodes/${encodeURIComponent(args.node_key)}`, {
        actor: 'codex', request_hash: node.request_hash, output_refs: outputRefs,
        progress: { state: 'provider_completed_downloading', submission_state: 'accepted', message: '上游生成已完成，但本地媒体尚未取得可读字节', generation_id: generationId, correlation_id: taskId, provider_task_id: generation?.provider_task_id || null, media_probe: mediaProbe },
        decision: { ...(node.decision || {}), provider_result: sanitize({ generation, task }), cost_outcome: 'provider_completed_billing_expected_local_artifact_pending' },
      })
      return { outcome: 'provider_completed_downloading', generation, task, media_probe: mediaProbe, node: updated.node }
    }
    const acceptedMedia = { type: 'generated_video', id: String(generationId || generation?.provider_task_id || taskId), role: 'accepted_media', path: generation?.local_path || null, task_id: taskId || null, provider_task_id: generation?.provider_task_id || null }
    outputRefs = mergeOutputRefs(outputRefs, [acceptedMedia])
    const completed = await api('POST', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/nodes/${encodeURIComponent(args.node_key)}/actions/complete`, {
      actor: 'codex', message: '视频生成、下载和本地可读性验证均已完成', output_refs: outputRefs,
      progress: { state: 'completed', submission_state: 'settled', message: '视频已生成并保存为本地可读产物', generation_id: generationId, correlation_id: taskId, provider_task_id: generation?.provider_task_id || null, media_probe: mediaProbe },
      decision: { ...(node.decision || {}), provider_result: sanitize({ generation, task }), media_probe: mediaProbe, cost_outcome: 'estimated_from_live_catalog_billing_receipt_not_available' },
      receipt: { status: 'success', source: 'video-provider-and-local-storage', message: '视频生成、下载和本地可读性验证均已完成', retryable: 'false', next_actions: ['continue', 'inspect_media'], correlation_id: generation?.provider_task_id || taskId || null },
    })
    return { outcome: 'succeeded', generation, task, media_probe: mediaProbe, node: completed.node }
  }
  if (generationStatus === 'failed') {
    const message = generation?.error_msg || task?.error || task?.message || '视频生成失败'
    const definitelyNotAccepted = ['not_sent', 'rejected'].includes(providerSubmission) && !generation?.provider_task_id
    const failed = await api('POST', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/nodes/${encodeURIComponent(args.node_key)}/actions/fail`, {
      actor: 'codex', message, original_code: 'VIDEO_GENERATION_FAILED', retryable: definitelyNotAccepted ? 'true' : 'unknown', correlation_id: generation?.provider_task_id || taskId || null,
      next_actions: definitelyNotAccepted ? ['reopen_after_user_confirmation', 'edit_plan', 'skip'] : ['inspect_provider_task', 'manual_billing_reconcile', 'skip'],
      progress: { state: 'failed', submission_state: definitelyNotAccepted ? 'rejected' : 'settled', message, generation_id: generationId, correlation_id: taskId, provider_task_id: generation?.provider_task_id || null },
      decision: { ...(node.decision || {}), provider_result: sanitize({ generation, task }), cost_outcome: definitelyNotAccepted ? 'billing_not_expected_provider_receipt_unavailable' : 'billing_unknown_pending_provider_receipt' },
    })
    return { outcome: 'failed', generation, task, node: failed.node }
  }
  if (generationStatus === 'ambiguous' || providerSubmission === 'ambiguous') {
    const message = generation?.error_msg || '供应商是否受理仍不明确；保持原请求锁定并继续查询，禁止重发'
    const updated = await api('PATCH', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/nodes/${encodeURIComponent(args.node_key)}`, {
      actor: 'codex', request_hash: node.request_hash, output_refs: outputRefs,
      progress: { state: 'provider_unknown', submission_state: 'uncertain', message, generation_id: generationId, correlation_id: taskId, provider_task_id: generation?.provider_task_id || null },
      error: { code: 'VIDEO_PROVIDER_RESULT_UNCERTAIN', message, retryable: 'unknown', next_actions: ['reconcile_video', 'inspect', 'manual_billing_reconcile'] },
      decision: { ...(node.decision || {}), provider_result: sanitize({ generation, task }), cost_outcome: 'billing_unknown_pending_provider_receipt' },
    })
    return { outcome: 'unresolved', generation, task, node: updated.node }
  }
  const updated = await api('PATCH', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/nodes/${encodeURIComponent(args.node_key)}`, {
    actor: 'codex', request_hash: node.request_hash, output_refs: outputRefs,
    progress: { state: 'provider_processing', submission_state: providerSubmission === 'accepted' || generation?.provider_task_id ? 'accepted' : 'submitting', message: '视频任务仍在生成或下载中；继续查询同一任务', generation_id: generationId, correlation_id: taskId, provider_task_id: generation?.provider_task_id || null, generation_status: generationStatus || null, download_status: downloadStatus || null },
    decision: { ...(node.decision || {}), provider_result: sanitize({ generation, task }), cost_outcome: 'pending_provider_completion_and_billing_receipt' },
  })
  return { outcome: 'pending', generation, task, node: updated.node }
}

async function generateImage(args) {
  if (!args.session_id || !args.node_key) throw new Error('图片生成必须绑定 session_id 和 node_key')
  const authorization = await paidAuthorization(args)
  const image = {
    prompt: String(args.prompt || '').trim(), model: String(args.model || '').trim(), provider: String(args.provider || '').trim(),
    image_service_type: String(args.image_service_type || 'image'), image_config_id: Number(args.image_config_id), drama_id: Number(args.drama_id) || 0,
    size: args.size || undefined, aspect_ratio: args.aspect_ratio || undefined,
    reference_images: Array.isArray(args.reference_images) ? args.reference_images : undefined,
    negative_prompt: args.negative_prompt || undefined, frame_type: args.frame_type || undefined,
  }
  if (!image.prompt) throw new Error('图片生成缺少 prompt')
  if (!image.model || !image.provider || !Number.isInteger(image.image_config_id) || image.image_config_id <= 0) throw new Error('图片生成必须锁定 model、provider 和 image_config_id，避免改配置后仍误用旧模型')
  rejectSecrets(image)
  const publicConfig = await api('GET', `/api/v1/ai-configs/${encodeURIComponent(image.image_config_id)}`)
  const configuredModels = Array.isArray(publicConfig?.model) ? publicConfig.model.map(String) : [publicConfig?.model].filter(Boolean).map(String)
  if (!['image', 'storyboard_image'].includes(String(publicConfig?.service_type || ''))) throw new Error('锁定配置不是图片服务，已在付费提交前停止')
  if (String(publicConfig?.provider || '') !== image.provider) throw new Error('锁定配置的 provider 与请求不一致，已在付费提交前停止')
  if (![...configuredModels, String(publicConfig?.default_model || '')].includes(image.model)) throw new Error('锁定配置不包含请求模型，已在付费提交前停止')
  if (publicConfig?.is_active === false || publicConfig?.is_enabled === false) throw new Error('锁定配置当前未启用，已在付费提交前停止')
  if (publicConfig?.has_api_key !== true) throw new Error('锁定配置没有已保存凭据，已在付费提交前停止')
  let configSettings = publicConfig?.settings
  if (typeof configSettings === 'string') {
    try { configSettings = JSON.parse(configSettings) } catch { configSettings = {} }
  }
  const configuredGroup = String(configSettings?.group_name || configSettings?.group || publicConfig?.group_name || '').trim()
  // Yinzi prices are exposed by the same live catalog that proves the model
  // exists for the current runtime.  The local model_prices table is optional
  // (and may be empty after a fresh start), so it must not be the only source
  // of truth for a Yinzi image request.  Keep the older local-price path for
  // non-Yinzi providers and for already-imported USD contracts.
  let priceItems = []
  let priceCatalog = null
  let liveCatalogHadImageSection = false
  if (image.provider === 'yinzi') {
    priceCatalog = await api('GET', `/api/v1/ai-configs/yinzi/catalog?config_id=${encodeURIComponent(image.image_config_id)}`)
    // A reachable, structured Yinzi image catalog is authoritative even when
    // it does not contain this exact model.  In that case a stale local price
    // must not reopen a paid path for a model the current key did not prove.
    // Older test fixtures and pre-catalog runtimes may omit the image section
    // entirely; those retain the compatibility fallback below.
    liveCatalogHadImageSection = Array.isArray(priceCatalog?.image)
      || (image.image_service_type === 'storyboard_image' && Array.isArray(priceCatalog?.storyboard_image))
    const catalogItems = [
      ...(Array.isArray(priceCatalog?.image) ? priceCatalog.image : []),
      ...(image.image_service_type === 'storyboard_image' && Array.isArray(priceCatalog?.storyboard_image)
        ? priceCatalog.storyboard_image : []),
    ]
    const catalogItem = catalogItems.find((item) => String(item?.model || '').trim().toLowerCase() === image.model.toLowerCase())
    priceItems = (Array.isArray(catalogItem?.prices) ? catalogItem.prices : [])
      .map((item) => ({
        ...item,
        provider: image.provider,
        service_type: image.image_service_type,
        model: image.model,
        group_name: item.group_name || item.group || '',
        unit_price_native: Number.isFinite(Number(item.effective_price)) ? Number(item.effective_price)
          : Number.isFinite(Number(item.effective_model_price)) ? Number(item.effective_model_price) : null,
        currency: String(item.currency || 'CNY').toUpperCase(),
        source: item.source || priceCatalog?.source || 'yinzi-catalog',
        source_version: item.source_version || priceCatalog?.pricing_version || null,
      }))
      .filter((item) => Number.isFinite(item.unit_price_native) && item.unit_price_native >= 0)
  }
  // Keep compatibility with older local fixtures/configuration snapshots when
  // the live catalog endpoint is reachable but does not contain this exact
  // image model. A local USD contract is still valid evidence for a non-live
  // provider path; it must never override a matching Yinzi catalog item.
  if (!priceItems.length && !(image.provider === 'yinzi' && liveCatalogHadImageSection)) {
    const prices = await api('GET', `/api/v1/settings/advanced/prices?provider=${encodeURIComponent(image.provider)}&service_type=image&model=${encodeURIComponent(image.model)}`)
    priceItems = (Array.isArray(prices?.items) ? prices.items : []).filter((item) => (
      String(item.provider || '') === image.provider
      && String(item.service_type || '') === 'image'
      && String(item.model || '') === image.model
      && Number.isFinite(Number(item.unit_price_usd))
    ))
  }
  let selectedPrice = null
  let pricingBasis = ''
  if (configuredGroup) {
    if (args.group_name && configuredGroup !== String(args.group_name)) throw new Error('请求分组与锁定配置中可验证的分组不一致，已在付费提交前停止')
    selectedPrice = priceItems.find((item) => String(item.group_name || '') === configuredGroup) || null
    pricingBasis = 'verified_config_group'
  } else if (priceItems.length) {
    selectedPrice = priceItems.reduce((highest, item) => {
      const value = Number(item.unit_price_native ?? item.unit_price_usd)
      const highestValue = Number(highest.unit_price_native ?? highest.unit_price_usd)
      return value > highestValue ? item : highest
    })
    pricingBasis = priceItems.length === 1 ? 'single_catalog_price' : 'unverified_config_group_worst_case'
  }
  const selectedNativePrice = Number(selectedPrice?.unit_price_native ?? selectedPrice?.unit_price_usd)
  if (!selectedPrice || !Number.isFinite(selectedNativePrice)) throw new Error('当前锁定模型/分组没有可验证实时价格，已在付费提交前停止')
  const nativeCurrency = String(selectedPrice.currency || 'USD').toUpperCase()
  const explicitCnyCeiling = Number.isFinite(Number(args.max_unit_price_cny)) ? Number(args.max_unit_price_cny) : null
  const legacyNumericCeiling = Number.isFinite(Number(args.max_unit_price_usd)) ? Number(args.max_unit_price_usd) : null
  const maximumPrice = explicitCnyCeiling ?? legacyNumericCeiling
  if (!Number.isFinite(maximumPrice) && !authorization.unattended) throw new Error('图片付费请求需要 max_unit_price_cny 或 max_unit_price_usd 授权上限，未提交')
  const ceilingBasis = explicitCnyCeiling != null
    ? `${nativeCurrency.toUpperCase()}_explicit`
    : `${nativeCurrency.toUpperCase()}_legacy_numeric_compatibility`
  if (maximumPrice != null && selectedNativePrice > maximumPrice) {
    const ceilingLabel = explicitCnyCeiling != null ? `${maximumPrice} CNY` : `${maximumPrice}（旧 USD 字段的兼容数值，不做汇率换算）`
    throw new Error(`实时单价 ${selectedNativePrice} ${nativeCurrency} 超过本次授权上限 ${ceilingLabel}，未提交`)
  }
  const unitPriceUsd = nativeCurrency === 'USD' ? selectedNativePrice : null
  const requestHash = createHash('sha256').update(JSON.stringify({ image: sanitize(image), idempotency_key: args.idempotency_key })).digest('hex')
  const reserve = await api('POST', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/nodes/${encodeURIComponent(args.node_key)}/external-request`, {
    actor: 'codex', request_hash: requestHash, message: '正在提交一次受预算保护的图片生成请求',
    decision: { paid: true, idempotency_key: args.idempotency_key, provider: image.provider, model: image.model, image_config_id: image.image_config_id, configured_group: configuredGroup || null, requested_group: args.group_name || null, pricing_basis: pricingBasis, price_snapshot: sanitize(selectedPrice), native_currency: nativeCurrency, estimated_cost_native: selectedNativePrice, price_ceiling_basis: ceilingBasis, maximum_unit_price_usd: args.max_unit_price_usd ?? null, maximum_unit_price_cny: args.max_unit_price_cny ?? null },
  })
  if (!reserve.reserved) return { submitted: false, reused: true, reconciliation_required: reserve.reconciliation_required, request_hash: requestHash, node: reserve.node }
  try {
    const result = await api('POST', '/api/v1/images', image, Number(args.timeout_ms) || 30000)
    const taskId = result?.task_id || null; const generationId = result?.id || null
    const updated = await api('PATCH', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/nodes/${encodeURIComponent(args.node_key)}`, {
      actor: 'codex', request_hash: requestHash,
      progress: { state: 'provider_ack', submission_state: taskId ? 'accepted' : 'uncertain', message: taskId ? '图片执行器已受理，等待真实结果' : '返回中缺少 task_id，需要查询记录对账', correlation_id: taskId },
      output_refs: [...(taskId ? [{ type: 'async_task', id: String(taskId), role: 'provider_task' }] : []), ...(generationId ? [{ type: 'image_generation', id: String(generationId), role: 'generation_record' }] : [])],
      decision: { paid: true, idempotency_key: args.idempotency_key, provider: image.provider, model: image.model, image_config_id: image.image_config_id, configured_group: configuredGroup || null, requested_group: args.group_name || null, pricing_basis: pricingBasis, price_snapshot: sanitize(selectedPrice), native_currency: nativeCurrency, estimated_cost_native: selectedNativePrice, price_ceiling_basis: ceilingBasis, request: sanitize(image) },
    })
    return { submitted: true, request_hash: requestHash, task_id: taskId, generation_id: generationId, estimated_cost_usd: unitPriceUsd, estimated_cost_native: selectedNativePrice, native_currency: nativeCurrency, pricing_basis: pricingBasis, configured_group: configuredGroup || null, requested_group: args.group_name || null, pricing_source: selectedPrice.source, pricing_version: selectedPrice.source_version, node: updated.node }
  } catch (error) {
    await api('PATCH', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/nodes/${encodeURIComponent(args.node_key)}`, {
      actor: 'codex', request_hash: requestHash, progress: { state: 'provider_unknown', submission_state: 'uncertain', message: '图片创建结果不明确；先按 request_hash 查询对账，禁止直接重发' },
      error: { code: 'IMAGE_CREATE_AMBIGUOUS', message: error.message, retryable: 'unknown', next_actions: ['reconcile', 'inspect', 'manual'] },
    })
    throw error
  }
}

async function reconcileImage(args) {
  if (!args.session_id || !args.node_key) throw new Error('图片对账必须绑定 session_id 和 node_key')
  const bundle = await api('GET', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}?include_inactive=true&event_limit=200`)
  const node = bundle.nodes?.find((item) => item.node_key === args.node_key || item.id === args.node_key)
  if (!node) throw new Error('找不到图片生成编排节点')
  const generationId = args.generation_id || (node.output_refs || []).find((item) => item.type === 'image_generation')?.id
  const taskId = args.task_id || (node.output_refs || []).find((item) => item.type === 'async_task')?.id
  if (!generationId && !taskId) return { outcome: 'unresolved', message: '没有 generation_id 或 task_id，无法证明是否受理；保持 uncertain，不重发', node }
  const generation = generationId ? await api('GET', `/api/v1/images/${encodeURIComponent(generationId)}`) : null
  const task = taskId ? await api('GET', `/api/v1/tasks/${encodeURIComponent(taskId)}`) : null
  const status = String(generation?.status || task?.status || '').toLowerCase()
  if (['completed', 'succeeded', 'success'].includes(status)) {
    const output = { type: 'generated_image', id: String(generation?.id || generationId || taskId), role: 'accepted_media', path: generation?.local_path || generation?.image_url || null, task_id: taskId || null }
    const completed = await api('POST', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/nodes/${encodeURIComponent(args.node_key)}/actions/complete`, {
      actor: 'codex', message: '图片生成已完成并取得可读取产物', output_refs: [...(node.output_refs || []), output],
      progress: { state: 'completed', submission_state: 'settled', message: '图片生成完成', correlation_id: taskId || null },
      decision: { ...(node.decision || {}), provider_result: sanitize({ generation, task }), cost_outcome: 'estimated_from_live_catalog_pending_provider_billing_receipt' },
    })
    return { outcome: 'succeeded', generation, task, node: completed.node }
  }
  if (status === 'failed') {
    const message = generation?.error_msg || task?.error || task?.message || '图片生成失败'
    const failed = await api('POST', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/nodes/${encodeURIComponent(args.node_key)}/actions/fail`, {
      actor: 'codex', message, original_code: 'IMAGE_GENERATION_FAILED', retryable: 'unknown', correlation_id: taskId || null,
      progress: { state: 'failed', submission_state: 'settled', message, correlation_id: taskId || null },
      decision: { ...(node.decision || {}), provider_result: sanitize({ generation, task }), cost_outcome: 'billing_unknown_pending_provider_receipt' },
    })
    return { outcome: 'failed', generation, task, node: failed.node }
  }
  return { outcome: 'pending', generation, task, node }
}

const tools = [
  { name: 'get_workflow_preferences', description: '读取实时质量档位与持久化挂机模式。', inputSchema: { type: 'object', properties: {} } },
  { name: 'set_workflow_preferences', description: '更新本机工作流偏好。用户勾选挂机、明确说自己挂机或授权自主花费时，可设置 unattended_mode=true；可随时关闭。保留用户任务范围与预算。', inputSchema: { type: 'object', properties: { unattended_mode: { type: 'boolean' }, quality_profile: { enum: ['quality', 'balanced', 'speed'] } } } },
  { name: 'workflow_health', description: '检查本机银子视频工作流服务是否可用。', inputSchema: { type: 'object', properties: {} } },
  { name: 'open_workflow', description: '启动/打开工作流观察入口，返回已确认的本地运行时、前端地址和首用下一步；不会创建任务或产生费用。', inputSchema: { type: 'object', properties: { open_browser: { type:'boolean', default:true } } } },
  { name: 'list_model_candidates', description: '读取本机已启用的文本、图片或视频模型候选；返回脱敏配置、备注、用途、优先级和可选能力提示。不会测试 Key、不会提交付费请求。', inputSchema: { type: 'object', properties: { service_type: { enum: ['text', 'image', 'storyboard_image', 'video'] } } } },
  { name: 'complete_session', description: '所有活动节点已有真实终态后，完成任务并收口交付；不会把未完成节点自动标为成功。', inputSchema: { type:'object', required:['session_id'], properties:{ session_id:{type:'string'}, summary:{type:'string'}, expected_version:{type:'integer'} } } },
  { name: 'record_event', description: '把 Codex 的事实、决定、进度、研究或验收记录写入指定编排会话；使用幂等键且拒绝密钥。', inputSchema: { type: 'object', required: ['session_id', 'event_type', 'event_idempotency_key'], properties: { session_id: { type: 'string' }, event_type: { type: 'string' }, event_idempotency_key: { type: 'string' }, node_id: { type: 'string' }, payload: { type: 'object' } } } },
  { name: 'list_modules', description: '按需求搜索媒体合同；V5 为有执行器的本地操作。无需在任务前读取完整目录。', inputSchema: { type: 'object', properties: { q: { type: 'string' }, version_track: { type: 'string' }, availability: { type: 'string' } } } },
  { name: 'local_media_run', description: '提交本地媒体处理，缺少组件会自动下载、安装和实际运行检查，然后继续原作业。立即返回持久作业编号；相同请求键复用原作业。', inputSchema: { type:'object',required:['session_id','request_key','module_id','input_path'],properties:{session_id:{type:'string'},request_key:{type:'string'},module_id:{type:'string'},input_path:{type:'string'},node_key:{type:'string'},parameters:{type:'object'}} } },
  { name: 'local_media_get_job', description: '读取本地作业组件下载、安装、执行、验收进度与成果。', inputSchema: { type:'object',required:['job_id'],properties:{job_id:{type:'string'}} } },
  { name: 'local_media_resume', description: '恢复失败的原本地作业，复用下载缓存和成功安装的组件。', inputSchema: { type:'object',required:['job_id'],properties:{job_id:{type:'string'}} } },
  { name: 'local_media_components', description: '读取设备摘要和登记组件状态，不触发供应商鉴权。', inputSchema: { type:'object',properties:{} } },
  { name: 'list_sessions', description: '检索已存在的可恢复编排任务，避免重复创建。', inputSchema: { type: 'object', properties: { status: { type: 'string' }, linked_run_id: { type: 'string' }, limit: { type: 'integer' } } } },
  { name: 'get_session', description: '读取一个编排任务的会话、节点、事件和回执真值。', inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string' }, include_inactive: { type: 'boolean' }, event_limit: { type: 'integer' } } } },
  { name: 'begin_media_task', description: '立即登记或恢复当前媒体任务并打开对应页面；分析阶段即可展示，不发起付费生成。', inputSchema: { type:'object', required:['user_goal','idempotency_key'], properties:{ user_goal:{type:'string'}, idempotency_key:{type:'string'}, title:{type:'string'}, intent:{enum:['analyze','create']}, source_context:{type:'object'}, open_browser:{type:'boolean',default:true} } } },
  { name: 'report_activity', description: '记录当前真实动作、下一步、是否需要用户和分析报告。分析完成可收口；不会执行媒体生成。', inputSchema: { type:'object', required:['session_id','event_idempotency_key','message'], properties:{ session_id:{type:'string'}, event_idempotency_key:{type:'string'}, stage:{type:'string'}, state:{enum:['working','waiting','completed']}, message:{type:'string'}, next_action:{type:'string'}, needs_user:{type:'boolean'}, analysis_report:{type:['object','string']} } } },
  { name: 'create_session', description: '使用稳定幂等键创建或复用 Codex 视频编排任务。', inputSchema: { type: 'object', required: ['idempotency_key', 'user_goal'], properties: { idempotency_key: { type: 'string' }, title: { type: 'string' }, user_goal: { type: 'string' }, mode: { enum: ['auto', 'collaborate', 'manual'] }, source_context: { type: 'object' }, budget: { type: 'object' } } } },
  { name: 'submit_plan', description: '提交可动态增删重排的计划和节点；计划版本冲突会拒绝覆盖。', inputSchema: { type: 'object', required: ['session_id', 'nodes'], properties: { session_id: { type: 'string' }, expected_revision: { type: 'integer' }, confirm: { type: 'boolean' }, plan: { type: 'object' }, nodes: { type: 'array', items: { type: 'object' } } } } },
  { name: 'session_action', description: '确认/开始/暂停/恢复任务或保存检查点。', inputSchema: { type: 'object', required: ['session_id', 'action'], properties: { session_id: { type: 'string' }, action: { enum: ['confirm', 'start', 'pause', 'resume', 'checkpoint'] }, expected_revision: { type: 'integer' }, expected_version: { type: 'integer' }, checkpoint: { type: 'object' }, note: { type: 'string' } } } },
  { name: 'node_action', description: '对节点执行开始、完成、失败、跳过、重试或重开；失败/重试不要求填写长理由。', inputSchema: { type: 'object', required: ['session_id', 'node_key', 'action'], properties: { session_id: { type: 'string' }, node_key: { type: 'string' }, action: { enum: ['start', 'complete', 'fail', 'skip', 'retry', 'reopen'] }, force: { type: 'boolean' }, partial: { type: 'boolean' }, message: { type: 'string' }, original_code: { type: 'string' }, retryable: { enum: ['true', 'false', 'unknown'] }, input_refs: { type: 'array' }, output_refs: { type: 'array' }, progress: { type: 'object' }, decision: { type: 'object' }, receipt: { type: 'object' } } } },
  { name: 'blender_render_once', description: '在已确认的编排节点上启动一次受约束的本地 Blender 专业参考渲染；同一请求只复用已有作业，不重复启动。', inputSchema: { type: 'object', required: ['session_id', 'node_key', 'request_key', 'scene'], properties: { session_id: { type: 'string' }, node_key: { type: 'string' }, request_key: { type: 'string' }, request_hash: { type: 'string' }, scene: { type: 'object' }, max_preview_frames: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' }, frames: { type: 'array', items: { type: 'integer' } } } } },
  { name: 'blender_get_job', description: '读取 Blender 本地作业的真实阶段、恢复状态、错误和成果清单。', inputSchema: { type: 'object', required: ['session_id', 'job_id'], properties: { session_id: { type: 'string' }, job_id: { type: 'string' } } } },
  { name: 'blender_resume_job', description: '恢复一个中断或部分完成的 Blender 本地作业；只读取已有 manifest 并补缺失阶段。', inputSchema: { type: 'object', required: ['session_id', 'job_id'], properties: { session_id: { type: 'string' }, job_id: { type: 'string' } } } },
  { name: 'blender_cancel_job', description: '取消本地 Blender 作业并保留已经生成的文件；不声称取消任何上游付费任务。', inputSchema: { type: 'object', required: ['session_id', 'job_id'], properties: { session_id: { type: 'string' }, job_id: { type: 'string' }, note: { type: 'string' } } } },
  { name: 'update_node', description: '更新节点输入输出、进度、决策、请求哈希或配置版本，不需要伪造终态。', inputSchema: { type: 'object', required: ['session_id', 'node_key', 'patch'], properties: { session_id: { type: 'string' }, node_key: { type: 'string' }, patch: { type: 'object' } } } },
  { name: 'scan_assets', description: '有界扫描用户明确授权的文件/文件夹，生成哈希化素材清单；可自动写回 asset.scan 节点。', inputSchema: { type: 'object', properties: { path: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } }, session_id: { type: 'string' }, node_key: { type: 'string' }, max_files: { type: 'integer' }, max_bytes: { type: 'integer' }, max_depth: { type: 'integer' }, hash_max_bytes: { type: 'integer' }, include_absolute_paths: { type: 'boolean' }, force: { type: 'boolean' } } } },
  { name: 'workflow_bridge', description: '受审计地调用既有 production-run/asset-import 执行器。写操作必须绑定节点；付费操作使用已有授权或挂机模式，并保留幂等键。', inputSchema: { type: 'object', required: ['method', 'path'], properties: { method: { enum: ['GET', 'POST', 'PATCH'] }, path: { type: 'string' }, body: { type: 'object' }, session_id: { type: 'string' }, node_key: { type: 'string' }, paid: { type: 'boolean' }, confirmed_paid_action: { type: 'boolean' }, idempotency_key: { type: 'string' }, reconcile: { type: 'boolean' }, force: { type: 'boolean' }, timeout_ms: { type: 'integer' } } } },
  { name: 'generate_image_once', description: '按锁定配置和当前实时目录价格只提交一次图片任务；Yinzi 目录优先使用原生 CNY 价格，重复调用只返回恢复要求，不会重复生成。请提供 max_unit_price_cny；旧 max_unit_price_usd 仅作为不汇率换算的兼容数值上限。', inputSchema: { type: 'object', required: ['session_id', 'node_key', 'idempotency_key', 'image_config_id', 'provider', 'model', 'group_name', 'prompt'], properties: { session_id: { type: 'string' }, node_key: { type: 'string' }, idempotency_key: { type: 'string' }, confirmed_paid_action: { type: 'boolean' }, image_config_id: { type: 'integer' }, provider: { type: 'string' }, model: { type: 'string' }, group_name: { type: 'string' }, prompt: { type: 'string' }, size: { type: 'string' }, aspect_ratio: { type: 'string' }, drama_id: { type: 'integer' }, image_service_type: { enum: ['image', 'storyboard_image'] }, reference_images: { type: 'array', items: { type: 'string' } }, negative_prompt: { type: 'string' }, frame_type: { type: 'string' }, max_unit_price_usd: { type: 'number' }, max_unit_price_cny: { type: 'number' }, timeout_ms: { type: 'integer' } } } },
  { name: 'reconcile_image', description: '查询同一图片 generation/task 并将真实终态写回编排节点；没有关联 ID 时保持 uncertain。', inputSchema: { type: 'object', required: ['session_id', 'node_key'], properties: { session_id: { type: 'string' }, node_key: { type: 'string' }, generation_id: { type: ['string', 'integer'] }, task_id: { type: 'string' } } } },
  { name: 'generate_video_once', description: '按用户指定配置只提交一次视频。目录不作为鉴权门槛；已有授权或挂机模式下执行，重复或未知结果只对账。max_cost_cny沿用用户预算；挂机且用户未设限时可省略。', inputSchema: { type: 'object', required: ['session_id', 'node_key', 'idempotency_key', 'video_config_id', 'provider', 'model', 'group_name', 'prompt', 'duration'], properties: { session_id: { type: 'string' }, node_key: { type: 'string' }, idempotency_key: { type: 'string' }, confirmed_paid_action: { type: 'boolean' }, video_config_id: { type: 'integer' }, provider: { type: 'string' }, model: { type: 'string' }, group_name: { type: 'string' }, prompt: { type: 'string' }, duration: { type: 'number' }, aspect_ratio: { type: 'string' }, resolution: { type: 'string' }, drama_id: { type: 'integer' }, storyboard_id: { type: 'integer' }, image_url: { type: 'string' }, first_frame_url: { type: 'string' }, last_frame_url: { type: 'string' }, reference_image_urls: { type: 'array', items: { type: 'string' } }, reference_video_urls: { type: 'array', items: { type: 'string' } }, reference_audio_urls: { type: 'array', items: { type: 'string' } }, camera_fixed: { type: 'boolean' }, watermark: { type: 'boolean' }, prompt_contract: { type: 'object' }, contract_validation_mode: { enum: ['advisory', 'strict'] }, max_cost_cny: { type: 'number' }, timeout_ms: { type: 'integer' }, catalog_timeout_ms: { type: 'integer' } } } },
  { name: 'reconcile_video', description: '查询同一视频 generation/task，区分上游生成与本地下载，并在需要时只恢复下载、绝不重提视频。', inputSchema: { type: 'object', required: ['session_id', 'node_key'], properties: { session_id: { type: 'string' }, node_key: { type: 'string' }, generation_id: { type: ['string', 'integer'] }, task_id: { type: 'string' }, retry_download: { type: 'boolean' }, timeout_ms: { type: 'integer' } } } },
  { name: 'export_audit', description: '导出完整编排任务审计包。', inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string' } } } },
]

async function callTool(name, args = {}) {
  if (name === 'get_workflow_preferences') return api('GET', '/api/v1/creative-preferences')
  if (name === 'set_workflow_preferences') {
    rejectSecrets(args)
    return api('PUT', '/api/v1/creative-preferences', { unattended_mode: args.unattended_mode, quality_profile: args.quality_profile })
  }
  switch (name) {
    case 'workflow_health': return workflowHealth()
    case 'begin_media_task': {
      rejectSecrets(args)
      const runtime = await callTool('open_workflow', {open_browser:false})
      const work = await api('POST','/api/v1/orchestration-sessions/begin',{...args,actor:'codex'})
      const taskUrl = new URL(`/codex-console/${encodeURIComponent(work.session.id)}`,runtime.frontend_url).href
      const browser = args.open_browser === false ? {requested:false} : await openBrowser(taskUrl)
      return {...runtime,...work,frontend_url:taskUrl,browser}
    }
    case 'report_activity': {
      const {session_id,...body}=args;rejectSecrets(body)
      return api('POST',`/api/v1/orchestration-sessions/${encodeURIComponent(session_id)}/activity`,{...body,actor:'codex'})
    }
    case 'open_workflow': {
      let health
      let launch = null
      try {
        health = await workflowHealth()
      } catch (error) {
        if (String(process.env.YINZI_WORKFLOW_AUTO_START || '1') === '0') throw error
        launch = await launchLocalRuntime()
        // Re-discover after launch so the UI and MCP use the same verified
        // runtime identity. This also avoids trusting a launcher stdout URL.
        const launched = localOrigin(launch.api_base)
        const checked = await probeCandidate(launched)
        if (!checked.ok || checked.identity.database?.fingerprint !== launch.database_fingerprint) throw new Error('启动器地址的运行时身份未通过回读')
        activeApiBase = launched
        apiDiscoveryPromise = null
        health = await workflowHealth()
      }
      const frontendUrl = String(process.env.YINZI_WORKFLOW_FRONTEND_URL || launch?.frontend_url || health.api_base + '/')
      localOrigin(frontendUrl)
      if (!await verifyUi(frontendUrl)) throw new Error('工作台首页或脚本不可读，请运行安装启动脚本修复构建')
      const browser = args.open_browser === false ? { requested:false } : await openBrowser(frontendUrl)
      const onboarding = await api('GET', '/api/v1/orchestration-onboarding')
      return {
        ...health,
        onboarding,
        frontend_url: frontendUrl,
        browser,
        runtime_launch: launch ? { reused: launch.reused === true, registry: launch.registry || null } : null,
      }
    }
    case 'list_model_candidates': {
      const serviceType = ['text', 'image', 'storyboard_image', 'video'].includes(String(args.service_type || 'text')) ? String(args.service_type || 'text') : 'text'
      return api('GET', `/api/v1/ai-configs/candidates?service_type=${encodeURIComponent(serviceType)}`)
    }
    case 'complete_session': { const { session_id,...body }=args; return api('POST',`/api/v1/orchestration-sessions/${encodeURIComponent(session_id)}/complete`,{...body,actor:'codex'}) }
    case 'record_event': {
      const { session_id, ...body } = args
      rejectSecrets(body)
      return api('POST', `/api/v1/orchestration-sessions/${encodeURIComponent(session_id)}/events`, { ...body, actor: 'codex' })
    }
    case 'list_modules': {
      const query = new URLSearchParams(Object.entries(args).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]))
      return api('GET', `/api/v1/orchestration-modules${query.size ? `?${query}` : ''}`)
    }
    case 'local_media_run': rejectSecrets(args); return api('POST', '/api/v1/local-media/jobs', args);
    case 'local_media_get_job': return api('GET', `/api/v1/local-media/jobs/${encodeURIComponent(args.job_id)}`);
    case 'local_media_resume': return api('POST', `/api/v1/local-media/jobs/${encodeURIComponent(args.job_id)}/resume`, {});
    case 'local_media_components': return api('GET', '/api/v1/media-components/profile');
    case 'list_sessions': {
      const query = new URLSearchParams(Object.entries(args).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]))
      return api('GET', `/api/v1/orchestration-sessions${query.size ? `?${query}` : ''}`)
    }
    case 'get_session': return api('GET', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}?include_inactive=${Boolean(args.include_inactive)}&event_limit=${Number(args.event_limit) || 200}`)
    case 'create_session': return api('POST', '/api/v1/orchestration-sessions', { ...args, actor: 'codex' })
    case 'submit_plan': {
      const { session_id, ...body } = args
      return api('PUT', `/api/v1/orchestration-sessions/${encodeURIComponent(session_id)}/plan`, { ...body, actor: 'codex' })
    }
    case 'session_action': {
      const { session_id, action, ...body } = args
      return api('POST', `/api/v1/orchestration-sessions/${encodeURIComponent(session_id)}/${action}`, { ...body, actor: action === 'confirm' ? 'user' : 'codex' })
    }
    case 'node_action': {
      const { session_id, node_key, action, ...body } = args
      return api('POST', `/api/v1/orchestration-sessions/${encodeURIComponent(session_id)}/nodes/${encodeURIComponent(node_key)}/actions/${action}`, { ...body, actor: 'codex' })
    }
    case 'blender_render_once': {
      const { session_id, node_key, ...body } = args
      rejectSecrets(body)
      return api('POST', `/api/v1/orchestration-sessions/${encodeURIComponent(session_id)}/nodes/${encodeURIComponent(node_key)}/blender/render`, body, 30000)
    }
    case 'blender_get_job':
      return api('GET', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/blender/jobs/${encodeURIComponent(args.job_id)}`)
    case 'blender_resume_job':
      return api('POST', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/blender/jobs/${encodeURIComponent(args.job_id)}/resume`, {})
    case 'blender_cancel_job':
      return api('POST', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/blender/jobs/${encodeURIComponent(args.job_id)}/cancel`, { note: args.note || null, actor: 'codex' })
    case 'update_node': return api('PATCH', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/nodes/${encodeURIComponent(args.node_key)}`, { ...args.patch, actor: 'codex' })
    case 'scan_assets': return scanAssets(args)
    case 'workflow_bridge': return workflowBridge(args)
    case 'generate_image_once': return generateImage(args)
    case 'reconcile_image': return reconcileImage(args)
    case 'generate_video_once': return generateVideo(args)
    case 'reconcile_video': return reconcileVideo(args)
    case 'export_audit': return api('GET', `/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/export`)
    default: throw new Error(`未知工具：${name}`)
  }
}

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`) }
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', async (line) => {
  if (!line.trim()) return
  let request
  try { request = JSON.parse(line) } catch { return }
  if (request.method === 'notifications/initialized' || request.method?.startsWith('notifications/')) return
  if (request.id == null) return
  try {
    if (request.method === 'initialize') {
      send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'yinzi-video-workflow', version: '0.2.0' } } })
    } else if (request.method === 'ping') {
      send({ jsonrpc: '2.0', id: request.id, result: {} })
    } else if (request.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: request.id, result: { tools } })
    } else if (request.method === 'tools/call') {
      try { send({ jsonrpc: '2.0', id: request.id, result: textResult(await callTool(request.params?.name, request.params?.arguments || {})) }) }
      catch (error) { send({ jsonrpc: '2.0', id: request.id, result: textResult({ message: redactString(error.message), ...(error.details || {}) }, true) }) }
    } else {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
    }
  } catch (error) {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: redactString(error.message) } })
  }
})
