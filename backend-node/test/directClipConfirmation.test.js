const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { setupRouter } = require('../src/routes');
const repo = require('../src/services/productionRepository');

const log = { info() {}, warn() {}, error() {} };
let db;
let server;
let baseUrl;
let storageDir;
let run;

function migrateQuietly() {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = originalLog; console.warn = originalWarn; }
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body == null || typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() };
}

describe('direct clip confirmation route', () => {
  beforeEach(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-clip-storage-'));
    db = new Database(':memory:');
    migrateQuietly();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO dramas (id, title, created_at, updated_at) VALUES (1, ?, ?, ?)').run('测试剧', now, now);
    db.prepare('INSERT INTO episodes (id, drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, 1, ?, ?, ?)').run('第一集', now, now);
    run = repo.createRun(db, { drama_id: 1, episode_id: 1, idempotency_key: `direct-clip-${Date.now()}`, input: { story: '导入视频确认测试' } }).run;
    const app = express();
    app.use(express.json());
    app.use('/api', setupRouter({ storage: { local_path: storageDir } }, db, log));
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  });

  afterEach(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('approves the new included revision and is idempotent', async () => {
    const artifact = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'shot_video',
      scope_type: 'shot',
      scope_id: '1',
      status: 'approved',
      title: '导入片段',
      media_path: 'imports/clip.mp4',
      mime_type: 'video/mp4',
      content: {
        imported: true,
        direct_clip_candidate: true,
        included: false,
        inclusion_pending_confirmation: true,
        direct_clip: { source_start_seconds: 0, source_end_seconds: null, speed: 1, keep_audio: true, subtitle_mode: 'inherit' },
      },
    });

    const confirmed = await request(`/production-artifacts/${artifact.id}/confirm-direct-clip`, { method: 'POST', body: {} });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.data.status, 'approved');
    assert.equal(confirmed.body.data.content.included, true);
    assert.equal(confirmed.body.data.content.inclusion_pending_confirmation, false);
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'shot_video', current: true, status: 'approved', page_size: 20 }).items.length, 1);

    // Use the original candidate id to model a rapid double-click/retry that
    // races with the first request.
    const repeated = await request(`/production-artifacts/${artifact.id}/confirm-direct-clip`, { method: 'POST', body: {} });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.data.id, confirmed.body.data.id);
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'shot_video', current: true, page_size: 20 }).items.length, 1);
  });
});
