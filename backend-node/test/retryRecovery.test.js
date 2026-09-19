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


for (const [submission,status,task] of [
  ['rejected','failed',null],['ambiguous','failed',null],
  ['submitting','processing',null],['accepted','processing','provider-one'],
  ['accepted','completed','provider-one'],['accepted','failed','provider-one'],
  ['not_sent','pending',null],
]) test(`explicit retry accepts ${submission}/${status} and preserves history`, () => {
  const id=setup(); reserve(id); generation('request-one',submission,status,task);
  if(status==='failed') fail(id,submission);
  if(status==='completed') service.actOnNode(id,'work','complete',{output_refs:[{type:'video_generation',id:'1'}]});
  const prior=db.prepare('SELECT * FROM video_generations').all();
  const receipts=service.listReceipts(id);
  const node=service.retryNode(id,'work').node;
  assert.equal(node.attempt,2); assert.equal(node.status,'ready');
  assert.equal(node.request_hash,null); assert.deepEqual(node.output_refs,[]);
  assert.equal(node.decision.user_note,'preserve this setting');
  assert.equal(reserve(id,'request-two').reserved,true);
  assert.deepEqual(db.prepare('SELECT * FROM video_generations').all(),prior);
  assert.deepEqual(service.listReceipts(id),receipts);
  const archive=service.listEvents(id).find(e=>e.event_type==='node.attempt_archived');
  assert.equal(archive.payload.request_hash,'request-one');
});
test('restart with stale/erased progress permits explicit retry of same logical node',()=>{
  const id=setup();reserve(id);generation('request-one','ambiguous');fail(id,'uncertain');
  db.prepare("UPDATE orchestration_nodes SET progress_json='{}',decision_json='{}',output_refs_json='[]' WHERE session_id=?").run(id);
  db.close();db=new Database(dbFile);service=createOrchestrationService(db);
  assert.equal(service.actOnNode(id,'work','reopen').node.attempt,2);
  assert.equal(reserve(id,'request-two').reserved,true);
});
test('image unknown outcome is retained but does not block explicit retry',()=>{
  const id=setup('image.generate');reserve(id);
  db.prepare('INSERT INTO image_generations VALUES (1,?,?,?,?,?)').run('failed','ambiguous','ambiguous',null,'local-one');
  fail(id,'uncertain',{},[{type:'image_generation',id:'1'}]);
  service.retryNode(id,'work');assert.equal(reserve(id,'request-two').reserved,true);
  assert.equal(db.prepare('SELECT submission_status FROM image_generations').get().submission_status,'ambiguous');
});
test('same request is idempotent and deliberate retry requires fresh request identity',()=>{
  const id=setup();reserve(id);
  assert.equal(reserve(id).reserved,false);
  assert.throws(()=>reserve(id,'different'),{code:'REQUEST_HASH_CONFLICT'});
  service.retryNode(id,'work');
  assert.throws(()=>reserve(id),{code:'REQUEST_HASH_RETIRED'});
  assert.equal(reserve(id,'request-two').reserved,true);
});
test('old callback cannot overwrite new attempt before or after a fresh reservation',()=>{
  const id=setup();reserve(id);generation('request-one','ambiguous');
  service.retryNode(id,'work');
  for(const action of ['complete','fail']){
    const before=service.listNodes(id)[0];
    const result=service.actOnNode(id,'work',action,{request_hash:'request-one',output_refs:[{type:'video_generation',id:'1'}]});
    assert.equal(result.ignored,true);assert.deepEqual(service.listNodes(id)[0],before);
  }
  reserve(id,'request-two');
  const before=service.listNodes(id)[0];
  assert.equal(service.updateNode(id,'work',{request_hash:'request-one',status:'succeeded'}).ignored,true);
  assert.equal(service.updateNode(id,'work',{expected_attempt:1,status:'failed'}).ignored,true);
  assert.deepEqual(service.listNodes(id)[0],before);
  assert.equal(service.actOnNode(id,'work','complete',{request_hash:'request-two',expected_attempt:2}).node.status,'succeeded');
});
test('reservation-only interruption can be retried without fabricated rejection evidence',()=>{
  const id=setup();reserve(id);const result=service.retryNode(id,'work');
  assert.equal(result.node.attempt,2);
  assert.equal(service.listEvents(id).find(e=>e.event_type==='node.retry_authorized').payload.previous_external_state,'unresolved');
  assert.equal(reserve(id,'request-two').reserved,true);
});
test('paused session resumes on explicit retry and preserves source/model definitions',()=>{
  const id=setup('local.image.resize');service.pauseSession(id);
  const n=service.retryNode(id,'work').node;
  assert.equal(n.status,'ready');assert.equal(n.decision.user_note,'preserve this setting');
  assert.deepEqual(n.input_refs,[{id:'source-v1'}]);
  assert.equal(service.getBundle(id).session.status,'running');
});
test('retry rollback preserves prior state if history cannot be written',()=>{
  const id=setup();reserve(id);const before=service.getBundle(id);
  db.exec("CREATE TRIGGER reject_archive BEFORE INSERT ON orchestration_events WHEN NEW.event_type='node.attempt_archived' BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END;");
  assert.throws(()=>service.retryNode(id,'work'),/fixture disk failure/);
  assert.deepEqual(service.getBundle(id),before);
});
test('concurrent stale version cannot increment retry twice',()=>{
  const id=setup();const version=service.listNodes(id)[0].version;
  service.retryNode(id,'work',{expected_version:version});
  assert.throws(()=>service.retryNode(id,'work',{expected_version:version}),{code:'VERSION_CONFLICT'});
  assert.equal(service.listNodes(id)[0].attempt,2);
});
