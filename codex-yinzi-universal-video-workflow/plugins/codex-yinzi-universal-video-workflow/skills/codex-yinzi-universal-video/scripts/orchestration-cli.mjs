#!/usr/bin/env node

import fs from 'node:fs/promises'
import { compactModuleIndex } from './module-index.mjs'
import { activityResponse } from './activity-response.mjs'
import { researchRequest } from '../../../mcp/research-tools.mjs'
import { readRegistry, localOrigin } from '../../../scripts/runtime-state.mjs'

const explicitBase = String(process.env.YINZI_WORKFLOW_URL || '').trim().replace(/\/+$/, '')
const candidateUrls = String(process.env.YINZI_WORKFLOW_CANDIDATE_URLS || '')
  .split(',').map((value) => value.trim().replace(/\/+$/, '')).filter(Boolean)
const candidateBases = candidateUrls.length
  ? candidateUrls
  : String(process.env.YINZI_WORKFLOW_CANDIDATE_PORTS || '5683,5679,5680,5682')
    .split(',').map((value) => value.trim()).filter((value) => /^\d{1,5}$/.test(value))
    .map((port) => `http://127.0.0.1:${port}`)
let base = explicitBase || null
let discoveryPromise = null
const probeTimeoutMs = Math.min(Math.max(Number(process.env.YINZI_WORKFLOW_PROBE_TIMEOUT_MS) || 1100, 250), 3000)
const [command = 'help', ...args] = process.argv.slice(2)

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function option(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function positional() {
  const out = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith('--')) { index += 1; continue }
    out.push(args[index])
  }
  return out
}

function assertNoSecrets(value, path = '$') {
  const blocked = new Set(['api_key', 'apikey', 'authorization', 'access_token', 'refresh_token', 'password', 'secret', 'client_secret', 'credential'])
  if (typeof value === 'string' && /\bsk-[A-Za-z0-9_-]{12,}\b/.test(value)) fail(`拒绝发送疑似 API Key：${path}`)
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`))
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (blocked.has(key.toLowerCase())) fail(`拒绝发送密钥字段：${path}.${key}`)
    assertNoSecrets(item, `${path}.${key}`)
  }
}

async function input() {
  const file = option('--input')
  if (!file) return {}
  const parsed = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
  assertNoSecrets(parsed)
  return parsed
}

async function readJsonResponse(request) {
  const response = await request
  const payload = await response.json().catch(() => ({}))
  return { response, payload }
}

async function probeCandidate(candidate) {
  const [healthResult, identityResult, routeResult] = await Promise.allSettled([
    readJsonResponse(fetch(`${candidate}/health`, { signal: AbortSignal.timeout(probeTimeoutMs) })),
    readJsonResponse(fetch(`${candidate}/api/v1/runtime-identity`, { signal: AbortSignal.timeout(probeTimeoutMs) })),
    readJsonResponse(fetch(`${candidate}/api/v1/orchestration-sessions/__codex_capability_probe__/nodes/__probe__/actions/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(probeTimeoutMs),
    })),
  ])
  const errors = []
  let identity = null
  if (healthResult.status === 'rejected') errors.push(`health ${healthResult.reason?.message || '探测失败'}`)
  else if (!healthResult.value.response.ok || healthResult.value.payload?.status !== 'ok') errors.push(`health HTTP ${healthResult.value.response.status}`)
  if (identityResult.status === 'rejected') errors.push(`运行时身份 ${identityResult.reason?.message || '探测失败'}`)
  else {
    identity = identityResult.value.payload?.data ?? identityResult.value.payload
    if (!identityResult.value.response.ok || !identity?.schema || identity?.orchestration_router !== true) errors.push(`运行时身份 HTTP ${identityResult.value.response.status}`)
  }
  if (routeResult.status === 'rejected') errors.push(`编排路由探针 ${routeResult.reason?.message || '探测失败'}`)
  else if (routeResult.value.response.status !== 404 || !['ORCHESTRATION_NOT_FOUND', 'ORCHESTRATION_NODE_NOT_FOUND'].includes(routeResult.value.payload?.error?.code)) {
    errors.push(`编排路由探针 HTTP ${routeResult.value.response.status}`)
  }
  return errors.length ? { ok: false, errors } : { ok: true, identity }
}

