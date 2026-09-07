const { test } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const director = require('../src/services/blenderDirector');
const { createOrchestrationService } = require('../src/services/orchestrationService');
const { createOrchestrationBlenderService } = require('../src/services/orchestrationBlenderService');
const { encodingArgs } = require('../src/services/orchestrationBlenderFiles');
const { setupRouter } = require('../src/routes');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const log = { info() {}, warn() {}, error() {} };
const scene = () => ({ version: 2, active_camera_id: 'camera', objects: [
  { id: 'camera', kind: 'camera', position: [4, -4, 3], props: { aim_mode: 'target' } },
  { id: 'floor', kind: 'plane', props: {} },
], timeline: { duration: 2, keyframes: [] } });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDNsAAAAASUVORK5CYII=', 'base64');
const glb = Buffer.alloc(12); glb.write('glTF'); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(12, 8);
const video = Buffer.from('000000186674797069736F6D0000020069736F6D69736F32', 'hex');
function materialize(dir, frames) {
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scene.blend'), 'BLENDER-v500test');
  fs.writeFileSync(path.join(dir, 'scene.glb'), glb);
  for (const frame of frames) {
    const file = path.join(dir, 'frames/frame-' + String(frame).padStart(4, '0') + '.png');
    if (!fs.existsSync(file)) fs.writeFileSync(file, png);
  }
}
function harness() {
  const db = new Database(':memory:');
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-blender-job-'));
  const cfg = { storage: { local_path: storage, base_url: 'https://must-not-escape.example/static' } };
  const state = { liveOrphan: false, hold: false, encodingFailure: false, available: true, spawnFailure: false, children: [], calls: [] };
  const fake = {
    ...director,
    resolveBlenderExecutable: () => state.available ? 'test-blender' : null,
    prepareBlenderRender: (cfg, input) => director.prepareBlenderRender(cfg, input, {
      candidates: ['test-blender'], spawnSync: () => state.available ? { status: 0, stdout: 'Blender 5.2.1\n' } : { error: { code: 'ENOENT' } },
    }),
  };
  const spawn = (executable, args, options) => {
    state.calls.push({ executable, args, options });
    if (state.spawnFailure) throw Object.assign(new Error('cannot spawn'), { code: 'EACCES' });
    const child = new EventEmitter();
    child.pid = 999999;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { setImmediate(() => child.emit('close', null, 'SIGTERM')); return true; };
    state.children.push(child);
    if (!state.hold) setImmediate(() => {
      if (args.includes('--python')) {
        const frames = args[args.indexOf('--frames') + 1].split(',').map(Number);
        materialize(options.cwd, frames);
        child.stdout.emit('data', 'YINZI_PROGRESS {"phase":"rendering"}\n');
        child.emit('close', 0);
      } else if (state.encodingFailure) {
        child.stderr.emit('data', 'test encoder failure'); child.emit('close', 1);
      } else { fs.writeFileSync(path.join(options.cwd, 'preview.pending.mp4'), video); child.emit('close', 0); }
    });
    return child;
  };
  const orchestration = createOrchestrationService(db);
  const injected = { blenderDirector: fake, spawn, ffmpegPath: 'test-ffmpeg', isProcessAlive: (pid) => state.liveOrphan && pid === 999999 };
  const service = createOrchestrationBlenderService(db, cfg, log, { ...injected, orchestration });
  function session(key = crypto.randomUUID()) {
    const created = orchestration.createSession({ idempotency_key: key, user_goal: 'Blender 参考作业验收' });
    const id = created.session.id;
    orchestration.submitPlan(id, { confirm: true, nodes: [{ node_key: 'director', module_id: 'director.blender-render' }] });
    orchestration.startSession(id);
    return id;
  }
  return { db, storage, cfg, state, injected, service, orchestration, session,
    input: { node_key: 'director', request_key: 'test:director:v1', scene: scene(), frames: [1, 13, 48], width: 321, height: 181 },
    async close() { await service.stop(); db.close(); assert.ok(storage.startsWith(os.tmpdir())); fs.rmSync(storage, { recursive: true, force: true }); },
  };
}

