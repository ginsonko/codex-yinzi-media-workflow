const ALLOWED_UNITS = new Set(['per_request', 'per_image', 'per_second', 'per_character', 'per_1k_tokens', 'unknown']);
const ALLOWED_STATUSES = new Set(['reserved', 'settled', 'released', 'uncertain', 'unpriced']);

function parseJson(value, fallback = {}) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function json(value) {
  return JSON.stringify(value == null ? {} : value);
}

function nowIso() {
  return new Date().toISOString();
}

function toMicrousd(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error('价格必须是非负有限数字');
  return Math.round(number * 1000000);
}

function fromMicrousd(value) {
  return value == null ? null : Number((Number(value) / 1000000).toFixed(6));
}

function normalizeUnit(value) {
  const unit = String(value || 'unknown').trim();
  if (!ALLOWED_UNITS.has(unit)) throw new Error(`不支持的计价单位：${unit}`);
  return unit;
}

function publicPrice(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: Boolean(row.enabled),
    unit_price_usd: fromMicrousd(row.unit_price_microusd),
    input_price_usd: fromMicrousd(row.input_price_microusd),
    output_price_usd: fromMicrousd(row.output_price_microusd),
  };
}

function upsertPrice(db, input = {}) {
  const provider = String(input.provider || '').trim().toLowerCase();
  const serviceType = String(input.service_type || '').trim();
  const model = String(input.model || '').trim();
  const group = String(input.group_name || input.group || '').trim();
  const unit = normalizeUnit(input.billing_unit);
  if (!provider || !serviceType || !model) throw new Error('价格必须包含 provider、service_type 和 model');
  if (String(input.currency || 'USD').toUpperCase() !== 'USD') throw new Error('当前版本只支持 USD 价格');
  const unitPrice = input.unit_price_microusd != null ? Number(input.unit_price_microusd) : toMicrousd(input.unit_price_usd);
  const inputPrice = input.input_price_microusd != null ? Number(input.input_price_microusd) : toMicrousd(input.input_price_usd);
  const outputPrice = input.output_price_microusd != null ? Number(input.output_price_microusd) : toMicrousd(input.output_price_usd);
  if (unit !== 'per_1k_tokens' && unit !== 'unknown' && unitPrice == null) throw new Error('当前计价单位需要 unit_price_usd');
  if (unit === 'per_1k_tokens' && inputPrice == null && outputPrice == null) throw new Error('token 计价至少需要输入或输出价格');
  for (const value of [unitPrice, inputPrice, outputPrice]) {
    if (value != null && (!Number.isInteger(value) || value < 0 || value > 1000000000000)) throw new Error('价格超出允许范围');
  }
  const now = nowIso();
  db.prepare(
    `INSERT INTO model_prices (
       provider, service_type, model, group_name, billing_unit,
       unit_price_microusd, input_price_microusd, output_price_microusd,
       currency, source, source_version, source_fetched_at, enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, service_type, model, group_name, billing_unit) DO UPDATE SET
       unit_price_microusd = excluded.unit_price_microusd,
       input_price_microusd = excluded.input_price_microusd,
       output_price_microusd = excluded.output_price_microusd,
       source = excluded.source,
       source_version = excluded.source_version,
       source_fetched_at = excluded.source_fetched_at,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`
  ).run(
    provider, serviceType, model, group, unit,
    unitPrice, inputPrice, outputPrice,
    String(input.source || 'manual'), input.source_version || null, input.source_fetched_at || null,
    input.enabled === false ? 0 : 1, now, now
  );
  return publicPrice(db.prepare(
    `SELECT * FROM model_prices WHERE provider = ? AND service_type = ? AND model = ? AND group_name = ? AND billing_unit = ?`
  ).get(provider, serviceType, model, group, unit));
}