async function request(method, path, body) {
  if (explicitBase) {
    if (!discoveryPromise) {
      discoveryPromise = (async () => {
        try {
          const result = await probeCandidate(explicitBase)
          if (!result.ok) {
            fail(`指定的工作流服务不具备当前 Codex 编排能力；请重启对应后端或更换 YINZI_WORKFLOW_URL`, 2)
          }
          return explicitBase
        } catch (error) {
          if (error?.code === 'ERR_SCRIPT_FAILURE') throw error
          fail(`指定的工作流服务不可用或身份不匹配：${error.message}`, 2)
        }
      })()
    }
    await discoveryPromise
  }
  if (!base) {
    if (!discoveryPromise) {
      discoveryPromise = (async () => {
        const registered = await readRegistry()
        if (registered?.api_base && !candidateUrls.length && !process.env.YINZI_WORKFLOW_CANDIDATE_PORTS) {
          const result = await probeCandidate(localOrigin(registered.api_base))
          if (result.ok && registered.database_fingerprint === result.identity?.database?.fingerprint) { base = registered.api_base; return base }
        }
        const results = await Promise.all(candidateBases.map(async (candidate) => ({ candidate, result: await probeCandidate(candidate) })))
        const checked = results.map(({ candidate, result }) => ({ candidate, errors: result.errors || [] }))
        const available = results.filter(({ result }) => result.ok).map(({ candidate, result }) => ({
          candidate,
          identity: result.identity,
          identityKey: [result.identity.schema, result.identity.app_version, result.identity.source_revision, result.identity.database?.fingerprint, result.identity.orchestration_router].join('|'),
        }))
        const canonical = available.filter((item) => item.identity?.canonical === true)
        const pool = canonical.length ? canonical : available
        const groups = [...new Set(pool.map((item) => item.identityKey))]
        if (pool.length && groups.length === 1) {
          base = pool[0].candidate
          return base
        }
        if (groups.length > 1) fail(`检测到多个不一致的本地工作流实例，已停止自动选择以避免任务分叉。请设置 YINZI_WORKFLOW_URL 固定正确实例。候选：${JSON.stringify(pool.map(({ candidate, identity }) => ({ candidate, identity })))}`, 2)
        fail(`未找到可用的 Codex 编排服务。已探测：${JSON.stringify(checked)}；请启动工作流后端，或设置 YINZI_WORKFLOW_URL`, 2)
      })()
    }
    await discoveryPromise
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.YINZI_WORKFLOW_TIMEOUT_MS || 30000)),
  })
  const text = await response.text()
  let payload
  try { payload = text ? JSON.parse(text) : null } catch { payload = { raw: text } }
  if (!response.ok || payload?.success === false) {
    const detail = payload?.error || payload || { message: response.statusText }
    process.stderr.write(`${JSON.stringify({ http_status: response.status, error: detail }, null, 2)}\n`)
    process.exit(response.status === 409 ? 3 : 2)
  }
  return payload?.data ?? payload
}