test('concurrent duplicate requests render once, register playable URLs, and close the node/session', async () => {
  const h = harness();
  try {
    const id = h.session();
    const [first, second] = await Promise.all([h.service.createJob(id, h.input), h.service.createJob(id, h.input)]);
    assert.equal(first.job.id, second.job.id);
    assert.equal(second.reused, true);
    await h.service.waitForIdle();
    const job = h.service.getJob(first.job.id);
    assert.equal(job.status, 'succeeded');
    assert.ok(job.started_at && job.completed_at);
    assert.deepEqual(job.plan.profile.frames, [1, 13, 48]);
    assert.equal(h.state.calls.filter((call) => call.args.includes('--python')).length, 1);
    assert.equal(h.state.calls.filter((call) => !call.args.includes('--python')).length, 1);
    const bundle = h.orchestration.getBundle(id);
    assert.equal(bundle.nodes[0].status, 'succeeded');
    assert.equal(bundle.session.status, 'succeeded');
    assert.equal(bundle.artifacts.length, 7);
    assert.ok(bundle.artifacts.every((item) => item.url.startsWith('/static/') && item.bytes > 0));
    assert.equal(bundle.blender_jobs[0].status, job.status);
    assert.ok(bundle.events.some((event) => event.event_type === 'blender.completed'));
    assert.equal((await h.service.resumeJob(job.id)).reused, true);
    assert.equal(h.state.calls.length, 2);
  } finally { await h.close(); }
});

test('request hash collision or changed scene/profile cannot reuse or overwrite a job', async () => {
  const h = harness();
  try {
    const id = h.session();
    await h.service.createJob(id, { ...h.input, request_hash: 'stable-hash' });
    await assert.rejects(h.service.createJob(id, { ...h.input, width: 640, request_hash: 'stable-hash' }), { code: 'REQUEST_HASH_CONFLICT' });
    await assert.rejects(h.service.createJob(id, { ...h.input, frames: [1, 24], request_hash: 'stable-hash' }), { code: 'REQUEST_HASH_CONFLICT' });
    await h.service.waitForIdle();
    const otherId = h.session();
    const other = await h.service.createJob(otherId, h.input);
    assert.notEqual(other.job.output_dir, h.service.listJobs(id)[0].output_dir);
  } finally { await h.close(); }
});

test('queued cancellation starts no process; running cancellation waits for close and stays cancelled', async () => {
  const h = harness(); h.state.hold = true;
  try {
    const first = await h.service.createJob(h.session(), h.input);
    assert.equal(h.service.cancelJob(first.job.id).job.status, 'cancelling');
    await h.service.waitForIdle();
    assert.equal(h.state.calls.length, 0);
    assert.equal(h.service.getJob(first.job.id).status, 'cancelled');
    const next = await h.service.createJob(h.session(), h.input);
    await new Promise(setImmediate);
    assert.equal(h.state.calls.length, 1);
    assert.equal(h.service.cancelJob(next.job.id).job.status, 'cancelling');
    assert.equal((await h.service.resumeJob(next.job.id)).reused, true);
    await h.service.waitForIdle();
    const job = h.service.getJob(next.job.id);
    assert.equal(job.status, 'cancelled');
    assert.equal(h.orchestration.getBundle(job.session_id).nodes[0].status, 'cancelled');
    h.state.hold = false;
    await h.service.resumeJob(job.id);
    await h.service.waitForIdle();
    assert.equal(h.service.getJob(job.id).status, 'succeeded');
    assert.equal(h.orchestration.getBundle(job.session_id).nodes[0].attempt, 2);
  } finally { await h.close(); }
});

