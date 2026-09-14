const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { createOrchestrationService } = require('../src/services/orchestrationService');

// The fixture opens only new databases beneath this candidate directory.
// Real SQLite, real service/API, and actual catalog/preferences modules; no
// provider calls, server startup, production configuration or runtime database.
const evidenceDir = path.resolve(__dirname, '../../evidence/sqlite');
fs.mkdirSync(evidenceDir, { recursive: true });
let db, service, dbFile;
beforeEach(() => {
  dbFile = path.join(evidenceDir, `${crypto.randomUUID()}.sqlite`);
  db = new Database(dbFile);
  db.exec(`CREATE TABLE video_generations (
    id INTEGER PRIMARY KEY, status TEXT, generation_status TEXT,
    submission_status TEXT, provider_task_id TEXT, task_id TEXT,
    prompt_contract_json TEXT, submission_receipt_json TEXT);
    CREATE TABLE image_generations (
    id INTEGER PRIMARY KEY, status TEXT, generation_status TEXT,
    submission_status TEXT, provider_task_id TEXT, task_id TEXT);`);
  service = createOrchestrationService(db);
});
afterEach(() => db.close());

function setup(moduleId = 'video.generate') {
  const id = service.createSession({ user_goal: 'Isolated retry reliability test' }).session.id;
  service.submitPlan(id, { confirm: true, nodes: [{ node_key: 'work', module_id: moduleId, input_refs: [{ id: 'source-v1' }], decision: { user_note: 'preserve this setting' } }] });
  service.startSession(id);
  return id;
}
function reserve(id, hash = 'request-one', decision = {}) {
  return service.reserveExternalRequest(id, 'work', { request_hash: hash, decision: { paid: true, idempotency_key: hash, request: { prompt: 'original prompt' }, ...decision } });
}
function generation(hash, submission = 'rejected', status = 'failed', providerTask = null) {
  db.prepare('INSERT INTO video_generations VALUES (1,?,?,?,?,?,?,?)').run(status, status, submission, providerTask, 'local-one', JSON.stringify({ orchestration_request_hash: hash }), JSON.stringify({ status: submission, request_id: 'receipt-one' }));
}
function fail(id, state = 'rejected', decision = {}, outputRefs = [{ type: 'video_generation', id: '1' }, { type: 'async_task', id: 'local-one' }]) {
  return service.actOnNode(id, 'work', 'fail', {
    progress: { state: 'failed', submission_state: state },
    decision: { ...service.listNodes(id)[0].decision, ...decision }, output_refs: outputRefs,
    message: 'Fixture failure', retryable: 'true',
  });
}

test('definite rejection releases only active attempt links and keeps all history', () => {
  const id = setup();
  const definitionDecision = service.listNodes(id)[0].decision;
  reserve(id, 'request-one', { custom_executor_field: 'attempt-specific' });
  generation('request-one');
  fail(id, 'rejected', { provider_result: { generation: { id: 1, status: 'failed', submission_status: 'rejected' } }, cost_outcome: 'old-cost-result' });
  service.recordArtifact(id, { artifact_id: 'old-evidence', type: 'report', path: 'old-evidence.json' });
  const oldGeneration = db.prepare('SELECT * FROM video_generations').all();
  const oldReceipts = service.listReceipts(id);
  const retried = service.retryNode(id, 'work').node;
  assert.equal(retried.attempt, 2);
  assert.equal(retried.request_hash, null);
  assert.deepEqual(retried.output_refs, []);
  assert.deepEqual(retried.decision, definitionDecision);
  assert.equal(reserve(id, 'request-two').reserved, true);
  assert.deepEqual(db.prepare('SELECT * FROM video_generations').all(), oldGeneration);
  assert.deepEqual(service.listReceipts(id), oldReceipts);
  assert.equal(service.listArtifacts(id).length, 1);
  const archive = service.listEvents(id).find(event => event.event_type === 'node.attempt_archived');
  assert.equal(archive.payload.node.request_hash, 'request-one');
  assert.equal(archive.payload.node.decision.provider_result.generation.id, 1);
  assert.equal(archive.payload.node.output_refs[0].id, '1');
});

test('same-attempt duplicate reservation never submits twice', () => {
  const id = setup(); reserve(id);
  assert.equal(reserve(id).reserved, false);
  assert.equal(reserve(id).reconciliation_required, true);
  assert.equal(service.listEvents(id).filter(event => event.event_type === 'node.external_request_reserved').length, 1);
  assert.throws(() => reserve(id, 'different'), { code: 'REQUEST_HASH_CONFLICT' });
});

test('retired request identity cannot be recycled after retry', () => {
  const id = setup(); reserve(id); generation('request-one'); fail(id);
  service.retryNode(id, 'work');
  assert.throws(() => reserve(id), { code: 'REQUEST_HASH_RETIRED' });
  assert.equal(reserve(id, 'request-two').reserved, true);
});