const pos = positional()
if (command === 'research' || command === 'research-platform') {
  try {
    const tool = command === 'research' ? 'product_video_research' : 'research_platform_connection'
    const parameters = {action: pos[0] || 'list', job_id: pos[1], platform: pos[1], input: await input()}
    process.stdout.write(JSON.stringify(await request(...researchRequest(tool, parameters)), null, 2) + '\n')
    process.exit(0)
  } catch (error) { fail(JSON.stringify({code:error.code, message:error.message}), 2) }
}
if (command === 'ae') {
  const { createRequire } = await import('node:module')
  const nodePath = await import('node:path')
  const registry = await readRegistry()
  const sourceRoot = option('--project-root') || registry?.source_root
  if (!sourceRoot) fail('AE requires the installed source root or --project-root')
  const bridge = createRequire(import.meta.url)(nodePath.join(sourceRoot, 'backend-node/src/services/afterEffectsJob.js'))
  try {
    let result
    if (pos[0] === 'discover') result = { executable: bridge.discover(), platform: process.platform }
    else if (pos[0] === 'read') result = bridge.read(nodePath.resolve(option('--output')))
    else if (pos[0] === 'run' || pos[0] === 'prepare') {
      if (!option('--input') || !option('--output')) fail('AE run/prepare needs --input job.json --output directory')
      result = pos[0] === 'run' ? await bridge.execute(await input(), option('--output')) : bridge.prepare(await input(), option('--output'))
    } else fail('AE: ae discover | ae run/prepare --input job.json --output DIR | ae read --output DIR')
    const summary = result?.status ? {status:result.status,error:result.error,project:result.project,outputs:result.outputs,reused:result.reused,layer_count:result.layer_count,keyframe_count:result.keyframe_count,elapsed_seconds:result.elapsed_seconds,receipt:nodePath.join(nodePath.resolve(option('--output')),'ae-receipt.json')} : result
    process.stdout.write(JSON.stringify(summary) + '\n')
    process.exit(result?.status === 'failed' ? 2 : 0)
  } catch (error) { fail(JSON.stringify({ code:error.code, message:error.message }), 2) }
}
const routes = {
  supervisors: ['GET', `/api/v1/media-supervisors?${new URLSearchParams({ q: option('--query') || '', include_deleted: args.includes('--include-deleted') })}`],
  supervisor: ['GET', `/api/v1/media-supervisors/${encodeURIComponent(pos[0] || '')}`],
  'supervisor-create': ['POST', '/api/v1/media-supervisors'],
  'supervisor-update': ['PUT', `/api/v1/media-supervisors/${encodeURIComponent(pos[0] || '')}`],
  'supervisor-delete': ['DELETE', `/api/v1/media-supervisors/${encodeURIComponent(pos[0] || '')}`],
  'supervisor-restore': ['POST', `/api/v1/media-supervisors/${encodeURIComponent(pos[0] || '')}/restore`],
  'supervisor-recommend': ['POST', '/api/v1/media-supervisors/recommend'],
  'supervisor-export': ['GET', `/api/v1/media-supervisors/export?${new URLSearchParams(Object.entries({ q: option('--query'), offset: option('--offset'), limit: option('--limit') }).filter(([,value]) => value !== undefined))}`],
  'supervisor-import': ['POST', '/api/v1/media-supervisors/import'],
  'task-supervisor': ['GET', `/api/v1/orchestration-sessions/${encodeURIComponent(pos[0] || '')}/supervisor`],
  'supervisor-select': ['PUT', `/api/v1/orchestration-sessions/${encodeURIComponent(pos[0] || '')}/supervisor`],
  'supervisor-review': ['POST', `/api/v1/orchestration-sessions/${encodeURIComponent(pos[0] || '')}/supervisor/reviews`],
  'prompt-profiles': ['GET', '/api/v1/prompt-adapter/profiles'],
  'prompt-adapt': ['POST', '/api/v1/prompt-adapter'],
  components: ['GET', '/api/v1/media-components/profile'],
  'local-run': ['POST', '/api/v1/local-media/jobs'],
  'local-job': ['GET', `/api/v1/local-media/jobs/${encodeURIComponent(pos[0] || '')}`],
  'local-resume': ['POST', `/api/v1/local-media/jobs/${encodeURIComponent(pos[0] || '')}/resume`],
  'tool-options': ['GET', `/api/v1/media-tool-options?${new URLSearchParams({q:option('--query')||'',category:option('--category')||'',limit:option('--limit')||'20',offset:option('--offset')||'0'})}`],
  'tool-option': ['GET', `/api/v1/media-tool-options/${encodeURIComponent(pos[0] || '')}`],
  experiences: ['GET', `/api/v1/media-experiences?${new URLSearchParams({q:option('--query')||'',module_id:option('--module')||'',session_id:option('--session')||'',limit:option('--limit')||'20',offset:option('--offset')||'0'})}`],
  experience: ['GET', `/api/v1/media-experiences/${encodeURIComponent(pos[0] || '')}`],
  'record-experience': ['POST', '/api/v1/media-experiences'],
  preferences: ['GET', '/api/v1/creative-preferences'],
  'set-preferences': ['PUT', '/api/v1/creative-preferences'],
  begin: ['POST', '/api/v1/orchestration-sessions/begin'],
  update: ['PATCH', `/api/v1/orchestration-sessions/${encodeURIComponent(pos[0] || '')}`],
  activity: ['POST', `/api/v1/orchestration-sessions/${encodeURIComponent(pos[0] || '')}/activity`],
  health: ['GET', '/health'],
  onboarding: ['GET', '/api/v1/orchestration-onboarding'],
  modules: ['GET', `/api/v1/orchestration-modules${option('--query') ? '?q=' + encodeURIComponent(option('--query')) : ''}`],
  'module-index': ['GET', '/api/v1/orchestration-modules?include_disabled=true'],
  module: ['GET', `/api/v1/orchestration-modules/${encodeURIComponent(pos[0] || '')}`],
  sessions: ['GET', '/api/v1/orchestration-sessions?limit=50'],
  get: ['GET', `/api/v1/orchestration-sessions/${encodeURIComponent(pos[0] || '')}?include_inactive=true&event_limit=500`],
  export: ['GET', `/api/v1/orchestration-sessions/${encodeURIComponent(pos[0] || '')}/export`],
  create: ['POST', '/api/v1/orchestration-sessions'],
  plan: ['PUT', `/api/v1/orchestration-sessions/${encodeURIComponent(pos[0] || '')}/plan`],
  confirm: ['POST', `/api/v1/orchestration-sessions/${encodeURIComponent(pos[0] || '')}/confirm`],
  start: ['POST', `/api/v1/orchestration-sessions/${encodeURIComponent(pos[0] || '')}/start`],
  node: ['PATCH', `/api/v1/orchestration-sessions/${encodeURIComponent(pos[0] || '')}/nodes/${encodeURIComponent(pos[1] || '')}`],
  retry: ['POST', `/api/v1/orchestration-sessions/${encodeURIComponent(pos[0] || '')}/nodes/${encodeURIComponent(pos[1] || '')}/retry`],
  pause: ['POST', `/api/v1/orchestration-sessions/${encodeURIComponent(pos[0] || '')}/pause`],
  resume: ['POST', `/api/v1/orchestration-sessions/${encodeURIComponent(pos[0] || '')}/resume`],
  checkpoint: ['POST', `/api/v1/orchestration-sessions/${encodeURIComponent(pos[0] || '')}/checkpoint`],
  event: ['POST', `/api/v1/orchestration-sessions/${encodeURIComponent(pos[0] || '')}/events`],
}