test('FFmpeg failure preserves frames and project; resume only encodes at the original profile', async () => {
  const h = harness(); h.state.encodingFailure = true;
  try {
    const first = await h.service.createJob(h.session(), h.input);
    await h.service.waitForIdle();
    const partial = h.service.getJob(first.job.id);
    assert.equal(partial.status, 'partial');
    assert.equal(partial.error.code, 'FFMPEG_FAILED');
    assert.equal(partial.manifest.frames.length, 3);
    assert.ok(h.orchestration.getBundle(partial.session_id).artifacts.some((file) => file.type === 'glb'));
    const framePath = path.join(h.storage, partial.output_dir, partial.manifest.frames[0]);
    const before = fs.statSync(framePath).mtimeMs;
    h.state.encodingFailure = false;
    await h.service.resumeJob(partial.id);
    await h.service.waitForIdle();
    assert.equal(h.service.getJob(partial.id).status, 'succeeded');
    assert.equal(h.state.calls.filter((call) => call.args.includes('--python')).length, 1);
    assert.equal(fs.statSync(framePath).mtimeMs, before);
    assert.deepEqual(h.service.getJob(partial.id).plan.profile, partial.plan.profile);
    const args = h.state.calls.at(-1).args;
    assert.equal(args[args.indexOf('-t') + 1], '2');
    assert.match(args[args.indexOf('-vf') + 1], /pad=/);
    // A success receipt alone cannot hide a subsequently missing MP4.
    fs.unlinkSync(path.join(h.storage, partial.output_dir, 'preview.mp4'));
    await h.service.resumeJob(partial.id); await h.service.waitForIdle();
    assert.equal(h.state.calls.filter((call) => call.args.includes('--python')).length, 1);
  } finally { await h.close(); }
});

test('backend shutdown persists recoverable state and resume can use the stored scene before scene.json existed', async () => {
  const h = harness();
  try {
    const first = await h.service.createJob(h.session(), h.input);
    await h.service.stop();
    assert.equal(h.service.getJob(first.job.id).status, 'recoverable');
    await h.service.resumeJob(first.job.id); await h.service.waitForIdle();
    assert.equal(h.service.getJob(first.job.id).status, 'succeeded');
  } finally { await h.close(); }
});

test('startup recovers persisted jobs and refuses a live orphan process', async () => {
  const h = harness(); h.state.hold = true;
  try {
    const first = await h.service.createJob(h.session(), h.input);
    await h.service.stop();
    h.db.prepare("UPDATE orchestration_blender_jobs SET status='rendering',pid=999999 WHERE id=?").run(first.job.id);
    h.service.recoverOnStartup();
    assert.equal(h.service.getJob(first.job.id).status, 'recoverable');
    h.state.liveOrphan = true;
    await assert.rejects(h.service.resumeJob(first.job.id), { code: 'BLENDER_PROCESS_STILL_ACTIVE' });
    assert.throws(() => h.service.cancelJob(first.job.id), { code: 'BLENDER_PROCESS_STILL_ACTIVE' });
    h.state.liveOrphan = false;
    h.state.hold = false;
    await h.service.resumeJob(first.job.id); await h.service.waitForIdle();
    assert.equal(h.service.getJob(first.job.id).status, 'succeeded');
  } finally { await h.close(); }
});

test('missing Blender is blocked with no media write; installing it restores the original job', async () => {
  const h = harness(); h.state.available = false;
  try {
    const first = await h.service.createJob(h.session(), h.input);
    await h.service.waitForIdle();
    const job = h.service.getJob(first.job.id);
    assert.equal(job.status, 'blocked');
    assert.equal(job.error.code, 'BLENDER_NOT_FOUND');
    assert.equal(h.state.calls.length, 0);
    assert.deepEqual(fs.readdirSync(h.storage), []);
    h.state.available = true;
    await h.service.resumeJob(job.id); await h.service.waitForIdle();
    assert.equal(h.service.getJob(job.id).status, 'succeeded');
  } finally { await h.close(); }
});

