import test from 'node:test'
import assert from 'node:assert/strict'
import { describeWorkActivity, selectExecutionActivity } from '../src/utils/workActivity.js'
import { progressFromNodes } from '../src/utils/orchestrationExperience.js'

const now = Date.parse('2026-09-09T15:00:00Z')
const session = { status: 'running', updated_at: new Date(now).toISOString(), source_context: { activity: { stage: 'create', state: 'working', message: '准备320项', updated_at: '2026-09-09T14:50:00Z' } } }

test('polling or changing the session does not turn stale agent activity into live work', () => {
  const view = describeWorkActivity(session, [], now)
  assert.equal(view.label, '暂未收到新进展')
  assert.equal(view.lastMessage, '准备320项')
  assert.equal(describeWorkActivity({ status: 'running' }, [], now).stale, true)
})
test('a submitted provider task remains visible when the agent report is old', () => {
  const view = describeWorkActivity(session, [{ status: 'running', progress: { state: 'provider_processing', message: '等待模型原任务' } }], now)
  assert.equal(view.label, '模型处理中')
  assert.equal(view.message, '等待模型原任务')
})
test('an uncertain submission is not shown as successful generation or a safe retry', () => {
  const view = describeWorkActivity(session, [{ status: 'running', progress: { submission_state: 'uncertain', message: '连接超时' } }], now)
  assert.equal(view.label, '提交结果待核对')
  assert.match(view.next, /避免重复提交/)
})
test('paused and finished tasks override the previous working stage', () => {
  assert.equal(describeWorkActivity({ ...session, status: 'paused' }, [], now).label, '后续步骤已暂停')
  assert.equal(describeWorkActivity({ ...session, status: 'partial' }, [], now).label, '任务已结束')
})
test('explicit waits and inactive nodes do not appear as active production', () => {
  const waiting = { ...session, source_context: { activity: { state: 'waiting', updated_at: new Date(now).toISOString() } } }
  assert.equal(describeWorkActivity(waiting, [{ active: false, status: 'running', progress: { state: 'provider_processing' } }], now).label, '等待中')
})

test('a current accepted task is visible alongside older uncertain submissions', () => {
  const nodes = [
    { node_key: 'old', status: 'running', updated_at: '2026-09-08T01:00:00Z', progress: { submission_state: 'uncertain', message: '旧提交超时' } },
    { node_key: 'accepted', status: 'running', updated_at: '2026-09-09T14:59:00Z', progress: { state: 'provider_processing', submission_state: 'accepted', message: '新视频正在生成' } },
  ]
  const view = describeWorkActivity(session, nodes, now)
  assert.equal(view.label, '模型处理中')
  assert.equal(view.message, '新视频正在生成')
  assert.match(view.notice, /1 笔提交结果待核对/)
  assert.equal(progressFromNodes(nodes).current.node_key, 'accepted')
  assert.equal(nodes[0].node_key, 'old')
})

test('unknown outcomes cannot become active production from a stale processing field', () => {
  const node = { status: 'running', progress: { state: 'provider_processing', submission_state: 'ambiguous' } }
  const selected = selectExecutionActivity([node, { status: 'failed', progress: { state: 'provider_processing' } }, { active: false, status: 'running', progress: { state: 'downloading' } }])
  assert.equal(selected.backend, undefined)
  assert.equal(selected.unknown.length, 1)
  assert.equal(describeWorkActivity(session, [node], now).label, '提交结果待核对')
})

test('the newest real backend update wins and pause still overrides it', () => {
  const nodes = [
    { status: 'running', updated_at: '2026-09-09T14:58:00Z', progress: { state: 'provider_processing' } },
    { node_key: 'download', status: 'running', updated_at: '2026-09-09T14:59:00Z', progress: { state: 'downloading', message: '正在下载原结果' } },
  ]
  assert.equal(selectExecutionActivity(nodes).backend.node_key, 'download')
  assert.equal(describeWorkActivity(session, nodes, now).label, '正在下载结果')
  assert.equal(describeWorkActivity({ ...session, status: 'paused' }, nodes, now).label, '后续步骤已暂停')
})
