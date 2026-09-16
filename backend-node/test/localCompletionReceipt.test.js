const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { createOrchestrationService } = require('../src/services/orchestrationService');
const { createLocalMediaJobs } = require('../src/services/localMediaJobs');

function fixture(options = {}) {
  const root = path.resolve(__dirname, '../../evidence', crypto.randomUUID());
  fs.mkdirSync(root, { recursive: true });
  const db = new Database(path.join(root, 'isolated.sqlite'));
  const service = createOrchestrationService(db);
  const id = service.createSession({ user_goal: 'Isolated local completion receipt test' }).session.id;
  service.submitPlan(id, { confirm: true, nodes: [{ node_key: 'edit', module_id: 'local.image.resize' }] });
  service.startSession(id);
  const input = path.join(root, 'input.fixture'); fs.writeFileSync(input, 'deterministic test input');
  let calls = 0;
  const jobs = createLocalMediaJobs(db, { storage: { local_path: root } }, service, {
    manager: {}, experiences: { recordJob() {} },
    execute: async (request, context) => {
      calls++;
      if (request.parameters.width === 99 || options.failFirst && calls === 1) throw Object.assign(Error('Fixture local validation failure'), { code: 'FIXTURE_FAILED' });
      fs.mkdirSync(context.outputDir, { recursive: true });
      const output = path.join(context.outputDir, 'result.fixture');
      const bytes = Buffer.from(`test executor output ${calls}`); fs.writeFileSync(output, bytes);
      return { output_path: output, bytes: bytes.length, output_sha256: crypto.createHash('sha256').update(bytes).digest('hex'), details: options.review ? { quality_status: 'review_required' } : {} };
    },
  });
  const body = key => ({ session_id: id, node_key: 'edit', module_id: 'local.image.resize', input_path: input, request_key: key });
  return { db, jobs, service, id, body, calls: () => calls, close: async () => { await jobs.close(); db.close(); } };
}

test('new-key local retry creates a new attempt and a success receipt, preserving the failed receipt', async () => {
  const f = fixture();
  try {
    const failed = f.jobs.create({ ...f.body('first'), parameters: { width: 99 } });
    await f.jobs.waitForIdle();
    const oldReceipt = f.service.listReceipts(f.id)[0];
    assert.equal(oldReceipt.status, 'failed'); assert.equal(oldReceipt.attempt, 1);
    const next = f.jobs.create({ ...f.body('fixed-input'), parameters: { width: 80 } });
    await f.jobs.waitForIdle();
    const node = f.service.listNodes(f.id)[0], receipts = f.service.listReceipts(f.id);
    assert.equal(node.status, 'succeeded'); assert.equal(node.attempt, 2); assert.deepEqual(node.error, {});
    assert.deepEqual(receipts[0], oldReceipt);
    assert.equal(receipts.length, 2); assert.equal(receipts[1].status, 'success'); assert.equal(receipts[1].attempt, 2);
    assert.equal(receipts[1].correlation_id, next.id); assert.equal(receipts[1].source, 'local-media-executor');
    assert.equal([...f.service.getBundle(f.id).receipts].reverse().find(item => item.node_id === node.id).status, 'success');
    assert.equal(f.jobs.get(failed.id).status, 'failed'); assert.equal(f.jobs.get(next.id).status, 'succeeded');
    assert.equal(f.jobs.create({ ...f.body('fixed-input'), parameters: { width: 80 } }).reused, true);
    assert.equal(f.service.listNodes(f.id)[0].attempt, 2); assert.equal(f.calls(), 2);
  } finally { await f.close(); }
});

test('resuming the same failed job writes the next attempt success without an extra increment', async () => {
  const f = fixture({ failFirst: true });
  try {
    const job = f.jobs.create(f.body('resume')); await f.jobs.waitForIdle();
    assert.equal(f.jobs.get(job.id).status, 'failed');
    f.jobs.resume(job.id); await f.jobs.waitForIdle();
    assert.equal(f.jobs.get(job.id).status, 'succeeded'); assert.equal(f.jobs.get(job.id).attempt, 2);
    assert.equal(f.service.listNodes(f.id)[0].attempt, 2);
    assert.deepEqual(f.service.listReceipts(f.id).map(r => [r.attempt, r.status]), [[1, 'failed'], [2, 'success']]);
    assert.equal(f.jobs.resume(job.id).reused, true); assert.equal(f.service.listReceipts(f.id).length, 2);
  } finally { await f.close(); }
});

test('review-required output receipt reports technical completion without claiming content approval', async () => {
  const f = fixture({ review: true });
  try {
    const job = f.jobs.create(f.body('review')); await f.jobs.waitForIdle();
    const receipt = f.service.listReceipts(f.id)[0];
    assert.equal(receipt.status, 'success'); assert.equal(receipt.correlation_id, job.id);
    assert.match(receipt.message, /内容仍待核对/); assert.deepEqual(receipt.next_actions, ['inspect_media']);
    assert.equal(f.service.listArtifacts(f.id)[0].status, 'review_required');
  } finally { await f.close(); }
});

test('failed execution never emits a success receipt', async () => {
  const f = fixture();
  try {
    f.jobs.create({ ...f.body('failure'), parameters: { width: 99 } }); await f.jobs.waitForIdle();
    assert.deepEqual(f.service.listReceipts(f.id).map(r => r.status), ['failed']);
    assert.equal(f.service.listArtifacts(f.id).length, 0);
  } finally { await f.close(); }
});

test('explicit new local job after success starts the next attempt while request reuse stays idempotent', async () => {
  const f = fixture();
  try {
    const first = f.jobs.create(f.body('one')); await f.jobs.waitForIdle();
    assert.equal(f.jobs.create(f.body('one')).id, first.id); assert.equal(f.service.listNodes(f.id)[0].attempt, 1);
    const second = f.jobs.create(f.body('two')); await f.jobs.waitForIdle();
    assert.equal(f.service.listNodes(f.id)[0].attempt, 2);
    assert.deepEqual(f.service.listReceipts(f.id).map(r => [r.attempt, r.correlation_id]), [[1, first.id], [2, second.id]]);
    assert.equal(f.calls(), 2);
  } finally { await f.close(); }
});
