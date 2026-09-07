const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const repo = require('../src/services/productionRepository');
const {
  createProductionAutonomyRunner,
  delayForOutcome,
  shouldScheduleRun,
} = require('../src/services/productionAutonomyRunner');

let db;
const log = { info() {}, warn() {}, error() {} };

function migrateQuietly() {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = originalLog; console.warn = originalWarn; }
}

function createRun(owner, suffix) {
  return repo.createRun(db, {
    drama_id: 1,
    review_owner: owner,
    idempotency_key: `runner-${suffix}`,
    input: { story: '一个用于后台推进器测试的完整故事输入。' },
  }).run;
}

beforeEach(() => {
  db = new Database(':memory:');
  migrateQuietly();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (id, title, created_at, updated_at) VALUES (1, ?, ?, ?)').run('后台任务', now, now);
});

afterEach(() => db.close());

describe('production autonomy runner', () => {
  it('schedules only non-human runnable work and respects intervention/client stops', () => {
    assert.equal(shouldScheduleRun({ review_owner: 'ai', status: 'running', runtime: {} }), true);
    assert.equal(shouldScheduleRun({ review_owner: 'auto_accept', status: 'waiting_provider', runtime: {} }), true);
    assert.equal(shouldScheduleRun({ review_owner: 'human', status: 'running', runtime: {} }), false);
    assert.equal(shouldScheduleRun({ review_owner: 'ai', status: 'waiting_client', runtime: {} }), false);
    assert.equal(shouldScheduleRun({ review_owner: 'ai', status: 'waiting_review', waiting_reason: 'manual_content_required', runtime: {} }), false);
    assert.equal(shouldScheduleRun({ review_owner: 'ai', status: 'waiting_review', waiting_reason: 'ambiguous_video_create', runtime: {} }), false);
    assert.equal(shouldScheduleRun({ review_owner: 'ai', status: 'waiting_review', waiting_reason: 'ambiguous_retry_ready', runtime: {} }), false);
    assert.equal(shouldScheduleRun({ review_owner: 'ai', status: 'waiting_review', runtime: { autonomy: { intervention: {} } } }), false);
  });

  it('uses short progress delay and slower provider polling', () => {
    assert.equal(delayForOutcome({ state: 'progressed' }, { progress_delay_ms: 25 }), 25);
    assert.equal(delayForOutcome({ state: 'waiting_provider' }, { provider_delay_ms: 2500 }), 2500);
  });

  it('advances a runnable AI task once and leaves human tasks untouched', async () => {
    const aiRun = createRun('ai', 'ai');
    const humanRun = createRun('human', 'human');
    repo.updateRun(db, aiRun.id, { status: 'running' });
    repo.updateRun(db, humanRun.id, { status: 'running' });
    const calls = [];
    const runner = createProductionAutonomyRunner(db, {}, log, {
      service: {
        async advance(runId, input) {
          calls.push({ runId, input });
          repo.updateRun(db, runId, { status: 'waiting_provider', waiting_reason: 'test_provider' });
          return { state: 'waiting_provider' };
        },
      },
      now: () => 1000,
      max_runs_per_tick: 4,
    });
    const result = await runner.runOnce();
    assert.equal(result.processed, 1);
    assert.equal(calls[0].runId, aiRun.id);
    assert.match(calls[0].input.lease_owner, /^autonomy-/);
    assert.equal(repo.getRun(db, humanRun.id).status, 'running');
    runner.stop();
  });

  it('recovers persisted autonomous work after a fresh runner starts without touching hard stops', async () => {
    const resumable = createRun('ai', 'restart-resumable');
    const human = createRun('human', 'restart-human');
    const ambiguous = createRun('auto_accept', 'restart-ambiguous');
    repo.updateRun(db, resumable.id, {
      status: 'failed', waiting_reason: 'video_generation_failed',
      error_code: 'VIDEO_GENERATION_FAILED', error_message: 'temporary provider outage',
    });
    repo.updateRun(db, human.id, {
      status: 'failed', waiting_reason: 'video_generation_failed',
      error_code: 'VIDEO_GENERATION_FAILED', error_message: 'manual task failure',
    });
    repo.updateRun(db, ambiguous.id, {
      status: 'waiting_review', waiting_reason: 'ambiguous_external_task',
      error_code: 'VIDEO_CREATE_AMBIGUOUS', error_message: 'provider result unknown',
    });

    const calls = [];
    const runner = createProductionAutonomyRunner(db, {}, log, {
      service: {
        async advance(runId) {
          calls.push(runId);
          repo.updateRun(db, runId, { status: 'running', waiting_reason: null, error_code: null, error_message: null });
          return { state: 'progressed' };
        },
      },
      now: () => 5000,
      max_runs_per_tick: 10,
    });

    const result = await runner.runOnce();
    assert.equal(result.processed, 1);
    assert.deepEqual(calls, [resumable.id]);
    assert.equal(repo.getRun(db, human.id).status, 'failed');
    assert.equal(repo.getRun(db, ambiguous.id).waiting_reason, 'ambiguous_external_task');
    runner.stop();
  });

  it('backs off when an outcome claims progress but persisted semantics did not change', async () => {
    const run = createRun('ai', 'semantic-idle');
    repo.updateRun(db, run.id, { status: 'running' });
    let clock = 1000;
    let calls = 0;
    const runner = createProductionAutonomyRunner(db, {}, log, {
      service: { async advance() { calls += 1; return { state: 'progressed' }; } },
      now: () => clock,
      max_runs_per_tick: 1,
      semantic_idle_delay_ms: 3500,
      semantic_idle_max_delay_ms: 30000,
    });

    const first = await runner.runOnce();
    assert.equal(first.outcomes[0].outcome.semantic_progress, false);
    assert.equal(calls, 1);
    clock = 4499;
    assert.equal((await runner.runOnce()).processed, 0);
    clock = 4500;
    assert.equal((await runner.runOnce()).processed, 1);
    assert.equal(calls, 2);
    clock = 11499;
    assert.equal((await runner.runOnce()).processed, 0);
    clock = 11500;
    assert.equal((await runner.runOnce()).processed, 1);
    assert.equal(calls, 3);
    runner.stop();
  });

  it('resets semantic idle backoff after a real artifact change', async () => {
    const run = createRun('ai', 'semantic-reset');
    repo.updateRun(db, run.id, { status: 'running' });
    let clock = 1000;
    let calls = 0;
    const runner = createProductionAutonomyRunner(db, {}, log, {
      service: {
        async advance(runId) {
          calls += 1;
          if (calls === 2) {
            repo.createArtifact(db, {
              run_id: runId, stage: 'script', scope_type: 'run', scope_id: '',
              title: '语义进展', status: 'draft', content: { text: '新剧本' },
            });
          }
          return { state: 'progressed' };
        },
      },
      now: () => clock,
      max_runs_per_tick: 1,
      progress_delay_ms: 150,
      semantic_idle_delay_ms: 3500,
    });

    await runner.runOnce();
    clock = 4500;
    const changed = await runner.runOnce();
    assert.equal(changed.outcomes[0].outcome.semantic_progress, true);
    clock = 4649;
    assert.equal((await runner.runOnce()).processed, 0);
    clock = 4650;
    assert.equal((await runner.runOnce()).processed, 1);
    runner.stop();
  });
});