for (const [submission, status, providerTask] of [
  ['ambiguous', 'failed', null], ['submitting', 'processing', null],
  ['accepted', 'processing', 'provider-one'], ['not_sent', 'pending', null],
]) test(`durable ${submission}/${status} survives legacy erased progress and process restart`, () => {
  const id = setup(); reserve(id); generation('request-one', submission, status, providerTask);
  fail(id, 'rejected'); // Deliberately stale and misleading local state.
  const row = service.listNodes(id)[0];
  db.prepare("UPDATE orchestration_nodes SET status='ready',attempt=attempt+1,progress_json='{}',error_json='{}',output_refs_json='[]',decision_json='{}' WHERE id=?").run(row.id);
  db.close(); db = new Database(dbFile); service = createOrchestrationService(db);
  const before = service.getBundle(id);
  assert.throws(() => service.retryNode(id, 'work', { force: true }), { code: 'EXTERNAL_REQUEST_UNRESOLVED' });
  assert.throws(() => service.actOnNode(id, 'work', 'reopen'), { code: 'EXTERNAL_REQUEST_UNRESOLVED' });
  assert.deepEqual(service.getBundle(id), before);
  assert.equal(reserve(id).reserved, false);
  assert.equal(reserve(id).reconciliation_required, true);
  assert.throws(() => reserve(id, 'request-two'), { code: 'REQUEST_HASH_CONFLICT' });
});

test('decision evidence protects unknown requests without generation tables or progress', () => {
  const id = setup(); reserve(id);
  fail(id, 'uncertain', { provider_result: { generation: { submission_status: 'ambiguous', status: 'failed' } } }, []);
  db.exec('DROP TABLE video_generations; DROP TABLE image_generations;');
  db.prepare("UPDATE orchestration_nodes SET status='ready',progress_json='{}' WHERE session_id=?").run(id);
  assert.throws(() => service.retryNode(id, 'work'), { code: 'EXTERNAL_REQUEST_UNRESOLVED' });
});

test('reservation alone without a result stays reconciliation-only', () => {
  const id = setup(); reserve(id);
  db.prepare("UPDATE orchestration_nodes SET status='failed',progress_json='{}',decision_json='{}' WHERE session_id=?").run(id);
  assert.throws(() => service.retryNode(id, 'work'), { code: 'EXTERNAL_REQUEST_UNRESOLVED' });
});

test('generation request hash protects a legacy binding without a reservation event', () => {
  const id = setup(); generation('legacy-request', 'ambiguous');
  service.updateNode(id, 'work', { status: 'failed', request_hash: 'legacy-request' });
  assert.throws(() => service.retryNode(id, 'work'), { code: 'EXTERNAL_REQUEST_UNRESOLVED' });
});

test('current generation evidence overrides stale rejected decision snapshots', () => {
  const id = setup(); reserve(id); generation('request-one', 'accepted', 'processing', 'provider-one');
  fail(id, 'rejected', { provider_result: { generation: { status: 'failed', submission_status: 'rejected' } } });
  assert.throws(() => service.retryNode(id, 'work', { force: true }), { code: 'EXTERNAL_REQUEST_UNRESOLVED' });
});

test('image generation records use the same unknown and rejection boundary', () => {
  const id = setup('image.generate'); reserve(id);
  db.prepare('INSERT INTO image_generations VALUES (1,?,?,?,?,?)').run('failed', 'ambiguous', 'ambiguous', null, 'image-local');
  fail(id, 'rejected', {}, [{ type: 'image_generation', id: '1' }]);
  assert.throws(() => service.actOnNode(id, 'work', 'reopen'), { code: 'EXTERNAL_REQUEST_UNRESOLVED' });
  db.prepare("UPDATE image_generations SET generation_status='failed',submission_status='rejected' WHERE id=1").run();
  service.retryNode(id, 'work');
  assert.equal(reserve(id, 'request-two').reserved, true);
});

test('cleared hash with surviving unknown decision cannot obtain a new reservation', () => {
  const id = setup(); reserve(id);
  fail(id, 'uncertain', { provider_result: { generation: { submission_status: 'ambiguous', status: 'failed' } } }, []);
  db.prepare("UPDATE orchestration_nodes SET status='ready',request_hash=NULL,progress_json='{}' WHERE session_id=?").run(id);
  assert.throws(() => reserve(id, 'request-two'), { code: 'EXTERNAL_REQUEST_UNRESOLVED' });
});

test('terminal receipt state in durable events supports legacy rejection recovery', () => {
  const id = setup(); reserve(id); fail(id, 'rejected', {}, []);
  db.prepare("UPDATE orchestration_nodes SET status='ready',progress_json='{}',decision_json='{}' WHERE session_id=?").run(id);
  assert.equal(service.retryNode(id, 'work').node.request_hash, null);
  assert.equal(reserve(id, 'request-two').reserved, true);
});

