const aiConfigService = require('../services/aiConfigService');
const response = require('../response');

function list(db) {
  return (req, res) => {
    const list = aiConfigService.listConfigs(db, req.query.service_type).map(aiConfigService.toPublicConfig);
    response.success(res, list);
  };
}

function get(db) {
  return (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return response.badRequest(res, '无效的配置ID');
    const config = aiConfigService.getConfig(db, id);
    if (!config) return response.notFound(res, '配置不存在');
    response.success(res, aiConfigService.toPublicConfig(config));
  };
}

function vendorLock(cfg) {
  return (req, res) => {
    const status = aiConfigService.getVendorLockStatus(cfg);
    response.success(res, status);
  };
}

function create(db, log, cfg) {
  return (req, res) => {
    if (aiConfigService.getVendorLockStatus(cfg).enabled) {
      return response.badRequest(res, '当前为厂商锁定模式，不允许添加配置');
    }
    const body = req.body || {};
    if (!body.service_type || !body.name || !body.provider || !body.base_url) {
      return response.badRequest(res, '缺少必填字段: service_type, name, provider, base_url');
    }
    if (body.api_key === undefined || body.api_key === null) {
      return response.badRequest(res, '缺少必填字段: api_key');
    }
    try {
      const config = require('../services/configMutationService').withAutomaticSnapshot(db, `新增 AI 配置 ${body.name}`, () => (
        aiConfigService.createConfig(db, log, { ...body, model: body.model ?? [] })
      )).result;
      response.created(res, aiConfigService.toPublicConfig(config));
    } catch (err) {
      log.errorw('Create AI config failed', { error: err.message });
      if (err.code === 'TEXT_CONFIG_LIMIT_REACHED') {
        return response.error(res, 409, err.code, err.message, err.details);
      }
      response.internalError(res, '创建失败');
    }
  };
}

function candidates(db) {
  return (req, res) => {
    try {
      response.success(res, aiConfigService.candidateConfigs(db, req.query || {}));
    } catch (error) {
      response.badRequest(res, error.message || '读取模型候选失败');
    }
  };
}

function update(db, log, cfg) {
  return (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return response.badRequest(res, '无效的配置ID');

    let body = req.body || {};
    // 锁定模式下只允许修改 api_key、default_model、is_default
    if (aiConfigService.getVendorLockStatus(cfg).enabled) {
      const allowed = {};
      if (body.api_key !== undefined) allowed.api_key = body.api_key;
      if (body.default_model !== undefined) allowed.default_model = body.default_model;
      if (body.is_default !== undefined) allowed.is_default = body.is_default;
      body = allowed;
    }

    const config = require('../services/configMutationService').withAutomaticSnapshot(db, `修改 AI 配置 #${id}`, () => (
      aiConfigService.updateConfig(db, log, id, body)
    )).result;
    if (!config) return response.notFound(res, '配置不存在');
    response.success(res, aiConfigService.toPublicConfig(config));
  };
}