function listPrices(db, query = {}) {
  const clauses = [];
  const values = [];
  for (const [field, value] of [['provider', query.provider], ['service_type', query.service_type], ['model', query.model]]) {
    if (value == null || value === '') continue;
    clauses.push(`${field} = ?`);
    values.push(field === 'provider' ? String(value).toLowerCase() : String(value));
  }
  if (query.enabled != null) {
    clauses.push('enabled = ?');
    values.push(query.enabled === true || query.enabled === 'true' || query.enabled === 1 ? 1 : 0);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM model_prices ${where} ORDER BY provider, service_type, model, group_name`).all(...values).map(publicPrice);
}

function findPrice(db, input = {}) {
  const provider = String(input.provider || '').trim().toLowerCase();
  const serviceType = String(input.service_type || '').trim();
  const model = String(input.model || '').trim();
  const group = String(input.group_name || input.group || '').trim();
  if (!provider || !serviceType || !model) return null;
  const rows = db.prepare(
    `SELECT * FROM model_prices
     WHERE enabled = 1 AND provider = ? AND service_type = ? AND model = ?
       AND (group_name = ? OR group_name = '')
      ORDER BY CASE WHEN source = 'manual' THEN 0 ELSE 1 END,
               CASE WHEN group_name = ? THEN 0 ELSE 1 END,
               updated_at DESC`
  ).all(provider, serviceType, model, group, group);
  return publicPrice(rows[0] || null);
}

function estimateMicrousd(price, usage = {}) {
  if (!price || price.billing_unit === 'unknown') return null;
  const units = Math.max(0, Number(usage.units ?? usage.quantity ?? 1) || 0);
  if (price.billing_unit === 'per_1k_tokens') {
    const inputTokens = Math.max(0, Number(usage.input_tokens) || 0);
    const outputTokens = Math.max(0, Number(usage.output_tokens) || 0);
    return Math.ceil(
      (inputTokens / 1000) * Number(price.input_price_microusd || 0)
      + (outputTokens / 1000) * Number(price.output_price_microusd || 0)
    );
  }
  return Math.ceil(units * Number(price.unit_price_microusd || 0));
}

function budgetMicrousd(run) {
  if (run?.budget?.max_cost_microusd != null) return Math.max(0, Math.floor(Number(run.budget.max_cost_microusd) || 0));
  if (run?.budget?.max_cost_usd != null) return toMicrousd(run.budget.max_cost_usd);
  return null;
}

function sumRun(db, runId) {
  if (!runId) return { reserved_microusd: 0, settled_microusd: 0, uncertain_microusd: 0, unpriced_count: 0 };
  const rows = db.prepare(
    `SELECT status, COUNT(*) AS count, COALESCE(SUM(CASE
       WHEN status = 'settled' THEN COALESCE(actual_microusd, reserved_microusd)
       WHEN status IN ('reserved', 'uncertain') THEN reserved_microusd ELSE 0 END), 0) AS amount
     FROM cost_ledger WHERE run_id = ? GROUP BY status`
  ).all(runId);
  const result = { reserved_microusd: 0, settled_microusd: 0, uncertain_microusd: 0, unpriced_count: 0 };
  for (const row of rows) {
    if (row.status === 'reserved') result.reserved_microusd = Number(row.amount || 0);
    if (row.status === 'settled') result.settled_microusd = Number(row.amount || 0);
    if (row.status === 'uncertain') result.uncertain_microusd = Number(row.amount || 0);
    if (row.status === 'unpriced') result.unpriced_count = Number(row.count || 0);
  }
  return result;
}

function reserve(db, input = {}) {
  const key = String(input.idempotency_key || '').trim();
  if (!key) throw new Error('费用预留缺少幂等键');
  const existing = db.prepare('SELECT * FROM cost_ledger WHERE idempotency_key = ?').get(key);
  if (existing) return { entry: publicLedger(existing), reused: true };
  const run = input.run_id ? require('./productionRepository').getRun(db, input.run_id) : null;
  const price = input.price || findPrice(db, input);
  const estimate = input.estimated_microusd != null
    ? Math.max(0, Math.floor(Number(input.estimated_microusd) || 0))
    : estimateMicrousd(price, input.usage || { units: input.units });
  // Existing projects without a money cap must keep working even when a
  // third-party provider has no catalog price. They are recorded as unpriced,
  // never as zero. Once a cap exists, unknown prices require explicit opt-in.
  const allowUnknown = input.allow_unknown_price === true
    || run?.budget?.allow_unknown_price === true
    || budgetMicrousd(run) == null;
  if (estimate == null && !allowUnknown) {
    const error = new Error(`模型 ${input.model || '未知'} 没有可用价格，已在付费提交前停止`);
    error.code = 'COST_PRICE_UNKNOWN';
    throw error;
  }
  const tx = db.transaction(() => {
    const raced = db.prepare('SELECT * FROM cost_ledger WHERE idempotency_key = ?').get(key);
    if (raced) return { entry: publicLedger(raced), reused: true };
    const summary = sumRun(db, input.run_id);
    const limit = budgetMicrousd(run);
    const reserved = estimate || 0;
    const committed = summary.reserved_microusd + summary.settled_microusd + summary.uncertain_microusd;
    if (limit != null && committed + reserved > limit) {
      const error = new Error(`本次预计 ${fromMicrousd(reserved).toFixed(6)} USD，将超过任务金额上限 ${fromMicrousd(limit).toFixed(6)} USD`);
      error.code = 'COST_BUDGET_EXHAUSTED';
      error.details = { limit_microusd: limit, committed_microusd: committed, requested_microusd: reserved };
      throw error;
    }
    const now = nowIso();
    const status = estimate == null ? 'unpriced' : 'reserved';
    const priceSnapshot = price || {
      provider: String(input.provider || ''), service_type: String(input.service_type || ''),
      model: String(input.model || ''), billing_unit: String(input.billing_unit || 'unknown'), source: 'unpriced',
    };
    const info = db.prepare(
      `INSERT INTO cost_ledger (
         run_id, action_id, idempotency_key, provider, service_type, model, billing_unit,
         units, status, estimated_microusd, reserved_microusd, price_snapshot_json,
         usage_snapshot_json, note, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.run_id || null, input.action_id || null, key, String(input.provider || '').toLowerCase(),
      String(input.service_type || ''), String(input.model || ''), normalizeUnit(input.billing_unit || price?.billing_unit || 'unknown'),
      Math.max(0, Number(input.units ?? input.usage?.units ?? 0) || 0), status, estimate, reserved,
      json(priceSnapshot), json(input.usage || {}), input.note || null, now, now
    );
    return { entry: publicLedger(db.prepare('SELECT * FROM cost_ledger WHERE id = ?').get(Number(info.lastInsertRowid))), reused: false };
  });
  return tx.immediate();
}