test('spawn exception and error/close preserve a recoverable failure instead of a stuck running job', async () => {
  const h = harness(); h.state.spawnFailure = true;
  try {
    const first = await h.service.createJob(h.session(), h.input);
    await h.service.waitForIdle();
    assert.equal(h.service.getJob(first.job.id).status, 'failed');
    assert.equal(h.service.getJob(first.job.id).error.code, 'EACCES');
    h.state.spawnFailure = false; h.state.hold = true;
    await h.service.resumeJob(first.job.id); await new Promise(setImmediate);
    const child = h.state.children.at(-1);
    child.emit('error', Object.assign(new Error('missing executable'), { code: 'ENOENT' }));
    child.emit('close', -1);
    await h.service.waitForIdle();
    assert.equal(h.service.getJob(first.job.id).error.code, 'ENOENT');
  } finally { await h.close(); }
});

test('HTTP routes enforce session/node binding, plan readiness, idempotency and error codes', async () => {
  const h = harness(); let server;
  try {
    const saveLog = console.log, saveWarn = console.warn;
    console.log = () => {}; console.warn = () => {};
    try { runMigrationsAndEnsure(h.db); } finally { console.log = saveLog; console.warn = saveWarn; }
    const app = express(); app.use(express.json());
    app.use('/api', setupRouter(h.cfg, h.db, log, { orchestration: h.injected }));
    app.use('/static', express.static(h.storage));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = 'http://127.0.0.1:' + server.address().port;
    async function request(route, method = 'GET', body) {
      const res = await fetch(base + '/api/orchestration-sessions/' + route, { method, headers: { 'Content-Type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });
      return { status: res.status, data: await res.json() };
    }
    const id = h.session(), other = h.session();
    const render = id + '/nodes/director/blender/render';
    assert.equal((await request('missing/blender/jobs')).status, 404);
    assert.equal((await request(id + '/nodes/missing/blender/render', 'POST', h.input)).status, 404);
    h.orchestration.pauseSession(id);
    assert.equal((await request(render, 'POST', h.input)).status, 409);
    h.orchestration.resumeSession(id);
    const rejected = await request(render, 'POST', { ...h.input, python: 'print(1)' });
    assert.equal(rejected.status, 400);
    const secret = await request(render, 'POST', { ...h.input, scene: { ...scene(), label: 'sk-abcdefghijklmno' } });
    assert.equal(secret.data.error.code, 'BLENDER_SECRET_REJECTED');
    const first = await request(render, 'POST', h.input);
    assert.equal(first.status, 201);
    const jobId = first.data.data.job.id;
    assert.equal((await request(other + '/blender/jobs/' + jobId)).status, 404);
    assert.equal((await request(other + '/blender/jobs/' + jobId + '/resume', 'POST', {})).status, 404);
    assert.equal((await request(other + '/blender/jobs/' + jobId + '/cancel', 'POST', {})).status, 404);
    assert.equal((await request(render, 'POST', h.input)).data.data.reused, true);
    assert.equal((await request(render, 'POST', { ...h.input, width: 640 })).status, 409);
    await h.service.waitForIdle();
    const bundle = h.orchestration.getBundle(id);
    for (const artifact of bundle.artifacts) {
      const file = await fetch(base + artifact.url);
      assert.equal(file.status, 200);
      assert.equal(Number(file.headers.get('content-length')), artifact.bytes);
    }
    const delivered = await request(id + '/delivery', 'POST', { idempotency_key: 'delivery-1', artifact_ids: bundle.artifacts.map((file) => file.artifact_id) });
    assert.equal(delivered.status, 201);
    assert.equal(delivered.data.data.delivery.items.length, 7);
  } finally { if (server) await new Promise((resolve) => server.close(resolve)); await h.close(); }
});
