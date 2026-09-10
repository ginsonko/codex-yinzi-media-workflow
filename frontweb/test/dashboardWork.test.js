import test from 'node:test'
import assert from 'node:assert/strict'
import { dashboardBatchMessage, dashboardBundle, dashboardDetailTargets, selectDashboardSession } from '../src/utils/dashboardWork.js'

test('the active task beyond the recent six still gets its own detail request', () => {
  const sessions = Array.from({ length: 7 }, (_, i) => ({ id: String(i), status: i === 6 ? 'running' : 'succeeded' }))
  const current = selectDashboardSession(sessions)
  const targets = dashboardDetailTargets(sessions)
  assert.equal(current.id, '6')
  assert.equal(targets.length, 6)
  assert.equal(targets[0].id, '6')
  assert.equal(sessions[0].id, '0')
})

test('missing or failed current details never borrow another task nodes', () => {
  const unrelated = { session: { id: 'finished' }, nodes: [{ status: 'succeeded' }] }
  assert.equal(dashboardBundle({ id: 'running' }, [unrelated]), null)
  assert.equal(dashboardBundle(null, [unrelated]), null)
  const own = { session: { id: 'running' }, nodes: [{ status: 'pending' }] }
  assert.equal(dashboardBundle({ id: 'running' }, [unrelated, own]), own)
})

test('a newer active batch keeps dashboard focus and paused copy preserves existing jobs', () => {
  assert.equal(selectDashboardSession([{ id: 'a', status: 'running', created_at: '2026-01-01' }], [{ status: 'paused', created_at: '2026-01-02' }]), null)
  assert.match(dashboardBatchMessage({ status: 'paused' }), /后续提交已暂停/)
  assert.match(dashboardBatchMessage({ status: 'paused' }), /已提交的任务保留/)
  assert.match(dashboardBatchMessage({ status: 'queued' }), /等待后台/)
  assert.match(dashboardBatchMessage({ status: 'needs_review' }), /核对/)
})