function publicLedger(row) {
  if (!row) return null;
  return {
    ...row,
    price_snapshot: parseJson(row.price_snapshot_json),
    usage_snapshot: parseJson(row.usage_snapshot_json),
    estimated_usd: fromMicrousd(row.estimated_microusd),
    reserved_usd: fromMicrousd(row.reserved_microusd),
    actual_usd: fromMicrousd(row.actual_microusd),
    price_snapshot_json: undefined,
    usage_snapshot_json: undefined,
  };
}

function transition(db, keyOrId, status, input = {}) {
  if (!ALLOWED_STATUSES.has(status)) throw new Error(`未知费用状态：${status}`);
  const row = typeof keyOrId === 'number'
    ? db.prepare('SELECT * FROM cost_ledger WHERE id = ?').get(keyOrId)
    : db.prepare('SELECT * FROM cost_ledger WHERE idempotency_key = ?').get(String(keyOrId));
  if (!row) return null;
  if (['settled', 'released'].includes(row.status)) return publicLedger(row);
  if (row.status === 'unpriced') {
    db.prepare(
      `UPDATE cost_ledger SET usage_snapshot_json = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?`
    ).run(json({ ...parseJson(row.usage_snapshot_json), ...(input.usage || {}) }), input.note || null, nowIso(), row.id);
    return publicLedger(db.prepare('SELECT * FROM cost_ledger WHERE id = ?').get(row.id));
  }
  const actual = status === 'settled'
    ? (input.actual_microusd != null ? Math.max(0, Math.floor(Number(input.actual_microusd) || 0)) : row.reserved_microusd)
    : null;
  const now = nowIso();
  db.prepare(
    `UPDATE cost_ledger SET status = ?, actual_microusd = ?, usage_snapshot_json = ?, note = COALESCE(?, note),
       updated_at = ?, settled_at = ? WHERE id = ?`
  ).run(status, actual, json({ ...parseJson(row.usage_snapshot_json), ...(input.usage || {}) }), input.note || null, now,
    ['settled', 'released'].includes(status) ? now : null, row.id);
  return publicLedger(db.prepare('SELECT * FROM cost_ledger WHERE id = ?').get(row.id));
}

