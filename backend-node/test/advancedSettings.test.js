const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const promptRegistry = require('../src/services/productionPromptRegistry');
const costs = require('../src/services/productionCostLedger');
const bundles = require('../src/services/configBundleService');
const repo = require('../src/services/productionRepository');
const automationPreferences = require('../src/services/productionAutomationPreferences');

let db;

function quietMigrate(database) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { runMigrationsAndEnsure(database); } finally { console.log = originalLog; console.warn = originalWarn; }
}

function seedProject() {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (id, title, created_at, updated_at) VALUES (1, ?, ?, ?)').run('预算测试', now, now);
  db.prepare('INSERT INTO episodes (id, drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, 1, ?, ?, ?)').run('第一集', now, now);
}

function makeRun(overrides = {}) {
  return repo.createRun(db, {
    drama_id: 1,
    episode_id: 1,
    idempotency_key: overrides.idempotency_key || `advanced-${Math.random()}`,
    review_owner: 'human',
    input: { story: '一个用于验证预算和配置迁移的故事。' },
    budget: { max_video_attempts: 10, max_video_seconds: 60, ...overrides.budget },
  }).run;
}

beforeEach(() => {
  db = new Database(':memory:');
  quietMigrate(db);
  seedProject();
});

afterEach(() => db.close());

