const response = require('../response');
const promptRegistry = require('../services/productionPromptRegistry');
const promptOverrides = require('../services/promptOverridesService');
const promptI18n = require('../services/promptI18n');
const costs = require('../services/productionCostLedger');
const bundles = require('../services/configBundleService');
const settingsService = require('../services/settingsService');
const automationPreferences = require('../services/productionAutomationPreferences');
const { withAutomaticSnapshot } = require('../services/configMutationService');

const DEFAULT_BUDGET = Object.freeze({
  max_cost_usd: null,
  allow_unknown_price: false,
});

function sendError(res, log, label, error) {
  log.error(label, { error: error.message, code: error.code });
  response.badRequest(res, error.message);
}

function parseBudget(body = {}) {
  const maxCost = body.max_cost_usd;
  if (maxCost != null && maxCost !== '') {
    const number = Number(maxCost);
    if (!Number.isFinite(number) || number < 0 || number > 1000000) {
      throw new Error('默认金额上限需为 0 到 1000000 USD 之间的数字，留空表示不限额');
    }
  }
  return {
    max_cost_usd: maxCost == null || maxCost === '' ? null : Number(Number(maxCost).toFixed(6)),
    allow_unknown_price: body.allow_unknown_price === true,
  };
}

function budgetDefaults(db) {
  const saved = settingsService.getGlobalSetting(db, 'production_default_budget', {});
  const allowUnknown = settingsService.getGlobalSetting(db, 'production_allow_unknown_price', false);
  return {
    ...DEFAULT_BUDGET,
    ...(saved && typeof saved === 'object' ? saved : {}),
    allow_unknown_price: Boolean(allowUnknown),
    applies_to: 'new_runs_only',
  };
}

function buildSummary(db) {
  const promptItems = promptRegistry.list(db);
  const snapshots = bundles.listSnapshots(db, { page: 1, page_size: 1 });
  const prices = costs.listPrices(db);
  return {
    prompts: { total: promptItems.length, customized: promptItems.filter((item) => item.is_customized).length },
    prices: {
      total: prices.length,
      automatic: prices.filter((item) => item.source === 'yinzi-auto').length,
      last_yinzi_sync_at: prices.filter((item) => item.source === 'yinzi-auto')
        .map((item) => item.source_fetched_at).filter(Boolean).sort().at(-1) || null,
    },
    budget_defaults: budgetDefaults(db),
    automation_preferences: automationPreferences.get(db),
    backup: { total: snapshots.pagination.total, latest: snapshots.items[0] || null },
    secrets_in_backups: false,
  };
}

