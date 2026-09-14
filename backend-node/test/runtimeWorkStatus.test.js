const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { setupRouter } = require('../src/routes');
const { createOrchestrationService } = require('../src/services/orchestrationService');
const { collectRuntimeWorkStatus } = require('../src/services/runtimeWorkStatus');

let db;
let server;
let origin;
let storageDir;
const log = { info() {}, warn() {}, error() {} };

function migrateQuietly() {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = originalLog; console.warn = originalWarn; }
}

async function request(route) {
  const response = await fetch(`${origin}/api/v1${route}`);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: response.status, body };
}

function fingerprint(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

beforeEach(async () => {
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-work-status-'));
  db = new Database(path.join(storageDir, 'drama_generator.db'));
  migrateQuietly();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1', setupRouter({ storage: { local_path: storageDir, base_url: 'http://127.0.0.1/static' } }, db, log, {
    production: { media: { fetchVideoCatalog: async () => ({ video: [] }) } },
    orchestration: { localMedia: { execute: async () => { throw new Error('isolation fixture must not execute media'); } } },
  }));
  server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe('runtime work status upgrade boundary', () => {
  it('keeps historical analysis drafts as recoverable context and does not mark the runtime busy', async () => {
    const orchestration = createOrchestrationService(db);
    const first = orchestration.beginWork({ idempotency_key: 'analysis-draft-1', user_goal: '整理历史分析草稿', intent: 'analyze' });
    orchestration.beginWork({ idempotency_key: 'analysis-draft-2', user_goal: '第二份分析草稿', intent: 'analyze' });
    const asset = path.join(storageDir, 'keep.bin');
    fs.writeFileSync(asset, 'user-asset-bytes');
    const beforeAsset = fingerprint(asset);
    const beforeSession = db.prepare('SELECT COUNT(*) n FROM orchestration_sessions').get().n;

    const status = await request('/runtime-work-status');
    assert.equal(status.status, 200);
    assert.equal(status.body.data.schema, 'yinzi.runtime-work-status/v2');
    assert.equal(status.body.data.counts.analysis, 2);
    assert.equal(status.body.data.busy, false);
    assert.deepEqual(status.body.data.blocking, []);
    assert.equal(status.body.data.analysis_is_recoverable_context, true);

    const bundle = orchestration.getBundle(first.session.id);
    assert.equal(bundle.session.status, 'draft');
    assert.equal(bundle.session.source_context.activity.state, 'working');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM orchestration_sessions').get().n, beforeSession);
    assert.equal(fingerprint(asset), beforeAsset);
  });

  it('blocks upgrades while a local queue or live generation is actually executing', async () => {
    db.prepare("INSERT INTO local_media_jobs (id,session_id,request_key,request_hash,status,job_json,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run('job-live', 'session-live', 'req-live', 'hash-live', 'running', JSON.stringify({ id: 'job-live', status: 'running' }), new Date().toISOString());
    const live = await request('/runtime-work-status');
    assert.equal(live.body.data.busy, true);
    assert.ok(live.body.data.blocking.includes('execution'));
    assert.equal(live.body.data.counts.local_media_jobs, 1);

    db.prepare("UPDATE local_media_jobs SET status='succeeded' WHERE id='job-live'").run();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO video_generations (provider, prompt, model, status, generation_status, download_status, created_at, updated_at) VALUES ('fixture','keep','fixture','processing','processing','pending',?,?)")
      .run(now, now);
    const generating = await request('/runtime-work-status');
    assert.equal(generating.body.data.busy, true);
    assert.equal(generating.body.data.counts.video_generations, 1);
  });

  it('protects unknown paid submissions and treats paused batches as recoverable context', async () => {
    const orchestration = createOrchestrationService(db);
    const created = orchestration.createSession({ idempotency_key: 'unknown-paid', user_goal: '未知付费请求必须保留' });
    orchestration.submitPlan(created.session.id, { expected_revision: 0, confirm: true, nodes: [{ node_key: 'generate', module_id: 'local.image.resize' }] });
    orchestration.startSession(created.session.id);
    const node = orchestration.listNodes(created.session.id)[0];
    assert.equal(node.status, 'ready');
    orchestration.reserveExternalRequest(created.session.id, node.id, { request_hash: 'paid-hash-1', message: '已提交外部请求' });
    orchestration.updateNode(created.session.id, node.id, {
      status: 'running',
      progress: { state: 'provider_unknown', submission_state: 'uncertain', message: '结果未知，只核对原请求' },
    });

    const unknown = await request('/runtime-work-status');
    assert.equal(unknown.body.data.busy, true);
    assert.ok(unknown.body.data.blocking.includes('unknown_paid_request'));
    assert.ok(unknown.body.data.counts.unknown_paid_requests >= 1);
    assert.equal(db.prepare('SELECT request_hash FROM orchestration_nodes WHERE id=?').get(node.id).request_hash, 'paid-hash-1');

    db.prepare("INSERT INTO media_batches (id,kind,status,title,prompt,settings_json,total,created_at,updated_at) VALUES ('paused-batch','image','paused','暂停批次','','{}',1,?,?)")
      .run(new Date().toISOString(), new Date().toISOString());
    const paused = await request('/runtime-work-status');
    assert.equal(db.prepare('SELECT request_hash FROM orchestration_nodes WHERE id=?').get(node.id).request_hash, 'paid-hash-1');
    assert.equal(paused.body.data.counts.recoverable_paused_batches, 1);
    assert.equal(paused.body.data.paused_batches_are_recoverable, true);
    assert.equal(paused.body.data.counts.media_batches, 0);
    assert.ok(paused.body.data.busy);
  });

  it('does not treat a recoverable paused batch as live execution by itself', async () => {
    db.prepare("INSERT INTO media_batches (id,kind,status,title,prompt,settings_json,total,created_at,updated_at) VALUES ('paused-only','image','paused','仅暂停','','{}',1,?,?)")
      .run(new Date().toISOString(), new Date().toISOString());
    const status = await request('/runtime-work-status');
    assert.equal(status.body.data.counts.recoverable_paused_batches, 1);
    assert.equal(status.body.data.counts.media_batches, 0);
    assert.equal(status.body.data.busy, false);
    assert.deepEqual(status.body.data.blocking, []);
  });

  it('keeps busy=false when optional tables are missing and never clears existing rows', async () => {
    const before = db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\'').all().map((row) => row.name);
    db.exec('DROP TABLE IF EXISTS orchestration_blender_jobs');
    db.exec('DROP TABLE IF EXISTS local_media_jobs');
    const status = await request('/runtime-work-status');
    assert.equal(status.status, 200);
    assert.equal(status.body.data.busy, false);
    assert.equal(status.body.data.readable, true);
    assert.equal(status.body.data.counts.orchestration_blender_jobs, 0);
    assert.equal(status.body.data.counts.local_media_jobs, 0);
    assert.ok(before.includes('orchestration_sessions'));
  });

  it('does not report idle when a present table cannot be queried', async () => {
    db.exec('DROP TABLE IF EXISTS local_media_jobs');
    db.exec('CREATE TABLE local_media_jobs (id TEXT PRIMARY KEY)');

    const direct = collectRuntimeWorkStatus(db);
    assert.equal(direct.busy, true);
    assert.ok(direct.blocking.includes('unreadable') || direct.blocking.includes('incomplete'));
    assert.equal(direct.readable, false);
    assert.equal(direct.details && direct.details.table, 'local_media_jobs');

    const status = await request('/runtime-work-status');
    const data = status.body && status.body.data;
    const blocking = data && Array.isArray(data.blocking) ? data.blocking : [];
    const failClosedHttp = status.status !== 200;
    const failClosedBusy = Boolean(data && data.busy === true && (blocking.includes('unreadable') || blocking.includes('incomplete')));
    assert.ok(failClosedHttp || failClosedBusy, `table present but query failed must not idle: status=${status.status} body=${JSON.stringify(status.body)}`);
    if (status.status === 200) {
      assert.equal(data.busy, true);
      assert.ok(blocking.includes('unreadable') || blocking.includes('incomplete'));
      assert.notEqual(data.readable, true);
    }
  });
});