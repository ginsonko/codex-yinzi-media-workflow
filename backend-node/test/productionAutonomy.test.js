const test = require('node:test');
const assert = require('node:assert/strict');

const autonomy = require('../src/services/productionAutonomy');

test('records consecutive failures across revisions of the same scoped object', () => {
  const base = { runtime: {}, budget: { max_text_revisions: 3 } };
  const first = autonomy.recordAttempt(base, {
    stage: 'script', scope_type: 'run', scope_id: '', kind: 'review', reason: '结构不完整',
  });
  const second = autonomy.recordAttempt({ ...base, runtime: first.runtime }, {
    stage: 'script', scope_type: 'run', scope_id: '', kind: 'review', reason: '人物动机仍不清楚',
  });
  assert.equal(second.count, 2);
  assert.equal(second.exhausted, false);
  assert.equal(second.object.attempts.length, 2);
})

test('escalates exactly at the configured object limit', () => {
  let run = { runtime: {}, budget: { max_image_revisions: 2 } };
  let result = autonomy.recordAttempt(run, {
    stage: 'asset_images', scope_type: 'character', scope_id: '1', reason: '外观不一致',
  });
  assert.equal(result.exhausted, false);
  run = { ...run, runtime: result.runtime };
  result = autonomy.recordAttempt(run, {
    stage: 'asset_images', scope_type: 'character', scope_id: '1', reason: '服装颜色仍错误',
  });
  assert.equal(result.exhausted, true);
  assert.equal(result.object.escalation_reason, 'automation_limit_reached');
})

test('keeps counters isolated by stage and scope', () => {
  const base = { runtime: {}, budget: {} };
  const first = autonomy.recordAttempt(base, {
    stage: 'shot_video', scope_type: 'shot', scope_id: '1', reason: '失败',
  });
  const other = autonomy.recordAttempt({ ...base, runtime: first.runtime }, {
    stage: 'shot_video', scope_type: 'shot', scope_id: '2', reason: '失败',
  });
  assert.equal(other.count, 1);
  assert.equal(Object.keys(other.runtime.autonomy.objects).length, 2);
})

test('classifies ambiguous and budget failures as hard stops', () => {
  assert.equal(autonomy.classifyFailure({ code: 'VIDEO_CREATE_AMBIGUOUS' }).recoverable, false);
  assert.equal(autonomy.classifyFailure({ code: 'VIDEO_SECONDS_BUDGET' }).stop_reason, 'budget_exhausted');
  assert.equal(autonomy.classifyFailure({ code: 'STAGE_HANDLER_PENDING' }).counts_as_failure, false);
  assert.equal(autonomy.classifyFailure({ code: 'VIDEO_DOWNLOAD_PENDING' }).category, 'workflow_wait');
})

test('classifies explicit video content-policy rejection separately from provider outages', () => {
  const moderation = autonomy.classifyFailure({
    stage: 'shot_video', code: 'VIDEO_GENERATION_FAILED', message: '400 content moderation rejected by safety policy',
  });
  assert.equal(moderation.category, 'content_moderation_failure');
  assert.equal(moderation.recoverable, true);
  assert.equal(moderation.allow_model_switch, true);
  const outage = autonomy.classifyFailure({
    stage: 'shot_video', code: 'VIDEO_GENERATION_FAILED', message: 'temporary provider outage',
  });
  assert.equal(outage.category, 'provider_or_content_failure');
})

test('keeps a stale local video-config binding error recoverable without switching models', () => {
  const binding = autonomy.classifyFailure({
    stage: 'shot_video', code: 'VIDEO_GENERATION_FAILED', message: '未配置视频模型',
  });
  assert.equal(binding.category, 'configuration_binding_failure');
  assert.equal(binding.recoverable, true);
  assert.equal(binding.allow_model_switch, false);

  const missing = autonomy.classifyFailure({
    stage: 'shot_video', code: 'VIDEO_CONFIG_UNAVAILABLE', message: '请重新选择视频配置',
  });
  assert.equal(missing.category, 'resource_unavailable');
  assert.equal(missing.recoverable, false);
})

test('stops deterministic unavailable routes without retrying the same model', () => {
  for (const message of [
    '图片生成请求失败: 503 - smartrouter: no eligible automatic route',
    'No available channel for model seedance-2.5-720p under group test',
    'Image generation is not enabled for this group',
  ]) {
    const result = autonomy.classifyFailure({
      stage: 'storyboard_images', code: 'IMAGE_GENERATION_FAILED', message,
    });
    assert.equal(result.category, 'resource_unavailable');
    assert.equal(result.recoverable, false);
    assert.equal(result.stop_reason, 'resource_unavailable');
    assert.equal(result.message, message);
  }

  const transient = autonomy.classifyFailure({
    stage: 'storyboard_images', code: 'IMAGE_GENERATION_FAILED', message: 'temporary provider timeout',
  });
  assert.equal(transient.category, 'provider_or_content_failure');
  assert.equal(transient.recoverable, true);
})

test('summarizes unavailable routes with a concrete non-retry next action', () => {
  const summary = autonomy.escalationSummary({
    stage: 'storyboard_images',
    last_failure: {
      error_code: 'IMAGE_GENERATION_FAILED',
      reason: '503 smartrouter: no eligible automatic route',
    },
    attempts: [{
      at: '2026-08-30T00:00:00.000Z', kind: 'generation', model: 'gpt-image-2',
      error_code: 'IMAGE_GENERATION_FAILED', reason: '503 smartrouter: no eligible automatic route',
    }],
  });
  assert.equal(summary.title, '当前模型暂无可用渠道');
  assert.equal(summary.normalized_category, 'resource_unavailable');
  assert.equal(summary.retryable, false);
  assert.deepEqual(summary.next_actions, ['switch_configured_channel', 'wait_for_provider_recovery']);
  assert.match(summary.suggestion, /停止重复提交/);
})

test('sanitizes keys, authorization values and local paths before diagnostics', () => {
  const value = autonomy.sanitizeFailureText(
    'Authorization: Bearer abc.def api_key=sk-secretvalue C:\\private\\project\\file.png failed'
  );
  assert.equal(value.includes('sk-secretvalue'), false);
  assert.equal(value.includes('abc.def'), false);
  assert.equal(value.includes('C:\\private'), false);
  assert.match(value, /\[REDACTED\]/);
})
