const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const videoClient = require('../src/services/videoClient');
const videoService = require('../src/services/videoService');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE video_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drama_id INTEGER,
      storyboard_id INTEGER,
      provider TEXT,
      prompt TEXT,
      model TEXT,
      aspect_ratio TEXT,
      video_url TEXT,
      local_path TEXT,
      status TEXT,
      generation_status TEXT,
      download_status TEXT,
      remote_video_url TEXT,
      download_source_url TEXT,
      download_requires_auth INTEGER NOT NULL DEFAULT 0,
      download_error TEXT,
      download_attempts INTEGER NOT NULL DEFAULT 0,
      download_lease_owner TEXT,
      download_lease_expires_at TEXT,
      download_started_at TEXT,
      download_completed_at TEXT,
      provider_completed_at TEXT,
      video_config_id INTEGER,
      provider_protocol TEXT,
      provider_config_snapshot_json TEXT,
      submission_status TEXT,
      submission_http_status INTEGER,
      submission_receipt_json TEXT,
      provider_task_id TEXT,
      provider_prompt_receipt_json TEXT,
      task_id TEXT,
      completed_at TEXT,
      error_msg TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
  `);
  return db;
}

const log = {
  info() {},
  warn() {},
  error() {},
};

function insertGeneration(db, patch = {}) {
  const now = new Date().toISOString();
  const row = {
    drama_id: null,
    storyboard_id: null,
    provider: 'yinzi',
    prompt: 'test',
    model: 'test-video-model',
    aspect_ratio: '16:9',
    video_url: null,
    local_path: null,
    status: 'processing',
    generation_status: 'completed',
    download_status: 'failed',
    remote_video_url: 'https://example.test/old.mp4',
    download_source_url: 'https://example.test/old.mp4',
    download_requires_auth: 0,
    download_error: 'timeout',
    download_attempts: 0,
    provider_task_id: 'provider-task-1',
    task_id: null,
    completed_at: null,
    error_msg: null,
    created_at: now,
    updated_at: now,
    ...patch,
  };
  const columns = Object.keys(row);
  const info = db.prepare(
    `INSERT INTO video_generations (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  ).run(...columns.map((key) => row[key]));
  return Number(info.lastInsertRowid);
}

