'use strict';

// Isolation-only counterexample. Does not touch the live database, runtime
// config, or real backend. Seeds leftover work the official startupRecovery
// tests never insert, then boots createApp in manual mode.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SOURCE = path.resolve(__dirname, '..');

const child = String.raw`
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const outbound = [];
  const realFetch = global.fetch;
  global.fetch = async (url, ...rest) => {
    const href = String(url && url.url || url);
    if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(href)) return realFetch(url, ...rest);
    outbound.push('fetch:' + href.slice(0, 180));
    throw new Error('adversarial outbound denied');
  };
  for (const name of ['node:http', 'node:https']) {
    const mod = require(name);
    const realRequest = mod.request.bind(mod);
    const realGet = mod.get.bind(mod);
    const hostOf = (opts) => String(opts && (opts.hostname || opts.host) || '');
    const local = (host) => /^(127\.0\.0\.1|localhost|::1)$/i.test(host);
    mod.request = function (opts, cb) {
      if (local(hostOf(opts))) return realRequest(opts, cb);
      outbound.push(name + '.request:' + hostOf(opts).slice(0, 80));
      throw Object.assign(new Error('adversarial outbound denied'), { code: 'NO_EGRESS' });
    };
    mod.get = function (opts, cb) {
      if (local(hostOf(opts))) return realGet(opts, cb);
      outbound.push(name + '.get:' + hostOf(opts).slice(0, 80));
      throw Object.assign(new Error('adversarial outbound denied'), { code: 'NO_EGRESS' });
    };
  }
  const { loadConfig } = require('./src/config');
  const { getDb, closeDb } = require('./src/db');
  const db = getDb(loadConfig().database);
  require('./src/db/migrate').runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const orchestration = require('./src/services/orchestrationService').createOrchestrationService(db);
  const session = orchestration.beginWork({
    idempotency_key: 'manual-leftover-session',
    user_goal: 'keep paused leftover work',
    intent: 'analyze',
  }).session;
  db.prepare("UPDATE orchestration_sessions SET status='paused' WHERE id=?").run(session.id);

  db.prepare("INSERT INTO async_tasks (id,type,status,progress,message,resource_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run('task-image-unknown','image_generation','pending',0,'','1',now,now);
  db.prepare("INSERT INTO image_generations (prompt,model,status,task_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run('unknown in-flight image','fixture','pending','task-image-unknown',now,now);

  db.prepare("INSERT INTO async_tasks (id,type,status,progress,message,resource_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run('task-video-no-provider','video_generation','processing',10,'','2',now,now);
  db.prepare("INSERT INTO video_generations (prompt,model,status,generation_status,download_status,submission_status,task_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run('stuck create without provider id','fixture','processing','processing','pending','ambiguous','task-video-no-provider',now,now);

  db.prepare("INSERT INTO async_tasks (id,type,status,progress,message,resource_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run('task-video-provider','video_generation','processing',20,'','3',now,now);
  db.prepare("INSERT INTO video_generations (prompt,model,status,generation_status,download_status,submission_status,task_id,provider_task_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run('known upstream task','fixture','processing','processing','pending','accepted','task-video-provider','upstream-task-keep',now,now);

  db.prepare("INSERT INTO async_tasks (id,type,status,progress,message,resource_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run('task-video-ambiguous','video_generation','failed',0,'upstream ambiguous','4',now,now);
  db.prepare("INSERT INTO video_generations (prompt,model,status,generation_status,download_status,submission_status,task_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run('historical unknown bill','fixture','failed','ambiguous','pending','ambiguous','task-video-ambiguous',now,now);

  const batchId = 'queued-legacy-batch';
  db.prepare("INSERT INTO media_batches (id,idempotency_key,kind,status,title,prompt,concurrency,total,queued,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(batchId,batchId,'image','queued','legacy leftover batch','do not auto submit',1,1,1,now,now);
  db.prepare("INSERT INTO media_batch_items (id,batch_id,request_key,ordinal,kind,request_json,status,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run('queued-legacy-item',batchId,'queued-legacy-item',0,'image',JSON.stringify({prompt:'do not auto submit'}),'queued',now);

  const fixtureFile = path.join(process.env.ADVERSARIAL_DIR, 'input.png');
  fs.writeFileSync(fixtureFile, 'png-fixture');
  const jobId = 'queued-local-job';
  const job = {
    id: jobId,
    session_id: session.id,
    request_key: 'leftover-local',
    request_hash: 'fixture',
    node_id: null,
    operation_title: '缩放',
    request: { module_id: 'local.image.resize', input_path: fixtureFile, input_identity: { size: 11, mtime_ms: 1, ctime_ms: 1, ino: 1 }, parameters: { width: 32, height: 32 } },
    status: 'queued',
    attempt: 0,
    created_at: now,
    updated_at: now,
    events: [],
    progress: { stage: 'queued', message: 'leftover' },
  };
  db.exec("CREATE TABLE IF NOT EXISTS local_media_jobs (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,status TEXT NOT NULL,owner_pid INTEGER,job_json TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(session_id,request_key))");
  db.prepare('INSERT INTO local_media_jobs (id,session_id,request_key,request_hash,status,job_json,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(job.id, job.session_id, job.request_key, job.request_hash, 'queued', JSON.stringify(job), now);

  let videoRecovery = 0;
  require('./src/services/videoService').resumeProcessingVideoGenerations = () => { videoRecovery += 1; };

  const localMediaJobs = require('./src/services/localMediaJobs');
  const originalCreate = localMediaJobs.createLocalMediaJobs;
  let recoverCalled = 0;
  let localExecutions = 0;
  localMediaJobs.createLocalMediaJobs = function (database, cfg, orch, injected) {
    const api = originalCreate(database, cfg, orch, {
      ...(injected || {}),
      execute: async () => {
        localExecutions += 1;
        throw Object.assign(new Error('fixture blocked leftover local execute'), { code: 'FIXTURE_BLOCK' });
      },
    });
    const originalRecover = api.recover.bind(api);
    api.recover = function () {
      recoverCalled += 1;
      return originalRecover();
    };
    return api;
  };

  const { app, productionAutonomyRunner } = require('./src/app').createApp();
  const listener = app.listen(0, '127.0.0.1', async () => {
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const response = await fetch('http://127.0.0.1:' + listener.address().port + '/api/v1/runtime-identity');
      const identity = (await response.json()).data;
      const imageTask = db.prepare('SELECT status, error FROM async_tasks WHERE id=?').get('task-image-unknown');
      const videoNoProviderTask = db.prepare('SELECT status, error FROM async_tasks WHERE id=?').get('task-video-no-provider');
      const videoProviderTask = db.prepare('SELECT status FROM async_tasks WHERE id=?').get('task-video-provider');
      const imageRow = db.prepare('SELECT status FROM image_generations WHERE task_id=?').get('task-image-unknown');
      const videoNoProvider = db.prepare('SELECT generation_status, submission_status FROM video_generations WHERE task_id=?').get('task-video-no-provider');
      const videoProvider = db.prepare('SELECT generation_status, provider_task_id FROM video_generations WHERE task_id=?').get('task-video-provider');
      const ambiguous = db.prepare('SELECT generation_status, submission_status FROM video_generations WHERE task_id=?').get('task-video-ambiguous');
      const batch = db.prepare('SELECT status, queued FROM media_batches WHERE id=?').get(batchId);
      const batchItem = db.prepare('SELECT status FROM media_batch_items WHERE id=?').get('queued-legacy-item');
      const localJob = db.prepare('SELECT status FROM local_media_jobs WHERE id=?').get(jobId);
      const imageCount = db.prepare('SELECT COUNT(*) n FROM image_generations').get().n;
      const videoCount = db.prepare('SELECT COUNT(*) n FROM video_generations').get().n;
      const result = {
        mode: identity.startup_recovery,
        videoRecovery,
        autonomy: Boolean(productionAutonomyRunner?.isRunning()),
        recoverCalled,
        localExecutions,
        outbound,
        imageTask,
        videoNoProviderTask,
        videoProviderTask,
        imageRow,
        videoNoProvider,
        videoProvider,
        ambiguous,
        batch,
        batchItem,
        localJob,
        imageCount,
        videoCount,
        session: db.prepare('SELECT status FROM orchestration_sessions WHERE id=?').get(session.id).status,
      };
      process.stdout.write('\nRESULT:' + JSON.stringify(result) + '\n');
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      productionAutonomyRunner?.stop();
      app.locals.mediaBatchService.stop();
      await app.locals.blenderService.stop();
      await new Promise((resolve) => listener.close(resolve));
      closeDb();
    }
  });
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-manual-adversarial-'));
const configFile = path.join(dir, 'config.json');
fs.writeFileSync(configFile, JSON.stringify({
  app: { name: 'manual adversarial', version: 'test' },
  server: { cors_origins: [] },
  database: { path: path.join(dir, 'test.db') },
  storage: { local_path: path.join(dir, 'storage') },
  media_components: { root: path.join(dir, 'components') },
  runtime: { startup_recovery: 'manual' },
}));

const env = { ...process.env, YINZI_WORKFLOW_CONFIG: configFile, ADVERSARIAL_DIR: dir };
delete env.YINZI_WORKFLOW_STARTUP_RECOVERY;
delete env.PRODUCTION_AUTONOMY_DISABLED;

const result = spawnSync(process.execPath, ['-e', child], {
  cwd: SOURCE,
  env,
  encoding: 'utf8',
  timeout: 30000,
  windowsHide: true,
});

const marker = (result.stdout || '').split('\n').find((line) => line.startsWith('RESULT:'));
const receipt = {
  status: result.status,
  signal: result.signal,
  error: result.error && result.error.message,
  stderrTail: (result.stderr || '').slice(-2500),
  stdoutTail: (result.stdout || '').slice(-2500),
  outcome: null,
  findings: [],
};
if (marker) receipt.outcome = JSON.parse(marker.slice(7));

if (result.status !== 0 || !receipt.outcome) {
  receipt.findings.push('child-failed');
} else {
  const o = receipt.outcome;
  if (o.mode !== 'manual') receipt.findings.push('identity-not-manual');
  if (o.videoRecovery !== 0) receipt.findings.push('video-resume-ran');
  if (o.autonomy) receipt.findings.push('autonomy-started');
  if (o.batch?.status !== 'queued' || o.batchItem?.status !== 'queued') receipt.findings.push('batch-auto-pumped');
  if (o.imageCount !== 1 || o.videoCount !== 3) receipt.findings.push('new-generation-rows');
  if (o.ambiguous?.generation_status !== 'ambiguous') receipt.findings.push('ambiguous-rewritten');
  if (o.session !== 'paused') receipt.findings.push('paused-session-changed');
  if ((o.outbound || []).length) receipt.findings.push('outbound-attempted');
  if (o.recoverCalled >= 1 && o.localExecutions >= 1) receipt.findings.push('manual-still-recovers-queued-local-jobs');
  else if (o.recoverCalled < 1) receipt.findings.push('local-recover-not-called');
  if (o.imageTask?.status === 'failed' && o.imageRow?.status === 'pending') receipt.findings.push('failOrphaned-rewrites-inflight-image-task');
  if (o.videoNoProviderTask?.status === 'failed' && o.videoNoProvider?.generation_status === 'processing') receipt.findings.push('failOrphaned-fails-unknown-video-task-leaves-generation-processing');
  if (o.videoProviderTask?.status !== 'processing') receipt.findings.push('resumable-video-task-not-preserved');
  if (o.videoProvider?.generation_status !== 'processing') receipt.findings.push('resumable-video-row-changed');
}

receipt.passedOfficialGates = Boolean(receipt.outcome)
  && receipt.outcome.mode === 'manual'
  && receipt.outcome.videoRecovery === 0
  && receipt.outcome.autonomy === false
  && receipt.outcome.batch?.status === 'queued'
  && receipt.outcome.ambiguous?.generation_status === 'ambiguous'
  && receipt.outcome.imageCount === 1
  && receipt.outcome.videoCount === 3;
receipt.blockingCounterexamples = receipt.findings.filter((item) => [
  'manual-still-recovers-queued-local-jobs',
  'failOrphaned-rewrites-inflight-image-task',
  'failOrphaned-fails-unknown-video-task-leaves-generation-processing',
  'new-generation-rows',
  'video-resume-ran',
  'autonomy-started',
  'batch-auto-pumped',
  'ambiguous-rewritten',
  'outbound-attempted',
].includes(item));

fs.rmSync(dir, { recursive: true, force: true });
const assert = require('node:assert/strict');
assert.equal(receipt.status, 0, receipt.stderrTail);
assert.ok(receipt.passedOfficialGates, JSON.stringify(receipt.findings));
assert.deepEqual(receipt.blockingCounterexamples, []);
assert.equal(receipt.outcome.recoverCalled, 0);
assert.equal(receipt.outcome.localExecutions, 0);
assert.equal(receipt.outcome.localJob.status, 'queued');
assert.equal(receipt.outcome.imageTask.status, 'pending');
assert.equal(receipt.outcome.videoNoProviderTask.status, 'processing');
assert.equal(receipt.outcome.videoNoProvider.submission_status, 'ambiguous');
