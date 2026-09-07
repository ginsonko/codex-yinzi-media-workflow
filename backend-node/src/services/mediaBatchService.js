const crypto = require('node:crypto');
const adaptive = require('./adaptiveConcurrency');
const imageService = require('./imageService');
const videoService = require('./videoService');
const assetService = require('./assetService');

const TERMINAL_BATCH_STATUSES = new Set(['completed', 'partial', 'failed', 'needs_review', 'cancelled']);
const MAX_ITEMS = 10000;
const DEFAULT_ITEM_PAGE_SIZE = 60;
const MAX_ITEM_PAGE_SIZE = 200;

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try { return value ? JSON.parse(value) : fallback; } catch (_) { return fallback; }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    if (value[key] !== undefined) result[key] = stableValue(value[key]);
    return result;
  }, {});
}

function requestHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (!key) return `media-batch:${crypto.randomUUID()}`;
  if (key.length > 240 || /[\u0000-\u001f]/.test(key)) {
    const error = new Error('批次请求键格式无效');
    error.code = 'MEDIA_BATCH_IDEMPOTENCY_INVALID';
    throw error;
  }
  return key;
}

function pagination(query = {}) {
  const page = Math.max(1, Math.floor(Number(query.item_page) || 1));
  const pageSize = Math.min(MAX_ITEM_PAGE_SIZE, Math.max(1, Math.floor(Number(query.item_page_size) || DEFAULT_ITEM_PAGE_SIZE)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function publicItem(row) {
  return {
    id: row.id,
    batch_id: row.batch_id,
    request_key: row.request_key || null,
    ordinal: Number(row.ordinal) || 0,
    kind: row.kind,
    status: row.status,
    request: parseJson(row.request_json, {}),
    attempt: Number(row.attempt) || 0,
    image_id: row.image_id == null ? null : Number(row.image_id),
    video_id: row.video_id == null ? null : Number(row.video_id),
    task_id: row.task_id,
    media_url: row.media_url,
    error_code: row.error_code,
    error_message: row.error_message,
    retryable: Boolean(row.retryable),
    submitted_at: row.submitted_at,
    completed_at: row.completed_at,
    updated_at: row.updated_at,
  };
}

function publicBatch(row, items = [], itemMeta = {}) {
  return {
    id: row.id,
    idempotency_key: row.idempotency_key || null,
    kind: row.kind,
    status: row.status,
    title: row.title,
    prompt: row.prompt,
    model: row.model,
    settings: parseJson(row.settings_json, {}),
    concurrency: normalizeConcurrency(row.concurrency),
    exploration: parseJson(row.exploration_json, {}),
    effective_concurrency: parseJson(row.exploration_json, {}).current || normalizeConcurrency(row.concurrency),
    total: Number(row.total) || 0,
    queued: Number(row.queued) || 0,
    running: Number(row.running) || 0,
    completed: Number(row.completed) || 0,
    failed: Number(row.failed) || 0,
    needs_review: Number(row.needs_review) || 0,
    paused_at: row.paused_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    items: items.map(publicItem),
    items_page: itemMeta.page || 1,
    items_page_size: itemMeta.pageSize || items.length,
    items_total: itemMeta.total == null ? items.length : Number(itemMeta.total),
    items_has_more: itemMeta.total == null ? false : itemMeta.offset + items.length < Number(itemMeta.total),
    reused: Boolean(itemMeta.reused),
  };
}

function normalizeKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  if (kind === 'image' || kind === 'video') return kind;
  const error = new Error('批量类型必须是 image 或 video');
  error.code = 'MEDIA_BATCH_KIND_INVALID';
  throw error;
}

function normalizeConcurrency(value) {
  if (value == null || value === '') return 8;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) {
    const error = new Error('并发数量必须是正整数');
    error.code = 'MEDIA_BATCH_CONCURRENCY_INVALID';
    throw error;
  }
  return n;
}

function now() { return new Date().toISOString(); }

function createMediaBatchService(db, log = console, injected = {}) {
  const dispatchImage = injected.dispatchImage || ((body) => imageService.create(db, log, body));
  const dispatchVideo = injected.dispatchVideo || (() => {
    const error = new Error('批量视频执行器未接入');
    error.code = 'MEDIA_BATCH_VIDEO_EXECUTOR_UNAVAILABLE';
    error.definitely_not_submitted = true;
    throw error;
  });
  const timers = new Map();
  const pumping = new Set();

  function readBatch(id, query = {}, reused = false) {
    const row = db.prepare('SELECT * FROM media_batches WHERE id = ?').get(String(id));
    if (!row) return null;
    const meta = pagination(query);
    const count = db.prepare('SELECT COUNT(*) AS total FROM media_batch_items WHERE batch_id = ?').get(String(id));
    const items = db.prepare('SELECT * FROM media_batch_items WHERE batch_id = ? ORDER BY ordinal ASC LIMIT ? OFFSET ?')
      .all(String(id), meta.pageSize, meta.offset);
    const result = publicBatch(row, items, { ...meta, total: Number(count.total) || 0, reused });
    result.items = result.items.map(item => {
      const media = item.kind === 'video' && item.video_id ? videoService.getById(db, item.video_id) : item.image_id ? imageService.getById(db, item.image_id) : null;
      if (!media) return item;
      const key = item.kind === 'video' ? 'video_gen_id' : 'image_gen_id';
      const asset = db.prepare(`SELECT id FROM assets WHERE ${key}=? AND deleted_at IS NULL ORDER BY id LIMIT 1`).get(item.video_id || item.image_id);
      const file = assetService.localFileMetadata(media.local_path, injected.config);
      return { ...item, local_path: file ? media.local_path : null, file_size: file?.size || null, asset_id: asset?.id || null,
        download_url: file && asset ? `/api/v1/assets/${asset.id}/download` : null,
        generation_status: media.generation_status || media.status, download_status: media.download_status || null,
        download_error: media.download_error || null, provider_updated_at: media.updated_at, download_attempts: media.download_attempts || 0,
        can_retry_download: item.kind === 'video' && media.generation_status === 'completed' && !file && media.download_status !== 'downloading',
      };
    });
    return result;
  }

  function recalc(id) {
    const counts = db.prepare(
      "SELECT COUNT(*) AS total, " +
      "SUM(CASE WHEN status IN ('queued','paused') THEN 1 ELSE 0 END) AS queued, " +
      "SUM(CASE WHEN status IN ('submitting','processing') THEN 1 ELSE 0 END) AS running, " +
      "SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed, " +
      "SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed, " +
      "SUM(CASE WHEN status = 'needs_review' THEN 1 ELSE 0 END) AS needs_review " +
      'FROM media_batch_items WHERE batch_id = ?'
    ).get(String(id));
    const batch = db.prepare('SELECT * FROM media_batches WHERE id = ?').get(String(id));
    if (!batch) return null;
    const total = Number(counts.total) || 0;
    const queued = Number(counts.queued) || 0;
    const running = Number(counts.running) || 0;
    const completed = Number(counts.completed) || 0;
    const failed = Number(counts.failed) || 0;
    const needsReview = Number(counts.needs_review) || 0;
    let status = batch.status;
    let completedAt = batch.completed_at;
    if (total && queued === 0 && running === 0) {
      status = needsReview ? 'needs_review' : failed && completed ? 'partial' : failed ? 'failed' : 'completed';
      completedAt = completedAt || now();
    } else if (status === 'queued' && (running || completed || failed || needsReview)) {
      status = 'running';
    }
    db.prepare('UPDATE media_batches SET status = ?, total = ?, queued = ?, running = ?, completed = ?, failed = ?, needs_review = ?, completed_at = ?, updated_at = ? WHERE id = ?')
      .run(status, total, queued, running, completed, failed, needsReview, completedAt, now(), String(id));
    return db.prepare('SELECT * FROM media_batches WHERE id = ?').get(String(id));
  }

  function schedule(id, delay = 40) {
    const key = String(id);
    if (timers.has(key)) return;
    const timer = setTimeout(() => {
      timers.delete(key);
      pump(key).catch((error) => log.error?.('media batch pump failed', { batch_id: key, error: error.message }));
    }, delay);
    timer.unref?.();
    timers.set(key, timer);
  }

  function attemptRequestKey(item) {
    return `${item.request_key || `media-batch-item:${item.id}`}:attempt:${Math.max(1, Number(item.attempt) || 1)}`;
  }

  function findGeneration(kind, key) {
    const table = kind === 'image' ? 'image_generations' : 'video_generations';
    try {
      return db.prepare(`SELECT id, task_id FROM ${table} WHERE client_request_key = ? AND deleted_at IS NULL`).get(key) || null;
    } catch (error) {
      if (/no such (table|column)/i.test(String(error.message || ''))) return null;
      throw error;
    }
  }

  function attachGeneration(item, generation) {
    db.prepare("UPDATE media_batch_items SET status = 'processing', image_id = ?, video_id = ?, task_id = ?, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND status = 'submitting'")
      .run(item.kind === 'image' ? Number(generation.id) : null, item.kind === 'video' ? Number(generation.id) : null, generation.task_id || null, now(), item.id);
  }

  function recoverSubmitting() {
    const items = db.prepare("SELECT * FROM media_batch_items WHERE status = 'submitting'").all();
    for (const item of items) {
      const generation = findGeneration(item.kind, attemptRequestKey(item));
      if (generation) {
        attachGeneration(item, generation);
      } else {
        // Provider work only starts after the corresponding local generation
        // row exists. A missing row means this queue claim is safe to restore.
        db.prepare("UPDATE media_batch_items SET status = 'queued', submitted_at = NULL, error_code = 'RECOVERED_BEFORE_LOCAL_CREATE', error_message = NULL, updated_at = ? WHERE id = ? AND status = 'submitting'")
          .run(now(), item.id);
      }
      recalc(item.batch_id);
    }
    return items.length;
  }

  async function settleItem(item) {
    let media = null;
    try {
      if (item.kind === 'image' && item.image_id) media = imageService.getById(db, item.image_id);
      if (item.kind === 'video' && item.video_id) media = videoService.getById(db, item.video_id);
    } catch (error) {
      log.warn?.('media batch item read failed', { item_id: item.id, error: error.message });
      return;
    }
    if (!media) return;
    const status = String(media.status || '').toLowerCase();
    const generationStatus = String(media.generation_status || '').toLowerCase();
    const submissionStatus = String(media.submission_status || '').toLowerCase();
    const finished = status === 'completed' || (generationStatus === 'completed' && Boolean(media.local_path));
    if (item.kind === 'video' && generationStatus === 'completed' && !finished) {
      if (media.download_status === 'failed') db.prepare("UPDATE media_batch_items SET status='needs_review',error_code='DOWNLOAD_FAILED',error_message=?,retryable=0,updated_at=? WHERE id=?").run(media.download_error || '生成已完成，下载失败；可以重试原文件', now(), item.id);
      return;
    }
    const ambiguous = generationStatus === 'ambiguous' || submissionStatus === 'ambiguous';
    const failed = status === 'failed' || generationStatus === 'failed';
    if (!finished && !failed && !ambiguous) {
      if (item.task_id) {
        // Image/video generation records are backed by async_tasks in this
        // runtime. Keep the ambiguity check on the same durable task table
        // used by taskService so a long-running provider call does not stop
        // the batch pump with a missing-table error.
        const task = db.prepare('SELECT status, error FROM async_tasks WHERE id = ?').get(item.task_id);
        if (task?.status === 'failed') {
          db.prepare("UPDATE media_batch_items SET status = 'needs_review', error_code = 'INTERRUPTED_RESULT_UNKNOWN', error_message = ?, retryable = 0, completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('submitting','processing')")
            .run(String(task.error || '服务中断后无法确认上游结果，请先核对任务和账单').slice(0, 500), now(), now(), item.id);
        }
      }
      return;
    }
    const mediaUrl = media.local_path || media.image_url || media.video_local_path || media.video_url || null;
    const errorMessage = media.error_msg || media.error || (ambiguous ? '上游是否受理尚不明确，请先核对任务和账单' : null);
    const definitelyRejected = ['rejected', 'not_sent'].includes(submissionStatus);
    const retryable = failed && !ambiguous && definitelyRejected && /temporar|unavailable|busy|稍后|繁忙|不可用/i.test(String(errorMessage || ''));
    if (finished && media.local_path) {
      try { (item.kind === 'video' ? assetService.importFromVideo : assetService.importFromImage)(db, log, item.video_id || item.image_id, injected.config); } catch (error) { log.warn?.('asset registration pending', { item_id: item.id, error: error.message }); }
    }
    const nextStatus = finished ? 'completed' : ambiguous ? 'needs_review' : 'failed';
    const errorCode = finished ? null : ambiguous ? 'UPSTREAM_AMBIGUOUS' : 'PROVIDER_FAILED';
    db.prepare("UPDATE media_batch_items SET status = ?, media_url = ?, error_code = ?, error_message = ?, retryable = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('submitting','processing')")
      .run(nextStatus, mediaUrl, errorCode, errorMessage, retryable ? 1 : 0, now(), now(), item.id);
  }

  async function pump(id) {
    const key = String(id);
    if (pumping.has(key)) return;
    pumping.add(key);
    try {
      let batch = db.prepare('SELECT * FROM media_batches WHERE id = ?').get(key);
      if (!batch || TERMINAL_BATCH_STATUSES.has(batch.status)) return;
      const activeItems = db.prepare("SELECT * FROM media_batch_items WHERE batch_id = ? AND status IN ('submitting','processing') ORDER BY ordinal ASC").all(key);
      for (const item of activeItems) await settleItem(item);
      batch = recalc(key) || batch;
      if (batch.status === 'paused') {
        if (Number(batch.running) > 0) schedule(key, 1000);
        return;
      }
      const active = Number(db.prepare("SELECT COUNT(*) AS n FROM media_batch_items WHERE batch_id = ? AND status IN ('submitting','processing')").get(key).n) || 0;
      const previousExploration = parseJson(batch.exploration_json, adaptive.initialState({}, batch.concurrency));
      const cohortIds = previousExploration.cohort || [];
      const cohortItems = cohortIds.length ? db.prepare(`SELECT * FROM media_batch_items WHERE batch_id = ? AND id IN (${cohortIds.map(() => '?').join(',')})`).all(key, ...cohortIds) : [];
      let exploration = adaptive.evaluate(previousExploration, cohortItems, batch.concurrency);
      const exploring = exploration.mode === 'adaptive' && !exploration.frozen;
      const slots = exploring && exploration.cohort.length ? 0 : Math.max(0, Number(exploration.current || batch.concurrency) - active);
      const queued = db.prepare("SELECT * FROM media_batch_items WHERE batch_id = ? AND status = 'queued' ORDER BY ordinal ASC LIMIT ?").all(key, slots);
      if (JSON.stringify(exploration) !== batch.exploration_json) db.prepare('UPDATE media_batches SET exploration_json = ? WHERE id = ?').run(JSON.stringify(exploration), key);
      for (const item of queued) {
        // Awaiting a provider can yield while the user pauses this batch.
        if (db.prepare('SELECT status FROM media_batches WHERE id = ?').get(key)?.status === 'paused') break;
        const claimed = db.prepare("UPDATE media_batch_items SET status = 'submitting', attempt = attempt + 1, submitted_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
          .run(now(), now(), item.id);
        if (!claimed.changes) continue;
        if (exploring) {
          exploration.cohort.push(item.id);
          db.prepare('UPDATE media_batches SET exploration_json = ? WHERE id = ?').run(JSON.stringify(exploration), key);
        }
        const claimedItem = db.prepare('SELECT * FROM media_batch_items WHERE id = ?').get(item.id);
        try {
          const request = { ...parseJson(item.request_json, {}), client_request_key: attemptRequestKey(claimedItem) };
          const result = item.kind === 'image' ? await dispatchImage(request) : await dispatchVideo(request);
          if (!result?.id) throw Object.assign(new Error('媒体执行器未返回本地任务 ID'), { code: 'MEDIA_BATCH_LOCAL_ID_MISSING' });
          attachGeneration(claimedItem, result);
        } catch (error) {
          const definitelyNotSubmitted = Boolean(error?.definitely_not_submitted || ['MEDIA_BATCH_VIDEO_EXECUTOR_UNAVAILABLE', 'PROVIDER_UNAVAILABLE', 'VALIDATION_ERROR'].includes(error?.code));
          const nextStatus = definitelyNotSubmitted ? 'failed' : 'needs_review';
          db.prepare('UPDATE media_batch_items SET status = ?, error_code = ?, error_message = ?, retryable = ?, completed_at = ?, updated_at = ? WHERE id = ?')
            .run(nextStatus, error.code || 'SUBMIT_OUTCOME_UNKNOWN', String(error.message || '提交结果不明确').slice(0, 500), definitelyNotSubmitted && error?.retryable ? 1 : 0, now(), now(), item.id);
          log.error?.('media batch submit failed', { batch_id: key, item_id: item.id, error: error.message, status: nextStatus });
          if (exploring) break;
        }
      }
      batch = recalc(key) || batch;
      if (batch.status === 'running' || batch.status === 'queued') schedule(key, 500);
    } finally {
      pumping.delete(key);
    }
  }

  function create(body = {}) {
    const kind = normalizeKind(body.kind);
    const concurrency = normalizeConcurrency(body.concurrency);
    const exploration = adaptive.initialState(body.exploration || {}, concurrency);
    const sourceItems = Array.isArray(body.items) ? body.items : [];
    if (!sourceItems.length || sourceItems.length > MAX_ITEMS) {
      const error = new Error('批量项目数量必须在 1 到 ' + MAX_ITEMS + ' 之间');
      error.code = 'MEDIA_BATCH_ITEMS_INVALID';
      throw error;
    }
    const idempotencyKey = normalizeIdempotencyKey(body.idempotency_key);
    const settings = body.settings && typeof body.settings === 'object' ? body.settings : {};
    const normalized = {
      kind,
      title: String(body.title || (kind === 'image' ? '批量生图' : '批量生视频')).slice(0, 160),
      prompt: String(body.prompt || '').slice(0, 8000),
      model: body.model == null ? null : String(body.model).slice(0, 240),
      settings,
      concurrency,
      ...(body.exploration ? { exploration: adaptive.normalizePolicy(body.exploration) } : {}),
      items: sourceItems.map((entry) => entry && typeof entry === 'object' ? entry : {}),
    };
    const hash = requestHash(normalized);
    const existing = db.prepare('SELECT * FROM media_batches WHERE idempotency_key = ?').get(idempotencyKey);
    if (existing) {
      if (existing.request_hash && existing.request_hash !== hash) {
        const error = new Error('同一批次请求键对应的内容已变化，请刷新后重新创建');
        error.code = 'MEDIA_BATCH_IDEMPOTENCY_CONFLICT';
        throw error;
      }
      return readBatch(existing.id, {}, true);
    }
    const id = crypto.randomUUID();
    const timestamp = now();
    db.transaction(() => {
      db.prepare("INSERT INTO media_batches (id, idempotency_key, request_hash, kind, status, title, prompt, model, settings_json, concurrency, total, queued, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, idempotencyKey, hash, kind, normalized.title, normalized.prompt, normalized.model, JSON.stringify(settings), concurrency, sourceItems.length, sourceItems.length, timestamp, timestamp);
      db.prepare('UPDATE media_batches SET exploration_json = ? WHERE id = ?').run(JSON.stringify(exploration), id);
      const insert = db.prepare("INSERT INTO media_batch_items (id, batch_id, request_key, ordinal, kind, request_json, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)");
      sourceItems.forEach((entry, index) => {
        const request = { ...settings, ...(entry && typeof entry === 'object' ? entry : {}), prompt: String(entry?.prompt || normalized.prompt).slice(0, 8000), model: entry?.model == null ? normalized.model : entry.model };
        delete request._origin;
        const itemId = crypto.randomUUID();
        insert.run(itemId, id, `media-batch:${id}:item:${index}`, index, kind, JSON.stringify(request), timestamp);
      });
    })();
    schedule(id, 0);
    return readBatch(id);
  }

  function list(query = {}) {
    const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || 20)));
    const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
    const filter = query.origin === 'manual' ? " WHERE json_extract(settings_json, '$._origin') = 'manual'" : '';
    const rows = db.prepare('SELECT * FROM media_batches' + filter + ' ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(limit, offset);
    const total = Number(db.prepare('SELECT COUNT(*) AS total FROM media_batches' + filter).get().total) || 0;
    return { items: rows.map((row) => publicBatch(row)), total, limit, offset };
  }

  function get(id, query = {}) { return readBatch(id, query); }

  function pause(id) {
    const row = db.prepare('SELECT * FROM media_batches WHERE id = ?').get(String(id));
    if (!row) return null;
    if (TERMINAL_BATCH_STATUSES.has(row.status)) return readBatch(id);
    db.prepare("UPDATE media_batches SET status = 'paused', paused_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), String(id));
    return readBatch(id);
  }

  function resume(id) {
    const row = db.prepare('SELECT * FROM media_batches WHERE id = ?').get(String(id));
    if (!row) return null;
    if (TERMINAL_BATCH_STATUSES.has(row.status)) return readBatch(id);
    db.prepare("UPDATE media_batches SET status = 'running', paused_at = NULL, completed_at = NULL, updated_at = ? WHERE id = ?").run(now(), String(id));
    schedule(id, 0);
    return readBatch(id);
  }

  function retryDownload(batchId, itemId) {
    const item = db.prepare('SELECT * FROM media_batch_items WHERE id=? AND batch_id=?').get(String(itemId), String(batchId));
    if (!item?.video_id) throw Object.assign(new Error('视频任务不存在'), { code: 'MEDIA_BATCH_NOT_FOUND' });
    const media = videoService.getById(db, item.video_id);
    if (media?.generation_status !== 'completed') throw Object.assign(new Error('上游视频尚未完成，只能查询原任务'), { code: 'DOWNLOAD_NOT_READY' });
    db.prepare("UPDATE media_batch_items SET status='processing',error_code=NULL,error_message=NULL,completed_at=NULL,updated_at=? WHERE id=?").run(now(), item.id);
    db.prepare("UPDATE media_batches SET status='running',completed_at=NULL,updated_at=? WHERE id=?").run(now(), String(batchId));
    Promise.resolve().then(() => (injected.retryDownload || videoService.resumeDownloadForVideoGeneration)(db, log, item.video_id))
      .catch(error => log.warn?.('manual download retry failed', { item_id: item.id, error: error.message }));
    schedule(batchId, 0);
    return readBatch(batchId);
  }

  function retryItem(batchId, itemId) {
    const item = db.prepare('SELECT * FROM media_batch_items WHERE id = ? AND batch_id = ?').get(String(itemId), String(batchId));
    if (!item) return null;
    if (item.status === 'needs_review') {
      const error = new Error('该项目的上游结果尚不明确，请先核对任务和账单，不能直接重试');
      error.code = 'MEDIA_BATCH_ITEM_AMBIGUOUS';
      throw error;
    }
    if (item.status !== 'failed' || !item.retryable) {
      const error = new Error('只有确定失败的项目可以重试');
      error.code = 'MEDIA_BATCH_ITEM_NOT_RETRYABLE';
      throw error;
    }
    db.prepare("UPDATE media_batch_items SET status = 'queued', error_code = NULL, error_message = NULL, retryable = 0, completed_at = NULL, updated_at = ? WHERE id = ?")
      .run(now(), item.id);
    db.prepare("UPDATE media_batches SET status = 'running', paused_at = NULL, completed_at = NULL, updated_at = ? WHERE id = ?")
      .run(now(), String(batchId));
    schedule(batchId, 0);
    return readBatch(batchId);
  }

  function recoverStandaloneHistory() {
    // Older direct-create pages did not create a batch, but their generation rows are durable.
    // Adopt those existing rows without issuing a new generation request.
    db.transaction(() => {
      for (const kind of ['image','video']) {
        const table = kind === 'image' ? 'image_generations' : 'video_generations';
        const field = kind === 'image' ? 'image_id' : 'video_id';
        const rows = db.prepare(`SELECT g.* FROM ${table} g WHERE g.deleted_at IS NULL AND COALESCE(g.drama_id,0)=0 AND g.storyboard_id IS NULL AND g.client_request_key IS NULL AND NOT EXISTS (SELECT 1 FROM media_batch_items i WHERE i.${field}=g.id)`).all();
        for (const row of rows) {
          const id = `standalone-${kind}-${row.id}`; const created = row.created_at || now();
          db.prepare("INSERT OR IGNORE INTO media_batches (id,idempotency_key,kind,status,title,prompt,model,settings_json,concurrency,total,running,created_at,updated_at) VALUES (?,?,?,'running',?,?,?,?,1,1,1,?,?)")
            .run(id,id,kind,`历史独立${kind === 'image' ? '图片' : '视频'} · ${String(row.prompt || '').slice(0,40)}`,row.prompt || '',row.model || null,JSON.stringify({_origin:'manual',_legacy:true}),created,created);
          db.prepare(`INSERT OR IGNORE INTO media_batch_items (id,batch_id,request_key,ordinal,kind,request_json,status,${field},task_id,attempt,submitted_at,updated_at) VALUES (?,?,?,0,?,?,'processing',?,?,1,?,?)`)
            .run(id,id,id,kind,JSON.stringify({prompt:row.prompt || '',model:row.model || null}),row.id,row.task_id || null,created,created);
        }
      }
    })();
  }

  function resumeAll() {
    recoverStandaloneHistory();
    recoverSubmitting();
    const rows = db.prepare("SELECT id FROM media_batches WHERE status IN ('queued','running','paused')").all();
    rows.forEach((row) => schedule(row.id, 500));
    return rows.length;
  }

  function stop() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return { create, list, get, pause, resume, retryItem, retryDownload, recoverStandaloneHistory, resumeAll, pump, recoverSubmitting, stop };
}

module.exports = {
  MAX_ITEMS,
  createMediaBatchService,
  normalizeConcurrency,
  normalizeIdempotencyKey,
  normalizeKind,
  publicBatch,
  publicItem,
  requestHash,
};
