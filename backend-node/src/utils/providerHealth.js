const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
function createProviderHealth(options = {}) {
  const cooldownMs = Math.max(1000, Number(options.cooldownMs) || DEFAULT_COOLDOWN_MS);
  const failures = new Map();
  function key(provider, model) { return `${String(provider || 'unknown')}::${String(model || 'unknown')}`; }
  function observe(provider, model, input = {}) {
    const k = key(provider, model); const status = Number(input.httpStatus || input.status || 0); const code = String(input.code || '').toUpperCase();
    const transient = status === 429 || status >= 500 || code.includes('TIMEOUT') || code.includes('504');
    if (!transient) return { provider, model, healthy: true, consecutive_failures: 0, cooldown_until: null };
    const previous = failures.get(k) || { count: 0, until: 0 }; const count = previous.count + 1; const until = count >= 2 ? Date.now() + cooldownMs : 0; failures.set(k, { count, until });
    return { provider, model, healthy: false, consecutive_failures: count, cooldown_until: until ? new Date(until).toISOString() : null, retryable: true };
  }
  function state(provider, model) { const item = failures.get(key(provider, model)); const cooling = Boolean(item?.until && item.until > Date.now()); return { provider, model, healthy: !cooling, consecutive_failures: item?.count || 0, cooling_down: cooling, cooldown_until: cooling ? new Date(item.until).toISOString() : null }; }
  function reset(provider, model) { failures.delete(key(provider, model)); }
  return { observe, state, reset };
}
module.exports = { createProviderHealth, DEFAULT_COOLDOWN_MS };
