import assert from 'node:assert/strict'
import {test} from 'node:test'
import http from 'node:http'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {compactModuleIndex} from '../skills/codex-yinzi-universal-video/scripts/module-index.mjs'

const moduleRecord = (index, extra = {}) => ({module_id:`local.tool.${index}`, title:`Tool ${index}`,
  phase:'edit', availability:index % 2 ? 'external_bridge' : 'local_executor',
  installed:false, enabled:index % 3 !== 0, description:'Media operation',
  parameters:{large_schema:'x'.repeat(12000)}, ...extra})

test('compact pages cover all 1001 registered tools including disabled and uninstalled ones', () => {
  const items = Array.from({length:1001}, (_, i) => moduleRecord(i))
  const catalog = {items, total:items.length}
  let offset = 0
  const seen = [], fingerprints = new Set()
  do {
    const page = compactModuleIndex(catalog, {offset})
    assert.ok(page.rows.length <= 60)
    assert.equal(page.total, 1001)
    assert.equal(page.disabled_count, 334)
    assert.ok(!JSON.stringify(page).includes('large_schema'))
    seen.push(...page.rows.map(row => row[0]))
    fingerprints.add(page.catalog_fingerprint)
    offset = page.next_offset
  } while (offset !== null)
  assert.equal(new Set(seen).size, 1001)
  assert.equal(fingerprints.size, 1)
  assert.ok(seen.includes('local.tool.0'))
})

test('catalog changes are detected even when only hidden contract parameters change', () => {
  const items = [moduleRecord(1), moduleRecord(2)]
  const before = compactModuleIndex({items}).catalog_fingerprint
  assert.equal(compactModuleIndex({items:[...items].reverse()}).catalog_fingerprint, before)
  items[0].parameters.format = 'png'
  assert.notEqual(compactModuleIndex({items}).catalog_fingerprint, before)
})

test('empty and final pages terminate, Unicode summaries remain valid, bad catalogs do not claim coverage', () => {
  assert.equal(compactModuleIndex({items:[]}).next_offset, null)
  assert.deepEqual(compactModuleIndex({items:[moduleRecord(0)]}, {offset:5}).rows, [])
  const title = String.fromCodePoint(0x1f3ac).repeat(181)
  const page = compactModuleIndex({items:[moduleRecord(0, {description:title})]})
  assert.equal([...page.rows[0][5]].length, 180)
  assert.ok(!page.rows[0][5].includes('\ufffd'))
  assert.throws(() => compactModuleIndex({items:[], total:9}), /incomplete/)
  assert.throws(() => compactModuleIndex({items:[{}]}), /module ID/)
  assert.throws(() => compactModuleIndex({items:[moduleRecord(0), moduleRecord(0)]}), /duplicate/)
  for (const options of [{limit:0}, {limit:101}, {limit:'bad'}, {offset:-1}, {offset:1.5}]) {
    assert.throws(() => compactModuleIndex({items:[]}, options), /integer/)
  }
})

test('real CLI requests an unfiltered registry and prints only the selected compact page', async t => {
  const requests = []
  const items = [moduleRecord(0), moduleRecord(1), moduleRecord(2)]
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/health') return res.end(JSON.stringify({status:'ok'}))
    if (req.url === '/api/v1/runtime-identity') return res.end(JSON.stringify({data:{schema:'test',orchestration_router:true}}))
    if (req.url.includes('__codex_capability_probe__')) {
      res.statusCode=404
      return res.end(JSON.stringify({error:{code:'ORCHESTRATION_NOT_FOUND'}}))
    }
    if (req.url === '/api/v1/orchestration-modules?include_disabled=true') return res.end(JSON.stringify({data:{items,total:items.length}}))
    if (req.url === '/api/v1/orchestration-modules/local.tool.1') return res.end(JSON.stringify({data:items[1]}))
    res.statusCode=404; res.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const cli = fileURLToPath(new URL('../skills/codex-yinzi-universal-video/scripts/orchestration-cli.mjs', import.meta.url))
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli,...args], {windowsHide:true,
      env:{...process.env,YINZI_WORKFLOW_URL:`http://127.0.0.1:${server.address().port}`}})
    let stdout='', stderr=''
    child.stdout.on('data', chunk => {stdout += chunk})
    child.stderr.on('data', chunk => {stderr += chunk})
    child.on('error', reject)
    child.on('close', code => resolve({code,stdout,stderr}))
  })
  const compact = await run(['module-index','--offset','1','--limit','1'])
  assert.equal(compact.code, 0, compact.stderr)
  const page = JSON.parse(compact.stdout)
  assert.equal(page.total, 3)
  assert.equal(page.next_offset, 2)
  assert.deepEqual(page.rows.map(row => row[0]), ['local.tool.1'])
  assert.ok(compact.stdout.length < 1000)
  const detail = await run(['module','local.tool.1'])
  assert.equal(detail.code, 0, detail.stderr)
  assert.equal(JSON.parse(detail.stdout).parameters.large_schema.length, 12000)
  assert.ok(requests.includes('/api/v1/orchestration-modules?include_disabled=true'))
  const missing = await run(['module'])
  assert.notEqual(missing.code, 0)
})