function getByAction(db, actionId) {
  return publicLedger(db.prepare('SELECT * FROM cost_ledger WHERE action_id = ? ORDER BY id DESC LIMIT 1').get(Number(actionId)));
}

function listRunCosts(db, runId, query = {}) {
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 100));
  const items = db.prepare('SELECT * FROM cost_ledger WHERE run_id = ? ORDER BY id DESC LIMIT ?').all(runId, limit).map(publicLedger);
  const summary = sumRun(db, runId);
  const run = require('./productionRepository').getRun(db, runId);
  const limitValue = budgetMicrousd(run);
  return {
    items,
    summary: {
      ...summary,
      reserved_usd: fromMicrousd(summary.reserved_microusd),
      settled_usd: fromMicrousd(summary.settled_microusd),
      uncertain_usd: fromMicrousd(summary.uncertain_microusd),
      limit_microusd: limitValue,
      limit_usd: fromMicrousd(limitValue),
      remaining_usd: limitValue == null ? null : fromMicrousd(Math.max(0, limitValue - summary.reserved_microusd - summary.settled_microusd - summary.uncertain_microusd)),
    },
  };
}

function importYinziCatalog(db, catalog) {
  const saved = [];
  const fetchedAt = catalog?.fetched_at || nowIso();
  for (const [serviceType, items] of [['text', catalog?.text], ['image', catalog?.image], ['video', catalog?.video]]) {
    for (const item of Array.isArray(items) ? items : []) {
      const prices = Array.isArray(item.prices) ? item.prices : [];
      for (const price of prices) {
        const billingUnit = String(price.billing_unit || '').toLowerCase();
        if (serviceType === 'video' && !['per_request', 'per_second'].includes(billingUnit)) continue;
        const unit = billingUnit === 'per_second' ? 'per_second'
          : billingUnit.includes('token') ? 'per_1k_tokens'
            : serviceType === 'image' ? 'per_image' : 'per_request';
        const normalized = {
          provider: 'yinzi', service_type: serviceType, model: item.model,
          group_name: price.group || '', billing_unit: unit,
          unit_price_usd: price.effective_price,
          input_price_usd: price.effective_input_usd,
          output_price_usd: price.effective_output_usd,
          source: price.source === 'v0.1.2-default' ? 'yinzi-default' : 'yinzi-auto',
          source_version: price.source === 'v0.1.2-default' ? 'v0.1.2' : catalog.pricing_version || '',
          source_fetched_at: fetchedAt,
        };
        if (unit === 'per_1k_tokens' && normalized.input_price_usd == null && normalized.output_price_usd == null) continue;
        if (unit !== 'per_1k_tokens' && normalized.unit_price_usd == null) continue;
        const existing = db.prepare(
          `SELECT source FROM model_prices
           WHERE provider = ? AND service_type = ? AND model = ? AND group_name = ? AND billing_unit = ?`
        ).get('yinzi', serviceType, item.model, normalized.group_name, unit);
        if (existing?.source === 'manual') continue;
        saved.push(upsertPrice(db, normalized));
      }
    }
  }
  return saved;
}

module.exports = {
  ALLOWED_STATUSES,
  ALLOWED_UNITS,
  budgetMicrousd,
  estimateMicrousd,
  findPrice,
  fromMicrousd,
  getByAction,
  importYinziCatalog,
  listPrices,
  listRunCosts,
  publicLedger,
  reserve,
  sumRun,
  toMicrousd,
  transition,
  upsertPrice,
};
