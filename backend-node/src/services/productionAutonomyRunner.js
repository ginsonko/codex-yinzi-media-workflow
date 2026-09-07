const crypto = require('node:crypto');
const repo = require('./productionRepository');
const { createProductionService } = require('./productionService');
const { semanticProgressSignature, idleBackoffDelay } = require('./productionProgress');

const TERMINAL_WAIT_REASONS = new Set([
  'manual_content_required',
  'user_paused',
  'user_cancelled',
  'ambiguous_external_task',
  'budget_exhausted',
  'resource_unavailable',
  'automation_limit_reached',
  'automation_diagnosis_stopped',
  'automation_recovery_failed',
  'local_observation_stopped',
  'provider_cancelled_pending_refund',
  'provider_cancel_requested_unknown',
  // A provider create returned no task id. This is a manual reconciliation
  // hold; never keep scheduling the run while the user checks the provider.
  'ambiguous_video_create',
  'ambiguous_retry_ready',
]);

function shouldScheduleRun(run) {
  if (!run || run.review_owner === 'human') return false;
  if (run.runtime?.autonomy?.intervention) return false;
  if (['paused', 'cancelled', 'completed', 'draft', 'waiting_client'].includes(run.status)) return false;
  if (run.status === 'waiting_review' && TERMINAL_WAIT_REASONS.has(run.waiting_reason)) return false;
  return ['running', 'waiting_provider', 'waiting_review', 'failed'].includes(run.status);
}

function delayForOutcome(outcome, options = {}) {
  if (!outcome) return Number(options.error_delay_ms) || 5000;
  if (outcome.state === 'waiting_provider' || outcome.state === 'waiting_task') {
    return Number(options.provider_delay_ms) || 4000;
  }
  if (outcome.state === 'progressed' || outcome.state === 'approved') {
    return Number(options.progress_delay_ms) || 150;
  }
  return Number(options.idle_delay_ms) || 15000;
}

function createProductionAutonomyRunner(db, cfg, log, injected = {}) {
  const service = injected.service || createProductionService(db, cfg, log, injected.serviceAdapters || {});
  const intervalMs = Math.max(250, Number(injected.interval_ms) || 1000);
  const maxRunsPerTick = Math.max(1, Math.min(20, Number(injected.max_runs_per_tick) || 4));
  const ownerPrefix = injected.owner_prefix || `autonomy-${crypto.randomUUID()}`;
  const now = injected.now || (() => Date.now());
  const setIntervalFn = injected.setInterval || setInterval;
  const clearIntervalFn = injected.clearInterval || clearInterval;
  const dueAt = new Map();
  const consecutiveSemanticIdle = new Map();
  let timer = null;
  let running = false;
  let stopped = false;

  function listCandidates() {
    const candidates = [];
    let page = 1;
    while (page <= 20) {
      const result = repo.listRuns(db, { page, page_size: 100 });
      candidates.push(...result.items.filter(shouldScheduleRun));
      if (page >= result.pagination.total_pages) break;
      page += 1;
    }
    return candidates;
  }

  async function runOnce() {
    if (running || stopped) return { skipped: true, reason: stopped ? 'stopped' : 'busy' };
    running = true;
    const outcomes = [];
    try {
      const timestamp = now();
      const candidates = listCandidates()
        .filter((run) => Number(dueAt.get(run.id) || 0) <= timestamp)
        .slice(0, maxRunsPerTick);
      for (const run of candidates) {
        let outcome;
        try {
          const beforeSignature = semanticProgressSignature(repo.getRunSummary(db, run.id) || run);
          outcome = await service.advance(run.id, {
            lease_owner: `${ownerPrefix}:${run.id}`,
            lease_ttl_ms: 45000,
            background: true,
          });
          const latestSummary = repo.getRunSummary(db, run.id);
          const latest = latestSummary?.run || repo.getRun(db, run.id);
          const semanticChanged = beforeSignature !== semanticProgressSignature(latestSummary || latest || run);
          outcome = { ...(outcome || {}), semantic_progress: semanticChanged };
          if (semanticChanged) consecutiveSemanticIdle.delete(run.id);
          else if (['progressed', 'approved'].includes(outcome.state)) {
            consecutiveSemanticIdle.set(run.id, Number(consecutiveSemanticIdle.get(run.id) || 0) + 1);
          }
          if (shouldScheduleRun(latest)) {
            const idleCount = Number(consecutiveSemanticIdle.get(run.id) || 0);
            dueAt.set(run.id, now() + (idleCount > 0
              ? idleBackoffDelay(idleCount, injected)
              : delayForOutcome(outcome, injected)));
          } else {
            dueAt.delete(run.id);
            consecutiveSemanticIdle.delete(run.id);
          }
        } catch (error) {
          dueAt.set(run.id, now() + delayForOutcome(null, injected));
          log.error('Background production advance failed', {
            run_id: run.id,
            error: String(error?.message || error).slice(0, 800),
          });
          outcome = { state: 'error', error: String(error?.message || error).slice(0, 800) };
        }
        outcomes.push({ run_id: run.id, outcome });
      }
      return { skipped: false, processed: outcomes.length, outcomes };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer || stopped) return false;
    timer = setIntervalFn(() => { void runOnce(); }, intervalMs);
    if (typeof timer?.unref === 'function') timer.unref();
    void runOnce();
    return true;
  }

  function stop() {
    stopped = true;
    if (timer) clearIntervalFn(timer);
    timer = null;
    dueAt.clear();
    consecutiveSemanticIdle.clear();
  }

  return {
    delayForOutcome: (outcome) => delayForOutcome(outcome, injected),
    isRunning: () => Boolean(timer) && !stopped,
    runOnce,
    start,
    stop,
  };
}

module.exports = {
  createProductionAutonomyRunner,
  delayForOutcome,
  idleBackoffDelay,
  shouldScheduleRun,
};
