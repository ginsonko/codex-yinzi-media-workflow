import { test } from 'node:test'
import assert from 'node:assert/strict'
import { componentStatus } from '../src/utils/componentStatus.js'

test('authoritative ready copy remains usable after failed preparation', () => {
  const state = componentStatus({ status: 'ready', status_source: 'component_runtime', available: true, progress: { stage: 'failed', message: '下载超时' } })
  assert.equal(state.status, 'ready')
  assert.equal(state.active, false)
  assert.match(state.detail, /仍可使用/)
  assert.match(state.detail, /下载超时/)
})

test('interrupted and invalid files do not become permanently installing from stale progress', () => {
  for (const status of ['interrupted', 'repair_required']) {
    const state = componentStatus({ status, status_source: 'component_runtime', progress: { stage: 'download', percent: 35 } })
    assert.equal(state.status, status)
    assert.equal(state.active, false)
    assert.equal(state.percent, null)
  }
})

test('legacy response still explains a failed preparation instead of claiming ready', () => {
  assert.equal(componentStatus({ status: 'ready', progress: { stage: 'failed' } }).status, 'failed')
})
