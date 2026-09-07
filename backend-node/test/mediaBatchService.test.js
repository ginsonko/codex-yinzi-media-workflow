const { afterEach, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { createMediaBatchService, normalizeConcurrency } = require('../src/services/mediaBatchService');

const log = { info() {}, warn() {}, error() {} };

function migrate(db) {
  const savedLog = console.log;
  const savedWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = savedLog; console.warn = savedWarn; }
}

function insertImage(db, request, status = 'processing', extra = {}) {
  const timestamp = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO image_generations
       (drama_id, provider, prompt, status, task_id, client_request_key, image_url, local_path, error_msg, created_at, updated_at)
     VALUES (0, 'test', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    request.prompt || '',
    status,
    extra.task_id || null,
    request.client_request_key,
    extra.image_url || null,
    extra.local_path || null,
    extra.error_msg || null,
    timestamp,
    timestamp
  );
  return { id: Number(result.lastInsertRowid), task_id: extra.task_id || null };
}

function insertVideo(db, request, state) {
  const timestamp = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO video_generations
       (drama_id, provider, prompt, status, generation_status, submission_status, task_id,
        client_request_key, video_url, local_path, error_msg, created_at, updated_at)
     VALUES (0, 'test', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
  ).run(
    request.prompt || '',
    state.status,
    state.generation_status,
    state.submission_status,
    request.client_request_key,
    state.video_url || null,
    state.local_path || null,
    state.error_msg || null,
    timestamp,
    timestamp
  );
  return { id: Number(result.lastInsertRowid) };
}

