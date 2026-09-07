const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const repo = require('../src/services/productionRepository');
const costs = require('../src/services/productionCostLedger');
const tts = require('../src/services/ttsService');

let db;
let run;

function quietMigrate(database) {
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { runMigrationsAndEnsure(database); } finally { console.log = log; console.warn = warn; }
}

beforeEach(() => {
  db = new Database(':memory:');
  quietMigrate(db);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (id, title, created_at, updated_at) VALUES (1, ?, ?, ?)').run('TTS 费用', now, now);
  db.prepare('INSERT INTO episodes (id, drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, 1, ?, ?, ?)').run('第一集', now, now);
  run = repo.createRun(db, {
    drama_id: 1, episode_id: 1, idempotency_key: 'tts-cost-run', review_owner: 'human',
    input: { story: '验证 TTS 费用边界。' }, budget: { max_cost_usd: 10 },
  }).run;
  costs.upsertPrice(db, {
    provider: 'openai', service_type: 'tts', model: 'tts-pro', group_name: 'standard',
    billing_unit: 'per_character', unit_price_usd: 0.01,
  });
});

afterEach(() => db.close());

describe('TTS money lifecycle', () => {
  function reserve(key, provider = 'openai', model = 'tts-pro') {
    return tts.reserveTtsCost(db, {
      provider, model, text: '四个字符',
      cost_context: { run_id: run.id, group_name: provider === 'edge' ? 'local' : 'standard', idempotency_key: key },
    });
  }

  it('matches the real configured model and settles successful external TTS', () => {
    const reservation = reserve('tts:settled');
    assert.equal(reservation.entry.model, 'tts-pro');
    assert.equal(reservation.entry.reserved_usd, 0.04);
    tts.finishTtsCost(db, reservation, 'settled', { usage: { generated_bytes: 2048 } });
    const row = costs.listRunCosts(db, run.id).items.find((item) => item.idempotency_key === 'tts:settled');
    assert.equal(row.status, 'settled');
    assert.equal(row.actual_usd, 0.04);
  });

  it('releases explicit failures and keeps ambiguous network results committed', () => {
    const released = reserve('tts:released');
    tts.finishTtsCost(db, released, 'released', { note: 'HTTP 400' });
    const uncertain = reserve('tts:uncertain');
    assert.equal(tts.isAmbiguousTtsFailure(new Error('socket timeout')), true);
    tts.finishTtsCost(db, uncertain, 'uncertain', { note: 'socket timeout' });
    const rows = new Map(costs.listRunCosts(db, run.id).items.map((item) => [item.idempotency_key, item]));
    assert.equal(rows.get('tts:released').status, 'released');
    assert.equal(rows.get('tts:uncertain').status, 'uncertain');
    assert.equal(costs.listRunCosts(db, run.id).summary.uncertain_usd, 0.04);
  });

  it('records local Edge Neural TTS as settled zero external cost', () => {
    const reservation = reserve('tts:edge', 'edge', 'edge-neural-local');
    assert.equal(reservation.entry.reserved_usd, 0);
    assert.equal(reservation.entry.price_snapshot.source, 'local-zero-cost');
    tts.finishTtsCost(db, reservation, 'settled');
    const row = costs.listRunCosts(db, run.id).items.find((item) => item.idempotency_key === 'tts:edge');
    assert.equal(row.status, 'settled');
    assert.equal(row.actual_usd, 0);
  });
});