function routes(db, cfg, log, injected = {}) {
  const fetchYinziCatalog = injected.fetchYinziCatalog
    || require('../services/yinziService').fetchYinziCatalog;
  return {
    summary: (_req, res) => {
      try { response.success(res, buildSummary(db)); }
      catch (error) { sendError(res, log, 'advanced settings summary', error); }
    },
    listPrompts: (_req, res) => {
      try { response.success(res, { prompts: promptRegistry.list(db) }); }
      catch (error) { sendError(res, log, 'advanced settings prompts list', error); }
    },
    updatePrompt: (req, res) => {
      try {
        const result = withAutomaticSnapshot(db, `修改提示词 ${req.params.promptId}`, () => (
          promptRegistry.set(db, req.params.promptId, req.body?.content)
        ));
        response.success(res, { prompt: result.result, snapshot: result.snapshot });
      } catch (error) { sendError(res, log, 'advanced settings prompt update', error); }
    },
    resetPrompt: (req, res) => {
      try {
        const result = withAutomaticSnapshot(db, `恢复提示词 ${req.params.promptId} 默认值`, () => (
          promptRegistry.reset(db, req.params.promptId)
        ));
        response.success(res, { prompt: result.result, snapshot: result.snapshot });
      } catch (error) { sendError(res, log, 'advanced settings prompt reset', error); }
    },
    exportPrompts: (_req, res) => {
      try { response.success(res, promptRegistry.exportPackage(db)); }
      catch (error) { sendError(res, log, 'advanced settings prompt export', error); }
    },
    previewPromptImport: (req, res) => {
      try {
        const normalized = promptRegistry.validatePackage(req.body);
        const current = new Map(promptRegistry.list(db).map((item) => [item.id, item]));
        response.success(res, {
          valid: true,
          prompts: normalized.items.map((item) => ({
            prompt_id: item.prompt_id,
            action: current.get(item.prompt_id)?.is_customized ? 'update' : 'add',
            changed: current.get(item.prompt_id)?.current_content !== item.content,
          })),
        });
      } catch (error) { sendError(res, log, 'advanced settings prompt import preview', error); }
    },
    applyPromptImport: (req, res) => {
      try {
        const normalized = promptRegistry.validatePackage(req.body);
        const result = withAutomaticSnapshot(db, '导入提示词配置包', () => {
          for (const item of normalized.items) promptRegistry.set(db, item.prompt_id, item.content);
          return promptRegistry.list(db);
        });
        response.success(res, { prompts: result.result, snapshot: result.snapshot });
      } catch (error) { sendError(res, log, 'advanced settings prompt import apply', error); }
    },
    listPrices: (req, res) => {
      try { response.success(res, { items: costs.listPrices(db, req.query || {}) }); }
      catch (error) { sendError(res, log, 'advanced settings prices list', error); }
    },
    upsertPrice: (req, res) => {
      try {
        const result = withAutomaticSnapshot(db, `维护模型价格 ${req.body?.model || ''}`, () => costs.upsertPrice(db, req.body || {}));
        response.success(res, { price: result.result, snapshot: result.snapshot });
      } catch (error) { sendError(res, log, 'advanced settings price update', error); }
    },
    syncYinziPrices: async (_req, res) => {
      try {
        const catalog = await fetchYinziCatalog();
        const result = withAutomaticSnapshot(db, '同步 YinziAPI 价格目录', () => costs.importYinziCatalog(db, catalog));
        response.success(res, {
          imported: result.result.length,
          pricing_version: catalog.pricing_version || '',
          fetched_at: catalog.fetched_at || null,
          snapshot: result.snapshot,
        });
      } catch (error) { sendError(res, log, 'advanced settings yinzi price sync', error); }
    },
    getBudgetDefaults: (_req, res) => {
      try { response.success(res, budgetDefaults(db)); }
      catch (error) { sendError(res, log, 'advanced settings budget get', error); }
    },
    updateBudgetDefaults: (req, res) => {
      try {
        const parsed = parseBudget(req.body || {});
        const result = withAutomaticSnapshot(db, '修改新任务默认金额预算', () => {
          const saved = { max_cost_usd: parsed.max_cost_usd };
          settingsService.setGlobalSetting(db, 'production_default_budget', saved);
          settingsService.setGlobalSetting(db, 'production_allow_unknown_price', parsed.allow_unknown_price);
          return budgetDefaults(db);
        });
        response.success(res, { budget: result.result, snapshot: result.snapshot });
      } catch (error) { sendError(res, log, 'advanced settings budget update', error); }
    },
    getAutomationPreferences: (_req, res) => {
      try { response.success(res, automationPreferences.get(db)); }
      catch (error) { sendError(res, log, 'advanced settings automation preferences get', error); }
    },
    updateAutomationPreferences: (req, res) => {
      try {
        const result = withAutomaticSnapshot(db, '修改自动化与通知设置', () => (
          automationPreferences.set(db, req.body || {})
        ));
        response.success(res, { preferences: result.result, snapshot: result.snapshot });
      } catch (error) { sendError(res, log, 'advanced settings automation preferences update', error); }
    },
    exportBundle: (req, res) => {
      try { response.success(res, bundles.exportBundle(db, req.body || {})); }
      catch (error) { sendError(res, log, 'advanced settings bundle export', error); }
    },
    previewBundle: (req, res) => {
      try { response.success(res, bundles.previewImport(db, req.body)); }
      catch (error) { sendError(res, log, 'advanced settings bundle preview', error); }
    },
    applyBundle: (req, res) => {
      try { response.success(res, bundles.applyPreview(db, req.body?.token)); }
      catch (error) { sendError(res, log, 'advanced settings bundle apply', error); }
    },
    listBackups: (req, res) => {
      try { response.success(res, bundles.listSnapshots(db, req.query || {})); }
      catch (error) { sendError(res, log, 'advanced settings backups list', error); }
    },
    createBackup: (req, res) => {
      try {
        response.created(res, bundles.createSnapshot(db, {
          snapshot_type: 'manual', reason: req.body?.reason || '用户手动快照', pinned: req.body?.pinned === true,
        }));
      } catch (error) { sendError(res, log, 'advanced settings backup create', error); }
    },
    previewRollback: (req, res) => {
      try { response.success(res, bundles.previewSnapshotRollback(db, req.params.id)); }
      catch (error) { sendError(res, log, 'advanced settings rollback preview', error); }
    },
    rollback: (req, res) => {
      try { response.success(res, bundles.applySnapshotRollback(db, req.params.id, req.body?.token)); }
      catch (error) { sendError(res, log, 'advanced settings rollback apply', error); }
    },
  };
}

module.exports = routes;
module.exports.budgetDefaults = budgetDefaults;
module.exports.parseBudget = parseBudget;
