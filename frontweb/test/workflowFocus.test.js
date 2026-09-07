import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveWorkflowFocus } from '../src/utils/workflowFocus.js'

test('follows the new active shot and releases a stale manual pin', () => {
  assert.deepEqual(resolveWorkflowFocus({
    runId: 'run-1', activeScopeId: '1', selectedShotId: '1', pinned: true,
  }, {
    runId: 'run-1', activeScopeId: '2', validShotIds: ['1', '2', '3'],
  }), {
    selectedShotId: '2', pinned: false, shouldScroll: true,
    preserveViewport: false, reason: 'active_shot_changed',
  })
})

test('preserves a user-selected shot during ordinary polling', () => {
  assert.deepEqual(resolveWorkflowFocus({
    runId: 'run-1', activeScopeId: '2', selectedShotId: '1', pinned: true,
  }, {
    runId: 'run-1', activeScopeId: '2', validShotIds: ['1', '2', '3'],
  }), {
    selectedShotId: '1', pinned: true, shouldScroll: false,
    preserveViewport: true, reason: 'stable',
  })
})

test('selects the active shot without scrolling old viewport state into a new run', () => {
  const result = resolveWorkflowFocus({
    runId: 'run-1', activeScopeId: '3', selectedShotId: '3', pinned: true,
  }, {
    runId: 'run-2', activeScopeId: '1', validShotIds: ['1', '2'],
  })
  assert.equal(result.selectedShotId, '1')
  assert.equal(result.pinned, false)
  assert.equal(result.shouldScroll, false)
  assert.equal(result.preserveViewport, false)
})

test('falls back to the active or first available shot when the selection disappears', () => {
  const result = resolveWorkflowFocus({
    runId: 'run-1', activeScopeId: '2', selectedShotId: '9', pinned: true,
  }, {
    runId: 'run-1', activeScopeId: '2', validShotIds: ['1', '2'],
  })
  assert.equal(result.selectedShotId, '2')
  assert.equal(result.pinned, false)
  assert.equal(result.reason, 'selection_missing')
})
