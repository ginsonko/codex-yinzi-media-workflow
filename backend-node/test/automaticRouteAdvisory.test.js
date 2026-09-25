const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const repo = require('../src/services/productionRepository');
const aiConfigService = require('../src/services/aiConfigService');
const { createProductionMediaService } = require('../src/services/productionMediaService');
const { selectShotVideoRoute, listShotVideoRouteOptions } = require('../src/services/productionVideoRouter');

// All catalog and generation operations are injected. No real provider, key,
// production database, or filesystem media is used by these regressions.
const shot = { scope_id: '1', content: { number: 1, duration: 5, previs_mode: 'skip' } };
const policy = { video_routing_mode: 'auto', director_mode: 'off' };

test('automatic route uses actual configured model without a directory or invented price', () => {
  const route = selectShotVideoRoute({ shot, policy, catalog: { video: [], configured_model: 'user-config-model', discovery_outcome: 'unavailable', warnings: ['fixture timeout'] } });
  assert.equal(route.model, 'user-config-model');
  assert.equal(route.automatic, true);
  assert.equal(route.catalog_verified, false);
  assert.equal(route.estimated_price, null);
  assert.deepEqual(route.routing_diagnostics.warnings, ['fixture timeout']);
  assert.ok(route.reason_codes.includes('automatic_configured_model_fallback'));
});

test('configured model wins when metadata eliminates normal automatic candidates', () => {
  const route = selectShotVideoRoute({ shot, policy: { ...policy, video_group: 'chosen-group' }, catalog: {
    configured_model: 'user-config-model',
    video: [{ model: 'user-config-model', groups: ['other-group'], prices: [], capabilities: null, credential_verified: false },
      { model: 'unrelated-discovered', groups: ['chosen-group'], prices: [], capabilities: null, credential_verified: true }],
  } });
  assert.equal(route.model, 'user-config-model');
  assert.ok(route.contract_warnings.includes('group_unavailable'));
  assert.ok(route.contract_warnings.includes('credential_unverified'));
  assert.ok(route.contract_warnings.includes('price_unknown'));
  assert.equal(route.routing_diagnostics.candidates.length, 2);
});

test('metadata-only catalog exclusions remain diagnostic when no configured model exists', () => {
  const route = selectShotVideoRoute({ shot, policy, catalog: { video: [{ model: 'discovered-video', public_catalog: true, scope_verified: false, capabilities: null, prices: [] }] } });
  assert.equal(route.model, 'discovered-video');
  assert.ok(route.reason_codes.includes('automatic_catalog_metadata_advisory'));
  assert.ok(route.contract_warnings.includes('credential_unverified'));
});

test('only absence of both configured and discovered names is a missing-model error', () => {
  assert.throws(() => selectShotVideoRoute({ shot, policy, catalog: { video: [] } }), { code: 'VIDEO_MODEL_NOT_CONFIGURED' });
});

test('expensive model is selectable without a separate confirmation and missing prices stay null', () => {
  const catalog = { video: [{ model: '破甲seedance 720p-fast', prices: [{ billing_unit: 'per_second', effective_price: null }] }] };
  const option = listShotVideoRouteOptions({ shot, policy, catalog })[0];
  assert.equal(option.selectable, true);
  assert.equal(option.requires_explicit_confirmation, false);
  assert.ok(option.warnings.includes('expensive_bypass'));
  assert.equal(option.estimated_price, null);
});

test('production automatic route retains selected connection and default model through failed discovery and actual create', async () => {
  const db = new Database(':memory:');
  const originalLog = console.log; const originalWarn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = originalLog; console.warn = originalWarn; }
  try {
    const log = { info() {}, warn() {}, error() {} };
    const config = aiConfigService.createConfig(db, log, { service_type: 'video', provider: 'yinzi', name: 'Selected fixture connection', base_url: 'https://unused.invalid/v1', api_key: 'fixture-only', model: ['fixture-first', 'fixture-selected-default'], default_model: 'fixture-selected-default', is_default: true });
    const now = new Date().toISOString();
    db.prepare('INSERT INTO dramas (id,title,created_at,updated_at) VALUES (1,?,?,?)').run('Fixture', now, now);
    db.prepare('INSERT INTO episodes (id,drama_id,episode_number,title,created_at,updated_at) VALUES (1,1,1,?,?,?)').run('Fixture', now, now);
    const run = repo.createRun(db, { drama_id: 1, episode_id: 1, idempotency_key: 'automatic-route-advisory', input: { story: 'Fixture' }, policy: { ...policy, video_config_id: config.id, video_provider: 'yinzi' }, budget: { max_video_attempts: 1, max_video_seconds: 5 } }).run;
    const source = repo.createArtifact(db, { run_id: run.id, stage: 'storyboard_plan', scope_type: 'shot', scope_id: '1', status: 'approved', content: { ...shot.content, included: true, video_prompt: 'A continuous garden shot.', visual: 'Garden.', action: 'Walk.', transition_mode: 'opening', character_names: [], prop_names: [] } });
    const previous = repo.reserveAction(db, { run_id: run.id, action_key: 'original', stage: 'shot_video', kind: 'video_generate', scope_type: 'shot', scope_id: '1', request: { source_artifact_id: source.id }, reserved_video_seconds: 5 }).action;
    repo.updateAction(db, previous.id, { status: 'ambiguous' });
    repo.requestAmbiguousRetryStart(db, previous.id);
    let creates = 0; let request;
    const service = createProductionMediaService(db, { storage: { local_path: './unused-storage', base_url: 'http://localhost/static' } }, log, {
      fetchVideoCatalog: async () => { throw new Error('Fixture discovery unavailable'); },
      createVideo: async value => { request = value; creates++; return { id: 71, task_id: 'fixture-71', model: value.model }; },
    });
    const routed = await service.resolveShotVideoRoute(repo.getRun(db, run.id), source);
    assert.equal(routed.model, 'fixture-selected-default');
    assert.equal(routed.video_config_id, config.id);
    assert.equal(routed.catalog_verified, false);
    const generated = await service.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(generated.state, 'waiting_provider');
    assert.equal(creates, 1);
    assert.equal(request.model, 'fixture-selected-default');
    assert.equal(request.video_config_id, config.id);
    const pinned = await service.resolveShotVideoRoute(repo.getRun(db, run.id), source, { approvedRouteHint: { model: 'already-selected-model' } });
    assert.equal(pinned.model, 'already-selected-model');
    assert.equal(pinned.video_config_id, config.id);
    assert.ok(pinned.contract_warnings.includes('model_not_in_catalog'));
  } finally { db.close(); }
});