function remove(db, log, cfg) {
  return (req, res) => {
    if (aiConfigService.getVendorLockStatus(cfg).enabled) {
      return response.badRequest(res, '当前为厂商锁定模式，不允许删除配置');
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return response.badRequest(res, '无效的配置ID');
    const ok = require('../services/configMutationService').withAutomaticSnapshot(db, `删除 AI 配置 #${id}`, () => (
      aiConfigService.deleteConfig(db, log, id)
    )).result;
    if (!ok) return response.notFound(res, '配置不存在');
    response.success(res, { message: '删除成功' });
  };
}

function bulkUpdateKey(db, log, cfg) {
  return (req, res) => {
    if (!aiConfigService.getVendorLockStatus(cfg).enabled) {
      return response.badRequest(res, '批量换Key仅在厂商锁定模式下可用');
    }
    const { api_key } = req.body || {};
    if (!api_key || !api_key.trim()) {
      return response.badRequest(res, '请提供新的 API Key');
    }
    try {
      const count = require('../services/configMutationService').withAutomaticSnapshot(db, '批量更新 AI 配置凭据', () => (
        aiConfigService.bulkUpdateApiKey(db, log, api_key.trim())
      )).result;
      response.success(res, { updated: count, message: `已更新 ${count} 条配置的 API Key` });
    } catch (err) {
      log.error('Bulk update api_key failed', { error: err.message });
      response.internalError(res, '批量换Key失败');
    }
  };
}

function modelCapabilities(db) {
  return (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return response.badRequest(res, '无效的配置ID');
    const config = aiConfigService.getConfig(db, id);
    if (!config) return response.notFound(res, '配置不存在');
    response.success(res, {
      config_id: id,
      service_type: config.service_type,
      models: aiConfigService.modelCapabilityStates(config),
    });
  };
}

function updateModelCapabilities(db, log) {
  return (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return response.badRequest(res, '无效的配置ID');
    const body = req.body || {};
    const model = String(body.model || '').trim();
    if (!model) return response.badRequest(res, '模型名不能为空');
    try {
      const result = require('../services/configMutationService').withAutomaticSnapshot(
        db,
        `${body.reset ? '恢复' : '保存'}模型能力提示 #${id}`,
        () => body.reset
          ? aiConfigService.resetModelCapabilityOverride(db, log, id, model)
          : aiConfigService.updateModelCapabilityOverride(db, log, id, model, body.capability || {})
      ).result;
      if (!result) return response.notFound(res, '配置不存在');
      response.success(res, {
        config_id: id,
        model,
        reset: body.reset === true,
        config: aiConfigService.toPublicConfig(result),
        models: aiConfigService.modelCapabilityStates(result),
      });
    } catch (err) {
      log.error('Update model capability override failed', { config_id: id, model, error: err.message });
      response.badRequest(res, err.message || '模型能力提示保存失败');
    }
  };
}

function testConnection(db, log) {
  return async (req, res) => {
    const body = req.body || {};
    let resolved;
    try {
      resolved = aiConfigService.resolveConnectionTestConfig(db, body);
      const result = await aiConfigService.testConnection(resolved.config);
      response.success(res, {
        message: result.authenticated ? '连接与凭据验证成功' : '服务地址已连通',
        config_id: resolved.config_id,
        credential_source: resolved.credential_source,
        service_type: resolved.config.service_type || '',
        model: resolved.config.model || '',
        probe: result.probe,
        authenticated: !!result.authenticated,
        reachable_only: !!result.reachable_only,
        generated_media: false,
      });
    } catch (err) {
      const safeMessage = aiConfigService.redactConnectionTestError(err, [resolved?.config?.api_key]);
      log.error('AI config test connection failed', {
        config_id: resolved?.config_id ?? body.config_id ?? null,
        error: safeMessage,
      });
      response.badRequest(res, '连接测试失败: ' + safeMessage);
    }
  };
}

function yinziCatalog(db, log) {
  return async (req, res) => {
    try {
      const { fetchYinziCatalog, fetchYinziCapabilityCatalog } = require('../services/yinziService');
      if (req.query?.config_id != null) {
        const config = aiConfigService.getConfig(db, Number(req.query.config_id));
        if (!config || config.provider !== 'yinzi') return response.badRequest(res, '找不到指定的 Yinzi 配置');
        // A paid preflight must use this credential's catalog. Never fall back
        // to another site's public prices when authentication or discovery fails.
        const scoped = await fetchYinziCapabilityCatalog(config, fetch, { force_refresh: true });
        const states = aiConfigService.modelCapabilityStates(config);
        const offers = (scoped.video || []).map((offer) => {
          const state = states.find((item) => item.model === offer.model);
          return { ...offer, capabilities: offer.capabilities || state?.capability || null,
            capability_source: offer.capabilities ? offer.capability_source : state?.source || 'unknown',
            contract_status: offer.capabilities ? offer.contract_status : state?.contract_status || 'missing' };
        });
        return response.success(res, { ...scoped, config_id: config.id,
          image: ['image', 'storyboard_image'].includes(config.service_type) ? offers : [],
          video: config.service_type === 'video' ? offers : [] });
      }
      response.success(res, await fetchYinziCatalog());
    } catch (err) {
      log.error('Load Yinzi catalog failed', { error: err.message });
      response.error(res, 502, 'YINZI_CATALOG_ERROR', err.message || 'YinziAPI 模型目录加载失败');
    }
  };
}

/**
 * Read-only edition metadata used by onboarding. This is intentionally
 * non-secret and advisory: it never filters models or blocks a request.
 */
function distributionProfile(cfg) {
  return (req, res) => {
    const profiles = require('../services/distributionProfiles');
    response.success(res, profiles.getDistributionProfile(req.query?.profile || req.query?.distribution_profile, cfg));
  };
}

function discoverModels(db, log) {
  return async (req, res) => {
    const body = req.body || {};
    let resolved;
    try {
      resolved = aiConfigService.resolveConnectionTestConfig(db, body);
      const discovery = await aiConfigService.discoverModels(resolved.config, {
        // Browser refreshes keep the historical snapshot by default. Guarded
        // paid preflights opt out explicitly so a capability check cannot
        // mutate configuration truth or make an old catalog look current.
        db: body.persist_snapshot === false ? null : db,
        catalog_path: body.catalog_path,
      });
      let pricing = null;
      let smartRouting = false;
      if (String(resolved.config.provider || '').toLowerCase() === 'yinzi') {
        const yinziService = require('../services/yinziService');
        smartRouting = String(body.routing_mode || '').trim().toLowerCase() === 'smart'
          || body.smart_routing === true
          || yinziService.isYinziSmartRoutingConfig(resolved.config);
        try {
          pricing = await yinziService.fetchYinziCatalogForConfig(
            resolved.config,
            fetch,
            { include_public_catalog: true }
          );
        } catch (_) { pricing = null; }
      }
      const catalog = aiConfigService.mergeDiscoveredCatalog(discovery, pricing, {
        provider: resolved.config.provider,
        service_type: body.service_type || resolved.config.service_type || 'video',
        group: body.group || '',
        capability_overrides: aiConfigService.getModelCapabilityOverrides(resolved.config),
        include_public_catalog: String(resolved.config.provider || '').toLowerCase() === 'yinzi'
          && String(body.service_type || resolved.config.service_type || 'video') === 'video',
        smart_routing: smartRouting,
      });
      response.success(res, {
        ...discovery,
        catalog,
        config_id: resolved.config_id,
        credential_source: resolved.credential_source,
        snapshot_persisted: body.persist_snapshot !== false,
      });
    } catch (err) {
      const safeMessage = aiConfigService.redactConnectionTestError(err, [resolved?.config?.api_key]);
      log.error('Discover AI models failed', { config_id: resolved?.config_id ?? body.config_id ?? null, error: safeMessage });
      response.badRequest(res, '模型目录读取失败: ' + safeMessage);
    }
  };
}

function setupYinzi(db, log, cfg) {
  return async (req, res) => {
    if (aiConfigService.getVendorLockStatus(cfg).enabled) {
      return response.badRequest(res, '厂商锁定模式下不能创建 YinziAPI 配置');
    }
    const body = req.body || {};
    try {
      const { prepareYinziSetupInput, upsertYinziConfigs } = require('../services/yinziService');
      const { resolveDistributionProfile } = require('../services/distributionProfiles');
      const prepared = await prepareYinziSetupInput({
        ...body,
        distribution_profile: resolveDistributionProfile(body, cfg),
      });
      const result = require('../services/configMutationService').withAutomaticSnapshot(db, '一键配置 YinziAPI', () => (
        upsertYinziConfigs(db, log, prepared)
      )).result;
      response.success(res, result);
    } catch (err) {
      const safeMessage = aiConfigService.redactConnectionTestError(err, [
        body.api_key,
        body.universal_api_key,
        body.text_api_key,
        body.image_api_key,
        body.video_api_key,
      ]);
      log.error('Setup Yinzi configs failed', { error: safeMessage });
      response.badRequest(res, safeMessage || 'YinziAPI 配置失败');
    }
  };
}

function setupImageYinzi(db, log, cfg) {
  return async (req, res) => {
    if (aiConfigService.getVendorLockStatus(cfg).enabled) {
      return response.badRequest(res, '厂商锁定模式下不能创建银子媒体站配置');
    }
    const body = req.body || {};
    try {
      const service = require('../services/yinziImageSiteService');
      const { resolveDistributionProfile } = require('../services/distributionProfiles');
      const result = require('../services/configMutationService').withAutomaticSnapshot(db, '一键配置银子媒体站', () => (
        service.setup(db, log, {
          ...body,
          distribution_profile: resolveDistributionProfile(body, cfg),
        })
      )).result;
      response.success(res, result);
    } catch (err) {
      const safeMessage = aiConfigService.redactConnectionTestError(err, [body.text_api_key, body.image_api_key, body.video_api_key]);
      log.error('Setup image.yinziapi configs failed', { error: safeMessage });
      response.badRequest(res, safeMessage || '银子媒体站配置失败');
    }
  };
}

function setupLaoli(db, log, cfg) {
  return async (req, res) => {
    if (aiConfigService.getVendorLockStatus(cfg).enabled) {
      return response.badRequest(res, '厂商锁定模式下不能创建老李站点配置');
    }
    const body = req.body || {};
    try {
      const service = require('../services/laoliSiteService');
      const { resolveDistributionProfile } = require('../services/distributionProfiles');
      const result = require('../services/configMutationService').withAutomaticSnapshot(db, '一键配置老李站点', () => (
        service.setup(db, log, {
          ...body,
          distribution_profile: resolveDistributionProfile(body, cfg),
        })
      )).result;
      response.success(res, result);
    } catch (err) {
      const safeMessage = aiConfigService.redactConnectionTestError(err, [body.text_api_key, body.image_api_key, body.video_api_key]);
      log.error('Setup Laoli configs failed', { error: safeMessage });
      response.badRequest(res, safeMessage || '老李站点配置失败');
    }
  };
}

function previewYinzi(log, cfg) {
  return async (req, res) => {
    if (aiConfigService.getVendorLockStatus(cfg).enabled) {
      return response.badRequest(res, '厂商锁定模式下不能预览 YinziAPI 配置');
    }
    const body = req.body || {};
    try {
      const { resolveDistributionProfile } = require('../services/distributionProfiles');
      const prepared = await require('../services/yinziService').prepareYinziSetupInput({
        ...body,
        distribution_profile: resolveDistributionProfile(body, cfg),
      });
      response.success(res, {
        base_url: prepared.base_url,
        distribution_profile: prepared.distribution_profile,
        text_model: prepared.text_model,
        image_model: prepared.image_model,
        video_model: prepared.video_model,
        text: prepared.text_models.map((model) => ({ model })),
        image: prepared.image_models.map((model) => ({ model })),
        video: prepared.setup_catalog?.models || prepared.video_models.map((model) => ({ model })),
        catalog: prepared.setup_catalog || null,
      });
    } catch (err) {
      const safeMessage = aiConfigService.redactConnectionTestError(err, [
        body.api_key,
        body.universal_api_key,
        body.text_api_key,
        body.image_api_key,
        body.video_api_key,
      ]);
      log.error('Preview Yinzi configs failed', { error: safeMessage });
      response.badRequest(res, safeMessage || 'YinziAPI 模型目录读取失败');
    }
  };
}

/** ModelArk / 方舟私有资产库：代理调用 CreateAssetGroup、ListAssets 等（与官方 Action 名一致） */
function modelArkAsset(log) {
  return async (req, res) => {
    const body = req.body || {};
    const action = (body.action || '').toString().trim();
    try {
      const modelArkAssetProxyService = require('../services/modelArkAssetProxyService');
      const data = await modelArkAssetProxyService.callModelArkAsset(
        {
          base_url: body.base_url,
          api_key: body.api_key,
          action,
          body: body.payload,
          path_mode: body.path_mode,
          http_method: body.http_method,
          api_version: body.api_version,
          auth_mode: body.auth_mode,
          access_key_id: body.access_key_id,
          secret_access_key: body.secret_access_key,
          sign_region: body.sign_region,
          sign_service: body.sign_service,
          session_token: body.session_token,
          project_name: body.project_name,
        },
        log
      );
      response.success(res, data);
    } catch (err) {
      log.error('model-ark-asset proxy failed', { error: err.message, action });
      const status = err.status >= 400 && err.status < 600 ? err.status : 400;
      return response.error(res, status, 'MODEL_ARK_ASSET', err.message || '请求失败', err.payload);
    }
  };
}

/** 即梦2角色认证：代理 GET 素材列表（表单未保存也可用当前填写的网关与 Token） */
function listJimeng2MaterialAssets(log) {
  return async (req, res) => {
    const body = req.body || {};
    const base_url = (body.base_url || '').toString().trim().replace(/\/$/, '');
    const { normalizeMaterialHubToken } = require('../services/jimengMaterialHubService');
    let api_key = normalizeMaterialHubToken(body.api_key || '');
    if (!base_url || !api_key) {
      return response.badRequest(res, '请先填写网关 URL 与 Token');
    }
    const jimengMaterialHubService = require('../services/jimengMaterialHubService');
    const ctx = { baseUrl: base_url, token: api_key };
    const r = await jimengMaterialHubService.listAssets(ctx, { limit: body.limit, cursor: body.cursor }, log);
    if (!r.ok) {
      return response.badRequest(res, String(r.error || '列出素材失败').slice(0, 800));
    }
    response.success(res, r.data);
  };
}

module.exports = function aiConfigRoutes(db, log, cfg) {
  return {
    list: list(db),
    candidates: candidates(db),
    get: get(db),
    vendorLock: vendorLock(cfg),
    create: create(db, log, cfg),
    update: update(db, log, cfg),
    delete: remove(db, log, cfg),
    testConnection: testConnection(db, log),
    discoverModels: discoverModels(db, log),
    yinziCatalog: yinziCatalog(db, log),
    distributionProfile: distributionProfile(cfg),
    setupYinzi: setupYinzi(db, log, cfg),
    setupImageYinzi: setupImageYinzi(db, log, cfg),
    setupLaoli: setupLaoli(db, log, cfg),
    previewYinzi: previewYinzi(log, cfg),
    listJimeng2MaterialAssets: listJimeng2MaterialAssets(log),
    modelArkAsset: modelArkAsset(log),
    bulkUpdateKey: bulkUpdateKey(db, log, cfg),
    modelCapabilities: modelCapabilities(db),
    updateModelCapabilities: updateModelCapabilities(db, log),
  };
};
