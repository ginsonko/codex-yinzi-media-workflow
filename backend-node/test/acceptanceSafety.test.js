const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const safety = require('../src/services/acceptanceSafety');

describe('acceptance video-submit safety guard', () => {
  it('is inert unless the acceptance environment explicitly enables it', () => {
    const previous = process.env[safety.VIDEO_SUBMIT_GUARD_ENV];
    delete process.env[safety.VIDEO_SUBMIT_GUARD_ENV];
    try {
      assert.equal(safety.videoSubmitDisabled(), false);
      assert.doesNotThrow(() => safety.assertVideoSubmitAllowed({ entry: 'unit' }));
    } finally {
      if (previous == null) delete process.env[safety.VIDEO_SUBMIT_GUARD_ENV];
      else process.env[safety.VIDEO_SUBMIT_GUARD_ENV] = previous;
    }
  });

  it('blocks before provider submission and writes a local receipt', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-video-guard-'));
    const receipt = path.join(temp, 'blocked.jsonl');
    const priorGuard = process.env[safety.VIDEO_SUBMIT_GUARD_ENV];
    const priorReceipt = process.env[safety.VIDEO_SUBMIT_RECEIPT_ENV];
    process.env[safety.VIDEO_SUBMIT_GUARD_ENV] = '1';
    process.env[safety.VIDEO_SUBMIT_RECEIPT_ENV] = receipt;
    try {
      assert.throws(
        () => safety.assertVideoSubmitAllowed({ entry: 'unit', model: 'seedance-test' }),
        (error) => error.code === 'VIDEO_SUBMIT_DISABLED_FOR_ACCEPTANCE'
          && error.http_status === 423
          && error.acceptance_guard === true
      );
      const rows = fs.readFileSync(receipt, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].event, 'video_submit_blocked_for_acceptance');
      assert.equal(rows[0].context.entry, 'unit');
      assert.equal(rows[0].context.model, 'seedance-test');
    } finally {
      if (priorGuard == null) delete process.env[safety.VIDEO_SUBMIT_GUARD_ENV];
      else process.env[safety.VIDEO_SUBMIT_GUARD_ENV] = priorGuard;
      if (priorReceipt == null) delete process.env[safety.VIDEO_SUBMIT_RECEIPT_ENV];
      else process.env[safety.VIDEO_SUBMIT_RECEIPT_ENV] = priorReceipt;
    }
  });
});
