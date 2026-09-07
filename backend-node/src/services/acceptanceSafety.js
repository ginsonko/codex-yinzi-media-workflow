const fs = require('node:fs');
const path = require('node:path');

const VIDEO_SUBMIT_GUARD_ENV = 'YINZI_ACCEPTANCE_DISABLE_VIDEO_SUBMIT';
const VIDEO_SUBMIT_RECEIPT_ENV = 'YINZI_ACCEPTANCE_VIDEO_GUARD_RECEIPT';

function truthy(value) {
  return new Set(['1', 'true', 'yes', 'on']).has(String(value || '').trim().toLowerCase());
}

function videoSubmitDisabled() {
  return truthy(process.env[VIDEO_SUBMIT_GUARD_ENV]);
}

function appendReceipt(context) {
  const receiptPath = String(process.env[VIDEO_SUBMIT_RECEIPT_ENV] || '').trim();
  if (!receiptPath) return;
  try {
    const absolute = path.resolve(receiptPath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.appendFileSync(absolute, `${JSON.stringify({
      event: 'video_submit_blocked_for_acceptance',
      observed_at: new Date().toISOString(),
      context: context && typeof context === 'object' ? context : {},
    })}\n`, 'utf8');
  } catch (_) {
    // A receipt failure must never weaken the stop condition.
  }
}

function assertVideoSubmitAllowed(context = {}) {
  if (!videoSubmitDisabled()) return;
  appendReceipt(context);
  const error = new Error('当前处于验收保护模式：已在向视频上游提交前停止，没有发起视频生成请求。');
  error.code = 'VIDEO_SUBMIT_DISABLED_FOR_ACCEPTANCE';
  error.http_status = 423;
  error.acceptance_guard = true;
  throw error;
}

module.exports = {
  VIDEO_SUBMIT_GUARD_ENV,
  VIDEO_SUBMIT_RECEIPT_ENV,
  videoSubmitDisabled,
  assertVideoSubmitAllowed,
};
