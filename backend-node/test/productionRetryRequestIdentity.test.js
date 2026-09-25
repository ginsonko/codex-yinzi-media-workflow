const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const repo = require('../src/services/productionRepository');
const { createProductionService } = require('../src/services/productionService');
const { createProductionMediaService } = require('../src/services/productionMediaService');

let db;
const log = { info() {}, warn() {}, error() {} };
const cfg = { storage: { local_path: './unused-retry-fixture', base_url: 'http://localhost/static' } };
beforeEach(() => {
  db = new Database(':memory:');
  const originalLog = console.log; const originalWarn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = originalLog; console.warn = originalWarn; }
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (id,title,created_at,updated_at) VALUES (1,?,?,?)').run('Fixture', now, now);
  db.prepare('INSERT INTO episodes (id,drama_id,episode_number,title,created_at,updated_at) VALUES (1,1,1,?,?,?)').run('Fixture', now, now);
});
afterEach(() => db.close());
function fixture() {
  const run = repo.createRun(db, { drama_id: 1, episode_id: 1, idempotency_key: 'request-identity', input: { story: 'Fixture' }, policy: { image_model: 'fixture-image', director_mode: 'off' } }).run;
  const source = repo.createArtifact(db, { run_id: run.id, stage: 'asset_text', scope_type: 'character', scope_id: 'hero', status: 'approved', content: { included: true, name: 'Hero', description: 'Traveler', visual_prompt: 'Identity sheet' } });
  const service = createProductionService(db, cfg, log);
  let creates = 0;
  const media = createProductionMediaService(db, cfg, log, {
    createImage: async () => { const id = ++creates; return { id, task_id: `fixture-${id}` }; },
    getImage: async id => ({ id, task_id: `fixture-${id}`, status: 'completed', local_path: `images/${id}.png` }),
    validateImage: async mediaPath => ({ relative_path: mediaPath, width: 1536, height: 1024, nonblank: true, format: 'png', sha256: 'a'.repeat(64) }),
  });
  return { run, source, service, media, creates: () => creates };
}
async function createAndComplete(f) {
  const started = await f.media.ensureImageStage(repo.getRun(db, f.run.id), 'asset_images');
  assert.equal(started.state, 'waiting_task');
  const completed = await f.media.ensureImageStage(repo.getRun(db, f.run.id), 'asset_images');
  assert.equal(completed.state, 'progressed');
  repo.reviewArtifact(db, completed.artifact.id, { reviewer_type: 'human', decision: 'approved', reason: 'Fixture acceptance' });
  return { action: repo.getAction(db, started.action.id), artifact: repo.getArtifact(db, completed.artifact.id) };
}

test('fresh history clicks target the latest scope while key retransmission never creates another attempt', async () => {
  const f = fixture();
  const a = await createAndComplete(f);
  const first = f.service.authorizeRetry(f.run.id, { action_id: a.action.id, request_key: 'click-one' });
  assert.equal(first.reused, false);
  assert.equal(first.retry_request.source_action_id, a.action.id);
  assert.equal(first.retry_request.target_action_id, a.action.id);
  const pendingSnapshot = repo.getRun(db, f.run.id);
  assert.equal(f.service.authorizeRetry(f.run.id, { action_id: a.action.id, request_key: 'click-one' }).reused, true);
  assert.deepEqual(repo.getRun(db, f.run.id), pendingSnapshot);
  const b = await createAndComplete(f);
  assert.equal(f.creates(), 2);
  repo.updateRun(db, f.run.id, { status: 'completed', current_stage: 'final_edit', current_scope_type: 'run', current_scope_id: '', completed_at: new Date().toISOString() });
  const completedSnapshot = repo.getRun(db, f.run.id);
  assert.equal(f.service.authorizeRetry(f.run.id, { action_id: a.action.id, retry_request_key: 'click-one' }).reused, true);
  assert.deepEqual(repo.getRun(db, f.run.id), completedSnapshot);
  assert.equal(repo.getAction(db, b.action.id).status, 'completed');
  const second = f.service.authorizeRetry(f.run.id, { action_id: a.action.id, request_key: 'click-two' });
  assert.equal(second.reused, false);
  assert.equal(second.action.id, b.action.id);
  assert.equal(second.retry_request.source_action_id, a.action.id);
  assert.equal(second.retry_request.target_action_id, b.action.id);
  assert.equal(second.summary.run.current_stage, 'asset_images');
  assert.equal(second.summary.run.current_scope_type, 'character');
  assert.equal(second.summary.run.current_scope_id, 'hero');
  assert.equal(repo.getArtifact(db, b.artifact.id).status, 'invalidated');
  const c = await createAndComplete(f);
  assert.equal(f.creates(), 3);
  assert.equal(c.action.attempt, 3);
  repo.updateRun(db, f.run.id, { status: 'paused', current_stage: 'shot_video', current_scope_type: 'shot', current_scope_id: 'next' });
  const laterSnapshot = repo.getRun(db, f.run.id);
  for (const requestKey of ['click-one', 'click-two']) {
    const replay = f.service.authorizeRetry(f.run.id, { action_id: a.action.id, request_key: requestKey });
    assert.equal(replay.reused, true);
    assert.equal(replay.retry_request.request_key, requestKey);
  }
  assert.deepEqual(repo.getRun(db, f.run.id), laterSnapshot);
  assert.equal(repo.getAction(db, c.action.id).status, 'completed');
  assert.equal(f.creates(), 3);
  const receipts = repo.listEvents(db, f.run.id, { limit: 200 }).items.filter(event => event.event_type === 'action.retry_request_recorded');
  assert.equal(receipts.length, 2);
  assert.notEqual(receipts[0].id, receipts[1].id);
});

test('a retry key cannot be repurposed for another source action', async () => {
  const f = fixture(); const a = await createAndComplete(f);
  f.service.authorizeRetry(f.run.id, { action_id: a.action.id, request_key: 'stable-key' });
  const b = await createAndComplete(f);
  assert.throws(() => f.service.authorizeRetry(f.run.id, { action_id: b.action.id, request_key: 'stable-key' }), { code: 'RETRY_REQUEST_IDENTITY_CONFLICT' });
  assert.equal(repo.getAction(db, b.action.id).status, 'completed');
});

test('request receipt, action change, and current run scope roll back together on persistence failure', async () => {
  const f = fixture(); const a = await createAndComplete(f);
  const beforeRun = repo.getRun(db, f.run.id); const beforeAction = repo.getAction(db, a.action.id);
  db.exec("CREATE TRIGGER fixture_fail_retry_resume BEFORE UPDATE ON production_runs WHEN NEW.status='running' BEGIN SELECT RAISE(ABORT,'fixture write failed'); END;");
  assert.throws(() => f.service.authorizeRetry(f.run.id, { action_id: a.action.id, request_key: 'rollback-key' }), /fixture write failed/);
  assert.deepEqual(repo.getRun(db, f.run.id), beforeRun);
  assert.deepEqual(repo.getAction(db, a.action.id), beforeAction);
  assert.equal(repo.listEvents(db, f.run.id, { limit: 200 }).items.filter(event => event.event_type === 'action.retry_request_recorded').length, 0);
  assert.equal(repo.getArtifact(db, a.artifact.id).status, 'approved');
});