test('local retry needs no external evidence or reason and preserves user settings', () => {
  const id = setup('local.image.resize');
  service.actOnNode(id, 'work', 'fail', { message: 'Local file temporarily busy' });
  const retried = service.retryNode(id, 'work').node;
  assert.equal(retried.attempt, 2);
  assert.equal(retried.status, 'ready');
  assert.equal(retried.decision.user_note, 'preserve this setting');
});

test('successful external work needs explicit force true or explicit reopen', () => {
  const id = setup(); reserve(id); generation('request-one', 'accepted', 'completed', 'provider-one');
  service.actOnNode(id, 'work', 'complete', { output_refs: [{ type: 'video_generation', id: '1' }], progress: { submission_state: 'settled' } });
  assert.throws(() => service.retryNode(id, 'work'), { code: 'NODE_ALREADY_SUCCEEDED' });
  assert.throws(() => service.retryNode(id, 'work', { force: 'false' }), { code: 'NODE_ALREADY_SUCCEEDED' });
  const reopened = service.actOnNode(id, 'work', 'reopen');
  assert.equal(reopened.node.attempt, 2);
  assert.equal(reopened.node.request_hash, null);
  assert.equal(reserve(id, 'request-two').reserved, true);
});

test('provider final failure can start a fresh user-authorized attempt', () => {
  const id = setup(); reserve(id); generation('request-one', 'accepted', 'failed', 'provider-one'); fail(id, 'settled');
  db.prepare('UPDATE video_generations SET submission_receipt_json=? WHERE id=1').run(JSON.stringify({ status: 'accepted', provider_status: 'failed', request_id: 'receipt-one' }));
  service.retryNode(id, 'work');
  assert.equal(reserve(id, 'request-two').reserved, true);
});

test('local poll or dispatch failure after acceptance is not a provider terminal receipt', () => {
  const id = setup(); reserve(id); generation('request-one', 'accepted', 'failed', 'provider-one'); fail(id, 'settled');
  assert.throws(() => service.retryNode(id, 'work', { force: true }), { code: 'EXTERNAL_REQUEST_UNRESOLVED' });
  assert.throws(() => service.actOnNode(id, 'work', 'reopen'), { code: 'EXTERNAL_REQUEST_UNRESOLVED' });
  assert.equal(service.listNodes(id)[0].request_hash, 'request-one');
});

test('changed plan after rejection archives and releases old associations', () => {
  const id = setup(); reserve(id); generation('request-one'); fail(id);
  const result = service.submitPlan(id, { confirm: true, nodes: [{ node_key: 'work', module_id: 'video.generate', input_refs: [{ id: 'source-v2' }], decision: { prompt: 'changed prompt' } }] });
  assert.equal(result.nodes[0].attempt, 2);
  assert.equal(result.nodes[0].request_hash, null);
  assert.deepEqual(result.nodes[0].output_refs, []);
  service.startSession(id);
  assert.equal(reserve(id, 'request-two').reserved, true);
  assert.equal(service.listReceipts(id).length, 1);
});

test('changed plan cannot bypass unresolved work after legacy retry', () => {
  const id = setup(); reserve(id); generation('request-one', 'ambiguous'); fail(id, 'uncertain');
  db.prepare("UPDATE orchestration_nodes SET status='ready',progress_json='{}' WHERE session_id=?").run(id);
  const before = service.getBundle(id);
  assert.throws(() => service.submitPlan(id, { confirm: true, nodes: [{ node_key: 'work', module_id: 'video.generate', input_refs: [{ id: 'changed' }] }] }), { code: 'EXTERNAL_REQUEST_UNRESOLVED' });
  assert.deepEqual(service.getBundle(id), before);
});

test('retry event failure rolls back hash release and attempt increment', () => {
  const id = setup(); reserve(id); generation('request-one'); fail(id);
  const before = service.getBundle(id);
  db.exec("CREATE TRIGGER reject_archive BEFORE INSERT ON orchestration_events WHEN NEW.event_type='node.attempt_archived' BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END;");
  assert.throws(() => service.retryNode(id, 'work'), /fixture disk failure/);
  assert.deepEqual(service.getBundle(id), before);
});

test('stale version cannot increment attempt twice', () => {
  const id = setup('local.image.resize');
  service.actOnNode(id, 'work', 'fail', { message: 'Local failure' });
  const version = service.listNodes(id)[0].version;
  service.retryNode(id, 'work', { expected_version: version });
  assert.throws(() => service.retryNode(id, 'work', { expected_version: version }), { code: 'VERSION_CONFLICT' });
  assert.equal(service.listNodes(id)[0].attempt, 2);
});