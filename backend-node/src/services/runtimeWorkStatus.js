'use strict';

const QUEUE_TABLES = Object.freeze({
  async_tasks: ['pending', 'processing', 'running'],
  media_batches: ['queued', 'running'],
  production_runs: ['running'],
  orchestration_blender_jobs: ['queued', 'running'],
  local_media_jobs: ['queued', 'running'],
});

const LIVE_NODE_STATES = Object.freeze([
  'provider_processing',
  'provider_ack',
  'local_task_created',
  'downloading',
  'local_started',
]);

const UNKNOWN_SUBMISSION_STATES = Object.freeze(['submitting', 'uncertain', 'ambiguous']);

class WorkStatusUnreadableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'WorkStatusUnreadableError';
    this.code = 'WORK_STATUS_UNREADABLE';
    this.details = details;
  }
}

function unreadablePayload(details = {}) {
  return {
    schema: 'yinzi.runtime-work-status/v2',
    busy: true,
    blocking: ['unreadable'],
    counts: {},
    analysis_is_recoverable_context: true,
    paused_batches_are_recoverable: true,
    readable: false,
    details,
  };
}

function tableExists(db, name) {
  let row;
  try {
    row = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (error) {
    throw new WorkStatusUnreadableError(`无法确认数据表 ${name} 是否存在`, {
      table: name,
      cause: String(error && error.message || error),
    });
  }
  return Boolean(row);
}

function countRequired(db, sql, params = [], meta = {}) {
  try {
    const row = db.prepare(sql).get(...params);
    const n = Number(row && row.n);
    if (!Number.isFinite(n) || n < 0) {
      throw new WorkStatusUnreadableError('运行状态计数结果不可读', { ...meta, sql });
    }
    return n;
  } catch (error) {
    if (error instanceof WorkStatusUnreadableError) throw error;
    throw new WorkStatusUnreadableError('运行状态查询失败，保持保护', {
      ...meta,
      cause: String(error && error.message || error),
    });
  }
}

function placeholders(values) {
  return values.map(() => '?').join(',');
}

function countIfTable(db, table, sql, params = []) {
  if (!tableExists(db, table)) return 0;
  return countRequired(db, sql, params, { table });
}

function countStatus(db, table, statuses) {
  if (!statuses.length) return 0;
  return countIfTable(
    db,
    table,
    `SELECT COUNT(*) n FROM ${table} WHERE status IN (${placeholders(statuses)})`,
    statuses,
  );
}

function collectRuntimeWorkStatusOrThrow(db) {
  const counts = {};
  counts.research_jobs = require('./productResearchJobs').activeResearchCount();
  for (const [table, statuses] of Object.entries(QUEUE_TABLES)) {
    counts[table] = countStatus(db, table, statuses);
  }

  counts.media_batch_items = countIfTable(
    db,
    'media_batch_items',
    "SELECT COUNT(*) n FROM media_batch_items WHERE status IN ('submitting','processing')",
  );

  counts.image_generations = countIfTable(
    db,
    'image_generations',
    "SELECT COUNT(*) n FROM image_generations WHERE deleted_at IS NULL AND status IN ('pending','processing')",
  );

  counts.video_generations = countIfTable(
    db,
    'video_generations',
    `SELECT COUNT(*) n FROM video_generations
     WHERE deleted_at IS NULL AND (
       status IN ('pending','processing')
       OR generation_status = 'processing'
       OR download_status IN ('downloading','waiting_provider')
     )`,
  );

  counts.asset_import_sessions = countIfTable(
    db,
    'asset_import_sessions',
    "SELECT COUNT(*) n FROM asset_import_sessions WHERE status IN ('scanning','applying','uploading','running')",
  );

  counts.production_actions = countIfTable(
    db,
    'production_actions',
    "SELECT COUNT(*) n FROM production_actions WHERE status IN ('running','processing','submitting')",
  );

  counts.live_orchestration_nodes = countIfTable(
    db,
    'orchestration_nodes',
    `SELECT COUNT(*) n FROM orchestration_nodes
     WHERE active=1 AND status='running'
       AND json_extract(progress_json,'$.state') IN (${placeholders(LIVE_NODE_STATES)})
       AND COALESCE(json_extract(progress_json,'$.submission_state'),'') NOT IN (${placeholders(UNKNOWN_SUBMISSION_STATES)})`,
    [...LIVE_NODE_STATES, ...UNKNOWN_SUBMISSION_STATES],
  );

  counts.unknown_paid_requests = 0;
  if (tableExists(db, 'orchestration_nodes')) {
    counts.unknown_paid_requests += countRequired(
      db,
      `SELECT COUNT(*) n FROM orchestration_nodes
       WHERE active=1 AND (
         json_extract(progress_json,'$.submission_state') IN (${placeholders(UNKNOWN_SUBMISSION_STATES)})
         OR json_extract(progress_json,'$.state')='provider_unknown'
       )`,
      UNKNOWN_SUBMISSION_STATES,
      { table: 'orchestration_nodes' },
    );
  }
  if (tableExists(db, 'video_generations')) {
    counts.unknown_paid_requests += countRequired(
      db,
      `SELECT COUNT(*) n FROM video_generations
       WHERE deleted_at IS NULL AND (
         submission_status='ambiguous'
         OR generation_status='ambiguous'
       )`,
      [],
      { table: 'video_generations' },
    );
  }
  if (tableExists(db, 'media_batch_items')) {
    counts.unknown_paid_requests += countRequired(
      db,
      "SELECT COUNT(*) n FROM media_batch_items WHERE error_code='INTERRUPTED_RESULT_UNKNOWN'",
      [],
      { table: 'media_batch_items' },
    );
  }

  counts.analysis = countIfTable(
    db,
    'orchestration_sessions',
    `SELECT COUNT(*) n FROM orchestration_sessions
     WHERE deleted_at IS NULL AND (
       status='running'
       OR (status='draft' AND json_extract(source_context_json,'$.activity.state')='working')
     )`,
  );

  counts.recoverable_paused_batches = countIfTable(
    db,
    'media_batches',
    "SELECT COUNT(*) n FROM media_batches WHERE status='paused'",
  );

  const execution =
    counts.async_tasks
    + counts.media_batches
    + counts.production_runs
    + counts.orchestration_blender_jobs
    + counts.local_media_jobs
    + counts.media_batch_items
    + counts.image_generations
    + counts.video_generations
    + counts.asset_import_sessions
    + counts.production_actions
    + counts.live_orchestration_nodes
    + counts.research_jobs;

  const unknown = counts.unknown_paid_requests;
  const blocking = [];
  if (execution > 0) blocking.push('execution');
  if (unknown > 0) blocking.push('unknown_paid_request');

  return {
    schema: 'yinzi.runtime-work-status/v2',
    busy: blocking.length > 0,
    blocking,
    counts,
    analysis_is_recoverable_context: true,
    paused_batches_are_recoverable: true,
    readable: true,
  };
}

function collectRuntimeWorkStatus(db) {
  try {
    return collectRuntimeWorkStatusOrThrow(db);
  } catch (error) {
    if (error instanceof WorkStatusUnreadableError) {
      return unreadablePayload(error.details);
    }
    return unreadablePayload({ cause: String(error && error.message || error) });
  }
}

module.exports = {
  QUEUE_TABLES,
  LIVE_NODE_STATES,
  UNKNOWN_SUBMISSION_STATES,
  WorkStatusUnreadableError,
  collectRuntimeWorkStatus,
  collectRuntimeWorkStatusOrThrow,
};
