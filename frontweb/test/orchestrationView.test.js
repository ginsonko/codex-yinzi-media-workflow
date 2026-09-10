import test from 'node:test'
import assert from 'node:assert/strict'
import { canDirectlyRetryNode, formatBudgetTruth, latestReceipt, moduleAvailabilityLabel, nodeNextActions, progressLabel, providerFailureGuidance, normalizeRetryability, statusLabel, summarizeCounts } from '../src/utils/orchestrationView.js'

test('orchestration view never invents provider progress', () => {
  assert.match(progressLabel({ status: 'running', progress: {} }), /不显示虚假百分比/)
  assert.equal(progressLabel({ status: 'running', progress: { state: 'provider_ack' } }), '服务商已接收，等待真实状态')
})

test('orchestration view keeps unknown modules actionable', () => {
  assert.match(moduleAvailabilityLabel({ module_contract_status: 'unknown' }), /允许人工处理/)
  assert.deepEqual(nodeNextActions({ status: 'failed' }, { retryable: 'unknown', next_actions: [] }), ['skip'])
  assert.equal(statusLabel('waiting_confirmation', true), '等待确认')
})

test('retryability never treats the string false as truthy', () => {
  assert.equal(normalizeRetryability({ retryable: 'true' }), true)
  assert.equal(normalizeRetryability({ retryable: 'false' }), false)
  assert.equal(normalizeRetryability({ retryable: 'unexpected' }), 'unknown')
  assert.equal(canDirectlyRetryNode({ status: 'failed' }, { retryable: 'false' }), false)
  assert.equal(canDirectlyRetryNode({ status: 'failed' }, { retryable: 'true' }), true)
})

test('route contract failures explain configuration repair and block direct retry', () => {
  const receipt = {
    retryable: false,
    normalized_category: 'provider_route_contract_missing',
    next_actions: ['replace_with_video_enabled_key', 'repair_yinzi_smart_router_video_contract'],
  }
  const guidance = providerFailureGuidance({ status: 'failed' }, receipt)
  assert.equal(guidance.kind, 'configuration_required')
  assert.equal(guidance.action, 'open_ai_config')
  assert.equal(guidance.direct_retry_allowed, false)
  assert.match(guidance.summary, /沿原任务继续/)
  assert.deepEqual(nodeNextActions({ status: 'failed' }, receipt), ['skip'])
})

test('image configuration and input repair do not turn into video-key discovery gates', () => {
  const config = providerFailureGuidance({ status: 'failed' }, { normalized_category: 'configuration_required', retryable: false })
  assert.equal(config.title, '当前步骤需要补全配置')
  assert.doesNotMatch(config.steps.join(' '), /新建|能返回视频模型/)
  const input = providerFailureGuidance({ status: 'failed' }, { retryable: true, next_actions: ['repair_reference_asset'] })
  assert.equal(input.kind, 'retryable')
  assert.match(input.summary, /待执行状态/)
})

test('unknown failures keep manual recovery without unsafe automatic retry', () => {
  const guidance = providerFailureGuidance({ status: 'partial' }, { original_code: 'future_error' })
  assert.equal(guidance.kind, 'manual_review')
  assert.equal(guidance.direct_retry_allowed, false)
  assert.match(guidance.summary, /人工判断/)
})

test('successful or running nodes do not expose failure guidance', () => {
  assert.equal(providerFailureGuidance({ status: 'succeeded' }, { retryable: false }), null)
  assert.equal(providerFailureGuidance({ status: 'running' }, { retryable: true }), null)
})

test('orchestration view summarizes real terminal counts and receipts', () => {
  assert.deepEqual(summarizeCounts({ succeeded: 2, skipped: 1, failed: 1 }), { all: 4, done: 4, percent: 100 })
  assert.deepEqual(summarizeCounts({ succeeded: 1, failed: 1, running: 1 }), { all: 3, done: 2, percent: 67 })
  const found = latestReceipt({ receipts: [{ node_id: 'a', attempt: 1 }, { node_id: 'a', attempt: 2 }] }, 'a')
  assert.equal(found.attempt, 2)
})

test('orchestration view treats an explicit zero budget as a no-spend boundary', () => {
  assert.equal(formatBudgetTruth({ maximum: 0, currency: 'CNY' }), '预算上限 0 CNY；禁止付费调用')
  assert.equal(formatBudgetTruth({ max_cost_usd: 12 }), '预算上限 12.00 USD')
  assert.match(formatBudgetTruth({}), /未设置费用上限/)
})
