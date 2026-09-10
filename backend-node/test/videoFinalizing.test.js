const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Database = require('better-sqlite3');
const { videoDownloadError } = require('../src/services/videoDownloadError');
const videoService = require('../src/services/videoService');
const videoClient = require('../src/services/videoClient');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { createMediaBatchService } = require('../src/services/mediaBatchService');

test('recognizes explicit artifact finalizing, rejects ordinary errors and bounds/redacts bodies', async () => {
  const response = (status, body) => new Response(JSON.stringify(body), { status });
  for (const status of [200, 400, 409, 425, 503]) {
    const e = await videoDownloadError(response(status, { error: { message: 'Task is not completed yet, current status: FINALIZING' } }));
    assert.equal(e.code, 'VIDEO_ARTIFACT_NOT_READY');
  }
  for (const [status, body] of [
    [401, { error: { status: 'FINALIZING', message: 'unauthorized' } }],
    [403, { status: 'FINALIZING' }],
    [400, { error: { message: 'invalid prompt: FINALIZING' } }],
    [400, { error: { message: 'Task failed, current status: FINALIZING' } }],
  ]) assert.equal((await videoDownloadError(response(status, body))).code, 'VIDEO_DOWNLOAD_HTTP_ERROR');
  const redacted = await videoDownloadError(response(400, { error: { message: 'bad token=private sk-testsecret https://private.test/v?signature=secret Bearer abcdef' } }));
  assert.doesNotMatch(redacted.message, /private|testsecret|abcdef|signature=secret/);
  const oversized = await videoDownloadError(response(400, { message: 'x'.repeat(20000), status: 'FINALIZING' }));
  assert.equal(oversized.code, 'VIDEO_DOWNLOAD_HTTP_ERROR');
  assert.ok(oversized.message.length < 100);
});

test('real HTTP finalizing survives database reopen and recovers the same batch without another creation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-finalizing-'));
  const databasePath = path.join(root, 'state.sqlite');
  const logs = [];
  const log = { info(...v) { logs.push(v); }, warn(...v) { logs.push(v); }, error(...v) { logs.push(v); } };
  let ready = false;
  let gets = 0;
  let posts = 0;
  let creates = 0;
  let refreshes = 0;
  const bytes = Buffer.alloc(4096);
  bytes.write('ftyp', 4);
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') { posts += 1; res.writeHead(405); res.end(); return; }
    gets += 1;
    res.setHeader('content-type', ready ? 'video/mp4' : 'application/json');
    res.writeHead(ready ? 200 : 400);
    res.end(ready ? bytes : JSON.stringify({ error: { message: 'Task is not completed yet, current status: FINALIZING' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let db = new Database(databasePath);
  let batchService;
  const originalCreate = videoClient.callVideoApi;
  videoClient.callVideoApi = async () => { creates += 1; throw Error('unexpected generation'); };
  const cfg = { storage: { local_path: root } };
  const options = { config: cfg, video_config: { id: 1 }, disable_retry: true, skip_probe: true,
    refresh_source: async () => { refreshes += 1; return null; } };
  try {
    const oldLog = console.log;
    console.log = () => {};
    try { runMigrationsAndEnsure(db); } finally { console.log = oldLog; }
    const address = `http://127.0.0.1:${server.address().port}/original-video`;
    const id = Number(db.prepare(`INSERT INTO video_generations
      (drama_id,provider,prompt,model,status,generation_status,download_status,download_source_url,remote_video_url,provider_task_id,task_id,created_at,updated_at)
      VALUES (0,'test','original paid request','test','processing','completed','pending',?,?,'same-provider-task','same-local-task',datetime('now'),datetime('now'))`).run(address, address).lastInsertRowid);
    db.prepare("INSERT INTO async_tasks (id,type,status,progress,created_at,updated_at) VALUES ('same-local-task','video_generation','processing',92,datetime('now'),datetime('now'))").run();
    batchService = createMediaBatchService(db, log, { config: cfg, dispatchVideo: () => ({ id, task_id: 'same-local-task' }) });
    const batch = batchService.create({ kind: 'video', idempotency_key: 'original-only', prompt: 'original paid request', items: [{}] });
    await batchService.pump(batch.id);
    const first = await videoService.resumeDownloadForVideoGeneration(db, log, id, options);
    assert.equal(first.state, 'waiting_provider');
    assert.equal(gets, 1);
    assert.equal(refreshes, 0);
    await batchService.pump(batch.id);
    const waiting = batchService.get(batch.id).items[0];
    assert.equal(waiting.status, 'processing');
    assert.equal(waiting.download_status, 'waiting_provider');
    assert.equal(waiting.can_retry_download, false);
    assert.equal(waiting.download_url, null);
    assert.equal(waiting.error_message, null);
    assert.match(db.prepare("SELECT message FROM async_tasks WHERE id='same-local-task'").get().message, /FINALIZING/);
    batchService.stop();
    db.close();
    db = new Database(databasePath);
    assert.equal(db.prepare('SELECT download_status FROM video_generations WHERE id=?').get(id).download_status, 'waiting_provider');
    ready = true;
    const results = await Promise.all(Array.from({ length: 5 }, () => videoService.resumeDownloadForVideoGeneration(db, log, id, options)));
    assert.equal(results.filter(v => v.state === 'completed').length, 1);
    assert.equal(gets, 2);
    const final = db.prepare('SELECT * FROM video_generations WHERE id=?').get(id);
    assert.equal(final.provider_task_id, 'same-provider-task');
    assert.equal(final.download_status, 'completed');
    assert.equal(final.download_error, null);
    assert.equal(final.download_attempts, 2);
    assert.deepEqual(fs.readFileSync(path.join(root, final.local_path)), bytes);
    batchService = createMediaBatchService(db, log, { config: cfg, dispatchVideo: () => { creates += 1; throw Error('unexpected dispatch'); } });
    await batchService.pump(batch.id);
    assert.equal(batchService.get(batch.id).items[0].status, 'completed');
    assert.equal(posts, 0);
    assert.equal(creates, 0);
  } finally {
    videoClient.callVideoApi = originalCreate;
    batchService?.stop();
    if (db.open) db.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