if (command === 'help' || !routes[command]) {
  process.stdout.write('Supervisors: supervisors [--query TEXT]; supervisor ID; supervisor-create/update/delete/restore/recommend/import --input FILE (update/delete/restore also ID); supervisor-export; task-supervisor SESSION; supervisor-select/review SESSION --input FILE\n')
  process.stdout.write('Prompts: prompt-profiles; prompt-adapt --input request.json (editable IR, references and constraints; no generation)\n')
  process.stdout.write('Catalog: module-index [--limit 60] [--offset 0] (all registered tools, compact pages); module MODULE_ID (one full contract)\n')
  process.stdout.write('AE: ae discover; ae run --input job.json --output DIR; ae read --output DIR (local visible editor)\n')
  process.stdout.write(`Usage: node scripts/orchestration-cli.mjs <command> [session-id] [node-key] [--input file]\nResearch: research create|list|get|records|brief|update|resume|cancel|handoff [JOB_ID] [--input file]; research-platform list|open|check|disconnect [PLATFORM]\nCommands: preferences set-preferences begin activity event health modules sessions get export create plan confirm start node retry pause resume checkpoint components local-run local-job local-resume experiences experience record-experience tool-options tool-option\nLocal: local-run --input request.json; local-job JOB_ID; local-resume JOB_ID; modules --query SEARCH\nOptions: tool-options [--query TEXT] [--category CATEGORY] [--limit 20]; tool-option ID\nExperiences: experiences [--query TEXT] [--module MODULE_ID] [--session SESSION_ID] [--limit 20] [--offset 0]; experience ID; record-experience --input note.json\n`)
  process.exit(command === 'help' ? 0 : 1)
}

if (['activity', 'get', 'export', 'plan', 'confirm', 'start', 'pause', 'resume', 'checkpoint'].includes(command) && !pos[0]) fail(`${command} 需要 session-id`)
if (['node', 'retry'].includes(command) && (!pos[0] || !pos[1])) fail(`${command} 需要 session-id 和 node-key/node-id`)
if (command === 'module' && !pos[0]) fail('module requires a module ID')
if (['supervisor','supervisor-update','supervisor-delete','supervisor-restore','task-supervisor','supervisor-select','supervisor-review'].includes(command) && !pos[0]) fail(`${command} requires an ID`)

if (command === 'begin') {
  const {ensure} = await import('../../../scripts/runtime-core.mjs')
  const runtime = await ensure({})
  base = runtime.api_base; discoveryPromise = Promise.resolve(base)
}
const [method, path] = routes[command]
const body = method === 'GET' ? undefined : await input()
if (command === 'activity') body.response_detail ||= 'summary'
const result = await request(method, path, body)
if (command === 'begin' && result?.session?.id) {
  result.frontend_url = `${base}/codex-console/${encodeURIComponent(result.session.id)}`
  if (!args.includes('--no-browser')) { const {openBrowser} = await import('../../../scripts/runtime-state.mjs'); result.browser = await openBrowser(result.frontend_url) }
}
let output = result
if (command === 'activity') output = activityResponse(result, body.response_detail)
if (command === 'module-index') {
  try { output = compactModuleIndex(result, {limit: option('--limit'), offset: option('--offset')}) }
  catch (error) { fail(error.message, 2) }
}
process.stdout.write(`${JSON.stringify(output, null, command === 'module-index' ? 0 : 2)}\n`)