describe('durable media batch queue', () => {
  let db;
  let service;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
  });

  afterEach(() => {
    service?.stop();
    db.close();
    service = null;
  });

  it('accepts a configurable positive concurrency without an artificial cap', () => {
    assert.equal(normalizeConcurrency(undefined), 8);
    assert.equal(normalizeConcurrency(1), 1);
    assert.equal(normalizeConcurrency('8'), 8);
    assert.equal(normalizeConcurrency(64), 64);
    for (const value of [0, -1, 1.5, 'invalid', Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => normalizeConcurrency(value), { code: 'MEDIA_BATCH_CONCURRENCY_INVALID' });
    }
  });

  it('reuses one logical batch for the same request key and rejects changed content', () => {
    service = createMediaBatchService(db, log, { dispatchImage: () => ({ id: 1 }) });
    const body = { idempotency_key: 'tab-shared-key', kind: 'image', concurrency: 1, prompt: '同一批任务', items: [{ prompt: 'A' }] };
    const first = service.create(body);
    service.stop();
    const second = service.create(body);
    assert.equal(second.id, first.id);
    assert.equal(second.reused, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_batches').get().n, 1);
    assert.throws(() => service.create({ ...body, items: [{ prompt: 'B' }] }), { code: 'MEDIA_BATCH_IDEMPOTENCY_CONFLICT' });
  });

  it('stores five thousand items but returns a bounded page for polling', () => {
    service = createMediaBatchService(db, log, { dispatchImage: () => ({ id: 1 }) });
    const items = Array.from({ length: 5000 }, (_, index) => ({ prompt: `产品 ${index + 1}` }));
    const batch = service.create({ idempotency_key: 'five-thousand', kind: 'image', prompt: '批量商品图', items });
    service.stop();
    assert.equal(batch.total, 5000);
    assert.equal(batch.items.length, 60);
    const last = service.get(batch.id, { item_page: 100, item_page_size: 50 });
    assert.equal(last.items.length, 50);
    assert.equal(last.items[0].ordinal, 4950);
    assert.equal(last.items_has_more, false);
  });

  it('fills eight durable slots and pause prevents the remaining items from being claimed', async () => {
    service = createMediaBatchService(db, log, {
      dispatchImage: (request) => insertImage(db, request),
    });
    const items = Array.from({ length: 12 }, (_, index) => ({ prompt: `任务 ${index + 1}` }));
    const batch = service.create({ idempotency_key: 'pause-boundary', kind: 'image', concurrency: 8, items });
    service.stop();
    await service.pump(batch.id);
    service.stop();
    let current = service.get(batch.id);
    assert.equal(current.running, 8);
    assert.equal(current.queued, 4);
    service.pause(batch.id);
    const activeIds = db.prepare("SELECT image_id FROM media_batch_items WHERE batch_id = ? AND status = 'processing'").all(batch.id).map((row) => row.image_id);
    db.prepare("UPDATE image_generations SET status = 'completed', local_path = 'batch/result.png' WHERE id = ?").run(activeIds[0]);
    await service.pump(batch.id);
    service.stop();
    current = service.get(batch.id);
    assert.equal(current.completed, 1);
    assert.equal(current.running, 7);
    assert.equal(current.queued, 4);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM media_batch_items WHERE batch_id = ? AND attempt > 0").get(batch.id).n, 8);
    service.resume(batch.id);
    service.stop();
    await service.pump(batch.id);
    service.stop();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM media_batch_items WHERE batch_id = ? AND attempt > 0").get(batch.id).n, 9);
  });

  it('separates completed, rejected and ambiguous provider outcomes and blocks ambiguous retry', async () => {
    service = createMediaBatchService(db, log, {
      dispatchVideo: (request) => {
        if (request.prompt === '完成') return insertVideo(db, request, { status: 'completed', generation_status: 'completed', submission_status: 'accepted', local_path: 'batch/done.mp4' });
        if (request.prompt === '拒绝') return insertVideo(db, request, { status: 'failed', generation_status: 'failed', submission_status: 'rejected', error_msg: '模型暂时不可用' });
        return insertVideo(db, request, { status: 'failed', generation_status: 'ambiguous', submission_status: 'ambiguous', error_msg: '连接在提交后断开' });
      },
    });
    const batch = service.create({ idempotency_key: 'mixed-outcomes', kind: 'video', concurrency: 3, items: [{ prompt: '完成' }, { prompt: '拒绝' }, { prompt: '未知' }] });
    service.stop();
    await service.pump(batch.id);
    service.stop();
    await service.pump(batch.id);
    service.stop();
    const current = service.get(batch.id);
    assert.equal(current.completed, 1);
    assert.equal(current.failed, 1);
    assert.equal(current.needs_review, 1);
    assert.equal(current.status, 'needs_review');
    const ambiguous = current.items.find((item) => item.status === 'needs_review');
    assert.throws(() => service.retryItem(batch.id, ambiguous.id), { code: 'MEDIA_BATCH_ITEM_AMBIGUOUS' });
  });

  it('keeps polling a pending provider task through async_tasks', async () => {
    db.prepare(`INSERT INTO async_tasks (id, type, status, progress, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('async-image-1', 'image_generation', 'processing', 10, new Date().toISOString(), new Date().toISOString());
    service = createMediaBatchService(db, log, {
      dispatchImage: (request) => insertImage(db, request, 'processing', { task_id: 'async-image-1' }),
    });
    const batch = service.create({ idempotency_key: 'async-task-polling', kind: 'image', concurrency: 1, items: [{ prompt: '等待上游回执' }] });
    service.stop();
    await assert.doesNotReject(() => service.pump(batch.id));
    const current = service.get(batch.id);
    assert.equal(current.status, 'running');
    assert.equal(current.running, 1);
    assert.equal(current.needs_review, 0);
  });

  it('recovers a claimed item from its persisted generation and safely requeues a claim with no local row', () => {
    service = createMediaBatchService(db, log, { dispatchImage: () => ({ id: 1 }) });
    const batch = service.create({ idempotency_key: 'restart-recovery', kind: 'image', concurrency: 1, items: [{ prompt: 'A' }, { prompt: 'B' }] });
    service.stop();
    const rows = db.prepare('SELECT * FROM media_batch_items WHERE batch_id = ? ORDER BY ordinal').all(batch.id);
    db.prepare("UPDATE media_batch_items SET status = 'submitting', attempt = 1 WHERE id IN (?, ?)").run(rows[0].id, rows[1].id);
    insertImage(db, { prompt: 'A', client_request_key: `${rows[0].request_key}:attempt:1` });
    assert.equal(service.recoverSubmitting(), 2);
    const recovered = db.prepare('SELECT status, image_id FROM media_batch_items WHERE id = ?').get(rows[0].id);
    const safe = db.prepare('SELECT status, image_id FROM media_batch_items WHERE id = ?').get(rows[1].id);
    assert.equal(recovered.status, 'processing');
    assert.ok(recovered.image_id);
    assert.equal(safe.status, 'queued');
    assert.equal(safe.image_id, null);
  });

  it('ramps 1 to 2 to 3, preserves the cohort across restart, and freezes on a latency tail', async () => {
    service = createMediaBatchService(db, log, { dispatchImage: request => insertImage(db,request) });
    const batch = service.create({kind:'image',concurrency:12,exploration:{mode:'adaptive',min_observation_ms:30000,slowdown_ratio:2.5},items:Array.from({length:12},()=>({prompt:'同类素材',model:'test-model'}))});
    service.stop(); await service.pump(batch.id); service.stop();
    assert.equal(service.get(batch.id).running,1);
    db.prepare("UPDATE image_generations SET status='completed',local_path='test.png'").run();
    await service.pump(batch.id); service.stop();
    assert.equal(service.get(batch.id).effective_concurrency,2);assert.equal(service.get(batch.id).running,2);
    service=createMediaBatchService(db,log,{dispatchImage:request=>insertImage(db,request)});
    db.prepare("UPDATE image_generations SET status='completed',local_path='test.png'").run();
    await service.pump(batch.id);service.stop();
    assert.equal(service.get(batch.id).effective_concurrency,3);assert.equal(service.get(batch.id).running,3);
    db.prepare("UPDATE media_batch_items SET submitted_at=? WHERE batch_id=? AND status='processing'").run(new Date(Date.now()-3600000).toISOString(),batch.id);
    await service.pump(batch.id);service.stop();
    assert.equal(service.get(batch.id).exploration.frozen,true);assert.equal(service.get(batch.id).exploration.reason,'latency_tail');
    assert.equal(service.get(batch.id).effective_concurrency,3);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM image_generations').get().n,6);
  });
  it('honors pause while a provider submission is awaiting its local receipt', async () => {
    let release;
    service=createMediaBatchService(db,log,{dispatchImage:request=>new Promise(resolve=>{release=()=>resolve(insertImage(db,request))})});
    const batch=service.create({kind:'image',concurrency:20,items:[{prompt:'A'},{prompt:'B'}]});service.stop();
    const pumping=service.pump(batch.id);await new Promise(resolve=>setImmediate(resolve));
    service.pause(batch.id);release();await pumping;service.stop();
    assert.equal(service.get(batch.id).status,'paused');assert.equal(service.get(batch.id).queued,1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM image_generations').get().n,1);
  });
  it('rejects retry when the stored receipt does not authorize safe retry', () => {
    service=createMediaBatchService(db,log,{});const batch=service.create({kind:'image',items:[{prompt:'A'}]});service.stop();
    const item=batch.items[0];db.prepare("UPDATE media_batch_items SET status='failed',retryable=0 WHERE id=?").run(item.id);
    assert.throws(()=>service.retryItem(batch.id,item.id),{code:'MEDIA_BATCH_ITEM_NOT_RETRYABLE'});
  });

});