describe('advanced settings contracts', () => {
  it('normalizes automation preferences and includes them in portable snapshots', () => {
    assert.deepEqual(automationPreferences.get(db), automationPreferences.DEFAULTS);
    const saved = automationPreferences.set(db, {
      review_concurrency: 99,
      max_consecutive_review_rejections: 99,
      max_consecutive_recovery_failures: 0,
      notifications_enabled: false,
      notification_sound_enabled: true,
      moderation_fallback_enabled: true,
      moderation_fallback_model: '破甲seedance 720p-fast',
    });
    assert.equal(saved.review_concurrency, 99);
    assert.equal(saved.max_consecutive_review_rejections, 20);
    assert.equal(saved.max_consecutive_recovery_failures, 1);
    assert.equal(saved.notifications_enabled, false);
    assert.equal(saved.moderation_fallback_enabled, true);
    const bundle = bundles.exportBundle(db);
    assert.deepEqual(bundle.sections.settings.production_automation_preferences, saved);
    const snapshot = bundles.createSnapshot(db, { snapshot_type: 'manual', reason: '自动化设置' });
    automationPreferences.set(db, { review_concurrency: 1 });
    const preview = bundles.previewSnapshotRollback(db, snapshot.id);
    bundles.applyPreview(db, preview.token);
    assert.deepEqual(automationPreferences.get(db), saved);
  });

  it('validates prompt variables, preserves locked output contracts, and exports only overrides', () => {
    assert.throws(
      () => promptRegistry.set(db, 'production.storyboard.system', '使用 {{unknown}} 变量'),
      /未知变量/,
    );
    promptRegistry.set(db, 'production.storyboard.system', '镜头至少 {{min_shot_seconds}} 秒。{{transition_rule}}');
    const resolved = promptRegistry.resolve(db, 'production.storyboard.system', {
      variables: { min_shot_seconds: 5, transition_rule: '默认硬切。' },
    });
    assert.match(resolved.content, /镜头至少 5 秒/);
    assert.match(resolved.content, /只返回 JSON/);
    assert.equal(resolved.customized, true);
    const exported = promptRegistry.exportPackage(db);
    assert.equal(exported.prompts.length, 1);
    assert.equal(exported.prompts[0].prompt_id, 'production.storyboard.system');
    assert.throws(
      () => promptRegistry.validatePackage({ ...exported, prompts: [{ prompt_id: 'unknown', prompt_version: 1, content: 'x' }] }),
      /未知/,
    );
  });

  it('uses the versioned registry default at runtime, preserves overrides, and fully resets legacy keys', () => {
    const shipped = '  shipped system prompt\nwith its existing contract  ';
    const untouched = promptRegistry.resolveRuntime(db, 'production.script.system', { default_content: shipped });
    assert.notEqual(untouched.content, shipped);
    assert.match(untouched.content, /创作决策权/);
    assert.match(untouched.content, /不要输出 JSON/);
    assert.equal(untouched.customized, false);

    db.prepare('INSERT INTO prompt_overrides (key, content, updated_at) VALUES (?, ?, ?)')
      .run('story_expansion_system', '用户自定义剧本规则', new Date().toISOString());
    const customized = promptRegistry.resolveRuntime(db, 'production.script.system', { default_content: shipped });
    assert.match(customized.content, /^用户自定义剧本规则/);
    assert.match(customized.content, /不要输出 JSON/);
    assert.equal(customized.customized, true);
    promptRegistry.reset(db, 'production.script.system');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prompt_overrides WHERE key IN (?, ?)')
      .get('production.script.system', 'story_expansion_system').n, 0);
    assert.equal(
      promptRegistry.resolveRuntime(db, 'production.script.system', { default_content: shipped }).content,
      untouched.content
    );
  });

  it('renders the live storyboard duration ceiling instead of the obsolete 15-second limit', () => {
    const resolved = promptRegistry.resolveRuntime(db, 'production.storyboard.system', {
      variables: {
        min_shot_seconds: 5,
        max_shot_seconds: 60,
        provider_duration: '固定 30 秒',
        transition_rule: '默认硬切。',
      },
    });
    assert.match(resolved.content, /5 至 60 秒/);
    assert.match(resolved.content, /固定 30 秒/);
    assert.doesNotMatch(resolved.content, /每镜时长为 5 至 15 秒/);
  });

  it('reserves money atomically, reuses idempotency keys, and keeps uncertain money committed', () => {
    const run = makeRun({ budget: { max_cost_microusd: 1000000 } });
    const price = costs.upsertPrice(db, {
      provider: 'yinzi', service_type: 'video', model: 'video-test', group_name: 'test',
      billing_unit: 'per_second', unit_price_usd: 0.1,
    });
    const first = costs.reserve(db, {
      run_id: run.id, idempotency_key: 'cost:a', provider: 'yinzi', service_type: 'video', model: 'video-test',
      group_name: 'test', billing_unit: 'per_second', units: 5, price,
    });
    assert.equal(first.entry.reserved_microusd, 500000);
    assert.equal(costs.reserve(db, {
      run_id: run.id, idempotency_key: 'cost:a', provider: 'yinzi', service_type: 'video', model: 'video-test',
      billing_unit: 'per_second', units: 5, price,
    }).reused, true);
    costs.transition(db, 'cost:a', 'uncertain', { note: '创建结果不明确' });
    assert.throws(() => costs.reserve(db, {
      run_id: run.id, idempotency_key: 'cost:b', provider: 'yinzi', service_type: 'video', model: 'video-test',
      billing_unit: 'per_second', units: 6, price,
    }), (error) => error.code === 'COST_BUDGET_EXHAUSTED');
    const summary = costs.listRunCosts(db, run.id).summary;
    assert.equal(summary.uncertain_usd, 0.5);
    assert.equal(summary.remaining_usd, 0.5);
  });

  it('creates an action and its money reservation atomically, then follows action settlement', () => {
    const run = makeRun({ budget: { max_cost_microusd: 500000 } });
    const price = costs.upsertPrice(db, {
      provider: 'yinzi', service_type: 'image', model: 'image-test',
      billing_unit: 'per_image', unit_price_usd: 0.3,
    });
    assert.throws(() => repo.reserveAction(db, {
      run_id: run.id, action_key: 'too-expensive', stage: 'asset_images', scope_type: 'character', scope_id: '1',
      kind: 'image_generate', request: {}, cost: {
        provider: 'yinzi', service_type: 'image', model: 'image-test', billing_unit: 'per_image', units: 2, price,
      },
    }), (error) => error.code === 'COST_BUDGET_EXHAUSTED');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_actions WHERE run_id = ?').get(run.id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cost_ledger WHERE run_id = ?').get(run.id).n, 0);

    const reserved = repo.reserveAction(db, {
      run_id: run.id, action_key: 'within-budget', stage: 'asset_images', scope_type: 'character', scope_id: '1',
      kind: 'image_generate', request: {}, cost: {
        provider: 'yinzi', service_type: 'image', model: 'image-test', billing_unit: 'per_image', units: 1, price,
      },
    }).action;
    const ledger = db.prepare('SELECT * FROM cost_ledger WHERE action_id = ?').get(reserved.id);
    assert.equal(ledger.status, 'reserved');
    assert.equal(ledger.reserved_microusd, 300000);
    repo.updateAction(db, reserved.id, { status: 'completed', result: { ok: true } });
    assert.equal(db.prepare('SELECT status FROM cost_ledger WHERE action_id = ?').get(reserved.id).status, 'settled');
  });

  it('records unknown prices without pretending they cost zero when no money cap exists', () => {
    const run = makeRun({ budget: {} });
    const action = repo.reserveAction(db, {
      run_id: run.id, action_key: 'unpriced-compatible', stage: 'script', scope_type: 'run', scope_id: '',
      kind: 'text_generate', request: {}, cost: {
        provider: 'other', service_type: 'text', model: 'custom-model', billing_unit: 'unknown', units: 1,
      },
    }).action;
    const ledger = db.prepare('SELECT status, estimated_microusd FROM cost_ledger WHERE action_id = ?').get(action.id);
    assert.equal(ledger.status, 'unpriced');
    assert.equal(ledger.estimated_microusd, null);
    repo.updateAction(db, action.id, { status: 'completed', result: { ok: true } });
    assert.equal(db.prepare('SELECT status FROM cost_ledger WHERE action_id = ?').get(action.id).status, 'unpriced');
  });

  it('keeps a manual video price authoritative across automatic Yinzi catalog sync', () => {
    costs.upsertPrice(db, {
      provider: 'yinzi', service_type: 'video', model: 'video-manual-priority', group_name: '',
      billing_unit: 'per_second', unit_price_usd: 0.777, source: 'manual',
    });

    const imported = costs.importYinziCatalog(db, {
      pricing_version: 'live-v2',
      fetched_at: '2026-08-15T00:00:00.000Z',
      video: [{
        model: 'video-manual-priority',
        prices: [{
          group: '特价视频分组(即梦)', billing_unit: 'per_second', effective_price: 0.111,
        }],
      }],
    });

    assert.equal(imported.length, 1);
    const selected = costs.findPrice(db, {
      provider: 'yinzi', service_type: 'video', model: 'video-manual-priority',
      group_name: '特价视频分组(即梦)',
    });
    assert.equal(selected.source, 'manual');
    assert.equal(selected.unit_price_usd, 0.777);
    assert.equal(costs.listPrices(db, { model: 'video-manual-priority' }).length, 2);
  });

  it('does not overwrite an exact manual price during automatic Yinzi catalog sync', () => {
    costs.upsertPrice(db, {
      provider: 'yinzi', service_type: 'video', model: 'video-exact-manual',
      group_name: '特价视频分组(即梦)', billing_unit: 'per_request',
      unit_price_usd: 0.25, source: 'manual',
    });

    const imported = costs.importYinziCatalog(db, {
      pricing_version: 'live-v2',
      video: [{
        model: 'video-exact-manual',
        prices: [{
          group: '特价视频分组(即梦)', billing_unit: 'per_request', effective_price: 0.1,
        }],
      }],
    });

    assert.equal(imported.length, 0);
    const selected = costs.findPrice(db, {
      provider: 'yinzi', service_type: 'video', model: 'video-exact-manual',
      group_name: '特价视频分组(即梦)',
    });
    assert.equal(selected.source, 'manual');
    assert.equal(selected.unit_price_usd, 0.25);
  });

  it('never exports API keys, previews before applying, and restores snapshots with replace semantics', () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO ai_service_configs
       (service_type, provider, api_protocol, name, base_url, api_key, model, is_default, is_active, created_at, updated_at)
       VALUES ('text', 'yinzi', 'openai', '主文本', 'https://example.invalid/v1', 'secret-bait-value', '["model-a"]', 1, 1, ?, ?)`
    ).run(now, now);
    promptRegistry.set(db, 'production.script.system', '初始剧本提示词');
    costs.upsertPrice(db, {
      provider: 'yinzi', service_type: 'image', model: 'image-a', billing_unit: 'per_image', unit_price_usd: 0.03,
    });
    const snapshot = bundles.createSnapshot(db, { snapshot_type: 'manual', reason: '初始设置' });
    const exported = bundles.exportBundle(db);
    const bytes = JSON.stringify(exported);
    assert.doesNotMatch(bytes, /secret-bait-value/);
    assert.match(bytes, /"secrets_included":false/);

    promptRegistry.set(db, 'production.script.system', '后来修改的提示词');
    promptRegistry.set(db, 'production.review.system', '后来新增的审核提示词');
    costs.upsertPrice(db, {
      provider: 'other', service_type: 'video', model: 'extra', billing_unit: 'per_second', unit_price_usd: 1,
    });
    const preview = bundles.previewSnapshotRollback(db, snapshot.id);
    assert.ok(preview.token);
    const applied = bundles.applyPreview(db, preview.token);
    assert.equal(applied.applied, true);
    assert.equal(promptRegistry.list(db).find((item) => item.id === 'production.script.system').current_content, '初始剧本提示词');
    assert.equal(promptRegistry.list(db).find((item) => item.id === 'production.review.system').is_customized, false);
    assert.equal(costs.listPrices(db).some((item) => item.provider === 'other'), false);
    assert.equal(db.prepare('SELECT api_key FROM ai_service_configs WHERE name = ?').get('主文本').api_key, 'secret-bait-value');
  });

  it('rejects a changed configuration after import preview instead of partially applying it', () => {
    const bundle = bundles.exportBundle(db);
    const preview = bundles.previewImport(db, bundle);
    promptRegistry.set(db, 'production.script.system', '预览之后发生变化');
    assert.throws(() => bundles.applyPreview(db, preview.token), /预览后发生变化/);
    assert.equal(promptRegistry.list(db).find((item) => item.id === 'production.script.system').current_content, '预览之后发生变化');
  });
});
