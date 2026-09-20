import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../src/views/CodexOrchestration.vue', import.meta.url), 'utf8')
const start = source.indexOf('let bundleRead = 0')
const body = source.slice(start, source.indexOf('async function loadExperience', start))
function fixture() {
  const pending = []
  const context = { orchestrationAPI: { get: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) } }
  for (const name of ['selectedId', 'bundle', 'detailError', 'detailLoading', 'lastUpdated', 'refreshError', 'artifacts', 'artifactsError', 'delivery', 'blenderInspect', 'blenderJobs']) context[name] = { value: null }
  context.selectedId.value = 'A'
  context.detailLoading.value = false
  vm.createContext(context)
  vm.runInContext(body, context)
  return { context, pending }
}

test('leaving a pending task clears its spinner and ignores late success or failure', async () => {
  for (const outcome of ['resolve', 'reject']) {
    const { context: c, pending } = fixture()
    const read = c.loadBundle()
    assert.equal(c.detailLoading.value, true)
    c.selectedId.value = ''
    await c.loadBundle()
    pending[0][outcome](outcome === 'resolve' ? { session: { id: 'A' } } : new Error('late failure'))
    await read
    assert.equal(c.detailLoading.value, false)
    assert.equal(c.bundle.value, null)
    assert.equal(c.detailError.value, null)
  }
})

test('a slow earlier snapshot cannot erase newer artifacts from the same task', async () => {
  const { context: c, pending } = fixture()
  const older = c.loadBundle(), newer = c.loadBundle(true)
  const result = { session: { id: 'A' }, artifacts: [{ artifact_id: 'cut-v2' }], delivery: {} }
  pending[1].resolve(result)
  await newer
  pending[0].resolve({ session: { id: 'A' }, artifacts: [] })
  await older
  assert.equal(c.bundle.value, result)
  assert.equal(c.artifacts.value[0].artifact_id, 'cut-v2')
  assert.equal(c.detailLoading.value, false)
})