describe('video delivery recovery', () => {
  it('settles the original generation cost when the provider completes, before local delivery', () => {
    const db = createDb();
    db.exec(`
      CREATE TABLE production_actions (
        id INTEGER PRIMARY KEY,
        run_id TEXT,
        action_key TEXT,
        kind TEXT,
        generation_id INTEGER
      );
      CREATE TABLE cost_ledger (
        id INTEGER PRIMARY KEY,
        idempotency_key TEXT,
        status TEXT,
        reserved_microusd INTEGER,
        actual_microusd INTEGER,
        usage_snapshot_json TEXT,
        note TEXT,
        updated_at TEXT,
        settled_at TEXT
      );
    `);
    const id = insertGeneration(db, {
      generation_status: 'processing',
      download_status: 'pending',
      remote_video_url: null,
      download_source_url: null,
      provider_task_id: 'provider-task-cost',
    });
    db.prepare(
      `INSERT INTO production_actions (id, run_id, action_key, kind, generation_id)
       VALUES (1, 'run-1', 'shot-1-a1', 'video_generate', ?)`
    ).run(id);
    db.prepare(
      `INSERT INTO cost_ledger (
         id, idempotency_key, status, reserved_microusd, usage_snapshot_json, updated_at
       ) VALUES (1, 'production:run-1:shot-1-a1', 'reserved', 500000, '{}', ?)`
    ).run(new Date().toISOString());

    const row = db.prepare('SELECT * FROM video_generations WHERE id = ?').get(id);
    videoService._markProviderCompleted(db, log, id, row, 'https://example.test/final.mp4', {
      require_local: true,
    });

    const generation = db.prepare('SELECT * FROM video_generations WHERE id = ?').get(id);
    const ledger = db.prepare('SELECT * FROM cost_ledger WHERE id = 1').get();
    assert.equal(generation.status, 'processing');
    assert.equal(generation.generation_status, 'completed');
    assert.equal(generation.download_status, 'pending');
    assert.equal(generation.video_url, 'https://example.test/final.mp4');
    assert.equal(ledger.status, 'settled');
    assert.equal(ledger.actual_microusd, 500000);
    db.close();
  });

  it('backfills the historical completed-but-download-failed error without reopening generation', () => {
    const db = createDb();
    const id = insertGeneration(db, {
      status: 'failed',
      generation_status: null,
      download_status: null,
      remote_video_url: null,
      download_source_url: null,
      download_error: null,
      error_msg: '视频任务已完成，但结果无法下载到本地；请保留任务 ID 后重试下载，不要重新提交生成',
    });

    assert.equal(videoService._backfillVideoDeliveryState(db, log), 1);
    const row = db.prepare('SELECT * FROM video_generations WHERE id = ?').get(id);
    assert.equal(row.status, 'processing');
    assert.equal(row.generation_status, 'completed');
    assert.equal(row.download_status, 'failed');
    assert.match(row.download_error, /不要重新提交生成/);
    assert.equal(row.error_msg, null);
    db.close();
  });

  it('allows only one local download across ten concurrent retry clicks', async () => {
    const db = createDb();
    const id = insertGeneration(db);
    let downloads = 0;
    const download = async () => {
      downloads += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return 'projects/demo/videos/recovered.mp4';
    };
    const options = {
      config: { storage: { local_path: 'unused' } },
      video_config: { id: 1, api_key: 'redacted' },
      download,
      disable_retry: true,
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => videoService.resumeDownloadForVideoGeneration(db, log, id, options))
    );
    const row = db.prepare('SELECT * FROM video_generations WHERE id = ?').get(id);
    assert.equal(downloads, 1);
    assert.equal(row.status, 'completed');
    assert.equal(row.generation_status, 'completed');
    assert.equal(row.download_status, 'completed');
    assert.equal(row.local_path, 'projects/demo/videos/recovered.mp4');
    assert.equal(results.filter((result) => result.state === 'completed').length, 1);
    db.close();
  });

  it('refreshes an expired URL through the original task and never calls video creation', async () => {
    const db = createDb();
    const id = insertGeneration(db);
    let downloads = 0;
    let refreshes = 0;
    let creates = 0;
    const originalCreate = videoClient.callVideoApi;
    videoClient.callVideoApi = async () => {
      creates += 1;
      throw new Error('must not be called');
    };
    try {
      const result = await videoService.resumeDownloadForVideoGeneration(db, log, id, {
        config: { storage: { local_path: 'unused' } },
        video_config: { id: 1, api_key: 'redacted' },
        disable_retry: true,
        download: async (_storage, url) => {
          downloads += 1;
          if (url.includes('/old.')) throw new Error('HTTP 403');
          return 'videos/refreshed.mp4';
        },
        refresh_source: async () => {
          refreshes += 1;
          return {
            source_url: 'https://example.test/new.mp4',
            remote_video_url: 'https://example.test/new.mp4',
            requires_auth: false,
          };
        },
      });
      assert.equal(result.state, 'completed');
      assert.equal(downloads, 2);
      assert.equal(refreshes, 1);
      assert.equal(creates, 0);
    } finally {
      videoClient.callVideoApi = originalCreate;
      db.close();
    }
  });

  it('does not submit a completed generation again when processing is triggered twice', async () => {
    const db = createDb();
    const id = insertGeneration(db, {
      status: 'completed',
      download_status: 'completed',
      local_path: 'videos/final.mp4',
    });
    let creates = 0;
    const originalCreate = videoClient.callVideoApi;
    videoClient.callVideoApi = async () => {
      creates += 1;
      return { task_id: 'unexpected' };
    };
    try {
      await videoService.processVideoGeneration(db, log, id);
      await videoService.processVideoGeneration(db, log, id);
      assert.equal(creates, 0);
    } finally {
      videoClient.callVideoApi = originalCreate;
      db.close();
    }
  });

  it('keeps restart recovery deterministic for unsent and ambiguous submissions', () => {
    const db = createDb();
    const unsent = insertGeneration(db, {
      status: 'processing', generation_status: 'processing', download_status: 'pending',
      provider_task_id: null, submission_status: 'not_sent',
    });
    const ambiguous = insertGeneration(db, {
      status: 'processing', generation_status: 'processing', download_status: 'pending',
      provider_task_id: null, submission_status: 'ambiguous',
    });

    videoService.resumeProcessingVideoGenerations(db, log);

    const unsentRow = videoService.getById(db, unsent);
    const ambiguousRow = videoService.getById(db, ambiguous);
    assert.equal(unsentRow.status, 'failed');
    assert.equal(unsentRow.generation_status, 'failed');
    assert.equal(unsentRow.submission_status, 'not_sent');
    assert.equal(ambiguousRow.status, 'failed');
    assert.equal(ambiguousRow.generation_status, 'ambiguous');
    assert.equal(ambiguousRow.submission_status, 'ambiguous');
    db.close();
  });

  it('attaches a verified processing provider task without creating a replacement generation', async () => {
    const db = createDb();
    const id = insertGeneration(db, {
      status: 'failed', generation_status: 'ambiguous', download_status: 'pending',
      provider_task_id: null, submission_status: 'ambiguous',
      provider_config_snapshot_json: JSON.stringify({ provider: 'generic', protocol: 'openai-video' }),
    });
    const result = await videoService.attachProviderTaskForRecovery(db, log, id, 'provider-processing-1', {
      video_config: { provider: 'generic', protocol: 'openai-video', api_key: 'redacted' },
      probe: async () => ({ pending: true, status: 'processing', progress: 37 }),
      disable_resume: true,
    });
    assert.equal(result.reused, false);
    assert.equal(result.generation.id, id);
    assert.equal(result.generation.provider_task_id, 'provider-processing-1');
    assert.equal(result.generation.generation_status, 'processing');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM video_generations').get().n, 1);
    db.close();
  });

  it('records a verified completed task immediately and never invokes video creation', async () => {
    const db = createDb();
    const id = insertGeneration(db, {
      status: 'failed', generation_status: 'ambiguous', download_status: 'pending',
      provider_task_id: null, submission_status: 'ambiguous',
    });
    let creates = 0;
    const originalCreate = videoClient.callVideoApi;
    videoClient.callVideoApi = async () => { creates += 1; throw new Error('must not create'); };
    try {
      const result = await videoService.attachProviderTaskForRecovery(db, log, id, 'provider-completed-1', {
        video_config: { provider: 'generic', protocol: 'openai-video', api_key: 'redacted' },
        probe: async () => ({ status: 'completed', video_url: 'https://example.test/recovered.mp4' }),
        disable_resume: true,
      });
      assert.equal(result.generation.id, id);
      assert.equal(result.generation.generation_status, 'completed');
      assert.equal(result.generation.status, 'completed');
      assert.equal(result.generation.video_url, 'https://example.test/recovered.mp4');
      assert.equal(result.generation.download_status, 'not_required');
      assert.equal(creates, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM video_generations').get().n, 1);
    } finally {
      videoClient.callVideoApi = originalCreate;
      db.close();
    }
  });

  it('rejects an attempt to replace an already bound provider task id', async () => {
    const db = createDb();
    const id = insertGeneration(db, { provider_task_id: 'original-task' });
    await assert.rejects(
      videoService.attachProviderTaskForRecovery(db, log, id, 'different-task', {
        video_config: { provider: 'generic', protocol: 'openai-video', api_key: 'redacted' },
        probe: async () => ({ pending: true, status: 'processing' }),
        disable_resume: true,
      }),
      (error) => error.code === 'PROVIDER_TASK_ID_CONFLICT',
    );
    assert.equal(videoService.getById(db, id).provider_task_id, 'original-task');
    db.close();
  });
});
