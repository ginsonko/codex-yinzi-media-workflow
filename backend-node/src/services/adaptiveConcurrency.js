const TERMINAL = new Set(['completed', 'failed', 'needs_review']);
function normalizePolicy(input = {}) {
  const ratio = Number(input.slowdown_ratio ?? 2.5);
  const floor = Number(input.min_observation_ms ?? 30000);
  if (!Number.isFinite(ratio) || ratio <= 1 || !Number.isFinite(floor) || floor < 0) {
    throw Object.assign(new Error('探索参数需要大于 1 的耗时倍率和非负观察时长'), { code: 'MEDIA_BATCH_EXPLORATION_INVALID' });
  }
  return { mode: input.mode === 'adaptive' ? 'adaptive' : 'fixed', slowdown_ratio: ratio, min_observation_ms: floor };
}
function initialState(policy, limit) { return { ...normalizePolicy(policy), current: policy?.mode === 'adaptive' ? 1 : limit, frozen: false, reason: '', cohort: [], samples: {}, rounds: 0 }; }
function group(item) {
  let request; try { request = JSON.parse(item.request_json || '{}'); } catch { request = {}; }
  return JSON.stringify([item.kind, request.provider, request.config_id, request.model, request.size, request.width, request.height, request.duration, request.resolution]);
}
function elapsed(item, time) {
  const start = Date.parse(item.submitted_at); const end = item.completed_at ? Date.parse(item.completed_at) : time;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(1, end - start) : null;
}
function median(values) { const sorted = [...values].sort((a,b)=>a-b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; }
// Pure transition: providers are never called here. Cohorts and observations are
// persisted by the queue, so process recovery continues the same experiment.
function evaluate(state, items, limit, time = Date.now()) {
  const next = { ...state, current: Math.min(limit, Math.max(1, state.current || 1)), cohort: [...(state.cohort || [])], samples: { ...(state.samples || {}) } };
  if (next.mode !== 'adaptive') return { ...next, current: limit };
  if (next.frozen || !next.cohort.length) return next;
  const cohort = next.cohort.map(id => items.find(item=>item.id===id)).filter(Boolean);
  if (cohort.length !== next.cohort.length) return { ...next, frozen:true, reason:'cohort_missing' };
  if (cohort.some(item=>['failed','needs_review'].includes(item.status))) {
    const limited=cohort.some(item=>/429|rate.?limit|限流|too many|quota/i.test(`${item.error_code} ${item.error_message}`));
    return { ...next, frozen:true, reason:limited?'rate_limited':'result_requires_review', cohort:[] };
  }
  for (const item of cohort.filter(item=>item.submitted_at)) {
    const baseline=median(next.samples[group(item)] || []);
    const duration=elapsed(item,time);
    if (baseline && duration > Math.max(next.min_observation_ms, baseline * next.slowdown_ratio)) return { ...next, frozen:true, reason:'latency_tail', cohort:[] };
  }
  if (!cohort.every(item=>TERMINAL.has(item.status))) return next;
  for (const item of cohort) {
    const duration=elapsed(item,time); const key=group(item);
    if (duration != null) next.samples[key]=[...(next.samples[key] || []),duration].slice(-20);
  }
  next.current=Math.min(limit,next.current+1); next.rounds=(next.rounds||0)+1; next.cohort=[];
  if (next.current === limit) next.reason='configured_limit';
  return next;
}
module.exports={normalizePolicy,initialState,evaluate};
