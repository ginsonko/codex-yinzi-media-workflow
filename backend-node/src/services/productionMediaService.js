const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const repo = require('./productionRepository');
const imageService = require('./imageService');
const imageClient = require('./imageClient');
const videoService = require('./videoService');
const videoClient = require('./videoClient');
const taskService = require('./taskService');
const validation = require('./productionMediaValidation');
const boundaryFrames = require('./productionBoundaryFrames');
const videoMergeService = require('./videoMergeService');
const textStages = require('./productionTextStages');
const promptRegistry = require('./productionPromptRegistry');
const promptRuntime = require('./productionPromptRuntime');
const accounting = require('./productionRuntimeAccounting');
const costLedger = require('./productionCostLedger');
const { archiveDetachedVideoGeneration } = require('./productionDetachedMedia');
const {
  getYinziVideoCapability,
  capabilitySupportsRole,
} = require('./yinziVideoCapabilities');
const {
  fetchYinziCatalog,
  fetchYinziCatalogForConfig,
  isYinziSmartRoutingConfig,
} = require('./yinziService');
const aiConfigService = require('./aiConfigService');
const {
  listShotVideoRouteOptions,
  selectShotVideoRoute,
  fixedModelRoute,
  routingMaterialSignature,
  routingBindingPayload,
  routingBindingSignature,
} = require('./productionVideoRouter');
const { prepareYinziReferenceVideo } = require('./yinziReferenceMedia');
const {
  planReferenceVideoBudget,
  MIN_CONTINUITY_TAIL_SECONDS,
} = require('./productionReferenceVideoBudget');
const {
  normalizeProductionAspectRatio,
  productionAspectPrompt,
} = require('./productionAspectRatio');
const {
  identityForConfig,
  identityFromSnapshot,
  sameIdentity,
} = require('./productionConfigIdentity');
const {
  classifyFallbackFailure,
  canAutomaticallyFallback,
  isSeedance25Model,
  isSeedance20Model,
  planSeedanceFallback,
  nextFallbackSegment,
} = require('./yinziSmartRouteRecovery');
const templateExecutionPlan = require('./templateExecutionPlan');
const acceptanceSafety = require('./acceptanceSafety');

function approvedIncluded(db, runId, stage) {
  return repo.listArtifacts(db, runId, { stage, current: true, status: 'approved', page_size: 200 }).items
    .filter((item) => item.content?.included !== false);
}

function currentArtifacts(db, runId, stage) {
  return repo.listArtifacts(db, runId, { stage, current: true, page_size: 200 }).items;
}

function artifactMatchesSource(artifact, source) {
  return artifact
    && Number(artifact.content?.source_artifact_id) === Number(source.id)
    && ['draft', 'reviewing', 'approved'].includes(artifact.status);
}

function compareShots(left, right) {
  const leftNumber = Number(left.content?.number);
  const rightNumber = Number(right.content?.number);
  const leftHasNumber = Number.isFinite(leftNumber);
  const rightHasNumber = Number.isFinite(rightNumber);
  if (leftHasNumber && rightHasNumber && leftNumber !== rightNumber) return leftNumber - rightNumber;
  if (leftHasNumber !== rightHasNumber) return leftHasNumber ? -1 : 1;
  return String(left.scope_id).localeCompare(String(right.scope_id), undefined, { numeric: true });
}

function sameIdList(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => Number(value) === Number(right[index]));
}

const REFERENCE_BINDING_FIELDS = Object.freeze([
  ['profile', 'route profile'],
  ['model', 'video model'],
  ['planned_duration', 'creative duration'],
  ['provider_duration', 'provider duration'],
  ['execution_unit_count', 'provider execution unit count'],
  ['resolution', 'resolution'],
  ['requires_director_preview', 'director preview requirement'],
  ['uses_reference_video', 'reference video usage'],
  ['previs_mode', 'previsualization mode'],
  ['director_mode', 'director mode'],
  ['transition_mode', 'transition mode'],
  ['requires_strict_first_frame', 'strict first-frame requirement'],
  ['group', 'provider group'],
  ['video_config_id', 'video configuration'],
  ['video_config_fingerprint', 'video configuration fingerprint'],
  ['provider_protocol_snapshot', 'provider protocol'],
]);

function stableBindingValue(value) {
  if (Array.isArray(value)) return value.map(stableBindingValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableBindingValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function bindingValuesEqual(left, right) {
  return JSON.stringify(stableBindingValue(left)) === JSON.stringify(stableBindingValue(right));
}

function hasBindingValue(value) {
  return value !== undefined && value !== null && value !== '';
}

/**
 * Compare only facts that bind a reference package to a provider request.
 *
 * The complete material signature intentionally contains diagnostic catalog
 * metadata (price version, fetch time and warnings).  Those values are useful
 * evidence but are not reasons to invalidate an approved user selection.
 * New bundles carry an explicit stable signature.  For legacy bundles, use
 * the fields present in their saved routing receipt and leave absent fields
 * unknown instead of hashing nulls against a newer, richer route.
 */
function compareReferenceBundleBinding(bundle, desired) {
  const savedRoute = bundle?.content?.routing_receipt
    || bundle?.routing_receipt
    || {};
  const desiredRoute = desired?.route
    || desired?.content?.routing_receipt
    || {};
  const savedPayload = routingBindingPayload(savedRoute);
  const desiredPayload = routingBindingPayload(desiredRoute);
  const savedExplicitSignature = String(
    bundle?.content?.routing_binding_signature
      || savedRoute?.routing_binding_signature
      || ''
  ).trim();
  const savedStableEvidence = REFERENCE_BINDING_FIELDS.some(([field]) => hasBindingValue(savedPayload[field]));
  const desiredSignature = String(
    desired?.content?.routing_binding_signature
      || desiredRoute?.routing_binding_signature
      || routingBindingSignature(desiredRoute)
  ).trim();
  const changed = [];
  for (const [field, label] of REFERENCE_BINDING_FIELDS) {
    // A legacy receipt can predate a field (for example provider protocol or
    // config fingerprint).  Missing evidence is not evidence of a change.
    if (!hasBindingValue(savedPayload[field])) continue;
    if (!bindingValuesEqual(savedPayload[field], desiredPayload[field])) {
      changed.push({
        field,
        label,
        category: 'binding',
        saved: savedPayload[field],
        desired: desiredPayload[field],
      });
    }
  }
  // New records have a stable signature and therefore can make a definitive
  // comparison.  Legacy records deliberately use field evidence only: a
  // missing field is unknown, not a change, and volatile catalog metadata is
  // never consulted here.
  const legacyMaterialSignature = String(bundle?.content?.routing_material_signature || '').trim();
  const desiredMaterialSignature = String(desired?.content?.routing_material_signature || '').trim();
  const matches = savedExplicitSignature
    ? savedExplicitSignature === desiredSignature
    : savedStableEvidence
      ? changed.length === 0
      // A pre-V0.1.4 bundle with no binding receipt cannot be proven against
      // the live route. Keep the conservative legacy check in that case.
      : Boolean(legacyMaterialSignature && desiredMaterialSignature
        && legacyMaterialSignature === desiredMaterialSignature);
  return {
    matches,
    changed,
    legacy: !savedExplicitSignature,
    stable_evidence: savedStableEvidence,
    saved_signature: savedExplicitSignature || null,
    desired_signature: desiredSignature || null,
    saved_payload: savedPayload,
    desired_payload: desiredPayload,
  };
}

function referenceBundleComparison(bundle, desired, db = null, repository = null) {
  const changed = [];
  if (!bundle || !['draft', 'reviewing', 'approved'].includes(bundle.status)) {
    changed.push({ field: 'status', label: 'reference bundle status', category: 'bundle' });
    return { matches: false, changed, binding: compareReferenceBundleBinding(bundle, desired) };
  }
  if (Number(bundle.content?.source_artifact_id) !== Number(desired?.content?.source_artifact_id)) {
    changed.push({
      field: 'source_artifact_id',
      label: 'source shot',
      category: 'binding',
      saved: bundle.content?.source_artifact_id ?? null,
      desired: desired?.content?.source_artifact_id ?? null,
    });
  }
  const binding = compareReferenceBundleBinding(bundle, desired);
  changed.push(...binding.changed);
  const savedTransition = String(bundle.content?.transition_mode || '');
  const desiredTransition = String(desired?.content?.transition_mode || '');
  if (savedTransition !== desiredTransition) {
    changed.push({ field: 'transition_mode', label: 'transition mode', category: 'binding', saved: savedTransition, desired: desiredTransition });
  }
  if (bundle.status === 'approved' && db && repository) {
    for (const key of ['images', 'videos', 'audios']) {
      const items = Array.isArray(bundle.content?.[key]) ? bundle.content[key] : [];
      for (const item of items) {
        if (!String(item?.path || '').trim()) {
          changed.push({ field: `${key}.path`, label: `${key} reference path`, category: 'media', saved: item?.path || null, desired: 'non-empty' });
          continue;
        }
        if (item.artifact_id != null) {
          const sourceArtifact = repository.getArtifact(db, item.artifact_id);
          if (!sourceArtifact || sourceArtifact.status !== 'approved' || !sourceArtifact.media_path
            || ![item.path, item.original_path].filter(Boolean).map(String).includes(String(sourceArtifact.media_path))) {
            changed.push({
              field: `${key}.artifact_id`,
              label: `${key} reference artifact`,
              category: 'media',
              saved: item.artifact_id,
              desired: 'approved artifact with unchanged path',
            });
          }
        }
      }
    }
    // A legacy approved bundle may not have a dependency row even though its
    // saved source_artifact_id is correct. Missing lineage is unknown, not a
    // user change; the source id and media artifact checks above remain the
    // evidence for this compatibility path.
  } else {
    const manualBundle = ['manual', 'manual_revision'].includes(String(bundle.content?.bundle_origin || ''))
      || Boolean(bundle.content?.revision_source?.type === 'user_edit');
    if (!manualBundle) {
      const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
      for (const key of ['images', 'videos', 'audios']) {
        if (!same(bundle.content?.[key] || [], desired?.content?.[key] || [])) {
          changed.push({ field: key, label: `${key} references`, category: 'media' });
        }
      }
      if (!same(bundle.content?.reference_video_budget, desired?.content?.reference_video_budget)) {
        changed.push({ field: 'reference_video_budget', label: 'reference video budget', category: 'binding' });
      }
      for (const field of ['strict_first_frame_artifact_id', 'continuity_frame_artifact_id', 'continuity_frame_transport']) {
        if (!same(bundle.content?.[field], desired?.content?.[field])) {
          changed.push({ field, label: field, category: 'media', saved: bundle.content?.[field] ?? null, desired: desired?.content?.[field] ?? null });
        }
      }
      if (!same(bundle.content?.autolink_receipt, desired?.content?.autolink_receipt)) {
        changed.push({ field: 'autolink_receipt', label: 'automatic reference selection', category: 'media' });
      }
      if (repository && db
        && !same(repository.listUpstreamArtifactIds(db, bundle.id), desired?.dependencyIds || [])) {
        changed.push({ field: 'dependencies', label: 'reference dependencies', category: 'media' });
      }
    }
  }
  const deduped = [];
  const seen = new Set();
  for (const item of changed) {
    const key = `${item.field}:${item.category || ''}`;
    if (!seen.has(key)) { seen.add(key); deduped.push(item); }
  }
  // For a legacy bundle, absence of a stable signature is expected.  For a
  // signed bundle, the signature is authoritative even if a future field is
  // not understood by this client.
  const matches = binding.matches && deduped.length === 0;
  return { matches, changed: deduped, binding };
}

function isSequentialShotRun(run) {
  return run.runtime?.shot_pipeline?.mode === 'sequential';
}

function isDirectorDisabled(run) {
  const mode = String(run?.policy?.director_mode ?? 'auto').trim().toLowerCase();
  return new Set(['off', 'disabled', 'none', 'skip', 'false', '0']).has(mode);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function catalogWithStoredVideoPrices(db, catalog, run) {
  if (!Array.isArray(catalog?.video)) return catalog;
  const groupName = String(run?.policy?.video_group || '').trim();
  return {
    ...catalog,
    video: catalog.video.map((item) => {
      const stored = costLedger.findPrice(db, {
        provider: 'yinzi', service_type: 'video', model: item.model, group_name: groupName,
      });
      if (!stored || stored.source !== 'manual' || stored.unit_price_usd == null) return item;
      const manualPrice = {
        group: stored.group_name || groupName,
        billing_mode: 'fixed_price',
        billing_unit: stored.billing_unit,
        effective_price: stored.unit_price_usd,
        effective_input_usd: null,
        effective_output_usd: null,
        fixed_duration_seconds: null,
        source: 'manual',
      };
      const prices = (Array.isArray(item.prices) ? item.prices : [])
        .filter((price) => String(price.group || '') !== String(manualPrice.group || ''));
      return { ...item, prices: [manualPrice, ...prices], cheapest_effective_price: manualPrice.effective_price };
    }),
  };
}

// A legacy run may predate persisted video_config_id.  The routing picker still
// needs the active config's credential-scoped catalog, but resolving that
// context must never mutate the run policy or dispatch binding.
function readOnlyVideoConfigId(db, preferredModel = '') {
  const rows = db.prepare(
    `SELECT id FROM ai_service_configs
     WHERE deleted_at IS NULL AND is_active = 1 AND service_type = 'video'
     ORDER BY is_default DESC, priority DESC, created_at DESC, id ASC`
  ).all();
  if (!rows.length) return null;
  const configs = rows.map((row) => aiConfigService.getConfig(db, row.id)).filter(Boolean);
  const target = String(preferredModel || '').trim().toLowerCase();
  if (target) {
    const matched = configs.find((config) => {
      const configured = [
        ...(Array.isArray(config.model) ? config.model : config.model ? [config.model] : []),
        config.default_model,
        ...(Array.isArray(config.model_catalog_snapshot?.models)
          ? config.model_catalog_snapshot.models.map((item) => item?.model || item)
          : []),
      ].map((item) => String(item || '').trim().toLowerCase());
      return configured.includes(target);
    });
    if (matched) return Number(matched.id);
  }
  return Number(configs[0].id);
}

const SNAPSHOT_DISCOVERY_FALLBACK_CODES = new Set([
  'MODEL_DISCOVERY_NETWORK_ERROR',
  'MODEL_DISCOVERY_HTTP_ERROR',
]);

function canReuseModelCatalogSnapshot(error) {
  const code = String(error?.code || '');
  if (code === 'MODEL_DISCOVERY_NETWORK_ERROR') return true;
  if (!SNAPSHOT_DISCOVERY_FALLBACK_CODES.has(code)) return false;
  const status = Number(error?.status || String(error?.message || '').match(/HTTP\s+(\d+)/i)?.[1]);
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function discoveryFromStoredSnapshot(config, error) {
  const stored = config?.model_catalog_snapshot;
  if (!stored || typeof stored !== 'object' || !Array.isArray(stored.models) || !stored.models.length) {
    throw error;
  }
  const fallbackReason = String(error?.message || '模型目录刷新失败');
  const snapshot = {
    ...stored,
    reused_after_refresh_failure: true,
    stale_snapshot: true,
    fallback_code: String(error?.code || 'MODEL_DISCOVERY_ERROR'),
    fallback_reason: fallbackReason,
    fallback_at: new Date().toISOString(),
  };
  return {
    models: stored.models,
    snapshot,
    source_url: stored.source_url || null,
    availability_scope: stored.availability_scope || 'credential',
    discovery_outcome: 'snapshot_reused',
    stale_snapshot: true,
    warnings: [`实时模型目录暂不可用（${fallbackReason}），已使用此视频配置保存的目录快照`],
  };
}

async function discoverVideoCatalogForConfig(db, config, run = null, fetchImpl = fetch) {
  let discovery;
  try {
    discovery = await aiConfigService.discoverModels(config, { db, fetchImpl });
  } catch (error) {
    if (!canReuseModelCatalogSnapshot(error)) throw error;
    discovery = discoveryFromStoredSnapshot(config, error);
  }
  let pricing = null;
  const provider = String(config.provider || '').toLowerCase();
  if (provider === 'yinzi') {
    try {
      pricing = await fetchYinziCatalogForConfig(config, fetchImpl, { include_public_catalog: true });
    } catch (_) {
      pricing = null;
    }
  }
  return aiConfigService.mergeDiscoveredCatalog(discovery, pricing, {
    provider: config.provider,
    service_type: 'video',
    group: run?.policy?.video_group || '',
    capability_overrides: aiConfigService.getModelCapabilityOverrides(config),
    include_public_catalog: provider === 'yinzi',
    smart_routing: provider === 'yinzi' && isYinziSmartRoutingConfig(config),
  });
}

function routingCatalogRun(db, run, shot) {
  const policy = run?.policy && typeof run.policy === 'object' ? run.policy : {};
  const currentId = Number(policy.video_config_id);
  if (Number.isSafeInteger(currentId) && currentId > 0) return run;
  const preferredModel = configuredVideoModelForShot(run, shot);
  let configId = null;
  try { configId = readOnlyVideoConfigId(db, preferredModel); } catch (_) { configId = null; }
  if (!configId) return run;
  return { ...run, policy: { ...policy, video_config_id: configId } };
}

function videoConfigForRun(db, run, shot = null) {
  const policy = run?.policy && typeof run.policy === 'object' ? run.policy : {};
  let configId = Number(policy.video_config_id);
  if (!Number.isSafeInteger(configId) || configId <= 0) {
    try { configId = readOnlyVideoConfigId(db, configuredVideoModelForShot(run, shot)); }
    catch (_) { configId = null; }
  }
  if (!Number.isSafeInteger(configId) || configId <= 0) return null;
  return aiConfigService.getConfig(db, configId);
}

function decorateVideoRouteWithConfig(route, config) {
  const identity = identityForConfig(config);
  const decorated = {
    ...(route || {}),
    video_config_id: identity?.id || null,
    video_config_updated_at: identity?.updated_at || null,
    video_config_fingerprint: identity?.fingerprint || null,
    video_config_identity_version: identity?.version || null,
  };
  decorated.material_signature = routingMaterialSignature(decorated);
  decorated.routing_binding_signature = routingBindingSignature(decorated);
  return decorated;
}

function currentImageConfig(db, run, stage, model = '') {
  const serviceType = stage === 'storyboard_images' ? 'storyboard_image' : 'image';
  const explicit = stage === 'storyboard_images'
    ? run?.policy?.storyboard_image_config_id
    : run?.policy?.asset_image_config_id;
  try {
    return imageClient.getDefaultImageConfig(
      db,
      String(model || '').trim() || undefined,
      undefined,
      serviceType,
      explicit == null ? undefined : Number(explicit)
    );
  } catch (_) {
    return null;
  }
}

function imageRequestIdentity(db, run, stage, request = {}) {
  const model = String(request.model || '').trim();
  const config = currentImageConfig(db, run, stage, model);
  const identity = identityForConfig(config);
  return {
    config,
    identity,
    model: model || config?.default_model || config?.model?.[0] || '',
  };
}

function configuredImageModelForStage(run, stage) {
  const policy = run?.policy || {};
  return String(stage === 'storyboard_images'
    ? (policy.storyboard_image_model || policy.image_model || '')
    : (policy.asset_image_model || policy.image_model || '')).trim();
}

function imageActionConfigurationChanged(db, run, stage, action) {
  if (!action || !['failed', 'cancelled'].includes(action.status)) return false;
  const current = imageRequestIdentity(
    db,
    run,
    stage,
    { model: configuredImageModelForStage(run, stage) }
  );
  const previousModel = String(action.request?.model || '').trim();
  if (previousModel && current.model && previousModel !== current.model) return true;
  const previousIdentity = identityFromSnapshot(action.request || {});
  if (previousIdentity && current.identity) return !sameIdentity(previousIdentity, current.identity);
  const previousId = Number(action.request?.image_config_id);
  return Number.isSafeInteger(previousId) && previousId > 0
    && current.identity?.id != null
    && previousId !== Number(current.identity.id);
}

function requestConfigurationChanged(previousRequest, currentRequest) {
  const previousModel = String(previousRequest?.model || '').trim();
  const currentModel = String(currentRequest?.model || '').trim();
  if (previousModel && currentModel && previousModel !== currentModel) return true;
  const previousIdentity = identityFromSnapshot(previousRequest || {});
  const currentIdentity = identityFromSnapshot(currentRequest || {});
  if (!previousIdentity || !currentIdentity) {
    const previousId = Number(previousRequest?.video_config_id ?? previousRequest?.image_config_id);
    const currentId = Number(currentRequest?.video_config_id ?? currentRequest?.image_config_id);
    return Number.isSafeInteger(previousId) && previousId > 0
      && Number.isSafeInteger(currentId) && currentId > 0
      && previousId !== currentId;
  }
  return !sameIdentity(previousIdentity, currentIdentity);
}

function videoActionRouteChanged(action, route) {
  if (!action || !route) return false;
  const previousModel = String(action.request?.model || action.request?.routing_receipt?.model || '').trim();
  const currentModel = String(route.model || '').trim();
  if (previousModel && currentModel && previousModel !== currentModel) return true;
  const previousBindingSignature = String(
    action.request?.routing_binding_signature
      || action.request?.routing_receipt?.routing_binding_signature
      || action.result?.routing_binding_signature
      || ''
  ).trim();
  const currentBindingSignature = String(
    route.routing_binding_signature || routingBindingSignature(route)
  ).trim();
  if (previousBindingSignature && currentBindingSignature) {
    return previousBindingSignature !== currentBindingSignature;
  }
  const previousSignature = String(
    action.request?.routing_material_signature
      || action.request?.routing_receipt?.material_signature
      || action.result?.routing_material_signature
      || ''
  ).trim();
  const currentSignature = String(route.material_signature || '').trim();
  if (previousSignature && currentSignature && previousSignature !== currentSignature) return true;
  const previousIdentity = identityFromSnapshot({
    ...(action.request || {}),
    ...(action.request?.routing_receipt || {}),
  });
  const currentIdentity = {
    id: route.video_config_id,
    updated_at: route.video_config_updated_at,
    fingerprint: route.video_config_fingerprint,
  };
  if (previousIdentity && currentIdentity.id != null) return !sameIdentity(previousIdentity, currentIdentity);
  return false;
}

function supersedeTerminalVideoAction(db, action, route, reason = 'live_video_route_changed') {
  if (!action || !['failed', 'cancelled'].includes(action.status) || !videoActionRouteChanged(action, route)) {
    return action;
  }
  return repo.updateAction(db, action.id, {
    status: 'cancelled',
    result: {
      ...(action.result || {}),
      superseded_by_route_change: true,
      retry_authorized: true,
      retry_reason: reason,
      previous_route_model: action.request?.model || action.request?.routing_receipt?.model || null,
      replacement_route_model: route.model || null,
      previous_routing_material_signature: action.request?.routing_material_signature
        || action.request?.routing_receipt?.material_signature
        || null,
      replacement_routing_material_signature: route.material_signature || null,
      superseded_at: new Date().toISOString(),
    },
  });
}

function configuredVideoModelForShot(run, shot) {
  const policy = run?.policy || {};
  const overrides = policy.video_model_overrides && typeof policy.video_model_overrides === 'object'
    ? policy.video_model_overrides
    : {};
  const shotModel = String(overrides[String(shot?.scope_id ?? '')] || '').trim();
  if (shotModel) return shotModel;
  const projectMode = policy.video_routing_mode
    ? String(policy.video_routing_mode)
    : String(policy.video_model || '').trim() ? 'fixed' : 'auto';
  return projectMode === 'fixed' ? String(policy.video_model || '').trim() : '';
}

function assertVideoDispatchContract({ run, shot, route, bundle, request, persistedModel = null }) {
  const routeModel = String(route?.model || '').trim();
  const configuredModel = configuredVideoModelForShot(run, shot);
  const bundleModel = String(bundle?.content?.routing_receipt?.model || '').trim();
  const requestModel = String(request?.model || '').trim();
  const requestRouteModel = String(request?.routing_receipt?.model || '').trim();
  const persistedGenerationModel = String(persistedModel || '').trim();
  const routeSignature = routingMaterialSignature(route || {});
  const routeBinding = String(route?.routing_binding_signature || routingBindingSignature(route || '')).trim();
  const bundleSignature = String(bundle?.content?.routing_material_signature || '').trim();
  const bundleBinding = String(
    bundle?.content?.routing_binding_signature
      || bundle?.content?.routing_receipt?.routing_binding_signature
      || (bundle?.content?.routing_receipt
        ? routingBindingSignature(bundle.content.routing_receipt)
        : '')
  ).trim();
  const bundleReceiptSignature = String(bundle?.content?.routing_receipt?.material_signature || '').trim();
  const requestSignature = String(request?.routing_material_signature || '').trim();
  const requestBinding = String(
    request?.routing_binding_signature
      || request?.routing_receipt?.routing_binding_signature
      || (request?.routing_receipt ? routingBindingSignature(request.routing_receipt) : '')
  ).trim();
  const requestReceiptSignature = String(request?.routing_receipt?.material_signature || '').trim();
  const fallbackChild = request?.fallback_parent_action_id != null;
  const routeConfigIdentity = {
    id: route?.video_config_id,
    updated_at: route?.video_config_updated_at,
    fingerprint: route?.video_config_fingerprint,
  };
  const requestConfigIdentity = identityFromSnapshot({
    ...(request || {}),
    ...(request?.routing_receipt || {}),
  });
  const errors = [];

  if (!routeModel) errors.push('resolved route model is empty');
  if (!bundle || bundle.status !== 'approved') errors.push('reference bundle is not approved');
  if (Number(request?.bundle_artifact_id || 0) !== Number(bundle?.id || 0)) errors.push('reference bundle id changed');
  for (const [label, value] of [
    ['configured model', configuredModel],
    ['bundle model', bundleModel],
    ['request model', requestModel],
    ['request route model', requestRouteModel],
    ['persisted generation model', persistedGenerationModel],
  ]) {
    // A fallback child intentionally uses the alternate model while retaining
    // the parent shot's immutable request.  Its parent action and plan are
    // the explicit authority for that model change; do not mistake it for a
    // stale live-config race.
    if (value && routeModel && value !== routeModel
      && !(fallbackChild && ['configured model', 'bundle model'].includes(label))) {
      errors.push(`${label} does not match resolved route`);
    }
  }
  if (!bundleModel && !fallbackChild) errors.push('reference bundle model is empty');
  if (!requestModel) errors.push('request model is empty');
  if (!requestRouteModel) errors.push('request routing receipt model is empty');
  if (routeConfigIdentity.id != null && requestConfigIdentity
    && !sameIdentity(routeConfigIdentity, requestConfigIdentity)) {
    errors.push('request video config identity does not match resolved route');
  }
  for (const [label, value] of [
    ['bundle signature', bundleSignature],
    ['bundle receipt signature', bundleReceiptSignature],
    ['request signature', requestSignature],
    ['request receipt signature', requestReceiptSignature],
  ]) {
    if (!value && !(fallbackChild && label.startsWith('bundle '))) errors.push(`${label} is empty`);
    else if (fallbackChild && label.startsWith('bundle ')) continue;
    // Once a stable binding is present, the full signature is retained only
    // as diagnostic evidence. It may legitimately differ after a catalog
    // refresh (price/source/warning metadata) without changing the request
    // binding. Legacy records without the new field remain strict.
    else if ((label.startsWith('bundle ') && bundleBinding)
      || (label.startsWith('request ') && requestBinding)) continue;
    else if (value !== routeSignature) errors.push(`${label} does not match resolved route`);
  }
  // New requests carry the stable binding signature. Legacy records only
  // have the complete material signature and are checked by the loop above.
  // This keeps old approved bundles dispatchable while preventing volatile
  // catalog metadata from invalidating new bundles.
  for (const [label, value] of [
    ['bundle binding signature', bundleBinding],
    ['request binding signature', requestBinding],
  ]) {
    // Records written before V0.1.4 do not have this field. They remain
    // eligible for the legacy full-signature checks above; only compare the
    // stable binding when the record actually carries one.
    if (!value || (fallbackChild && label.startsWith('bundle '))) continue;
    if (value !== routeBinding) errors.push(`${label} does not match resolved route`);
  }
  if (errors.length) {
    throw codedError(
      'VIDEO_DISPATCH_CONTRACT_MISMATCH',
      `视频模型派发一致性检查失败：${errors.join('；')}`
    );
  }
  return {
    version: 1,
    consistent: true,
    configured_model: configuredModel || null,
    effective_model: routeModel,
    bundle_model: bundleModel,
    request_model: requestModel,
    dispatched_model: persistedGenerationModel || requestModel,
    persisted_generation_model: persistedGenerationModel || null,
    video_config_id: requestConfigIdentity?.id || routeConfigIdentity.id || null,
    video_config_updated_at: requestConfigIdentity?.updated_at || routeConfigIdentity.updated_at || null,
    video_config_fingerprint: requestConfigIdentity?.fingerprint || routeConfigIdentity.fingerprint || null,
    bundle_artifact_id: Number(bundle.id),
    routing_material_signature: routeSignature,
    routing_binding_signature: routeBinding,
    contract_status: route?.contract_status || 'missing',
    contract_warnings: Array.isArray(route?.contract_warnings) ? route.contract_warnings : [],
    reference_warnings: Array.isArray(request?.reference_warnings) ? request.reference_warnings : [],
  };
}

function transitionModeForShot(shot) {
  const value = String(shot?.content?.transition_mode || '').trim();
  if (['opening', 'hard_cut', 'reference_continuation', 'strict_continuation'].includes(value)) return value;
  return Number(shot?.content?.number) === 1 ? 'opening' : 'hard_cut';
}

const PROVIDER_PROMPT_PROFILE = 'structured-provider-prompt-v2';
const PROVIDER_PROMPT_MAX_CHARS = 12000;
const PROVIDER_PROMPT_RENDER_OVERHEAD_CHARS = 180;
const PROVIDER_PROMPT_SECTION_WEIGHTS = Object.freeze({
  boundary: 0.083,
  task: 0.035,
  references: 0.138,
  entry: 0.060,
  visual: 0.116,
  chronology: 0.283,
  exit: 0.094,
  prohibitions: 0.030,
  assets: 0.161,
});

function normalizePromptValue(value) {
  let raw = value;
  if (Array.isArray(raw)) raw = raw.filter(Boolean).join('；');
  else if (raw && typeof raw === 'object') raw = JSON.stringify(raw);
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

function semanticUnitKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s.,，。；;:：!?！？、"'“”‘’()（）\[\]【】]/g, '');
}

function splitSemanticUnits(value) {
  const normalized = normalizePromptValue(value);
  if (!normalized) return [];
  const coarse = normalized
    .replace(/([。！？!?；;])/g, '$1\n')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const expanded = [];
  for (const item of coarse) {
    const pieces = item
      .replace(/([，,、])/g, '$1\n')
      .split(/\r?\n/)
      .map((piece) => piece.replace(/[，,、。！？!?；;]+$/u, '').trim())
      .filter(Boolean);
    expanded.push(...pieces);
  }
  const seen = new Set();
  return expanded.filter((item) => {
    const key = semanticUnitKey(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compactSemanticText(value, maxChars, label = 'prompt field') {
  const normalized = normalizePromptValue(value);
  if (!normalized) return { text: '', compacted: false, source_chars: 0 };
  if (normalized.length <= maxChars) {
    return { text: normalized, compacted: false, source_chars: normalized.length };
  }
  const selected = [];
  let used = 0;
  for (const unit of splitSemanticUnits(normalized)) {
    const separatorLength = selected.length ? 1 : 0;
    if (used + separatorLength + unit.length > maxChars) continue;
    selected.push(unit);
    used += separatorLength + unit.length;
  }
  if (!selected.length) {
    throw codedError(
      'PROVIDER_PROMPT_UNCOMPACTABLE',
      `${label} contains no complete semantic unit that fits its ${maxChars}-character budget`
    );
  }
  return {
    text: selected.join('；'),
    compacted: true,
    source_chars: normalized.length,
  };
}

function compactPromptValue(value, maxChars = 1200, label = 'prompt field') {
  return compactSemanticText(value, maxChars, label).text;
}

function compactPromptEntries(entries, maxChars, sectionKey) {
  const values = entries.map(normalizePromptValue).filter(Boolean);
  if (!values.length) return '';
  const available = Math.max(values.length * 48, maxChars - (values.length - 1));
  const perEntry = Math.max(48, Math.floor(available / values.length));
  return values.map((entry, index) => (
    compactSemanticText(entry, perEntry, `${sectionKey} entry ${index + 1}`).text
  )).join('\n');
}

function providerPromptSectionBudgets(maxChars) {
  const usable = Math.max(900, maxChars - PROVIDER_PROMPT_RENDER_OVERHEAD_CHARS);
  return Object.fromEntries(Object.entries(PROVIDER_PROMPT_SECTION_WEIGHTS)
    .map(([key, weight]) => [key, Math.max(48, Math.floor(usable * weight))]));
}

function renderProviderPromptSections(sections, budgets = null) {
  return sections
    .filter((section) => section.entries.some(Boolean))
    .map((section) => {
      const body = budgets
        ? compactPromptEntries(section.entries, budgets[section.key], section.key)
        : section.entries.filter(Boolean).join('\n');
      return `【${section.title}】\n${body}`;
    })
    .join('\n\n')
    .trim();
}

function providerPromptSectionReceipt(prompt, sections) {
  const receipt = {};
  for (let index = 0; index < sections.length; index += 1) {
    const marker = `【${sections[index].title}】`;
    const start = prompt.indexOf(marker);
    if (start < 0) continue;
    const nextMarker = sections[index + 1] ? `【${sections[index + 1].title}】` : null;
    const end = nextMarker ? prompt.indexOf(nextMarker, start + marker.length) : prompt.length;
    receipt[sections[index].key] = end < 0 ? prompt.length - start : end - start;
  }
  return receipt;
}

function describeProviderReference(db, item, index, mediaType, transitionMode) {
  const artifact = item?.artifact_id ? repo.getArtifact(db, item.artifact_id) : null;
  const title = compactPromptValue(artifact?.title || item?.label || `${mediaType} ${index + 1}`, 120);
  const ordinal = mediaType === 'image' ? `参考图${index + 1}` : mediaType === 'video' ? `参考视频${index + 1}` : `参考音频${index + 1}`;
  if (item?.source === 'strict_first_frame') {
    return `- ${ordinal}「${title}」：严格首帧，生成画面的第一个解码帧必须与它一致。`;
  }
  if (item?.source === 'continuity_first_frame') {
    return `- ${ordinal}「${title}」：上一镜最终解码帧，作为本镜头第一顺位普通参考图；尽量匹配角色、场景、道具、构图和状态，但不得声称像素级严格首帧。`;
  }
  if (item?.source === 'storyboard') {
    return `- ${ordinal}「${title}」：本镜头最终分镜图，锁定构图、入镜状态、角色与道具数量；不得复刻成拼图或多格画面。`;
  }
  if (item?.source === 'uploaded_authority' || item?.role === 'subject_reference' && item?.locked === true) {
    const artifactId = item.artifact_id ? ` artifact ${item.artifact_id}` : '';
    return `- ${ordinal}「${title}」：用户上传的主体身份权威${artifactId}；必须直接参考其可见外观和身份，不得生成相似但不同的替代角色/商品，不得将其降级为仅风格参考。`;
  }
  if (item?.source === 'asset') {
    const authority = item.content?.authority === 'uploaded_asset' || item.content?.must_preserve_identity === true
      ? `严格复用用户上传 artifact ${item.content?.source_artifact_id || '已绑定素材'} 的同一主体，不得生成替代主体`
      : item.scope_type === 'scene'
      ? '锁定场景几何、固定陈设、材质与灯光基线'
      : item.scope_type === 'character'
        ? '锁定该角色的身份、脸、发型、体型、服装和固定装备'
        : '锁定该道具的唯一外形、材质、尺寸和数量';
    return `- ${ordinal}「${title}」：${authority}；只提取设定，不得生成四视图、白底设定板或分栏。`;
  }
  if (item?.source === 'director') {
    return `- ${ordinal}「${title}」：仅约束粗略机位、构图、运动方向、动作阻挡和时间节奏；人物、服装、道具和场景细节以参考图及固定资产约束为准。`;
  }
  if (item?.source === 'continuity_in') {
    const hardCutRule = transitionMode === 'hard_cut'
      ? '只继承角色身份、场景和道具状态，不得延续上一段的机位、运镜或未完成动作'
      : '用于继承已批准的连续状态';
    return `- ${ordinal}「${title}」：上一镜头成片，${hardCutRule}。`;
  }
  return `- ${ordinal}「${title}」：作为本镜头的${mediaType === 'audio' ? '声音' : '视觉'}参考，不得覆盖本提示词的镜头边界和动作时序。`;
}

const CHINESE_SHOT_NUMBERS = Object.freeze([
  '', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
]);

function shotRuleApplies(rule, shot) {
  const text = normalizePromptValue(rule);
  if (!text) return false;
  const number = Number(shot?.content?.number);
  const mentionsShot = /第(?:[一二三四五六七八九十]+|\d+)镜头|镜头\s*\d+/u.test(text);
  if (!mentionsShot || !Number.isFinite(number)) return true;
  const markers = [
    `第${number}镜头`,
    `镜头${number}`,
    CHINESE_SHOT_NUMBERS[number] ? `第${CHINESE_SHOT_NUMBERS[number]}镜头` : '',
  ].filter(Boolean);
  return markers.some((marker) => text.includes(marker));
}

function constraintPriority(unit, shot, sceneStateUnit = false) {
  const text = normalizePromptValue(unit);
  const number = Number(shot?.content?.number);
  const currentMarkers = [
    `第${number}镜头`,
    `镜头${number}`,
    CHINESE_SHOT_NUMBERS[number] ? `第${CHINESE_SHOT_NUMBERS[number]}镜头` : '',
  ].filter(Boolean);
  if (currentMarkers.some((marker) => text.includes(marker))) return 0;
  if (sceneStateUnit && /^(?:场景|背景|画面|街道|全程)?无/u.test(text)) return 0;
  if (sceneStateUnit && /不得|禁止|不能|不可|不出现|不含/u.test(text)) return 1;
  if (/始终|唯一|只|全程|不得|不能|不可|禁止/u.test(text)) return 1;
  return 2;
}

function evenlySampleSemanticUnits(items, limit) {
  const values = Array.isArray(items) ? items : [];
  if (values.length <= limit) return values;
  const indexes = new Set();
  for (let index = 0; index < limit; index += 1) {
    indexes.add(Math.round(index * (values.length - 1) / Math.max(1, limit - 1)));
  }
  return [...indexes].sort((left, right) => left - right).map((index) => values[index]);
}

function optionalSemanticGroup(label, values, maxChars) {
  const items = Array.isArray(values) ? values.filter(Boolean) : [];
  if (!items.length || maxChars <= label.length + 8) return '';
  try {
    const compacted = compactSemanticText(items.join('；'), maxChars - label.length, label).text;
    return compacted ? `${label}${compacted}` : '';
  } catch (error) {
    if (error.code === 'PROVIDER_PROMPT_UNCOMPACTABLE') return '';
    throw error;
  }
}

function assetProviderContract(asset, shot, maxChars = 1500) {
  const content = asset?.content || {};
  const typeLabel = asset.scope_type === 'character' ? '角色' : asset.scope_type === 'scene' ? '场景' : '道具';
  const anchors = asset.scope_type === 'scene' ? content.spatial_anchors : content.identity_anchors;
  const core = asset.scope_type === 'character'
    ? content.appearance
    : content.description;
  const authority = content.authority === 'uploaded_asset' || content.must_preserve_identity === true
    ? `权威来源：用户上传 artifact ${content.source_artifact_id || '已绑定素材'}；必须保持同一主体身份和可见外观，禁止生成替代主体。`
    : '';
  const header = `- ${typeLabel}「${content.name || asset.title}」${authority ? `；${authority}` : ''}`;
  const anchorUnits = splitSemanticUnits(anchors);
  const coreUnits = splitSemanticUnits(core);
  const stateCoreUnits = asset.scope_type === 'scene'
    ? coreUnits.filter((unit) => /无|不得|禁止|不能|不可|不出现|不含/u.test(unit))
    : [];
  const continuityUnits = splitSemanticUnits(content.continuity_rules)
    .filter((unit) => shotRuleApplies(unit, shot));
  const ruleUnits = [...stateCoreUnits, ...continuityUnits]
    .filter((unit, index, values) => values.findIndex((item) => semanticUnitKey(item) === semanticUnitKey(unit)) === index)
    .map((unit, index) => ({
      unit,
      index,
      priority: constraintPriority(unit, shot, stateCoreUnits.includes(unit)),
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map((item) => item.unit);
  const negativeUnits = evenlySampleSemanticUnits(splitSemanticUnits(content.negative_prompt), 12);
  const descriptiveUnits = anchorUnits.length ? [] : coreUnits.filter((unit) => !stateCoreUnits.includes(unit));
  const bodyBudget = Math.max(24, maxChars - header.length - 3);
  const anchorBudget = Math.floor(bodyBudget * 0.42);
  const ruleBudget = Math.floor(bodyBudget * 0.38);
  const negativeBudget = bodyBudget - anchorBudget - ruleBudget;
  const anchorGroup = optionalSemanticGroup(
    anchorUnits.length ? '锚点：' : '外观：',
    anchorUnits.length ? anchorUnits : descriptiveUnits,
    anchorBudget
  );
  const ruleGroup = optionalSemanticGroup('状态：', ruleUnits, ruleBudget);
  const negativeGroup = optionalSemanticGroup('禁止：', negativeUnits, negativeBudget);
  const combined = [header, anchorGroup, ruleGroup, negativeGroup].filter(Boolean).join('；');
  if (combined.length <= maxChars) return combined;
  return compactSemanticText(combined, maxChars, `${typeLabel} ${content.name || asset.title}`).text;
}

function buildProviderPromptPackage(db, run, shot, bundle, providerPrompt, explicitCapability = null) {
  const content = shot?.content || {};
  const transitionMode = transitionModeForShot(shot);
  const routeReceipt = bundle?.content?.routing_receipt || {};
  const capability = explicitCapability || getYinziVideoCapability(String(
    routeReceipt.model || run.policy?.video_model || ''
  ).trim());
  const plannedDuration = Math.max(1, Number(
    routeReceipt.planned_duration
      ?? content.creative_duration_seconds
      ?? content.duration
  ) || 1);
  // Never apply a global five-second floor here.  The route already carries
  // the concrete provider execution unit (fixed 30s for Seedance 2.5,
  // enumerated 5/10/15s for Seedance 2.0, etc.).  Unknown capabilities remain
  // open and use the user's planned duration until the provider validates it.
  const providerDuration = Math.max(1, Number(
    routeReceipt.provider_duration
      ?? routeReceipt.duration
      ?? content.provider_duration_seconds
      ?? plannedDuration
  ) || plannedDuration);
  const durationAdjusted = providerDuration > plannedDuration;
  const durationMode = capability?.duration_mode || routeReceipt.capability_snapshot?.duration_mode || null;
  const maxChars = Number(capability?.max_prompt_chars) || PROVIDER_PROMPT_MAX_CHARS;
  const providerHardMaxChars = Number(capability?.provider_prompt_hard_max_chars) || maxChars;
  const sectionBudgets = providerPromptSectionBudgets(maxChars);
  const references = [
    ...(bundle?.content?.images || []).map((item, index) => describeProviderReference(db, item, index, 'image', transitionMode)),
    ...(bundle?.content?.videos || []).map((item, index) => describeProviderReference(db, item, index, 'video', transitionMode)),
    ...(bundle?.content?.audios || []).map((item, index) => describeProviderReference(db, item, index, 'audio', transitionMode)),
  ];
  for (const item of bundle?.content?.videos || []) {
    if (item.source === 'continuity_in' && item.transport?.mode === 'tail_excerpt') {
      references.push('The predecessor input is a tail excerpt ending at the approved real cut boundary. Use it only for identity, scene, prop, and cut-state continuity; its first frame is not this shot\'s first frame.');
    }
  }
  const assetText = approvedIncluded(db, run.id, 'asset_text');
  const promptAssetPriority = { character: 0, scene: 1, prop: 2 };
  const scopedAssets = resourceDigestForShot(assetText, shot)
    .sort((left, right) => (promptAssetPriority[left.scope_type] ?? 3) - (promptAssetPriority[right.scope_type] ?? 3));
  const perAssetBudget = maxChars < PROVIDER_PROMPT_MAX_CHARS
    ? Math.max(96, Math.floor((sectionBudgets.assets - Math.max(0, scopedAssets.length - 1)) / Math.max(1, scopedAssets.length)))
    : 1500;
  const assets = scopedAssets.map((asset) => assetProviderContract(asset, shot, perAssetBudget));
  const materialContext = run.policy?.execution_plan
    ? templateExecutionPlan.materialContext(run.policy.execution_plan)
    : '';
  const transitionInstruction = transitionMode === 'opening'
    ? '这是成片开场的独立完整摄影镜头，不依赖前序画面，也不得把本镜头的动作或运镜留到下一次请求。'
    : transitionMode === 'hard_cut'
      ? '这是明确硬切后的新摄影镜头，必须从新机位和已定义入镜状态开始；不得继续上一段尚未完成的动作或运镜。'
      : transitionMode === 'reference_continuation'
        ? '这是尾帧参考续接镜头：上一镜最终帧只作为第一顺位普通参考图，尽量保持连续状态，但不是像素级严格首帧。'
        : '这是严格续拍镜头，必须从派生的精确首帧继续同一条摄影镜头。';
  const chronology = compactPromptValue(providerPrompt || content.video_prompt, 5000);
  const framing = compactPromptValue([content.shot_type, content.camera_angle], 700);
  const cameraMovement = compactPromptValue(content.camera_movement, 700);
  const lighting = compactPromptValue(content.lighting, 900);
  const defaultCreativeGuidance = '除动作时间线明确要求的状态变化外，不得新增、删除、复制、换手、变形或替换任何角色、肢体、服装、道具和场景陈设；不得换景、换昼夜、改变固定几何；不得出现可读文字、字幕、品牌、水印、额外人物或无关物体。动作必须符合关节、重心、接触和惯性，镜头稳定。';
  const creativeGuidance = promptRegistry.resolveRuntime(db, 'production.video_provider.guidance', {
    default_content: defaultCreativeGuidance,
  });
  const sections = [
    {
      key: 'boundary',
      title: '镜头边界，最高优先级',
      entries: [compactPromptValue(content.boundary_prompt || transitionInstruction, 1200), transitionInstruction],
    },
    {
      key: 'task',
      title: '生成任务',
      entries: [
        `时长 ${providerDuration} 秒，画幅 ${compactPromptValue(run.policy?.aspect_ratio || '16:9', 30)}。${compactPromptValue(run.policy?.style || run.policy?.visual_style, 1200)}`,
        durationAdjusted
          ? `原分镜按 ${plannedDuration} 秒设计，供应商本次执行单元为 ${providerDuration} 秒（${durationMode === 'fixed' ? '固定时长' : durationMode === 'enumerated' ? '枚举时长' : '能力边界'}）。必须在前 ${plannedDuration} 秒内完成原动作和剪辑点，剩余 ${Number((providerDuration - plannedDuration).toFixed(2))} 秒保持 cut_out 规定的最终状态，不新增动作、人物、道具、运镜或场景变化；最终成片在本地按 final_edit_duration_seconds 裁剪。`
          : '供应商执行时长与创作目标一致；最终成片仍以 final_edit_duration_seconds 为准。',
        '单个视频请求必须完成一个完整摄影镜头，镜头内部连续，不使用分屏或快速蒙太奇。',
      ],
    },
    { key: 'references', title: '参考媒体使用规则，严格按传入顺序', entries: references },
    ...(materialContext ? [{
      key: 'material_context',
      title: '素材权威与复用计划',
      entries: [materialContext],
    }] : []),
    {
      key: 'entry',
      title: '精确入镜状态',
      entries: [compactPromptValue(content.cut_in, 900), compactPromptValue(content.continuity_in, 1600)],
    },
    {
      key: 'visual',
      title: '画面与摄影',
      entries: [
        compactPromptValue(content.visual, 1800),
        framing ? `景别与角度：${framing}` : '',
        cameraMovement ? `运镜：${cameraMovement}` : '',
        lighting ? `灯光：${lighting}` : '',
      ],
    },
    {
      key: 'chronology',
      title: '本镜头完整动作时间线',
      entries: [chronology || compactPromptValue(content.action, 3000)],
    },
    {
      key: 'exit',
      title: '精确出镜状态与剪辑点',
      entries: [compactPromptValue(content.continuity_out, 1600), compactPromptValue(content.cut_out, 900)],
    },
    {
      key: 'prohibitions',
      title: '统一生成禁令',
      entries: [creativeGuidance.content],
    },
    { key: 'assets', title: '相关固定资产约束', entries: assets },
  ];
  const fullPrompt = renderProviderPromptSections(sections);
  const semanticAssetCompaction = maxChars < PROVIDER_PROMPT_MAX_CHARS && scopedAssets.length > 0;
  const prompt = fullPrompt.length <= maxChars
    ? fullPrompt
    : renderProviderPromptSections(sections, sectionBudgets);
  if (prompt.length > maxChars) {
    throw codedError(
      'PROVIDER_PROMPT_TOO_LONG',
      `视频提示词压缩后仍有 ${prompt.length} 字符，超过当前模型 ${maxChars} 字符上限，已在付费提交前停止`
    );
  }
  return {
    prompt,
    receipt: {
      profile: PROVIDER_PROMPT_PROFILE,
      max_chars: maxChars,
      provider_hard_max_chars: providerHardMaxChars,
      planned_duration: plannedDuration,
      provider_duration: providerDuration,
      duration_adjusted: durationAdjusted,
      full_chars: fullPrompt.length,
      final_chars: prompt.length,
      compacted: semanticAssetCompaction || prompt !== fullPrompt,
      section_chars: providerPromptSectionReceipt(prompt, sections),
      prompt_snapshot: {
        prompt_id: creativeGuidance.id,
        prompt_version: creativeGuidance.version,
        customized: creativeGuidance.customized,
        content_hash: creativeGuidance.content_hash,
        content: creativeGuidance.content,
      },
    },
  };
}

function buildProviderPrompt(db, run, shot, bundle, providerPrompt, explicitCapability = null) {
  return buildProviderPromptPackage(db, run, shot, bundle, providerPrompt, explicitCapability).prompt;
}

function scopeShotItems(items, run) {
  if (!isSequentialShotRun(run) || run.current_scope_id == null) return items;
  return items.filter((item) => item.scope_id === String(run.current_scope_id));
}

function actionKey(stage, source, attempt) {
  return `${stage}:${source.scope_type}:${source.scope_id}:source-r${source.revision}:a${attempt}`;
}

function sourceGenerationAttemptCount(db, runId, stage, source, kind) {
  return repo.listActions(db, runId, { page_size: 200 }).items.filter((action) => (
    action.stage === stage
    && action.kind === kind
    && String(action.scope_type || '') === String(source.scope_type || '')
    && String(action.scope_id || '') === String(source.scope_id || '')
    && Number(action.request?.source_artifact_id ?? action.result?.source_artifact_id) === Number(source.id)
  )).length;
}

function rejectedReviewFeedback(review) {
  const verdict = review?.evidence?.review_verdict;
  const feedback = {
    review_id: review.id,
    artifact_id: review.artifact_id,
    artifact_revision: review.artifact_revision,
    reason: String(review.reason || verdict?.reason || '').trim().slice(0, 4000),
    created_at: review.created_at,
  };
  if (verdict && typeof verdict === 'object') {
    feedback.severity = String(verdict.severity || '').trim().slice(0, 40) || null;
    feedback.blocking_issues = (Array.isArray(verdict.blocking_issues) ? verdict.blocking_issues : [])
      .map((item) => String(item || '').trim().slice(0, 1600)).filter(Boolean).slice(0, 12);
    feedback.improvement_notes = (Array.isArray(verdict.improvement_notes) ? verdict.improvement_notes : [])
      .map((item) => String(item || '').trim().slice(0, 1200)).filter(Boolean).slice(0, 8);
  }
  return feedback;
}

function rejectedVideoEvidence(db, run, shot) {
  const reviews = repo.listRejectedReviewEvidence(db, run.id, 'shot_video', 'shot', shot.scope_id)
    .map(rejectedReviewFeedback)
    .filter((review) => review.reason);
  const failures = repo.listActions(db, run.id, { page_size: 200 }).items
    .filter((action) => action.stage === 'shot_video'
      && action.scope_type === 'shot'
      && action.scope_id === String(shot.scope_id)
      && action.result?.automatic_diagnosis?.correction)
    .reverse()
    .map((action) => ({
      review_id: null,
      action_id: action.id,
      artifact_id: null,
      artifact_revision: null,
      reason: String(action.result.automatic_diagnosis.correction).slice(0, 4000),
      observed_failure: String(action.error_message || action.result.automatic_diagnosis.root_cause || '').slice(0, 2000),
      created_at: action.updated_at,
    }));
  return [...reviews, ...failures].slice(-20);
}

function rejectedImageEvidence(db, run, stage, source) {
  const reviews = repo.listRejectedReviewEvidence(db, run.id, stage, source.scope_type, source.scope_id)
    .slice(-5)
    .map(rejectedReviewFeedback)
    .filter((review) => review.reason);
  const failures = repo.listActions(db, run.id, { page_size: 200 }).items
    .filter((action) => action.stage === stage
      && action.scope_type === source.scope_type
      && action.scope_id === String(source.scope_id)
      && action.result?.automatic_diagnosis?.correction)
    .reverse()
    .map((action) => ({
      review_id: null,
      action_id: action.id,
      artifact_id: null,
      artifact_revision: null,
      reason: String(action.result.automatic_diagnosis.correction).slice(0, 4000),
      observed_failure: String(action.error_message || action.result.automatic_diagnosis.root_cause || '').slice(0, 2000),
      created_at: action.updated_at,
    }));
  return [...reviews, ...failures].slice(-5);
}

function appendImageRevisionFeedback(prompt, evidence, hasRevisionReference) {
  if (!evidence.length) return prompt;
  const requirements = evidence.map((review, index) => {
    const blocking = (review.blocking_issues || []).map((item) => `   - MUST FIX: ${item}`).join('\n');
    const improvements = (review.improvement_notes || []).map((item) => `   - OPTIONAL IF COMPATIBLE: ${item}`).join('\n');
    return [`${index + 1}. REVIEW REASON: ${review.reason}`, blocking, improvements].filter(Boolean).join('\n');
  }).join('\n');
  const referenceInstruction = hasRevisionReference
    ? 'The first reference image is the previous rejected revision. Preserve its useful identity, face, hairstyle, proportions, layout, and other uncriticized traits; change the criticized details only.'
    : 'Preserve every source-defined trait that is not criticized below.';
  return `${prompt}\n\nHIGH-PRIORITY REVISION REQUIREMENTS (override conflicting visual details):\n${referenceInstruction}\n${requirements}\nEvery MUST FIX item is mandatory. OPTIONAL items must never override approved facts or create a new subject, object, location, event, or visual state. Do not merely describe these corrections: render every corrected state visibly and consistently in the new image.`;
}

function rejectedImageReferenceOptedIn(run, source) {
  const policy = run?.policy || {};
  const sourcePolicy = source?.content || {};
  return policy.image_retry_reference_policy === 'include_rejected'
    || sourcePolicy.image_retry_reference_policy === 'include_rejected'
    || sourcePolicy.preserve_rejected_reference === true;
}

function mergeImageReferenceArtifacts(primary, fallback, limit = 4) {
  const selected = [];
  const paths = new Set();
  for (const item of [...primary, ...fallback]) {
    if (!item?.path || paths.has(item.path) || selected.length >= limit) continue;
    paths.add(item.path);
    selected.push(item);
  }
  return selected;
}

function runTemplateId(run) {
  return String(run?.policy?.template_id || run?.input?.template_id || '').trim().toLowerCase();
}

// An imported authority image can have two valid meanings.  Most templates
// may use it directly as the completed asset.  The image-to-video template,
// however, needs a generated identity sheet (four views) before shot images
// are produced.  Keep this distinction explicit so an upload is never
// silently replaced, and so a required supplement is not skipped.
function needsUploadedSubjectReferenceSheet(run, source, target) {
  if (runTemplateId(run) !== 'image-to-video') return false;
  if (source?.scope_type !== 'character' && source?.scope_type !== 'product') return false;
  // The source is the generated asset definition while target is the current
  // asset_images artifact.  Older runs may have a missing/mismatched target
  // scope, so use the source provenance as an additional signal instead of
  // silently skipping the identity sheet.
  return (target?.status === 'approved'
    && target?.media_path
    && target?.content?.imported === true
    && target?.content?.authority === 'uploaded_asset')
    || Number(source?.content?.source_artifact_id || 0) > 0;
}

function isReusableImportedAuthorityArtifact(target) {
  return target?.status === 'approved'
    && Boolean(target?.media_path)
    && target?.content?.imported === true
    && target?.content?.authority === 'uploaded_asset';
}

function uploadedAuthorityReference(db, run, source, target) {
  const sourceArtifactId = Number(source?.content?.source_artifact_id || 0);
  const authoritySubjectId = String(source?.content?.authority_subject_id || '').trim();
  // Older imports predate the explicit `authority` flag.  When the resource
  // definition points at a concrete source artifact, that immutable ID is
  // stronger evidence than the missing legacy flag and lets us recover the
  // original upload without falling back to a generated derivative.
  const candidates = currentArtifacts(db, run.id, 'asset_images')
    .filter((item) => item.status === 'approved' && item.media_path && item.content?.imported === true);
  const bySourceId = sourceArtifactId > 0
    ? candidates.find((item) => Number(item.id) === sourceArtifactId)
    : null;
  const bySubject = authoritySubjectId
    ? candidates.find((item) => String(item.content?.authority_subject_id || '') === authoritySubjectId)
    : null;
  const selected = bySourceId || bySubject
    || candidates.find((item) => item.content?.authority === 'uploaded_asset')
    || (target?.content?.imported === true && target?.media_path ? target : null);
  if (!selected) return null;
  return {
    path: selected.media_path,
    artifact_id: selected.id,
    scope_type: selected.scope_type,
    scope_id: selected.scope_id,
    role: 'primary_subject_reference',
    source: 'uploaded_authority',
    locked: true,
    content_hash: selected.content_hash || selected.content?.sha256 || null,
  };
}

const IN_FLIGHT_ACTION_STATUSES = new Set(['reserved', 'submitted', 'waiting']);

const AMBIGUOUS_IMAGE_FAILURE_PATTERNS = [
  /\btimeout\b/i,
  /timed out/i,
  /ECONNRESET/i,
  /socket hang up/i,
  /premature close/i,
  /connection (?:was )?closed/i,
  /response (?:was )?(?:aborted|truncated)/i,
];

function isAmbiguousImageGenerationFailure(generation) {
  if (!generation || generation.status === 'completed') return false;
  const message = String(generation.error_msg || generation.error_message || '');
  return AMBIGUOUS_IMAGE_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}

function selectGenerationAction(action, source, replacementTarget, options = {}) {
  if (!action) return { action: null, blocked: null };
  if (action.result?.detached_from_sequence === true) return { action: null, blocked: null, detached: action };
  if (action.status === 'ambiguous') return { action, blocked: null };
  const sourceArtifactId = action.result?.source_artifact_id ?? action.request?.source_artifact_id;
  const sourceChanged = sourceArtifactId != null && Number(sourceArtifactId) !== Number(source.id);
  const alreadySuperseded = action.result?.superseded_by_source_change === true
    || action.result?.superseded_by_route_change === true;
  if (sourceChanged) {
    if (action.status === 'reserved' && !action.generation_id) {
      const cancelled = options.cancelReserved?.(action, source) || action;
      return { action: null, blocked: null, cancelled, sourceChanged: true };
    }
    if (action.status === 'submitted' && !action.generation_id) {
      return { action, blocked: 'ambiguous_external_create', sourceChanged: true };
    }
    if (IN_FLIGHT_ACTION_STATUSES.has(action.status)) {
      return { action, blocked: null, sourceChanged: true };
    }
    return { action: null, blocked: null };
  }
  if (alreadySuperseded && !IN_FLIGHT_ACTION_STATUSES.has(action.status)) {
    return { action: null, blocked: null };
  }
  if (replacementTarget && action.status === 'completed') return { action: null, blocked: null };
  return { action, blocked: null };
}

function createDefaultAdapters(db, cfg, log) {
  return {
    createImage(request) {
      return imageService.create(db, log, request);
    },
    getImage(id) {
      return imageService.getById(db, id);
    },
    createVideo(request) {
      acceptanceSafety.assertVideoSubmitAllowed({
        entry: 'production_default_adapter',
        model: request?.model || null,
        run_id: request?.production_run_id || null,
      });
      const videoConfig = videoClient.getDefaultVideoConfig(db, request.model, request.video_config_id);
      if (!videoConfig) {
        const suffix = request.video_config_id == null
          ? '请先在设置中添加并启用视频 URL / Key 配置'
          : `视频配置 #${request.video_config_id} 不存在、不是视频配置或已停用，请重新选择配置`;
        throw codedError('VIDEO_CONFIG_UNAVAILABLE', suffix);
      }
      const task = taskService.createTask(db, log, 'video_generation', String(request.drama_id || ''));
      const timestamp = new Date().toISOString();
      const videoConfigId = videoConfig.id;
      const providerProtocol = videoClient.resolveVideoProtocol(videoConfig, request.model);
      const providerConfigSnapshot = videoClient.buildProviderConfigSnapshot(
        videoConfig,
        request.model,
        request.routing_receipt
      );
      const info = db.prepare(
        `INSERT INTO video_generations (
          drama_id, storyboard_id, provider, prompt, prompt_contract_json, model, duration, aspect_ratio, resolution,
          seed, camera_fixed, watermark, first_frame_url, last_frame_url, reference_image_urls,
          reference_video_urls, reference_audio_urls, status, generation_status, download_status,
          video_config_id, provider_protocol, provider_config_snapshot_json,
          submission_status, submission_http_status, submission_receipt_json, contract_validation_mode,
          task_id, created_at, updated_at
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', 'processing',
          'pending', ?, ?, ?, 'not_sent', NULL, NULL, ?, ?, ?, ?)`
      ).run(
        Number(request.drama_id) || 0,
        request.provider || 'yinzi',
        request.prompt || '',
        request.prompt_contract ? JSON.stringify(request.prompt_contract) : null,
        request.model,
        request.duration,
        request.aspect_ratio || '16:9',
        request.resolution || '480p',
        request.seed == null ? null : Number(request.seed),
        request.camera_fixed == null ? null : (request.camera_fixed ? 1 : 0),
        request.watermark ? 1 : 0,
        request.first_frame_url || null,
        request.last_frame_url || null,
        JSON.stringify(request.reference_image_urls || []),
        JSON.stringify(request.reference_video_urls || []),
        JSON.stringify(request.reference_audio_urls || []),
        videoConfigId,
        providerProtocol,
        JSON.stringify(providerConfigSnapshot),
        videoClient.normalizeContractValidationMode(request.contract_validation_mode || 'advisory'),
        task.id,
        timestamp,
        timestamp
      );
      const generationId = Number(info.lastInsertRowid);
      setImmediate(() => videoService.processVideoGeneration(db, log, generationId));
      return { id: generationId, task_id: task.id, status: 'processing', model: request.model };
    },
    getVideo(id) {
      return videoService.getById(db, id);
    },
    validateImage: (mediaPath, options) => validation.validateImage(cfg, mediaPath, options),
    validateVideo: (mediaPath, options) => validation.validateVideo(cfg, mediaPath, options),
    validateContinuityFrame: (mediaPath, options = {}) => validation.validateImage(cfg, mediaPath, {
      min_bytes: 64, allow_uniform: true, ...options,
    }),
    extractContinuityFrame: (mediaPath, input) => boundaryFrames.extractTailFrame(cfg, mediaPath, input),
    compareStrictFirstFrame: (expectedPath, generatedPath, options) => (
      boundaryFrames.compareStrictFirstFrame(cfg, expectedPath, generatedPath, options)
    ),
    probeHardCutBoundary: (previousPath, generatedPath) => (
      boundaryFrames.probeHardCutBoundary(cfg, previousPath, generatedPath)
    ),
    mergeVideoSegments: async (mediaPaths, options = {}) => {
      const storageRoot = validation.resolveLocalMediaPath(cfg, mediaPaths[0]).storage_root;
      const relative = `production/fallback/${crypto.createHash('sha256')
        .update(mediaPaths.join('|')).digest('hex').slice(0, 24)}.mp4`;
      const output = path.join(storageRoot, relative.replace(/\//g, path.sep));
      fs.mkdirSync(path.dirname(output), { recursive: true });
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-fallback-'));
      try {
        const resolved = mediaPaths.map((mediaPath) => validation.resolveLocalMediaPath(cfg, mediaPath).absolute_path);
        const ok = videoMergeService.runStrictNormalizedMerge(
          resolved,
          output,
          { aspect_ratio: options.aspect_ratio || '16:9' },
          log,
          tempDir
        );
        if (!ok) throw codedError('VIDEO_FALLBACK_MERGE_FAILED', '两段备用视频无法在本地合成为一个逻辑镜头');
        return { relative_path: relative, absolute_path: output };
      } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      }
    },
    prepareReferenceVideoTransport(mediaPath, options) {
      const resolved = validation.resolveLocalMediaPath(cfg, mediaPath);
      const prepared = prepareYinziReferenceVideo(resolved.absolute_path, {
        storage_root: resolved.storage_root,
        aspect_ratio: options.aspect_ratio,
        clip_start_seconds: options.start_seconds,
        clip_duration_seconds: options.duration_seconds,
        log,
      });
      const relativePath = path.relative(resolved.storage_root, prepared.file_path);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw codedError('REFERENCE_VIDEO_EXCERPT_OUTSIDE_STORAGE', 'Prepared reference-video excerpt escaped the storage root');
      }
      return {
        relative_path: relativePath.replace(/\\/g, '/'),
        source_relative_path: resolved.relative_path,
        duration: prepared.probe.duration,
        width: prepared.probe.width,
        height: prepared.probe.height,
        video_codec: prepared.probe.video_codec,
        pixel_format: prepared.probe.pixel_format,
        r_frame_rate: prepared.probe.r_frame_rate_raw,
        avg_frame_rate: prepared.probe.avg_frame_rate_raw,
        cache_reused: prepared.cache_reused === true,
      };
    },
    async fetchVideoCatalog(run = null) {
      const configId = Number(run?.policy?.video_config_id || 0);
      if (!Number.isSafeInteger(configId) || configId <= 0) return fetchYinziCatalog();
      const config = aiConfigService.getConfig(db, configId);
      if (!config || config.service_type !== 'video' || config.is_active === false) {
        const error = new Error(`视频配置 #${configId} 不存在、不是视频配置或已停用`);
        error.code = 'VIDEO_CONFIG_UNAVAILABLE';
        throw error;
      }
      return discoverVideoCatalogForConfig(db, config, run, fetch);
    },
  };
}

const AUTOLINK_RECEIPT_VERSION = 1;
const AUTOLINK_STRATEGY = 'shot_stable_ids_then_named_assets_v2';
const ASSET_TYPE_LABELS = Object.freeze({ scene: '场景', character: '角色', prop: '道具' });
const SHOT_FIELD_LABELS = Object.freeze({
  scene_name: '场景名称',
  character_names: '角色名单',
  prop_names: '道具名单',
});

function normalizeAutoLinkName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{White_Space}\p{P}\p{S}]+/gu, '');
}

function shotAssetReferenceRequests(shot) {
  const requested = [
    ...(Array.isArray(shot.content?.reference_asset_ids) ? shot.content.reference_asset_ids : [])
      .map((id) => ({ asset_type: 'reference', source_field: 'reference_asset_ids', requested_id: String(id || '').trim() }))
      .filter((item) => item.requested_id),
    ...(Array.isArray(shot.content?.character_ids) ? shot.content.character_ids : [])
      .map((id) => ({ asset_type: 'character', source_field: 'character_ids', requested_id: String(id || '').trim() }))
      .filter((item) => item.requested_id),
    ...(shot.content?.scene_id ? [{ asset_type: 'scene', source_field: 'scene_id', requested_id: String(shot.content.scene_id).trim() }] : []),
    ...(Array.isArray(shot.content?.prop_ids) ? shot.content.prop_ids : [])
      .map((id) => ({ asset_type: 'prop', source_field: 'prop_ids', requested_id: String(id || '').trim() }))
      .filter((item) => item.requested_id),
    ...(shot.content?.scene_name
      ? [{ asset_type: 'scene', source_field: 'scene_name', requested_name: shot.content.scene_name }]
      : []),
    ...(Array.isArray(shot.content?.character_names) ? shot.content.character_names : [])
      .map((name) => ({ asset_type: 'character', source_field: 'character_names', requested_name: name })),
    ...(Array.isArray(shot.content?.prop_names) ? shot.content.prop_names : [])
      .map((name) => ({ asset_type: 'prop', source_field: 'prop_names', requested_name: name })),
  ];
  const seen = new Set();
  return requested.map((item) => ({
    ...item,
    requested_name: String(item.requested_name || '').trim(),
    requested_id: String(item.requested_id || '').trim(),
    normalized_name: normalizeAutoLinkName(item.requested_name),
  })).filter((item) => {
    const key = `${item.asset_type}:${item.requested_id || item.normalized_name}`;
    if ((!item.normalized_name && !item.requested_id) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assetDefinitionIndex(assetText) {
  const index = new Map();
  for (const asset of [...assetText].sort((left, right) => Number(left.id) - Number(right.id))) {
    const normalizedName = normalizeAutoLinkName(asset.content?.name);
    if (!normalizedName) continue;
    const key = `${asset.scope_type}:${normalizedName}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(asset);
  }
  return index;
}

function assetDefinitionByStableId(assetText) {
  const index = new Map();
  for (const asset of assetText) {
    const keys = [
      asset.id,
      asset.scope_id,
      asset.content?.source_artifact_id,
      asset.content?.execution_asset_id,
      asset.content?.authority_subject_id,
      `${asset.scope_type}-${asset.scope_id}`,
      `${asset.scope_type}:${asset.scope_id}`,
    ]
      .filter((value) => value != null && String(value).trim());
    for (const key of keys) {
      if (!index.has(String(key))) index.set(String(key), []);
      if (!index.get(String(key)).some((item) => Number(item.id) === Number(asset.id))) index.get(String(key)).push(asset);
    }
  }
  return index;
}

function resourceDigestForShot(assetText, shot) {
  const definitions = assetDefinitionIndex(assetText);
  const definitionsById = assetDefinitionByStableId(assetText);
  return shotAssetReferenceRequests(shot).flatMap((request) => {
    const stable = request.requested_id ? (definitionsById.get(request.requested_id) || []) : [];
    const candidates = stable.length
      ? stable
      : (request.normalized_name ? (definitions.get(`${request.asset_type}:${request.normalized_name}`) || []) : []);
    return candidates.length === 1 ? candidates : [];
  });
}

function compareReferencePriority(left, right) {
  const priority = { scene: 0, character: 1, prop: 2 };
  const leftPriority = priority[left?.scope_type] ?? 3;
  const rightPriority = priority[right?.scope_type] ?? 3;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  return String(left?.scope_id || '').localeCompare(String(right?.scope_id || ''), undefined, { numeric: true });
}

function buildImageReferenceAutoLink(db, run, shot, limit = 4, options = {}) {
  const assetSlotLimit = Math.max(0, Math.floor(Number(limit) || 0));
  const providerImageLimit = Math.max(
    assetSlotLimit,
    Math.floor(Number(options.providerImageLimit) || assetSlotLimit)
  );
  const mandatoryImageCount = Math.max(0, Math.floor(Number(options.mandatoryImageCount) || 0));
  const assetText = approvedIncluded(db, run.id, 'asset_text');
  const definitions = assetDefinitionIndex(assetText);
  const definitionsById = assetDefinitionByStableId(assetText);
  const assetImages = currentArtifacts(db, run.id, 'asset_images')
    .filter((image) => image.status === 'approved' && image.media_path)
    .sort((left, right) => Number(right.id) - Number(left.id));
  const imageByScope = new Map();
  for (const image of assetImages) {
    const key = `${image.scope_type}:${image.scope_id}`;
    if (!imageByScope.has(key)) imageByScope.set(key, image);
  }
  const references = [];
  const receiptItems = [];
  const dependencyIds = new Set();
  const selectedPaths = new Set();
  for (const request of shotAssetReferenceRequests(shot)) {
    const idCandidates = request.requested_id ? (definitionsById.get(request.requested_id) || []) : [];
    const nameCandidates = request.normalized_name ? (definitions.get(`${request.asset_type}:${request.normalized_name}`) || []) : [];
    const candidates = idCandidates.length ? idCandidates : nameCandidates;
    const labelPrefix = ASSET_TYPE_LABELS[request.asset_type] || request.asset_type;
    const sourceFieldLabel = SHOT_FIELD_LABELS[request.source_field] || request.source_field;
    const baseReceipt = {
      asset_type: request.asset_type,
      source_field: request.source_field,
      source_field_label: sourceFieldLabel,
      requested_name: request.requested_name,
      normalized_name: request.normalized_name,
      match_basis: request.requested_id && idCandidates.length ? 'stable_id' : 'normalized_name_exact',
      requested_id: request.requested_id || null,
    };
    if (!candidates.length) {
      receiptItems.push({
        ...baseReceipt,
        status: 'missing_asset_definition',
        label: `${labelPrefix} · ${request.requested_name}`,
         reason: `镜头的${sourceFieldLabel}指定了“${request.requested_id || request.requested_name}”，但没有同类型的已确认资产定义`,
      });
      continue;
    }
    if (candidates.length > 1) {
      receiptItems.push({
        ...baseReceipt,
        status: 'ambiguous_asset_definition',
        label: `${labelPrefix} · ${request.requested_name}`,
        candidate_definition_artifact_ids: candidates.map((item) => item.id),
        reason: `有 ${candidates.length} 个${labelPrefix}资产归一化后同名，系统没有擅自选择`,
      });
      continue;
    }
    const definition = candidates[0];
    const definitionName = String(definition.content?.name || request.requested_name).trim();
    const image = imageByScope.get(`${definition.scope_type}:${definition.scope_id}`);
    const definitionReceipt = {
      ...baseReceipt,
      label: `${labelPrefix} · ${definitionName}`,
      asset_name: definitionName,
      asset_scope_id: definition.scope_id,
      definition_artifact_id: definition.id,
      definition_revision: definition.revision,
    };
    if (!image) {
      receiptItems.push({
        ...definitionReceipt,
        status: 'missing_approved_image',
        reason: `已匹配${labelPrefix}资产“${definitionName}”，但还没有可用的已确认资源图`,
      });
      continue;
    }
    const imageReceipt = {
      ...definitionReceipt,
      image_artifact_id: image.id,
      image_revision: image.revision,
      image_path: image.media_path,
    };
    if (references.length >= assetSlotLimit) {
      receiptItems.push({
        ...imageReceipt,
        status: 'omitted_by_capacity',
        reason: `视频模型的参考图容量已由更高优先级素材占满，未携带${labelPrefix}“${definitionName}”`,
      });
      continue;
    }
    if (selectedPaths.has(image.media_path)) {
      const referenceIndex = references.findIndex((item) => item.path === image.media_path);
      dependencyIds.add(definition.id);
      dependencyIds.add(image.id);
      receiptItems.push({
        ...imageReceipt,
        status: 'matched',
        reference_index: referenceIndex,
        reason: `按${sourceFieldLabel}精确匹配，复用同一张已确认资源图`,
      });
      continue;
    }
    selectedPaths.add(image.media_path);
    dependencyIds.add(definition.id);
    dependencyIds.add(image.id);
    const referenceIndex = references.length;
    references.push({
      path: image.media_path,
      artifact_id: image.id,
      definition_artifact_id: definition.id,
      scope_type: image.scope_type,
      scope_id: image.scope_id,
      asset_name: definitionName,
      label: `${labelPrefix} · ${definitionName}`,
      source: 'asset',
      role: 'reference',
      match_basis: 'normalized_name_exact',
      source_field: request.source_field,
    });
    receiptItems.push({
      ...imageReceipt,
      status: 'matched',
      reference_index: referenceIndex,
      reason: `按${sourceFieldLabel}精确匹配到已确认${labelPrefix}资源图`,
    });
  }
  const statusCounts = receiptItems.reduce((result, item) => {
    result[item.status] = Number(result[item.status] || 0) + 1;
    return result;
  }, {});
  return {
    references,
    dependencyIds: [...dependencyIds].sort((left, right) => left - right),
    receipt: {
      version: AUTOLINK_RECEIPT_VERSION,
      strategy: AUTOLINK_STRATEGY,
      capacity: {
        provider_image_limit: providerImageLimit,
        mandatory_image_count: mandatoryImageCount,
        asset_slot_limit: assetSlotLimit,
        selected_asset_images: references.length,
      },
      summary: {
        requested_count: receiptItems.length,
        matched_count: Number(statusCounts.matched || 0),
        selected_image_count: references.length,
        warning_count: receiptItems.filter((item) => item.status !== 'matched').length,
        status_counts: statusCounts,
      },
      items: receiptItems,
    },
  };
}

function selectImageReferenceArtifacts(db, run, shot, limit = 4) {
  return buildImageReferenceAutoLink(db, run, shot, limit).references;
}

function selectImageReferences(db, run, shot, limit = 4) {
  return selectImageReferenceArtifacts(db, run, shot, limit).map((item) => item.path);
}

function referenceSheetPrompt(source, run) {
  const style = run.policy?.style || run.policy?.visual_style || '电影感科幻写实';
  if (source.scope_type === 'scene') {
    const location = source.content?.location ? `\n固定地点：${source.content.location}` : '';
    const state = source.content?.reference_state ? `\n唯一参考状态：${source.content.reference_state}` : '';
    const exclusions = source.content?.negative_prompt ? `\n此状态必须排除：${source.content.negative_prompt}` : '';
    return `${style}。同一地点恰好四格空间设定板：全景、主方向、反方向、关键区域各一格；门窗、地标、建筑、植被、固定陈设、材质、昼夜和空间拓扑严格一致，只改变观察方向。\n名称：${source.content.name}${location}${state}\n生成要求：${source.content.visual_prompt}\n状态约束：本设定板只表现上述唯一参考状态，不得引入其它镜头中的过去、未来、人物动作或过渡状态。${exclusions}`;
  }
  const typeLabel = source.scope_type === 'character'
    ? '同一角色恰好四格一致性设定板：正面、左侧面、背面、右侧面各一格；全身中性站姿、同尺度、干净背景，每格同脸、同发型、同体型、同服装、同固定装备'
    : '同一件关键道具恰好四格产品设定板：正面、侧面、背面、关键结构角度各一格；四格是同一件物体，形状、尺寸、材质、颜色、磨损和标识完全一致，无人物和剧情环境';
  return `${style}。${typeLabel}。\n名称：${source.content.name}\n设定：${source.content.description}\n固定视觉锚点：${JSON.stringify(source.content.identity_anchors || source.content.continuity_rules || '')}\n生成要求：${source.content.visual_prompt}`;
}

function storyboardResourceDigest(assetText, shot) {
  return resourceDigestForShot(assetText, shot).map((item) => {
    if (item.scope_type === 'scene') {
      return {
        name: item.content.name,
        type: 'scene',
        stable_location: item.content.location || '',
        stable_time: item.content.time || '',
        baseline_reference_state: item.content.reference_state || '',
        usage: '场景参考图只锚定空间几何、材质和固定方位；镜头自身的入镜状态、出镜状态、动作和完整提示决定可变状态',
      };
    }
    return {
      name: item.content.name,
      type: item.scope_type,
      source_artifact_id: item.content.source_artifact_id || null,
      authority: item.content.authority || null,
      must_preserve_identity: item.content.must_preserve_identity === true,
      description: item.content.description,
      anchors: item.content.identity_anchors || item.content.continuity_rules || '',
    };
  });
}

function buildImagePromptPackage(stage, source, run, db) {
  const aspectPrompt = productionAspectPrompt(run.policy?.aspect_ratio);
  if (stage === 'asset_images') {
    const basePrompt = referenceSheetPrompt(source, run);
    const defaultContent = `${basePrompt}\n${aspectPrompt}`;
    const resolved = promptRegistry.resolveRuntime(db, 'production.image_asset.template', {
      default_content: defaultContent,
      variables: { base_prompt: basePrompt, aspect_prompt: aspectPrompt },
    });
    return {
      prompt: resolved.content,
      receipt: {
        prompt_id: resolved.id, prompt_version: resolved.version,
        customized: resolved.customized, content_hash: resolved.content_hash,
      },
    };
  }
  const assetText = approvedIncluded(db, run.id, 'asset_text');
  const relevant = storyboardResourceDigest(assetText, source);
  const style = run.policy?.style || run.policy?.visual_style || '电影感科幻写实';
  const photography = `${source.content.shot_type}，${source.content.camera_angle}，${source.content.camera_movement}`;
  const defaultContent = `${style}，单张电影分镜参考图，禁止拼图和分栏。\n${aspectPrompt}\n镜头构图：${source.content.visual}\n动作：${source.content.action}\n摄影：${photography}\n光线：${source.content.lighting}\n入镜连续性：${source.content.continuity_in}\n出镜连续性：${source.content.continuity_out}\n时序规则：镜头自身的入镜状态、出镜状态、动作和完整提示是可变场景状态的唯一权威；一致性资产只锚定身份和不变空间，不得引入本镜头未发生的过去、未来或过渡状态。\n角色/场景/道具固定设定：${JSON.stringify(relevant)}\n完整提示：${source.content.image_prompt}`;
  const resolved = promptRegistry.resolveRuntime(db, 'production.image_storyboard.template', {
    default_content: defaultContent,
    variables: {
      style, aspect_prompt: aspectPrompt, visual: source.content.visual || '', action: source.content.action || '',
      photography, lighting: source.content.lighting || '', continuity_in: source.content.continuity_in || '',
      continuity_out: source.content.continuity_out || '', asset_digest: JSON.stringify(relevant),
      image_prompt: source.content.image_prompt || '',
    },
  });
  return {
    prompt: resolved.content,
    receipt: {
      prompt_id: resolved.id, prompt_version: resolved.version,
      customized: resolved.customized, content_hash: resolved.content_hash,
    },
  };
}

function isVerifiedDuplicateCancellation(action) {
  return action?.status === 'cancelled'
    && action.result?.duplicate_cancelled === true
    && action.result?.task_cancelled === true;
}

function createProductionMediaService(db, cfg, log, injected = {}) {
  const adapters = { ...createDefaultAdapters(db, cfg, log), ...injected };
  const resolveVideoCapability = injected.getVideoCapability || getYinziVideoCapability;

  function capabilityForRoute(route) {
    if (!route || typeof route !== 'object') return null;
    if (Object.prototype.hasOwnProperty.call(route, 'capability')) {
      if (route.capability) return route.capability;
      return injected.getVideoCapability ? (resolveVideoCapability(route.model) || null) : null;
    }
    if (Object.prototype.hasOwnProperty.call(route, 'capability_snapshot')) {
      if (route.capability_snapshot) return route.capability_snapshot;
      return injected.getVideoCapability ? (resolveVideoCapability(route.model) || null) : null;
    }
    return resolveVideoCapability(route.model) || null;
  }

  function routingReceiptForRoute(route) {
    const { capability: _capability, ...receipt } = route || {};
    return {
      ...receipt,
      capability_model: String(route?.model || ''),
      capability_snapshot: capabilityForRoute(route),
      capability_source: route?.capability_source
        || (capabilityForRoute(route) ? 'builtin' : 'unknown'),
      contract_status: route?.contract_status
        || (capabilityForRoute(route) ? 'known' : 'missing'),
      catalog_verified: route?.catalog_verified === true,
      routing_binding_signature: route?.routing_binding_signature
        || routingBindingSignature(route || {}),
    };
  }

  /**
   * Stop/observe controls used by the V0.4 task drawer.  These helpers never
   * infer a provider cancellation capability from a model name or contract;
   * callers must inject an explicit cancelProviderTask adapter.  Unknown
   * provider support therefore remains truthful and billable state is kept
   * pending/uncertain instead of being released or marked refunded.
   */
  async function cancelRunAction(runId, input = {}) {
    const requestedMode = String(input.cancel_mode || 'auto').trim().toLowerCase();
    const cancelMode = ['cancel_local_request', 'cancel_provider_task', 'auto'].includes(requestedMode)
      ? requestedMode
      : 'auto';
    const actionId = Number(input.action_id || 0);
    const action = actionId > 0 ? repo.getAction(db, actionId) : repo.getLatestAction(db, runId, {
      stage: input.stage || null,
      scope_type: input.scope_type || null,
      scope_id: input.scope_id == null ? null : input.scope_id,
      kind: input.kind || null,
    });
    if (!action || String(action.run_id) !== String(runId)) {
      return { status: 'not_found', run_id: runId, action: null };
    }
    if (action.status === 'reserved' && !action.task_id && !action.generation_id && !action.provider_id) {
      const cancelled = repo.cancelReservedAction(db, action.id, {
        cancel_mode: 'cancel_local_request',
        external_outcome: 'not_submitted',
        cancelled_reason: String(input.reason || '用户停止本地请求').slice(0, 500),
      });
      return {
        status: 'cancelled_local',
        action: cancelled,
        paid_submission: false,
        retryable: true,
        message: '请求尚未外发，已在本地取消并释放预留额度',
      };
    }
    if (action.status === 'completed' || action.status === 'failed' || action.status === 'cancelled') {
      return {
        status: action.status,
        action,
        paid_submission: Boolean(action.task_id || action.generation_id || action.provider_id),
        retryable: action.status !== 'completed',
        message: action.status === 'cancelled' ? '该请求已经取消' : '该请求已经结束，未再次发送取消操作',
      };
    }
    // A previous request may already have stopped local observation or
    // recorded a provider cancellation.  Never poll or send a second remote
    // cancellation request on a repeated click/runner tick.
    if (action.result?.local_observation_stopped === true) {
      return {
        status: 'local_observation_stopped',
        action,
        paid_submission: Boolean(action.task_id || action.generation_id || action.provider_id),
        billable_status: 'uncertain',
        retryable: true,
        message: '已停止本地等待；供应商任务和费用状态保留待查询',
      };
    }
    if (action.result?.provider_cancel_confirmed === true) {
      return {
        status: 'cancelled_provider',
        action,
        paid_submission: true,
        billable_status: 'provider_cancelled_pending_refund',
        retryable: false,
        message: '已收到供应商取消确认；费用是否退款以供应商账单回执为准',
      };
    }
    if (action.result?.cancel_requested_provider_unknown === true) {
      return {
        status: 'cancel_requested_provider_unknown',
        action,
        paid_submission: true,
        billable_status: 'uncertain',
        retryable: true,
        message: '供应商取消尚未确认；已停止本地等待，任务和费用仍可能继续',
      };
    }
    // Explicit local cancellation never discovers/polls a provider task and
    // never invokes a provider adapter.  It only detaches this process from
    // the remote task while preserving its identity and accounting state.
    if (cancelMode === 'cancel_local_request') {
      const updated = repo.markLocalObservationStopped(db, action.id, {
        cancel_reason: String(input.reason || '用户停止本地等待').slice(0, 500),
      });
      return {
        status: 'local_observation_stopped',
        action: updated,
        paid_submission: Boolean(action.task_id || action.generation_id || action.provider_id),
        billable_status: action.task_id || action.generation_id || action.provider_id ? 'uncertain' : 'not_submitted',
        retryable: true,
        message: '已停止本地等待；供应商任务和费用状态保留待查询',
      };
    }
    let providerTaskId = action.provider_id || null;
    if (!providerTaskId && action.generation_id && typeof adapters.getVideo === 'function') {
      try {
        const generation = await adapters.getVideo(action.generation_id);
        providerTaskId = generation?.provider_task_id || generation?.task_id || null;
      } catch (_) {
        // A failed status lookup must not turn an accepted action into a
        // locally released reservation; leave the external outcome unknown.
      }
    }
    const cancelAdapter = adapters.cancelProviderTask;
    // `auto` preserves the compact legacy endpoint.  The explicit provider
    // endpoint is the only path that may invoke the adapter; when no task id
    // is available we still record an unknown external outcome truthfully.
    if ((cancelMode === 'cancel_provider_task' || cancelMode === 'auto')
      && typeof cancelAdapter === 'function' && providerTaskId) {
      try {
        const result = await cancelAdapter({
          run_id: runId,
          action,
          provider_task_id: providerTaskId,
          reason: String(input.reason || '用户请求停止供应商任务').slice(0, 500),
        });
        const confirmed = result?.cancelled === true || result?.status === 'cancelled';
        const updated = repo.markProviderCancelRequested(db, action.id, {
          provider_cancel_confirmed: confirmed,
          provider_cancel_receipt: result || null,
          cancel_requested_at: new Date().toISOString(),
          cancel_reason: String(input.reason || '').slice(0, 500) || null,
        });
        return {
          status: confirmed ? 'cancelled_provider' : 'cancel_requested_provider_unknown',
          action: updated,
          paid_submission: true,
          billable_status: confirmed ? 'provider_cancelled_pending_refund' : 'uncertain',
          retryable: !confirmed,
          message: confirmed
            ? '已收到供应商取消确认；费用是否退款以供应商账单回执为准'
            : '供应商未确认取消；已停止本地等待，任务和费用仍可能继续',
        };
      } catch (error) {
        const updated = repo.markProviderCancelRequested(db, action.id, {
          cancel_requested_at: new Date().toISOString(),
          cancel_reason: String(input.reason || '').slice(0, 500) || null,
          provider_cancel_error: String(error?.message || error).slice(0, 800),
          cancel_requested_provider_unknown: true,
        });
        return {
          status: 'cancel_requested_provider_unknown',
          action: updated,
          paid_submission: true,
          billable_status: 'uncertain',
          retryable: true,
          message: '取消请求未获供应商确认；已停止本地等待，任务和费用仍可能继续',
        };
      }
    }
    const updated = repo.markProviderCancelRequested(db, action.id, {
      cancel_requested_at: new Date().toISOString(),
      cancel_reason: String(input.reason || '').slice(0, 500) || null,
      cancel_requested_provider_unknown: true,
    });
    return {
      status: 'cancel_requested_provider_unknown',
      action: updated,
      paid_submission: true,
      billable_status: 'uncertain',
      retryable: true,
      message: '当前供应商未声明可取消接口；已停止本地等待，任务和费用仍可能继续',
    };
  }

  async function resolveShotVideoRoute(run, shot, options = {}) {
    const catalogRun = routingCatalogRun(db, run, shot);
    let routePolicy = catalogRun.policy || {};
    const routeHint = options?.approvedRouteHint && typeof options.approvedRouteHint === 'object'
      ? options.approvedRouteHint
      : null;
    const hintedModel = String(routeHint?.model || '').trim();
    const explicitlyConfiguredModel = configuredVideoModelForShot(run, shot);
    // Once a user has approved a bundle, an automatic route is a snapshot for
    // that bundle rather than a fresh price-based lottery on every poll.  We
    // still fetch the live credential-scoped catalog: if the model disappeared
    // or an explicit model/shot override differs, normal routing runs and the
    // binding comparison correctly asks for a new approval.
    if (hintedModel
      && (!explicitlyConfiguredModel
        || explicitlyConfiguredModel.toLowerCase() === hintedModel.toLowerCase())) {
      const hintedCatalog = catalogWithStoredVideoPrices(
        db,
        await adapters.fetchVideoCatalog(catalogRun),
        catalogRun,
      );
      const hintedPresent = (Array.isArray(hintedCatalog?.video) ? hintedCatalog.video : [])
        .some((item) => String(item?.model || '').trim().toLowerCase() === hintedModel.toLowerCase());
      if (hintedPresent) {
        routePolicy = {
          ...routePolicy,
          video_routing_mode: 'fixed',
          video_model: hintedModel,
        };
        const route = selectShotVideoRoute({ shot, catalog: hintedCatalog, policy: routePolicy });
        const decorated = decorateVideoRouteWithConfig(route, videoConfigForRun(db, catalogRun, shot));
        decorated.route_selection_source = 'approved_bundle_snapshot';
        return decorated;
      }
      // Do not preserve a route that the live directory no longer exposes.
      // Fall through to automatic selection so the changed model is visible as
      // a binding change instead of being silently submitted.
    }
    const catalog = catalogWithStoredVideoPrices(db, await adapters.fetchVideoCatalog(catalogRun), catalogRun);
    const route = selectShotVideoRoute({ shot, catalog, policy: routePolicy });
    return decorateVideoRouteWithConfig(route, videoConfigForRun(db, catalogRun, shot));
  }

  async function listVideoRoutingOptions(run, shot) {
    const catalogRun = routingCatalogRun(db, run, shot);
    const catalog = catalogWithStoredVideoPrices(db, await adapters.fetchVideoCatalog(catalogRun), catalogRun);
    return {
      pricing_version: String(catalog?.pricing_version || ''),
      fetched_at: catalog?.fetched_at || null,
      source: catalog?.source || null,
      discovery_outcome: catalog?.discovery_outcome || 'live',
      stale_snapshot: catalog?.stale_snapshot === true,
      warnings: Array.isArray(catalog?.warnings) ? catalog.warnings : [],
      group: String(catalogRun?.policy?.video_group || ''),
      options: listShotVideoRouteOptions({ shot, catalog, policy: catalogRun?.policy || {} }),
    };
  }

  async function ensureVideoPromptPlan(run, shot, attempt, evidence) {
    const basePrompt = String(shot.content?.video_prompt || '').trim();
    if (!evidence.length) return { state: 'ready', plan: { provider_prompt: basePrompt }, action: null };
    if (typeof adapters.generateText !== 'function') throw new Error('Video retry planning requires a configured text model');
    const latestPlan = repo.getLatestAction(db, run.id, {
      stage: 'shot_video', scope_type: 'shot', scope_id: shot.scope_id, kind: 'video_prompt_plan',
    });
    if (latestPlan?.status === 'completed'
      && Number(latestPlan.result?.source_artifact_id) === Number(shot.id)
      && JSON.stringify(latestPlan.result?.evidence || []) === JSON.stringify(evidence)) {
      return { state: 'ready', plan: latestPlan.result, action: latestPlan, reused: true };
    }
    const rawPrompts = textStages.videoRetryPlannerPrompts(shot.content, evidence);
    const resolvedPrompt = promptRuntime.resolvePair(db, 'production.video_retry.system', rawPrompts);
    let prompts = resolvedPrompt.prompts;
    let promptReceipt = resolvedPrompt.receipt;
    let action = null;
    const latestMatches = latestPlan
      && Number(latestPlan.request?.source_artifact_id) === Number(shot.id)
      && Number(latestPlan.request?.source_revision) === Number(shot.revision)
      && JSON.stringify(latestPlan.request?.evidence || []) === JSON.stringify(evidence);
    if (latestMatches && latestPlan.status === 'reserved') {
      action = latestPlan;
      const frozen = latestPlan.request?.prompt_snapshot;
      if (frozen?.system != null && frozen?.user != null) {
        prompts = { system: String(frozen.system), user: String(frozen.user) };
        promptReceipt = frozen;
      }
    } else if (latestMatches && ['submitted', 'waiting'].includes(latestPlan.status)) {
      return { state: 'waiting_review', reason: 'video_prompt_plan_in_progress', action: latestPlan };
    } else if (latestMatches && ['failed', 'ambiguous'].includes(latestPlan.status)) {
      return { state: 'waiting_review', reason: 'video_prompt_plan_failed', action: latestPlan };
    } else if (latestMatches && latestPlan.status === 'cancelled' && !latestPlan.result?.retry_authorized) {
      return { state: 'waiting_review', reason: 'video_prompt_plan_failed', action: latestPlan };
    }
    if (!action) {
      const plannerAttempt = repo.nextActionAttempt(
        db, run.id, 'shot_video', 'shot', shot.scope_id, 'video_prompt_plan'
      );
      const key = `shot_video_prompt_plan:shot:${shot.scope_id}:source-r${shot.revision}:video-a${attempt}:plan-a${plannerAttempt}`;
      const priorFailures = repo.listActions(db, run.id, { page_size: 200 }).items
        .filter((item) => item.kind === 'video_prompt_plan'
          && item.scope_type === 'shot'
          && item.scope_id === String(shot.scope_id)
          && ['failed', 'ambiguous', 'cancelled'].includes(item.status))
        .reverse()
        .map((item) => ({
          action_id: item.id,
          error_code: item.error_code || 'VIDEO_PROMPT_PLAN_FAILED',
          error_message: item.error_message || 'Retry planner failed without an error message',
          failed_at: item.updated_at,
          retry_reason: item.result?.retry_reason || null,
        }));
      const cost = accounting.textReservation(db, run, {
        ...prompts, scene_key: 'production_video_retry_planner', max_tokens: 5000,
      });
      const request = {
        source_artifact_id: shot.id,
        source_revision: shot.revision,
        intended_video_attempt: attempt,
        base_prompt: basePrompt,
        evidence,
        prior_failures: priorFailures,
        retry_of_action_id: latestMatches && latestPlan?.result?.retry_authorized ? latestPlan.id : null,
        prompt_snapshot: resolvedPrompt.receipt,
        model: cost.model || null,
        provider: cost.provider || null,
      };
      action = repo.reserveAction(db, {
        run_id: run.id,
        action_key: key,
        stage: 'shot_video',
        scope_type: 'shot',
        scope_id: shot.scope_id,
        kind: 'video_prompt_plan',
        attempt: plannerAttempt,
        request,
        cost,
      }).action;
    }
    if (['submitted', 'waiting'].includes(action.status)) {
      return { state: 'waiting_review', reason: 'video_prompt_plan_in_progress', action };
    }
    if (['failed', 'ambiguous', 'cancelled'].includes(action.status)) {
      return { state: 'waiting_review', reason: 'video_prompt_plan_failed', action };
    }
    action = repo.updateAction(db, action.id, { status: 'submitted' });
    try {
      const raw = await adapters.generateText(prompts.user, prompts.system, {
        temperature: 0.25,
        max_tokens: 5000,
        silence_timeout_ms: 120000,
        scene_key: 'production_video_retry_planner',
      });
      const plan = textStages.normalizeVideoRetryPlan(raw, log);
      action = repo.updateAction(db, action.id, {
        status: 'completed',
        result: {
          ...plan,
          source_artifact_id: shot.id,
          source_revision: shot.revision,
          evidence,
          prior_failures: action.request?.prior_failures || [],
          prompt_receipt: promptReceipt,
        },
        cost: accounting.textSettlement(db, action.id, { ...prompts, output: raw }),
      });
      return { state: 'planned', plan: action.result, action, reused: false };
    } catch (error) {
      action = repo.updateAction(db, action.id, {
        status: 'failed',
        error_code: error.code || 'VIDEO_PROMPT_PLAN_FAILED',
        error_message: error.message,
      });
      repo.updateRun(db, run.id, {
        status: 'waiting_review',
        waiting_reason: 'video_prompt_plan_failed',
        error_code: 'VIDEO_PROMPT_PLAN_FAILED',
        error_message: error.message,
      });
      return { state: 'waiting_review', reason: 'video_prompt_plan_failed', action };
    }
  }

  function imageConcurrencyFor(run, stage) {
    if (stage !== 'asset_images') return 1;
    const configured = Number(run.policy?.image_concurrency);
    if (!Number.isFinite(configured)) return 4;
    return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(configured)));
  }

  function imageResult(state, details = {}) {
    const response = {
      state,
      actions: details.actions || [],
      artifacts: details.artifacts || [],
      failures: details.failures || [],
      blockers: details.blockers || [],
      ...details,
    };
    if (!response.action && response.actions[0]) response.action = response.actions[0];
    if (!response.artifact && response.artifacts[0]) response.artifact = response.artifacts[0];
    return response;
  }

  function buildImageRequest(run, stage, source, target) {
    const retryEvidence = rejectedImageEvidence(db, run, stage, source);
    const rejectedReferenceOptedIn = rejectedImageReferenceOptedIn(run, source);
    const revisionReference = rejectedReferenceOptedIn && target?.status === 'rejected' && target.media_path
      ? [{ path: target.media_path, artifact_id: target.id, scope_type: target.scope_type, scope_id: target.scope_id }]
      : [];
    const uploadedSubjectReference = stage === 'asset_images' && needsUploadedSubjectReferenceSheet(run, source, target)
      ? uploadedAuthorityReference(db, run, source, target)
      : null;
    const fallbackAutoLink = stage === 'storyboard_images'
      ? buildImageReferenceAutoLink(db, run, source, Math.max(0, 4 - revisionReference.length), {
        providerImageLimit: 4,
        mandatoryImageCount: revisionReference.length,
      })
      : { references: [], receipt: null };
    const fallbackReferenceArtifacts = fallbackAutoLink.references;
    if (stage === 'storyboard_images'
      && target?.status === 'rejected'
      && target.media_path
      && !rejectedReferenceOptedIn
      && fallbackReferenceArtifacts.length === 0) {
      const error = codedError(
        'IMAGE_RETRY_REFERENCE_AUTHORITIES_MISSING',
        'Storyboard retry has no approved image authority after excluding the rejected frame'
      );
      error.retryEvidence = retryEvidence;
      throw error;
    }
    const referenceArtifacts = mergeImageReferenceArtifacts(
      [...(uploadedSubjectReference ? [uploadedSubjectReference] : []), ...revisionReference],
      fallbackReferenceArtifacts,
      4,
    );
    const promptPackage = buildImagePromptPackage(stage, source, run, db);
    const subjectReferenceInstruction = uploadedSubjectReference
      ? `\n\n主体参考图约束（最高优先级）：参考图 1 是用户上传的唯一主体身份权威（artifact ${uploadedSubjectReference.artifact_id}）。必须基于这张图生成同一主体的恰好四视图设定板；保持脸、发型、体型、服装、颜色、配饰和其它可见身份锚点一致，只补充观察角度。不得另造、替换、重绘成无关角色，也不得在没有该参考图的情况下生成。`
      : '';
    const prompt = appendImageRevisionFeedback(
      `${promptPackage.prompt}${subjectReferenceInstruction}`,
      retryEvidence,
      revisionReference.length > 0,
    );
    const references = referenceArtifacts.map((item) => item.path);
    const assetLayoutExclusions = source.scope_type === 'character'
      ? 'single narrative scene, action pose, interaction, second character, different faces, different outfits, cropped head, cropped feet, missing view, duplicate view, three panels, five panels'
      : source.scope_type === 'scene'
        ? 'four different places, changing architecture, changing landmarks, changing vegetation, changing time of day, character action, battle scene, missing view, duplicate view, three panels, five panels'
        : 'person holding the object, character, battle, blood, narrative environment, four different objects, changing geometry, missing view, duplicate view, three panels, five panels';
    const negativePrompt = stage === 'asset_images'
      ? [source.content?.negative_prompt, assetLayoutExclusions, 'text', 'watermark', 'labels', 'inconsistent identity', 'inconsistent geometry'].filter(Boolean).join(', ')
      : [source.content?.negative_prompt, 'split panels', 'collage', 'text watermark', 'inconsistent identity'].filter(Boolean).join(', ');
    const configuredModel = stage === 'storyboard_images'
      ? (run.policy?.storyboard_image_model || run.policy?.image_model)
      : (run.policy?.asset_image_model || run.policy?.image_model)
    const imageServiceType = stage === 'storyboard_images' ? 'storyboard_image' : 'image';
    const imageConfigId = stage === 'storyboard_images'
      ? run.policy?.storyboard_image_config_id
      : run.policy?.asset_image_config_id;
    const imageConfigState = imageRequestIdentity(db, run, stage, configuredModel || '');
    const effectiveImageModel = configuredModel || imageConfigState.model || undefined;
    const effectiveImageConfigId = imageConfigState.identity?.id
      || (imageConfigId == null ? undefined : Number(imageConfigId));
    return {
      request: {
        drama_id: run.drama_id,
        provider: 'openai',
        model: effectiveImageModel,
        image_service_type: imageServiceType,
        image_config_id: effectiveImageConfigId,
        image_config_identity_version: imageConfigState.identity?.version || null,
        image_config_updated_at: imageConfigState.identity?.updated_at || null,
        image_config_fingerprint: imageConfigState.identity?.fingerprint || null,
        prompt,
        prompt_snapshot: {
          ...promptPackage.receipt,
          final_content_hash: repo.hashJson(prompt),
          final_content: prompt,
        },
        negative_prompt: negativePrompt,
        aspect_ratio: normalizeProductionAspectRatio(run.policy?.aspect_ratio),
        frame_type: stage === 'asset_images' ? `${source.scope_type}_reference_sheet` : 'production_storyboard',
        reference_images: references,
        reference_artifact_ids: referenceArtifacts.map((item) => item.artifact_id),
        reference_roles: referenceArtifacts.map((item) => item.role || 'reference'),
        reference_sources: referenceArtifacts.map((item) => item.source || 'unknown'),
        reference_hashes: referenceArtifacts.map((item) => item.content_hash || null),
        reference_transport_types: referenceArtifacts.map((item) => (
          String(item.path || '').startsWith('data:') ? 'data_url' : 'storage_path'
        )),
        reference_provenance: referenceArtifacts.map((item) => ({
          artifact_id: item.artifact_id || null,
          path: item.path || null,
          role: item.role || 'reference',
          source: item.source || 'unknown',
          content_hash: item.content_hash || null,
        })),
        reference_autolink_receipt: fallbackAutoLink.receipt,
        source_artifact_id: source.id,
        source_revision: source.revision,
        revision_reference_artifact_id: revisionReference[0]?.artifact_id || null,
        rejected_reference_artifact_id: target?.status === 'rejected' && target.media_path ? target.id : null,
        rejected_reference_excluded: Boolean(target?.status === 'rejected' && target.media_path && !rejectedReferenceOptedIn),
        rejected_review_evidence: retryEvidence,
        revision_brief_hash: retryEvidence.length ? repo.hashJson(retryEvidence) : null,
      },
      retryEvidence,
    };
  }

  async function reconcileImageAction(run, stage, source, target) {
    const rejectedTarget = target && ['rejected', 'failed', 'invalidated'].includes(target.status);
    let action = repo.getLatestAction(db, run.id, {
      stage, scope_type: source.scope_type, scope_id: source.scope_id, kind: 'image_generate',
    });
    // A failed/cancelled image action is retryable automatically when the
    // user changed the live image model or configuration.  Keep the old
    // action as history, but never let its request snapshot block a fresh
    // request using the newly selected channel.
    if (imageActionConfigurationChanged(db, run, stage, action)) {
      const previous = action;
      action = repo.updateAction(db, action.id, {
        status: 'cancelled',
        result: {
          ...(action.result || {}),
          superseded_by_config_change: true,
          retry_authorized: true,
          previous_model: previous.request?.model || null,
          previous_image_config_id: previous.request?.image_config_id || null,
          superseded_at: new Date().toISOString(),
        },
      });
    }
    if (action?.status === 'cancelled'
      && (action.result?.retry_authorized || (rejectedTarget && isVerifiedDuplicateCancellation(action)))) action = null;
    const selection = selectGenerationAction(action, source, rejectedTarget, {
      cancelReserved(staleAction) {
        return repo.updateAction(db, staleAction.id, {
          status: 'cancelled',
          result: {
            ...(staleAction.result || {}),
            source_artifact_id: staleAction.request?.source_artifact_id || null,
            superseded_by_source_change: true,
            superseded_by_artifact_id: source.id,
            superseded_before_submission: true,
          },
        });
      },
    });
    if (selection.blocked) {
      const reason = selection.blocked === 'ambiguous_external_create'
        ? 'ambiguous_image_create'
        : selection.blocked;
      const blockedAction = selection.blocked === 'ambiguous_external_create'
        ? repo.updateAction(db, selection.action.id, {
          status: 'ambiguous', error_code: 'IMAGE_CREATE_AMBIGUOUS',
          error_message: '旧图片创建请求已经外发但没有任务 ID，无法确认是否扣费，禁止自动重提',
          result: {
            ...(selection.action.result || {}),
            superseded_by_source_change: true,
            superseded_by_artifact_id: source.id,
          },
        })
        : selection.action;
      return { kind: 'blocked', reason, action: blockedAction, source, target };
    }
    action = selection.action;
    const actionSourceChanged = selection.sourceChanged === true;
    if (!action) {
      const attempt = repo.nextActionAttempt(db, run.id, stage, source.scope_type, source.scope_id, 'image_generate');
      const sourceAttempt = sourceGenerationAttemptCount(db, run.id, stage, source, 'image_generate') + 1;
      if (sourceAttempt > Number(run.budget?.max_image_revisions || 2) + 1) {
        return { kind: 'blocked', reason: 'image_revision_limit', source, target };
      }
      let built;
      try { built = buildImageRequest(run, stage, source, target); }
      catch (error) { return { kind: 'blocked', reason: error.code || 'image_request_invalid', error, source, target }; }
      return {
        kind: 'candidate', source, target, attempt, sourceAttempt,
        actionKey: actionKey(stage, source, attempt), request: built.request,
      };
    }
    if (action.status === 'ambiguous') return { kind: 'blocked', reason: 'ambiguous_image_create', action, source, target };
    if (action.status === 'submitted' && !action.generation_id) {
      action = repo.updateAction(db, action.id, {
        status: 'ambiguous', error_code: 'IMAGE_CREATE_AMBIGUOUS',
        error_message: '图片创建结果未持久化，禁止自动重提',
      });
      return { kind: 'blocked', reason: 'ambiguous_image_create', action, source, target };
    }
    if (action.status === 'reserved' && !action.generation_id) {
      return { kind: 'submit', source, target, action, request: action.request };
    }
    if (['submitted', 'waiting'].includes(action.status)) {
      let generation;
      try { generation = action.generation_id ? await adapters.getImage(action.generation_id) : null; }
      catch (error) { return { kind: 'active', action, source, target, pollError: error }; }
      if (!generation || ['pending', 'processing'].includes(generation.status)) {
        return { kind: 'active', action, generation, source, target, superseded: actionSourceChanged };
      }
      if (actionSourceChanged) {
        const providerCompleted = generation.status === 'completed';
        repo.updateAction(db, action.id, {
          status: providerCompleted ? 'completed' : 'failed',
          error_code: providerCompleted ? null : 'SUPERSEDED_IMAGE_GENERATION_FAILED',
          error_message: providerCompleted ? null : (generation.error_msg || '旧图片任务失败，结果仅保留为历史'),
          result: {
            ...(action.result || {}),
            source_artifact_id: action.result?.source_artifact_id ?? action.request?.source_artifact_id ?? null,
            generation_id: generation.id || action.generation_id || null,
            generation_status: generation.status,
            superseded_by_source_change: true,
            superseded_by_artifact_id: source.id,
          },
        });
        return reconcileImageAction(repo.getRun(db, run.id), stage, source, target);
      }
      if (generation.status !== 'completed') {
        const errorMessage = generation.error_msg || '图片生成失败';
        if (isAmbiguousImageGenerationFailure(generation)) {
          action = repo.updateAction(db, action.id, {
            status: 'ambiguous', error_code: 'IMAGE_GENERATION_AMBIGUOUS', error_message: errorMessage,
            result: { ...(action.result || {}), ambiguous_reason: 'provider_transport_lost', generation_id: generation.id || action.generation_id || null },
          });
          return { kind: 'blocked', reason: 'image_generation_ambiguous', action, generation, source, target };
        }
        action = repo.updateAction(db, action.id, {
          status: 'failed', error_code: 'IMAGE_GENERATION_FAILED', error_message: errorMessage,
        });
        return { kind: 'failed', reason: 'image_generation_failed', action, generation, source, target };
      }
      const existing = repo.listArtifacts(db, run.id, { stage, scope_type: source.scope_type, scope_id: source.scope_id, page_size: 20 }).items
        .find((item) => Number(item.source_action_id) === Number(action.id) && item.media_path);
      if (existing) {
        action = repo.updateAction(db, action.id, { status: 'completed', result: { ...(action.result || {}), artifact_id: existing.id } });
        return { kind: 'artifact', action, artifact: existing, source, target };
      }
      try {
        const receipt = await adapters.validateImage(generation.local_path || generation.image_url, {
          min_width: 256,
          min_height: 256,
          expected_aspect_ratio: normalizeProductionAspectRatio(run.policy?.aspect_ratio),
        });
        const artifact = repo.createArtifact(db, {
          run_id: run.id, stage, scope_type: source.scope_type, scope_id: source.scope_id, title: source.title,
          content: {
            source_artifact_id: source.id, source_revision: source.revision,
            prompt: generation.prompt || action.request?.prompt,
            aspect_ratio: normalizeProductionAspectRatio(run.policy?.aspect_ratio),
            request_snapshot: {
              aspect_ratio: action.request?.aspect_ratio,
              frame_type: action.request?.frame_type,
              model: action.request?.model || generation.model || null,
              reference_artifact_ids: Array.isArray(action.request?.reference_artifact_ids)
                ? action.request.reference_artifact_ids
                : [],
              reference_roles: Array.isArray(action.request?.reference_roles)
                ? action.request.reference_roles
                : [],
              reference_sources: Array.isArray(action.request?.reference_sources)
                ? action.request.reference_sources
                : [],
              reference_hashes: Array.isArray(action.request?.reference_hashes)
                ? action.request.reference_hashes
                : [],
              reference_transport_types: Array.isArray(action.request?.reference_transport_types)
                ? action.request.reference_transport_types
                : [],
              reference_provenance: Array.isArray(action.request?.reference_provenance)
                ? action.request.reference_provenance
                : [],
            },
            included: true,
            validation: receipt,
          },
          status: 'draft', media_path: receipt.relative_path, mime_type: `image/${receipt.format || 'png'}`,
          content_hash: receipt.sha256, source_action_id: action.id, source_task_id: generation.task_id,
          source_generation_id: generation.id,
          depends_on: [...new Set([source.id, ...(Array.isArray(action.request?.reference_artifact_ids) ? action.request.reference_artifact_ids : [])]
            .map(Number).filter(Number.isInteger))],
        });
        action = repo.updateAction(db, action.id, { status: 'completed', result: { ...(action.result || {}), artifact_id: artifact.id, receipt } });
        return { kind: 'artifact', action, artifact, source, target };
      } catch (error) {
        action = repo.updateAction(db, action.id, { status: 'failed', error_code: error.code || 'IMAGE_VALIDATION_FAILED', error_message: error.message });
        return { kind: 'failed', reason: 'image_validation_failed', action, source, target, error };
      }
    }
    if (action.status === 'completed') {
      const existing = repo.getArtifact(db, action.result?.artifact_id);
      if (existing?.media_path) return { kind: 'artifact', action, artifact: existing, source, target };
      return { kind: 'blocked', reason: 'completed_image_missing_artifact', action, source, target };
    }
    if (['failed', 'cancelled'].includes(action.status)) {
      return { kind: 'blocked', reason: action.status, action, source, target };
    }
    return { kind: 'blocked', reason: 'image_action_unknown_state', action, source, target };
  }

  async function ensureImageStage(run, stage) {
    const sourceStage = stage === 'asset_images' ? 'asset_text' : 'storyboard_plan';
    const allSources = approvedIncluded(db, run.id, sourceStage);
    const sources = stage === 'storyboard_images' ? scopeShotItems(allSources, run) : allSources;
    if (!sources.length) throw new Error(`阶段 ${sourceStage} 没有已确认内容`);
    const targets = currentArtifacts(db, run.id, stage);
    const records = [];
    for (const source of sources) {
      const target = targets.find((item) => item.scope_type === source.scope_type && item.scope_id === source.scope_id);
      // An imported authority image already is the output of this stage. It
      // has no generation action/source_artifact_id because the uploaded file
      // is the source itself; treat it as a reusable approved result and do
      // not create an unrelated four-view replacement.
      if (stage === 'asset_images'
        && isReusableImportedAuthorityArtifact(target)
        && !needsUploadedSubjectReferenceSheet(run, source, target)) continue;
      if (artifactMatchesSource(target, source)) continue;
      records.push(await reconcileImageAction(run, stage, source, target));
    }

    const submissions = records.filter((item) => item.kind === 'candidate' || item.kind === 'submit');
    const reserved = [];
    const concurrency = imageConcurrencyFor(run, stage);
    const activeBeforeSubmit = records.filter((item) => item.kind === 'active').length;
    const available = Math.max(0, concurrency - activeBeforeSubmit);
    for (const candidate of submissions.slice(0, available)) {
      let action = candidate.action;
      if (!action) {
        action = repo.reserveAction(db, {
          run_id: run.id, action_key: candidate.actionKey, stage,
          scope_type: candidate.source.scope_type, scope_id: candidate.source.scope_id,
          kind: 'image_generate', attempt: candidate.attempt, request: candidate.request,
          cost: accounting.imageReservation(db, run, candidate.request),
        }).action;
      }
      if (action.status === 'reserved') {
        action = repo.updateAction(db, action.id, { status: 'submitted' });
        reserved.push({ ...candidate, action });
      } else if (action.status === 'waiting') {
        records.push({ kind: 'active', action, source: candidate.source, target: candidate.target });
      } else if (action.status === 'submitted' && !action.generation_id) {
        records.push({ kind: 'blocked', reason: 'ambiguous_image_create', action, source: candidate.source, target: candidate.target });
      }
    }
    const submissionResults = await Promise.allSettled(reserved.map(async (item) => {
      try {
        const created = await adapters.createImage(item.request);
        if (!created?.id) throw codedError('IMAGE_CREATE_AMBIGUOUS', '图片创建没有返回可追踪的 generation id');
        const action = repo.updateAction(db, item.action.id, {
          status: 'waiting', task_id: created.task_id, generation_id: created.id,
          result: { source_artifact_id: item.source.id },
        });
        return { kind: 'active', action, source: item.source, target: item.target };
      } catch (error) {
        const action = repo.updateAction(db, item.action.id, {
          status: error.code === 'IMAGE_CREATE_AMBIGUOUS' ? 'ambiguous' : 'failed',
          error_code: error.code || 'IMAGE_CREATE_FAILED', error_message: error.message,
          ...(error.code === 'IMAGE_CREATE_AMBIGUOUS' ? {} : { cost_status: 'released' }),
        });
        return { kind: 'failed', reason: action.status === 'ambiguous' ? 'ambiguous_image_create' : 'image_create_failed', action, source: item.source, target: item.target, error };
      }
    }));
    for (const result of submissionResults) {
      if (result.status === 'fulfilled') records.push(result.value);
      else records.push({ kind: 'failed', reason: 'image_create_failed', error: result.reason });
    }

    const active = records.filter((item) => item.kind === 'active' && item.action?.status === 'waiting');
    const artifacts = records.filter((item) => item.kind === 'artifact' && item.artifact).map((item) => item.artifact);
    const failures = records.filter((item) => ['failed', 'blocked'].includes(item.kind));
    const blockers = failures.filter((item) => item.kind === 'blocked');
    const latestTargets = currentArtifacts(db, run.id, stage);
    const unresolved = sources.filter((source) => {
      const target = latestTargets.find((item) => item.scope_type === source.scope_type && item.scope_id === source.scope_id);
      return !artifactMatchesSource(target, source)
        && !(stage === 'asset_images'
          && isReusableImportedAuthorityArtifact(target)
          && !needsUploadedSubjectReferenceSheet(run, source, target));
    });
    if (active.length) {
      repo.updateRun(db, run.id, { status: 'waiting_provider', waiting_reason: 'image_generation' });
      return imageResult('waiting_task', {
        actions: active.map((item) => item.action), artifacts, failures, blockers,
        source: unresolved[0] || sources[0],
      });
    }
    if (blockers.length || failures.length || unresolved.length) {
      const first = failures[0];
      repo.updateRun(db, run.id, {
        status: 'waiting_review', waiting_reason: first?.reason || 'image_generation_failed',
        error_code: first?.action?.error_code || null, error_message: first?.action?.error_message || first?.error?.message || null,
      });
      return imageResult('waiting_review', {
        reason: first?.reason || 'image_generation_failed', actions: records.map((item) => item.action).filter(Boolean),
        artifacts, failures, blockers, source: first?.source || unresolved[0] || sources[0],
      });
    }
    if (artifacts.length) {
      repo.updateRun(db, run.id, { status: 'running', waiting_reason: null, error_code: null, error_message: null });
      return imageResult('progressed', { actions: records.map((item) => item.action).filter(Boolean), artifacts });
    }
    repo.updateRun(db, run.id, { status: 'running', waiting_reason: null, error_code: null, error_message: null });
    return imageResult('stage_ready', { actions: records.map((item) => item.action).filter(Boolean), artifacts: latestTargets });
  }

  async function ensureContinuityFrame(run, shot, previousVideo) {
    if (!previousVideo?.media_path) {
      throw codedError(
        'PREDECESSOR_VIDEO_REQUIRED',
        `镜头 ${shot.scope_id} 要求携带上一镜尾帧，但上一镜头没有已确认的本地视频`
      );
    }
    const existing = currentArtifacts(db, run.id, 'continuity_frame')
      .find((item) => item.scope_id === shot.scope_id);
    if (existing?.status === 'approved'
      && Number(existing.content?.source_artifact_id) === Number(previousVideo.id)
      && Number(existing.content?.target_shot_artifact_id) === Number(shot.id)
      && existing.media_path) {
      try {
        await adapters.validateContinuityFrame(existing.media_path, {
          expected_aspect_ratio: normalizeProductionAspectRatio(run.policy?.aspect_ratio),
        });
        return existing;
      } catch (error) {
        log.warn?.('Cached predecessor tail frame is unavailable and will be rebuilt', {
          run_id: run.id, shot: shot.scope_id, artifact_id: existing.id, error: error.message,
        });
      }
    }
    const receipt = await adapters.extractContinuityFrame(previousVideo.media_path, {
      run_id: run.id,
      shot_scope_id: shot.scope_id,
      source_artifact_id: previousVideo.id,
      source_hash: previousVideo.content_hash,
    });
    const draft = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'continuity_frame',
      scope_type: 'shot',
      scope_id: shot.scope_id,
      title: `${shot.title} predecessor tail frame`,
      content: {
        source_artifact_id: previousVideo.id,
        target_shot_artifact_id: shot.id,
        source_video_hash: previousVideo.content_hash || null,
        role: 'predecessor_tail_frame',
        validation: receipt,
        included: true,
      },
      status: 'draft',
      media_path: receipt.relative_path,
      mime_type: 'image/png',
      content_hash: receipt.sha256,
      depends_on: [previousVideo.id, shot.id],
    });
    return repo.reviewArtifact(db, draft.id, {
      reviewer_type: 'deterministic',
      decision: 'approved',
      reason: 'Extracted the exact final decoded frame from the approved predecessor video for explicit boundary use',
    }).artifact;
  }

  function artifactVideoDuration(artifact) {
    const candidates = [
      artifact?.content?.validation?.duration,
      artifact?.content?.expected_duration,
      artifact?.content?.document?.timeline?.duration,
    ];
    for (const candidate of candidates) {
      const duration = Number(candidate);
      if (Number.isFinite(duration) && duration > 0.2) return duration;
    }
    return null;
  }

  async function applyReferenceVideoBudget(run, capability, videoRefs) {
    const planned = planReferenceVideoBudget(videoRefs, {
      max_total_seconds: capability?.max_reference_video_seconds_total,
      safety_margin_seconds: capability?.reference_video_safety_margin_seconds,
    });
    if (!planned.receipt?.enforced) return planned;

    async function prepareItem(item, transport = item.transport) {
      const windowed = transport?.mode === 'tail_excerpt';
      const prepared = await adapters.prepareReferenceVideoTransport(item.original_path || item.path, {
        start_seconds: windowed ? transport.start_seconds : undefined,
        duration_seconds: windowed ? transport.duration_seconds : undefined,
        aspect_ratio: run.policy?.aspect_ratio || '16:9',
      });
      return {
        ...item,
        original_path: item.original_path || item.path,
        path: prepared.relative_path,
        transport: {
          ...transport,
          prepared_duration_seconds: Number(Number(prepared.duration).toFixed(3)),
          width: prepared.width,
          height: prepared.height,
          video_codec: prepared.video_codec,
          pixel_format: prepared.pixel_format,
          r_frame_rate: prepared.r_frame_rate,
          avg_frame_rate: prepared.avg_frame_rate,
          cache_reused: prepared.cache_reused === true,
        },
      };
    }

    const videos = [];
    for (const item of planned.videos) videos.push(await prepareItem(item));
    const totalPreparedSeconds = () => videos.reduce((sum, item) => (
      sum + Number(item.transport?.prepared_duration_seconds ?? item.transport?.duration_seconds ?? 0)
    ), 0);
    let actualTotal = totalPreparedSeconds();
    const safeTarget = Number(planned.receipt.target_total_seconds);
    let frameRoundingCorrection = 0;
    if (Number.isFinite(safeTarget) && actualTotal > safeTarget + 0.001) {
      const continuityIndex = videos.findIndex((item) => item.source === 'continuity_in');
      const continuity = continuityIndex >= 0 ? videos[continuityIndex] : null;
      const requestedDuration = Number(continuity?.transport?.duration_seconds);
      const sourceDuration = Number(continuity?.source_duration_seconds);
      const requiredReduction = actualTotal - safeTarget + (1 / 24);
      if (!continuity
        || !Number.isFinite(requestedDuration)
        || !Number.isFinite(sourceDuration)
        || requestedDuration - requiredReduction < MIN_CONTINUITY_TAIL_SECONDS) {
        throw codedError(
          'REFERENCE_VIDEO_SAFE_TARGET_EXCEEDED',
          `Final reference videos total ${actualTotal.toFixed(3)} seconds and the continuity tail cannot absorb the safe-target correction`
        );
      }
      const correctedDuration = Number((requestedDuration - requiredReduction).toFixed(3));
      const correctedTransport = {
        ...continuity.transport,
        mode: 'tail_excerpt',
        start_seconds: Number((sourceDuration - correctedDuration).toFixed(3)),
        duration_seconds: correctedDuration,
      };
      videos[continuityIndex] = await prepareItem(planned.videos[continuityIndex], correctedTransport);
      frameRoundingCorrection = Number(requiredReduction.toFixed(3));
      actualTotal = totalPreparedSeconds();
    }
    if (Number.isFinite(safeTarget) && actualTotal > safeTarget + 0.001) {
      throw codedError(
        'REFERENCE_VIDEO_SAFE_TARGET_EXCEEDED',
        `Final reference videos total ${actualTotal.toFixed(3)} seconds, above the ${safeTarget.toFixed(3)}-second safe target`
      );
    }
    if (actualTotal > Number(planned.receipt.max_total_seconds) + 0.001) {
      throw codedError(
        'REFERENCE_VIDEO_DURATION_BUDGET_EXCEEDED',
        `Prepared reference videos total ${actualTotal.toFixed(3)} seconds, above the ${planned.receipt.max_total_seconds}-second provider limit`
      );
    }
    return {
      videos,
      receipt: {
        ...planned.receipt,
        prepared_total_seconds: Number(actualTotal.toFixed(3)),
        final_transport_total_seconds: Number(actualTotal.toFixed(3)),
        frame_rounding_correction_seconds: frameRoundingCorrection,
      },
    };
  }

  async function desiredReferenceBundle(run, shot) {
    const shots = approvedIncluded(db, run.id, 'storyboard_plan').sort(compareShots);
    const storyboardImages = currentArtifacts(db, run.id, 'storyboard_images').filter((item) => item.status === 'approved');
    const previews = currentArtifacts(db, run.id, 'director_preview').filter((item) => item.status === 'approved');
    const shotVideos = approvedIncluded(db, run.id, 'shot_video');
    const shotIndex = shots.findIndex((item) => Number(item.id) === Number(shot.id));
    const previousShot = shotIndex > 0 ? shots[shotIndex - 1] : null;
    const transitionMode = transitionModeForShot(shot);
    // An approved bundle is the user's accepted request snapshot. In
    // automatic-routing mode, feed that route back into resolution so a live
    // catalog refresh cannot silently choose another model between the review
    // click and the next polling/submit pass. Explicit model/shot overrides
    // still win and therefore intentionally produce a new binding when they
    // differ from the snapshot.
    const approvedBundle = currentArtifacts(db, run.id, 'reference_bundle')
      .find((item) => item.scope_id === shot.scope_id && item.status === 'approved');
    const approvedRouteHint = approvedBundle?.content?.routing_receipt
      && typeof approvedBundle.content.routing_receipt === 'object'
      ? approvedBundle.content.routing_receipt
      : null;
    const route = await resolveShotVideoRoute(run, shot, { approvedRouteHint });
    const capability = capabilityForRoute(route);
    const usesContinuityFrame = ['reference_continuation', 'strict_continuation'].includes(transitionMode);
    const strictFirstFrame = transitionMode === 'strict_continuation';
    const continuityVideo = usesContinuityFrame && previousShot
      ? shotVideos.find((item) => item.scope_id === previousShot.scope_id)
      : null;
    const referenceWarnings = [];
    if (strictFirstFrame && !capabilitySupportsRole(capability, 'image', 'first_frame')) {
      referenceWarnings.push('strict_first_frame_unsupported');
    }
    if (usesContinuityFrame && !continuityVideo) {
      // Keep the user's continuity choice, but do not force a predecessor
      // video to exist before the bundle can be edited or submitted.
      referenceWarnings.push('predecessor_video_missing');
    }
    let continuityFrame = null;
    if (usesContinuityFrame && continuityVideo) {
      try {
        continuityFrame = await ensureContinuityFrame(run, shot, continuityVideo);
      } catch (error) {
        // Extraction is an optional suggestion.  Preserve the source error as
        // a warning and let the user submit without the derived frame.
        referenceWarnings.push('continuity_frame_unavailable');
        log.warn?.('Optional continuity frame could not be prepared', {
          run_id: run.id,
          shot: shot.scope_id,
          source_artifact_id: continuityVideo.id,
          error: error.message,
        });
      }
    }
    const storyboardImage = storyboardImages.find((item) => item.scope_id === shot.scope_id);
    const preview = previews.find((item) => item.scope_id === shot.scope_id);
    if (!storyboardImage?.media_path) referenceWarnings.push('storyboard_image_missing');
    if (route.requires_director_preview && !preview?.media_path) referenceWarnings.push('director_preview_missing');
    const imageRefs = [];
    if (continuityFrame?.media_path) {
      imageRefs.push({
        path: continuityFrame.media_path,
        artifact_id: continuityFrame.id,
        label: strictFirstFrame ? '严格首帧' : '上一镜尾帧参考',
        source: strictFirstFrame ? 'strict_first_frame' : 'continuity_first_frame',
        role: strictFirstFrame ? 'first_frame' : 'reference',
        locked: true,
      });
    }
    if (storyboardImage?.media_path) {
      imageRefs.push({
        path: storyboardImage.media_path,
        artifact_id: storyboardImage.id,
        label: '当前分镜图',
        source: 'storyboard',
        role: 'reference',
      });
    }
    // Preserve uploaded authority images even when the generated resource
    // definition is absent or the model used a different display name. The
    // execution plan is the stable source of truth, so filename/name matching
    // cannot drop the user's original subject.
    const authorityArtifactIds = new Set((run.policy?.execution_plan?.subjects || [])
      .map((subject) => Number(subject.source_artifact_id || 0))
      .filter((id) => Number.isInteger(id) && id > 0));
    for (const asset of run.policy?.execution_plan?.assets || []) {
      if (['primary_subject_reference', 'character_reference', 'product_reference', 'scene_reference', 'outfit_reference'].includes(asset.role)) {
        const id = Number(asset.artifact_id || 0);
        if (Number.isInteger(id) && id > 0) authorityArtifactIds.add(id);
      }
    }
    const authorityImages = currentArtifacts(db, run.id, 'asset_images')
      .filter((item) => item.status === 'approved' && item.media_path && authorityArtifactIds.has(Number(item.id)))
      .sort((left, right) => Number(left.id) - Number(right.id));
    for (const image of authorityImages) {
      if (imageRefs.some((item) => item.path === image.media_path)) continue;
      imageRefs.push({
        path: image.media_path,
        artifact_id: image.id,
        label: '用户上传主体权威图',
        source: 'uploaded_authority',
        role: 'subject_reference',
        locked: true,
      });
    }
    // The execution plan is authoritative for imported subject/product
    // images. Name matching is intentionally not used here: an uploaded
    // image may have an arbitrary filename, but its artifact/subject binding
    // must still reach every generated shot that needs it.
    const plannedImageArtifactIds = new Set([
      ...(run.policy?.execution_plan?.subjects || []).map((subject) => Number(subject.source_artifact_id || 0)),
      ...(run.policy?.execution_plan?.assets || [])
        .filter((asset) => ['primary_subject_reference', 'character_reference', 'product_reference', 'scene_reference', 'prop_reference', 'visual_reference'].includes(asset.role))
        .map((asset) => Number(asset.artifact_id || 0)),
    ].filter((id) => Number.isInteger(id) && id > 0));
    if (plannedImageArtifactIds.size) {
      const importedImages = currentArtifacts(db, run.id, 'asset_images')
        .filter((item) => item.status === 'approved' && item.media_path && plannedImageArtifactIds.has(Number(item.id)))
        .sort((left, right) => Number(left.id) - Number(right.id));
      for (const image of importedImages) {
        if (imageRefs.some((item) => item.path === image.media_path)) continue;
        imageRefs.push({
          path: image.media_path,
          artifact_id: image.id,
          label: '素材计划指定参考图',
          source: 'execution_plan',
          role: 'subject_reference',
          locked: true,
        });
      }
    }
    const imageLimit = Number.isFinite(Number(capability?.max_images || route.limits?.images))
      ? Number(capability?.max_images || route.limits?.images)
      : 4;
    const autoLink = buildImageReferenceAutoLink(db, run, shot, Math.max(0, imageLimit - imageRefs.length), {
      providerImageLimit: imageLimit,
      mandatoryImageCount: imageRefs.length,
    });
    for (const reference of autoLink.references) {
      if (!imageRefs.some((item) => item.path === reference.path)) imageRefs.push(reference);
    }
    const videoRefs = [];
    if (route.uses_reference_video && preview?.media_path) {
      videoRefs.push({
        path: preview.media_path,
        artifact_id: preview.id,
        label: '3D 导演台预演',
        source: 'director',
        source_duration_seconds: artifactVideoDuration(preview),
      });
    }
    const videoLimit = Number.isFinite(Number(capability?.max_videos || route.limits?.videos))
      ? Number(capability?.max_videos || route.limits?.videos)
      : 1;
    const videoBudget = route.uses_reference_video
      ? await applyReferenceVideoBudget(run, capability, videoRefs.slice(0, videoLimit))
      : { videos: [], receipt: { enforced: false, reason: 'reference_video_not_selected' } };
    const routingReceipt = routingReceiptForRoute(route);
    const dependencyIds = [...new Set([
      shot.id,
      ...(storyboardImage?.id ? [storyboardImage.id] : []),
      ...(preview?.id && route.requires_director_preview ? [preview.id] : []),
      ...(continuityVideo ? [continuityVideo.id] : []),
      ...(continuityFrame ? [continuityFrame.id] : []),
      ...autoLink.dependencyIds,
    ].map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
    return {
      route,
      content: {
        source_artifact_id: shot.id,
        images: imageRefs.slice(0, imageLimit),
        videos: videoBudget.videos,
        audios: [],
        autolink_receipt: autoLink.receipt,
        routing_receipt: routingReceipt,
        routing_material_signature: routingMaterialSignature(route),
        routing_binding_signature: routingBindingSignature(route),
        reference_video_budget: videoBudget.receipt,
        continuity_in_artifact_id: continuityVideo?.id || null,
        continuity_frame_artifact_id: continuityFrame?.id || null,
        continuity_frame_transport: continuityFrame
          ? (strictFirstFrame ? 'strict_first_frame' : 'generic_image_reference')
          : 'none',
        strict_first_frame_artifact_id: strictFirstFrame ? (continuityFrame?.id || null) : null,
        transition_mode: transitionMode,
        previs_mode: route.previs_mode,
        uses_reference_video: route.uses_reference_video,
        requires_director_preview: route.requires_director_preview,
        bundle_origin: 'automatic_suggestion',
        limits: capability ? {
          images: Number(capability.max_images),
          videos: route.uses_reference_video ? Number(capability.max_videos || 0) : 0,
          audios: Number(capability.max_audios),
        } : null,
        soft_limits: !capability,
        reference_warnings: [...new Set(referenceWarnings)],
        media_constraints: {
          contract_status: capability ? 'known' : 'unknown',
          max_image_bytes: Number.isFinite(Number(capability?.max_image_bytes)) ? Number(capability.max_image_bytes) : null,
          max_video_bytes: Number.isFinite(Number(capability?.max_video_bytes)) ? Number(capability.max_video_bytes) : null,
          max_audio_bytes: Number.isFinite(Number(capability?.max_audio_bytes)) ? Number(capability.max_audio_bytes) : null,
          max_total_references: Number.isFinite(Number(capability?.max_total_references)) ? Number(capability.max_total_references) : null,
          max_reference_video_seconds_total: Number.isFinite(Number(capability?.max_reference_video_seconds_total))
            ? Number(capability.max_reference_video_seconds_total)
            : null,
        },
        included: true,
      },
      dependencyIds,
    };
  }

  function referenceBundleMatches(bundle, desired) {
    return referenceBundleComparison(bundle, desired, db, repo).matches;
    /* legacy comparator retained below only as rollback reference
    if (!bundle || !['draft', 'reviewing', 'approved'].includes(bundle.status)) return false;
    if (Number(bundle.content?.source_artifact_id) !== Number(desired.content.source_artifact_id)) return false;
    if (bundle.status === 'approved') {
      // An approved bundle is the user's explicit media selection.  Do not
      // recreate it just because it is empty, exceeds a locally cached
      // contract, or omits an optional continuity/director asset.
      for (const key of ['images', 'videos', 'audios']) {
        const items = Array.isArray(bundle.content?.[key]) ? bundle.content[key] : [];
        for (const item of items) {
          if (!String(item?.path || '').trim()) return false;
          if (item.artifact_id != null) {
            const sourceArtifact = repo.getArtifact(db, item.artifact_id);
            if (!sourceArtifact || sourceArtifact.status !== 'approved' || !sourceArtifact.media_path) return false;
            if (![item.path, item.original_path].filter(Boolean).map(String).includes(String(sourceArtifact.media_path))) return false;
        }
      }
      const desiredBinding = String(
        desired.content?.routing_binding_signature
          || desired.content?.routing_receipt?.routing_binding_signature
          || routingBindingSignature(desired.route || desired.content?.routing_receipt || {})
      ).trim();
      const savedBinding = String(
        bundle.content?.routing_binding_signature
          || bundle.content?.routing_receipt?.routing_binding_signature
          || (bundle.content?.routing_receipt ? routingBindingSignature(bundle.content.routing_receipt) : '')
      ).trim();
      // Legacy bundles without a stable binding continue to use the complete
      // signature as a conservative fallback. New bundles ignore volatile
      // catalog timestamps and warnings here.
      if (savedBinding && desiredBinding) {
        if (savedBinding !== desiredBinding) return false;
      } else if (String(bundle.content?.routing_material_signature || '')
        !== String(desired.content?.routing_material_signature || '')) return false;
      if (String(bundle.content?.transition_mode || '') !== String(desired.content.transition_mode || '')) return false;
      const actualDependencies = repo.listUpstreamArtifactIds(db, bundle.id);
      return actualDependencies.some((id) => Number(id) === Number(desired.content.source_artifact_id));
    }
    const desiredBinding = String(
      desired.content?.routing_binding_signature
        || desired.content?.routing_receipt?.routing_binding_signature
        || routingBindingSignature(desired.route || desired.content?.routing_receipt || {})
    ).trim();
    const savedBinding = String(
      bundle.content?.routing_binding_signature
        || bundle.content?.routing_receipt?.routing_binding_signature
        || (bundle.content?.routing_receipt ? routingBindingSignature(bundle.content.routing_receipt) : '')
    ).trim();
    const bindingMatches = savedBinding && desiredBinding
      ? savedBinding === desiredBinding
      : String(bundle.content?.routing_material_signature || '')
        === String(desired.content?.routing_material_signature || '');
    const manualBundle = ['manual', 'manual_revision'].includes(String(bundle.content?.bundle_origin || ''))
      || Boolean(bundle.content?.revision_source?.type === 'user_edit');
    if (manualBundle
      && bindingMatches
      && String(bundle.content?.transition_mode || '') === String(desired.content.transition_mode || '')) {
      // A saved manual draft/review is also authoritative for its media
      // arrays.  Polling must not silently put automatic suggestions back.
      return true;
    }
    const bundleImageIds = (bundle.content?.images || []).map((item) => item.artifact_id);
    const desiredImageIds = desired.content.images.map((item) => item.artifact_id);
    const bundleVideoIds = (bundle.content?.videos || []).map((item) => item.artifact_id);
    const desiredVideoIds = desired.content.videos.map((item) => item.artifact_id);
    const bundleAudioIds = (bundle.content?.audios || []).map((item) => item.artifact_id);
    const desiredAudioIds = desired.content.audios.map((item) => item.artifact_id);
    const videoTransportSignature = (items) => JSON.stringify((items || []).map((item) => ({
      artifact_id: item.artifact_id,
      source: item.source,
      path: item.path,
      original_path: item.original_path || null,
      source_duration_seconds: item.source_duration_seconds ?? null,
      transport: item.transport || null,
    })));
    const actualDependencies = repo.listUpstreamArtifactIds(db, bundle.id);
    return sameIdList(bundleImageIds, desiredImageIds)
      && sameIdList(bundleVideoIds, desiredVideoIds)
      && sameIdList(bundleAudioIds, desiredAudioIds)
      && videoTransportSignature(bundle.content?.videos) === videoTransportSignature(desired.content.videos)
      && JSON.stringify(bundle.content?.reference_video_budget || null) === JSON.stringify(desired.content.reference_video_budget || null)
      && bindingMatches
      && Number(bundle.content?.strict_first_frame_artifact_id || 0) === Number(desired.content.strict_first_frame_artifact_id || 0)
      && Number(bundle.content?.continuity_frame_artifact_id || 0) === Number(desired.content.continuity_frame_artifact_id || 0)
      && String(bundle.content?.continuity_frame_transport || 'none') === String(desired.content.continuity_frame_transport || 'none')
      && String(bundle.content?.transition_mode || '') === String(desired.content.transition_mode || '')
      && JSON.stringify(bundle.content?.autolink_receipt || null) === JSON.stringify(desired.content.autolink_receipt || null)
      && sameIdList(actualDependencies, desired.dependencyIds);
    */
   }

  async function ensureReferenceBundleForShot(run, shot, stateRetry = 0) {
    const latestRun = repo.getRun(db, run.id);
    if (!latestRun) throw new Error('制作任务不存在');
    const basisRun = Number(latestRun.version) === Number(run.version) ? run : latestRun;
    const desired = await desiredReferenceBundle(basisRun, shot);
    const afterDesiredRun = repo.getRun(db, run.id);
    if (Number(afterDesiredRun.version) !== Number(basisRun.version)) {
      if (stateRetry >= 2) {
        throw codedError('VIDEO_ROUTE_CONCURRENT_UPDATE', '视频模型或参考素材正在更新，请刷新后重试');
      }
      return ensureReferenceBundleForShot(afterDesiredRun, shot, stateRetry + 1);
    }
    // Read the target only after awaited route/reference preparation. This
    // prevents a late old snapshot from overwriting a bundle created while
    // the catalog request was in flight.
    const target = currentArtifacts(db, run.id, 'reference_bundle')
      .find((item) => item.scope_id === shot.scope_id);
    const comparison = referenceBundleComparison(target, desired, db, repo);
    if (comparison.matches) return { state: 'ready', artifact: target, route: desired.route, comparison };
    const draft = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'reference_bundle',
      scope_type: 'shot',
      scope_id: shot.scope_id,
      title: `${shot.title} reference bundle`,
      content: desired.content,
      status: 'draft',
      depends_on: desired.dependencyIds,
    });
    return { state: 'refreshed', artifact: draft, route: desired.route, comparison };
  }

  async function ensureReferenceBundles(run) {
    const shots = scopeShotItems(
      approvedIncluded(db, run.id, 'storyboard_plan').sort(compareShots),
      run
    );
    for (const shot of shots) {
      const ensured = await ensureReferenceBundleForShot(run, shot);
      if (ensured.state === 'refreshed') return { state: 'progressed', artifact: ensured.artifact };
    }
    return { state: 'stage_ready', artifacts: currentArtifacts(db, run.id, 'reference_bundle') };
  }

  function requestDirectorCapture(run) {
    if (isDirectorDisabled(run)) {
      return { state: 'stage_ready', artifacts: [] };
    }
    const plans = scopeShotItems(approvedIncluded(db, run.id, 'director_plan'), run);
    if (!plans.length) throw new Error('没有已确认的导演台方案');
    const targets = currentArtifacts(db, run.id, 'director_preview');
    for (const plan of plans) {
      const target = targets.find((item) => item.scope_id === plan.scope_id);
      if (artifactMatchesSource(target, plan)) continue;
      const rejectedTarget = target && ['rejected', 'failed', 'invalidated'].includes(target.status);
      let action = repo.getLatestAction(db, run.id, {
        stage: 'director_preview', scope_type: 'shot', scope_id: plan.scope_id, kind: 'client_capture',
      });
      if (action?.status === 'cancelled' && action.result?.retry_authorized) action = null;
      if (action && Number(action.request?.source_artifact_id) !== Number(plan.id)) {
        if (action.status === 'waiting') repo.updateAction(db, action.id, { status: 'cancelled' });
        action = null;
      }
      if (rejectedTarget && action?.status === 'completed') action = null;
      if (!action) {
        const attempt = repo.nextActionAttempt(db, run.id, 'director_preview', 'shot', plan.scope_id, 'client_capture');
        if (attempt > Number(run.budget?.max_director_revisions || 2) + 1) {
          return { state: 'waiting_review', reason: 'director_revision_limit', plan, target };
        }
        const key = actionKey('director_preview', plan, attempt);
        const clientToken = crypto.randomUUID();
        action = repo.reserveAction(db, {
          run_id: run.id, action_key: key, stage: 'director_preview', scope_type: 'shot', scope_id: plan.scope_id,
          kind: 'client_capture', attempt, request: {
            client_token: clientToken,
            source_artifact_id: plan.id,
            expected_duration: plan.content?.document?.timeline?.duration || 5,
            expected_aspect_ratio: normalizeProductionAspectRatio(run.policy?.aspect_ratio),
          },
        }).action;
        action = repo.updateAction(db, action.id, { status: 'waiting' });
      }
      if (action.status === 'completed') continue;
      if (['failed', 'ambiguous', 'cancelled'].includes(action.status)) {
        return { state: 'waiting_review', reason: action.status, action };
      }
      repo.updateRun(db, run.id, {
        status: 'waiting_client', waiting_reason: 'director_capture',
        runtime: { ...run.runtime, client_action_id: action.id },
      });
      return {
        state: 'client_action',
        client_action: {
          type: 'capture_director_preview',
          action_id: action.id,
          token: action.request.client_token,
          shot_id: plan.scope_id,
          expected_duration: action.request.expected_duration,
          expected_aspect_ratio: action.request.expected_aspect_ratio,
          director_document: plan.content.document,
        },
      };
    }
    return { state: 'stage_ready', artifacts: currentArtifacts(db, run.id, 'director_preview') };
  }

  async function acceptDirectorCapture(runId, input) {
    const run = repo.getRun(db, runId);
    if (!run) throw new Error('制作任务不存在');
    if (isDirectorDisabled(run)) {
      throw codedError('DIRECTOR_DISABLED', '本任务已关闭 3D 导演台，不能提交导演台 JSON 或预演视频');
    }
    const action = repo.getAction(db, input.action_id);
    if (!action || action.run_id !== runId || action.kind !== 'client_capture') throw new Error('客户端动作不存在');
    if (action.status === 'completed') return { reused: true, artifact: repo.getArtifact(db, action.result?.artifact_id) };
    if (action.status !== 'waiting') throw new Error('客户端动作当前不可提交');
    const provided = Buffer.from(String(input.token || ''));
    const expected = Buffer.from(String(action.request?.client_token || ''));
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) throw new Error('客户端动作令牌无效');
    const expectedDuration = Number(action.request.expected_duration) || 5;
    const receipt = await adapters.validateVideo(input.media_path, {
      expected_duration: expectedDuration,
      duration_tolerance: Math.max(1.5, expectedDuration * 0.3),
      min_bytes: 8192,
      expected_aspect_ratio: normalizeProductionAspectRatio(
        action.request?.expected_aspect_ratio || run.policy?.aspect_ratio
      ),
    });
    if (input.frame_count != null && Number(input.frame_count) < expectedDuration * 15) {
      throw new Error('3D 预演录制帧数不足');
    }
    const plan = repo.getArtifact(db, action.request.source_artifact_id);
    if (!plan || plan.status !== 'approved') throw new Error('对应导演台方案已失效');
    const artifact = repo.createArtifact(db, {
      run_id: run.id, stage: 'director_preview', scope_type: 'shot', scope_id: plan.scope_id,
      title: `${plan.title} 3D 预演`,
      content: {
        source_artifact_id: plan.id,
        expected_duration: expectedDuration,
        aspect_ratio: normalizeProductionAspectRatio(action.request?.expected_aspect_ratio || run.policy?.aspect_ratio),
        frame_count: input.frame_count == null ? null : Number(input.frame_count),
        frame_path: input.frame_path || null,
        validation: receipt,
        included: true,
      },
      status: 'draft', media_path: receipt.relative_path,
      mime_type: receipt.signature === 'webm' ? 'video/webm' : 'video/mp4',
      content_hash: receipt.sha256, source_action_id: action.id, depends_on: [plan.id],
    });
    repo.updateAction(db, action.id, { status: 'completed', result: { artifact_id: artifact.id, receipt } });
    repo.updateRun(db, run.id, {
      status: 'running', waiting_reason: null,
      runtime: { ...run.runtime, client_action_id: null },
    });
    return { reused: false, artifact, receipt };
  }

  function currentShotPlan(runId, scopeId) {
    return currentArtifacts(db, runId, 'storyboard_plan')
      .find((item) => String(item.scope_id) === String(scopeId)) || null;
  }

  function actionIsDetachedFromSequence(action, shot) {
    if (action?.result?.detached_from_sequence === true) return true;
    const liveShot = currentShotPlan(action?.run_id || shot?.run_id, shot?.scope_id);
    return Boolean(liveShot && liveShot.content?.included === false);
  }

  function actionStoppedLocally(action) {
    return action?.result?.local_observation_stopped === true
      || action?.result?.cancel_requested_provider_unknown === true
      || action?.result?.provider_cancel_confirmed === true;
  }

  function videoSubmissionStatus(generation) {
    const status = String(generation?.submission_status || '').trim().toLowerCase();
    if (['not_sent', 'rejected', 'accepted', 'ambiguous'].includes(status)) return status;
    if (generation?.provider_task_id) return 'accepted';
    return 'ambiguous';
  }

  function failVideoActionFromGeneration(action, generation, input = {}) {
    const submissionStatus = videoSubmissionStatus(generation);
    const errorMessage = input.error_message
      || generation?.error_msg
      || generation?.error_message
      || '视频生成失败';
    const result = {
      ...(action.result || {}),
      ...(input.result || {}),
      generation_id: generation?.id || action.generation_id || null,
      generation_status: generation?.generation_status || generation?.status || null,
      submission_status: submissionStatus,
      submission_http_status: generation?.submission_http_status ?? null,
      submission_receipt: generation?.submission_receipt || null,
    };
    if (['not_sent', 'rejected'].includes(submissionStatus) && !generation?.provider_task_id) {
      return repo.releaseUnacceptedVideoAction(db, action.id, {
        submission_status: submissionStatus,
        error_code: input.error_code || 'VIDEO_SUBMISSION_REJECTED',
        error_message: errorMessage,
        result,
      });
    }
    if (submissionStatus === 'ambiguous' && !generation?.provider_task_id) {
      return repo.updateAction(db, action.id, {
        status: 'ambiguous',
        error_code: input.ambiguous_error_code || 'VIDEO_CREATE_AMBIGUOUS',
        error_message: errorMessage,
        cost_status: 'uncertain',
        result,
      });
    }
    return repo.updateAction(db, action.id, {
      status: 'failed',
      ...(generation?.provider_task_id ? { provider_id: generation.provider_task_id } : {}),
      error_code: input.error_code || 'VIDEO_GENERATION_FAILED',
      error_message: errorMessage,
      result,
    });
  }

  function settleDetachedVideoAction(action, generation, shot, receipt = null) {
    const detachedAt = action.result?.detached_at || new Date().toISOString();
    const detachedResult = {
      ...(action.result || {}),
      source_artifact_id: action.result?.source_artifact_id ?? action.request?.source_artifact_id ?? shot?.id ?? null,
      bundle_artifact_id: action.result?.bundle_artifact_id ?? action.request?.bundle_artifact_id ?? null,
      detached_from_sequence: true,
      detached_reason: action.result?.detached_reason || 'shot_excluded_while_video_active',
      detached_at: detachedAt,
      workflow_blocking: false,
      generation_id: generation?.id || action.generation_id || null,
      generation_status: generation?.status || null,
      ...(receipt ? { receipt } : {}),
    };
    if (!generation || ['pending', 'processing'].includes(generation.status)) {
      const updated = repo.updateAction(db, action.id, {
        ...(generation?.provider_task_id && generation.provider_task_id !== action.provider_id
          ? { provider_id: generation.provider_task_id }
          : {}),
        result: detachedResult,
      });
      return { state: 'progressed', reason: 'detached_video_waiting', detached: true, action: updated, generation };
    }
    if (generation.status !== 'completed') {
      const updated = failVideoActionFromGeneration(action, generation, {
        error_code: 'DETACHED_VIDEO_GENERATION_FAILED',
        error_message: generation.error_msg || generation.error_message || '已跳过镜头的视频生成失败',
        result: detachedResult,
      });
      return { state: 'progressed', reason: 'detached_video_failed', detached: true, action: updated, generation };
    }
    const updated = repo.updateAction(db, action.id, {
      status: 'completed', error_code: null, error_message: null, result: detachedResult,
    });
    const archived = archiveDetachedVideoGeneration(db, {
      generation_id: generation.id || action.generation_id,
      local_path: receipt?.relative_path || generation.local_path || null,
      remote_url: generation.video_url || generation.remote_video_url || null,
    });
    return {
      state: 'progressed',
      reason: 'detached_video_archived',
      detached: true,
      action: updated,
      generation,
      archived_artifacts: archived,
    };
  }

  function fallbackSelectionMode(run, shot) {
    const policy = run?.policy || {};
    const shotOverride = String(shot?.content?.video_model_override || '').trim()
      || String(policy.video_model_overrides?.[String(shot?.scope_id || '')] || '').trim();
    if (shotOverride) return 'shot_override';
    const routingMode = String(policy.video_routing_mode || '').toLowerCase();
    if (routingMode === 'auto') return 'auto';
    if (routingMode === 'fixed' || String(policy.video_model || '').trim()) return 'project_fixed';
    return 'auto';
  }

  function fallbackModelForShot(run) {
    return String(
      run?.policy?.video_fallback_model
      || run?.policy?.fallback_video_model
      || 'seedance2.0 -720p-fast-15s'
    ).trim();
  }

  function fallbackRouteForShot(run, shot, model) {
    const policy = {
      ...(run?.policy || {}),
      video_model: model,
      video_routing_mode: 'fixed',
      video_duration_min: 15,
      video_duration_max: 15,
    };
    const capability = getYinziVideoCapability(model) || null;
    const route = fixedModelRoute(shot, model, policy, capability);
    return decorateVideoRouteWithConfig(route, videoConfigForRun(db, run, shot));
  }

  function fallbackPlanForAction(action) {
    const plan = action?.result?.fallback_plan;
    return plan && typeof plan === 'object' && plan.eligible === true ? plan : null;
  }

  async function submitFallbackSegment({ run, shot, bundle, parentAction, plan, segment, firstFrame = null }) {
    if (!segment || !plan || !parentAction) return { state: 'waiting_review', reason: 'fallback_segment_missing' };
    const route = fallbackRouteForShot(run, shot, segment.model);
    const capability = capabilityForRoute(route);
    const parentRequest = parentAction.request || {};
    const parentReceipt = parentRequest.routing_receipt || {};
    const references = Array.isArray(parentRequest.reference_image_urls)
      ? [...parentRequest.reference_image_urls]
      : [];
    const firstFramePath = String(
      firstFrame?.path || firstFrame?.relative_path || firstFrame?.media_path || ''
    ).trim();
    let strictFirstFrame = null;
    let continuityMode = firstFramePath ? 'continuity_advisory' : 'original_bundle';
    if (firstFramePath) {
      const supportsStrict = capabilitySupportsRole(capability, 'image', 'first_frame');
      if (supportsStrict) {
        strictFirstFrame = firstFramePath;
        continuityMode = 'strict_first_frame';
      } else {
        references.unshift(firstFramePath);
      }
    }
    const config = videoConfigForRun(db, run, shot);
    const identity = identityForConfig(config);
    const request = {
      ...parentRequest,
      video_config_id: identity?.id || parentRequest.video_config_id || null,
      video_config_identity_version: identity?.version || parentRequest.video_config_identity_version || null,
      video_config_updated_at: identity?.updated_at || parentRequest.video_config_updated_at || null,
      video_config_fingerprint: identity?.fingerprint || parentRequest.video_config_fingerprint || null,
      model: segment.model,
      duration: 15,
      resolution: parentRequest.resolution || capability?.resolution || '720p',
      first_frame_url: strictFirstFrame || undefined,
      reference_image_urls: references,
      reference_video_urls: [],
      reference_audio_urls: Array.isArray(parentRequest.reference_audio_urls)
        ? parentRequest.reference_audio_urls
        : [],
      transition_mode: strictFirstFrame ? 'strict_continuation' : 'reference_continuation',
      fallback_parent_action_id: parentAction.id,
      fallback_parent_action_key: plan.parent_action_key,
      fallback_plan_id: plan.plan_id,
      fallback_segment_index: segment.index,
      fallback_continuity_mode: continuityMode,
      routing_receipt: routingReceiptForRoute(route),
      routing_material_signature: routingMaterialSignature(route),
      routing_binding_signature: routingBindingSignature(route),
      provider_prompt: `${String(parentRequest.prompt || '').trim()}\n\n备用分段 ${segment.index}/2：保持同一角色、场景、道具与光线状态；这是同一逻辑镜头的连续执行片段，不添加刻意遮挡转场。${strictFirstFrame ? '严格从提供的首帧开始。' : '如未支持严格首帧，只把尾帧作为普通参考，最终剪辑在镜头边界处硬切。'}`,
    };
    request.prompt = request.provider_prompt;
    // Check the stable child key before mutating accounting state. Refreshes
    // and runner retries must reuse an existing child action rather than
    // consuming the parent reservation a second time.
    const existing = repo.getActionByKey(db, run.id, segment.action_key);
    if (existing) return { state: ['submitted', 'waiting'].includes(existing.status) ? 'waiting_provider' : 'progressed', action: existing, shot };
    const dispatchReceipt = assertVideoDispatchContract({ run, shot, route, bundle, request });
    acceptanceSafety.assertVideoSubmitAllowed({
      entry: 'production_fallback_segment',
      run_id: run.id,
      shot_id: shot.scope_id,
      model: request.model || null,
      segment_index: segment.index,
    });
    const segmentPrice = accounting.videoReservation(db, run, request, {
      ...route,
      billing_unit: 'per_request',
      unit_price: Number(plan.segment_cost || 3),
      estimated_price: Number(plan.segment_cost || 3),
      price_override: {
        provider: request.provider || 'yinzi',
        service_type: 'video',
        model: segment.model,
        group_name: route.group || run.policy?.video_group || '',
        billing_unit: 'per_request',
        unit_price_microusd: Math.round(Number(plan.segment_cost || 3) * 1000000),
        source: 'seedance_fallback_plan',
        source_version: String(plan.plan_id || ''),
      },
    });
    const attempt = Number(segment.index) + Number(parentAction.attempt || 1);
    const reservation = repo.reserveAction(db, {
      run_id: run.id,
      action_key: segment.action_key,
      stage: 'shot_video',
      scope_type: 'shot',
      scope_id: shot.scope_id,
      kind: 'video_generate',
      attempt,
      request,
      parent_action_id: parentAction.id,
      parent_action_key: plan.parent_action_key,
      segment_index: segment.index,
      reserved_video_seconds: 15,
      cost: segmentPrice,
    });
    const action = reservation.action;
    const costMicrousd = Number(segmentPrice.estimated_microusd || 0);
    if (costMicrousd > 0) {
      try {
        repo.consumeFallbackBudget(db, run.id, plan.parent_action_key, costMicrousd);
      } catch (error) {
        const cancelled = repo.cancelReservedAction(db, action.id, {
          fallback_budget_consume_failed: true,
          fallback_budget_error: error.message,
        });
        repo.updateRun(db, run.id, {
          status: 'waiting_review', waiting_reason: 'fallback_budget_exhausted',
          error_code: error.code || 'COST_FALLBACK_SEGMENT_BUDGET_EXHAUSTED',
          error_message: error.message,
        });
        return { state: 'waiting_review', reason: 'fallback_budget_exhausted', action: cancelled, shot, error };
      }
    }
    if (action.status !== 'reserved') return { state: 'waiting_provider', action, shot };
    repo.updateAction(db, action.id, { status: 'submitted' });
    let created;
    try {
      created = await adapters.createVideo(request);
    } catch (error) {
      const failed = repo.updateAction(db, action.id, {
        status: 'failed',
        error_code: error.code || 'VIDEO_FALLBACK_CREATE_FAILED',
        error_message: error.message,
        cost_status: 'released',
        result: { fallback_plan_id: plan.plan_id, fallback_segment_index: segment.index, dispatch_receipt: dispatchReceipt },
      });
      return { state: 'waiting_review', reason: 'fallback_segment_create_failed', action: failed, shot };
    }
    const persistedReceipt = assertVideoDispatchContract({
      run, shot, route, bundle, request, persistedModel: created.model || null,
    });
    const waiting = repo.updateAction(db, action.id, {
      status: 'waiting',
      task_id: created.task_id,
      generation_id: created.id,
      result: {
        fallback_plan_id: plan.plan_id,
        fallback_segment_index: segment.index,
        parent_action_id: parentAction.id,
        source_artifact_id: shot.id,
        bundle_artifact_id: bundle.id,
        routing_material_signature: routingMaterialSignature(route),
        routing_binding_signature: routingBindingSignature(route),
        dispatch_receipt: persistedReceipt,
      },
    });
    repo.updateRun(db, run.id, { status: 'waiting_provider', waiting_reason: `video_fallback_segment_${segment.index}` });
    return { state: 'waiting_provider', action: waiting, shot, fallback_segment: segment };
  }

  function fallbackFailureInput(action, generation) {
    return {
      error_code: generation?.error_code || action?.error_code || generation?.submission_receipt?.error_code,
      message: generation?.error_msg || generation?.error_message || action?.error_message,
      result: generation || action,
      generation,
    };
  }

  async function advanceSeedanceFallback(run, shot, bundle, action, generation = null) {
    // A child action is always handled by this one state machine.  This keeps
    // the legacy automatic model switch from creating a second, competing
    // retry for the same logical shot.
    const parent = action?.parent_action_id ? repo.getAction(db, action.parent_action_id) : action;
    const existingPlan = fallbackPlanForAction(parent);
    let plan = existingPlan;
    if (!plan) {
      const failure = fallbackFailureInput(parent, generation);
      const selectionMode = fallbackSelectionMode(run, shot);
      if (!canAutomaticallyFallback({
        selection_mode: selectionMode,
        policy: run.policy || {},
        allow_shot_fallback: shot?.content?.allow_auto_model_switch === true,
        failure,
      })) return null;
      const sourceModel = String(parent?.request?.model || parent?.request?.routing_receipt?.model || '').trim();
      const fallbackModel = fallbackModelForShot(run);
      plan = planSeedanceFallback({
        runId: run.id,
        shotId: shot.scope_id,
        parentActionKey: parent.action_key,
        fromModel: sourceModel,
        fallbackModel,
        failure,
        firstPrice: Number(parent?.cost?.estimated_usd || parent?.request?.estimated_price || 3.5),
        segmentPrice: 3,
        requestedDuration: 30,
        maxSegments: 2,
        strictFirstFrame: Boolean(parent?.request?.first_frame_url),
      });
      if (!plan.eligible) return null;
      const existingResult = parent.result || {};
      const saved = repo.updateAction(db, parent.id, {
        result: {
          ...existingResult,
          fallback_plan: plan,
          fallback_trigger: failure,
          fallback_selection_mode: selectionMode,
        },
      });
      if (saved) parent.result = saved.result;
    }

    const reserveAmount = Math.max(0, Math.round(Number(plan.segment_cost || 3) * Number(plan.max_segments || 2) * 1000000));
    if (reserveAmount > 0) {
      try {
        repo.reserveFallbackBudget(db, run.id, {
          reservation_key: plan.parent_action_key,
          amount_microusd: reserveAmount,
          reason: `Seedance 2.5 失败后的 ${plan.max_segments} 段 2.0 备用预算`,
          stage: 'shot_video', scope_type: 'shot', scope_id: shot.scope_id,
        });
      } catch (error) {
        repo.updateRun(db, run.id, {
          status: 'waiting_review', waiting_reason: 'fallback_budget_exhausted',
          error_code: error.code || 'COST_FALLBACK_BUDGET_EXHAUSTED', error_message: error.message,
        });
        return { state: 'waiting_review', reason: 'fallback_budget_exhausted', action: parent, error };
      }
    }

    const children = repo.listActions(db, run.id, { page_size: 200 }).items
      .filter((item) => item.parent_action_key === plan.parent_action_key && item.kind === 'video_generate')
      .sort((left, right) => Number(left.segment_index || 0) - Number(right.segment_index || 0));
    const completed = children.filter((item) => item.status === 'completed');
    const next = nextFallbackSegment(plan, completed.map((item) => ({ index: item.segment_index })));
    if (next) {
      const nextAction = children.find((item) => Number(item.segment_index) === Number(next.index));
      if (nextAction && ['failed', 'ambiguous', 'cancelled'].includes(nextAction.status)) {
        repo.updateRun(db, run.id, {
          status: 'waiting_review', waiting_reason: 'video_fallback_segment_failed',
          error_code: nextAction.error_code || 'VIDEO_FALLBACK_GENERATION_FAILED',
          error_message: nextAction.error_message || '备用视频分段未完成，无法继续创建后续分段',
        });
        return { state: 'waiting_review', reason: 'video_fallback_segment_failed', action: nextAction };
      }
      if (!nextAction) {
        const predecessor = Number(next.index) === 2
          ? children.find((item) => Number(item.segment_index) === 1 && item.status === 'completed')
          : null;
        const predecessorFrame = predecessor?.result?.tail_frame || null;
        const submitted = await submitFallbackSegment({
          run, shot, bundle, parentAction: parent, plan, segment: next,
          firstFrame: predecessorFrame,
        });
        return { ...submitted, fallback_parent_action: parent };
      }
      if (nextAction && ['submitted', 'waiting'].includes(nextAction.status)) {
        const nextGeneration = nextAction.generation_id ? await adapters.getVideo(nextAction.generation_id) : null;
        if (!nextGeneration || ['pending', 'processing'].includes(nextGeneration.status)) {
          repo.updateRun(db, run.id, { status: 'waiting_provider', waiting_reason: `video_fallback_segment_${next.index}` });
          return { state: 'waiting_provider', reason: `video_fallback_segment_${next.index}`, action: nextAction, generation: nextGeneration };
        }
        if (nextGeneration.status !== 'completed') {
          const failed = failVideoActionFromGeneration(nextAction, nextGeneration, {
            error_code: 'VIDEO_FALLBACK_GENERATION_FAILED',
            error_message: nextGeneration.error_msg || '备用视频分段生成失败',
          });
          repo.updateRun(db, run.id, { status: 'waiting_review', waiting_reason: 'video_fallback_generation_failed', error_code: failed.error_code, error_message: failed.error_message });
          return { state: 'waiting_review', reason: 'video_fallback_generation_failed', action: failed, generation: nextGeneration };
        }
        const refreshedChildren = repo.listActions(db, run.id, { page_size: 200 }).items
          .filter((item) => item.parent_action_key === plan.parent_action_key && item.kind === 'video_generate')
          .sort((left, right) => Number(left.segment_index || 0) - Number(right.segment_index || 0));
        const segmentOne = refreshedChildren.find((item) => Number(item.segment_index) === 1);
        const segmentOnePath = segmentOne?.result?.receipt?.relative_path || segmentOne?.result?.local_path || null;
        if (Number(next.index) === 2 && !segmentOnePath) {
          return { state: 'waiting_review', reason: 'fallback_segment_one_receipt_missing', action: nextAction };
        }
        const parentBundle = bundle || currentArtifacts(db, run.id, 'reference_bundle').find((item) => item.scope_id === shot.scope_id);
        const receipt = await adapters.validateVideo(nextGeneration.local_path || nextGeneration.video_url, {
          expected_duration: 15,
          duration_tolerance: 4,
          expected_aspect_ratio: normalizeProductionAspectRatio(run.policy?.aspect_ratio),
        });
        let tailFrame = null;
        if (Number(next.index) === 1) {
          tailFrame = await adapters.extractContinuityFrame(receipt.relative_path, {
            run_id: run.id, shot_scope_id: shot.scope_id,
            source_action_id: nextAction.id, source_hash: receipt.sha256,
          });
        }
        const updatedChild = repo.updateAction(db, nextAction.id, {
          status: 'completed',
          result: {
            ...(nextAction.result || {}),
            receipt,
            local_path: receipt.relative_path,
            ...(tailFrame ? { tail_frame: tailFrame } : {}),
          },
        });
        if (Number(next.index) === 1) {
          const second = plan.segments.find((item) => Number(item.index) === 2);
          const submitted = await submitFallbackSegment({
            run, shot, bundle: parentBundle, parentAction: parent, plan, segment: second,
            firstFrame: tailFrame,
          });
          return { ...submitted, fallback_parent_action: parent, completed_segment: updatedChild };
        }
      }
    }

    const latestChildren = repo.listActions(db, run.id, { page_size: 200 }).items
      .filter((item) => item.parent_action_key === plan.parent_action_key && item.kind === 'video_generate')
      .sort((left, right) => Number(left.segment_index || 0) - Number(right.segment_index || 0));
    if (latestChildren.length < plan.max_segments || latestChildren.some((item) => item.status !== 'completed')) {
      repo.updateRun(db, run.id, { status: 'waiting_provider', waiting_reason: 'video_fallback_segments' });
      return { state: 'waiting_provider', reason: 'video_fallback_segments', action: parent };
    }
    if (parent.result?.artifact_id) return { state: 'progressed', reason: 'video_fallback_converged', action: parent, artifact: repo.getArtifact(db, parent.result.artifact_id) };
    const paths = latestChildren.map((item) => item.result?.receipt?.relative_path || item.result?.local_path).filter(Boolean);
    if (paths.length !== plan.max_segments) return { state: 'waiting_review', reason: 'fallback_segment_receipt_missing', action: parent };
    const merged = await adapters.mergeVideoSegments(paths, { aspect_ratio: normalizeProductionAspectRatio(run.policy?.aspect_ratio) });
    const mergedReceipt = await adapters.validateVideo(merged.relative_path, {
      expected_aspect_ratio: normalizeProductionAspectRatio(run.policy?.aspect_ratio),
    });
    const finalBundle = bundle || currentArtifacts(db, run.id, 'reference_bundle').find((item) => item.scope_id === shot.scope_id);
    const artifact = repo.createArtifact(db, {
      run_id: run.id, stage: 'shot_video', scope_type: 'shot', scope_id: shot.scope_id,
      title: shot.title,
      content: {
        source_artifact_id: shot.id,
        bundle_artifact_id: finalBundle?.id || null,
        fallback: {
          plan_id: plan.plan_id, parent_action_id: parent.id,
          child_action_ids: latestChildren.map((item) => item.id),
          models: latestChildren.map((item) => item.request?.model),
          provider_durations: latestChildren.map(() => 15),
          continuity_mode: latestChildren[1]?.request?.fallback_continuity_mode || 'reference_continuation',
          original_failure: plan.trigger_category,
        },
        provider_generation_ids: latestChildren.map((item) => item.generation_id).filter(Boolean),
        validation: mergedReceipt,
        dispatch_transport: {
          first_frame: latestChildren[1]?.request?.first_frame_url || null,
          reference_images: latestChildren[1]?.request?.reference_image_urls || [],
          reference_videos: [], reference_audios: latestChildren[1]?.request?.reference_audio_urls || [],
        },
        included: true,
      },
      status: 'draft', media_path: mergedReceipt.relative_path, mime_type: 'video/mp4',
      content_hash: mergedReceipt.sha256, source_action_id: parent.id,
      depends_on: [shot.id, ...(finalBundle?.id ? [finalBundle.id] : [])],
    });
    repo.updateAction(db, parent.id, { status: 'completed', result: { ...(parent.result || {}), artifact_id: artifact.id, merged_receipt: mergedReceipt } });
    repo.releaseFallbackBudget(db, run.id, plan.parent_action_key, 'fallback_converged');
    repo.updateRun(db, run.id, { status: 'running', waiting_reason: null, error_code: null, error_message: null });
    return { state: 'progressed', reason: 'video_fallback_converged', action: repo.getAction(db, parent.id), artifact };
  }

  function fixedDurationExecutionPlanForAction(action) {
    const plan = action?.result?.fixed_duration_execution_plan;
    return plan && typeof plan === 'object' && Number(plan.execution_unit_count) > 1 ? plan : null;
  }

  function fixedDurationExecutionParent(runId, shot) {
    return repo.listActions(db, runId, { page_size: 200 }).items.find((item) => (
      item.kind === 'video_execution_parent'
      && item.scope_type === 'shot'
      && item.scope_id === String(shot.scope_id)
      && Number(item.request?.source_artifact_id) === Number(shot.id)
      && fixedDurationExecutionPlanForAction(item)
    )) || null;
  }

  function createFixedDurationExecutionParent(run, shot, bundle, route, request) {
    const count = Math.max(2, Number(route.execution_unit_count) || 2);
    const unitDuration = Math.max(1, Number(route.provider_duration || route.duration) || 1);
    const parentKey = `shot_video_execution:shot:${shot.scope_id}:source-r${shot.revision}:bundle-${bundle.id}:${routingBindingSignature(route)}`;
    const existing = repo.getActionByKey(db, run.id, parentKey);
    if (existing) return existing;
    const plan = {
      version: 1,
      plan_id: `${parentKey}:plan`,
      planned_duration: Number(route.planned_duration || shot.content?.duration || unitDuration * count),
      provider_duration: unitDuration,
      execution_unit_count: count,
      execution_unit_durations: Array.from({ length: count }, () => unitDuration),
      continuity: {
        preferred: 'previous_segment_tail_frame',
        fallback: 'ordinary_reference_or_hard_cut',
        truthful_when_strict_first_frame_unsupported: true,
      },
      segments: Array.from({ length: count }, (_, index) => ({
        index: index + 1,
        action_key: `${parentKey}:segment-${index + 1}`,
        duration: unitDuration,
        depends_on_segment: index === 0 ? null : index,
      })),
    };
    const reserved = repo.reserveAction(db, {
      run_id: run.id,
      action_key: parentKey,
      stage: 'shot_video',
      scope_type: 'shot',
      scope_id: shot.scope_id,
      kind: 'video_execution_parent',
      attempt: repo.nextActionAttempt(db, run.id, 'shot_video', 'shot', shot.scope_id, 'video_execution_parent'),
      request: {
        source_artifact_id: shot.id,
        bundle_artifact_id: bundle.id,
        model: route.model,
        routing_receipt: routingReceiptForRoute(route),
        routing_material_signature: routingMaterialSignature(route),
        routing_binding_signature: routingBindingSignature(route),
        request_template: request,
      },
      reserved_video_seconds: 0,
    }).action;
    if (fixedDurationExecutionPlanForAction(reserved)) return reserved;
    return repo.updateAction(db, reserved.id, {
      status: 'waiting',
      result: {
        ...(reserved.result || {}),
        fixed_duration_execution_plan: plan,
        source_artifact_id: shot.id,
        bundle_artifact_id: bundle.id,
        paid_submission: false,
        workflow_parent_only: true,
      },
    });
  }

  async function submitFixedDurationExecutionSegment({ run, shot, bundle, parent, plan, segment, tailFrame = null }) {
    const segmentActions = repo.listActions(db, run.id, { page_size: 200 }).items
      .filter((item) => item.parent_action_id === parent.id
        && item.kind === 'video_generate'
        && Number(item.segment_index) === Number(segment.index))
      .sort((left, right) => Number(right.id || 0) - Number(left.id || 0));
    const existing = segmentActions[0] || null;
    const existingRetryable = existing
      && ['failed', 'cancelled'].includes(existing.status)
      && existing.result?.retry_authorized === true;
    if (existing && !existingRetryable) {
      return {
        state: ['reserved', 'submitted', 'waiting'].includes(existing.status)
          ? 'waiting_provider'
          : existing.status === 'completed' ? 'progressed' : 'waiting_review',
        action: existing, shot,
      };
    }
    const template = parent.request?.request_template || {};
    const route = {
      ...(parent.request?.routing_receipt || {}),
      capability: capabilityForRoute(parent.request?.routing_receipt || {}),
    };
    const capability = capabilityForRoute(route);
    const tailPath = String(tailFrame?.path || tailFrame?.relative_path || tailFrame?.media_path || '').trim();
    const supportsStrict = tailPath && capabilitySupportsRole(capability, 'image', 'first_frame');
    const referenceImages = Array.isArray(template.reference_image_urls)
      ? [...template.reference_image_urls]
      : [];
    if (tailPath && !supportsStrict) referenceImages.unshift(tailPath);
    const request = {
      ...template,
      duration: Number(segment.duration),
      first_frame_url: supportsStrict ? tailPath : undefined,
      reference_image_urls: [...new Set(referenceImages.filter(Boolean))],
      transition_mode: tailPath
        ? (supportsStrict ? 'strict_continuation' : 'reference_continuation')
        : template.transition_mode,
      fixed_execution_parent_action_id: parent.id,
      fixed_execution_parent_action_key: parent.action_key,
      fixed_execution_plan_id: plan.plan_id,
      fixed_execution_segment_index: segment.index,
      fixed_execution_continuity_mode: tailPath
        ? (supportsStrict ? 'strict_first_frame' : 'ordinary_reference')
        : 'original_bundle',
      prompt: `${String(template.prompt || '').trim()}\n\n连续执行片段 ${segment.index}/${plan.execution_unit_count}：这是同一逻辑镜头的一部分。保持人物身份、脸部、发型、服装、颜色、场景、道具、光线和运动方向连续；不要重新设计主体，不要加入遮挡式转场。${tailPath ? '从上一段真实尾帧的状态继续动作。' : '从已确认参考包建立开场状态。'}`,
    };
    const dispatchReceipt = assertVideoDispatchContract({ run, shot, route, bundle, request });
    acceptanceSafety.assertVideoSubmitAllowed({
      entry: 'production_fixed_duration_segment', run_id: run.id,
      shot_id: shot.scope_id, model: request.model || null, segment_index: segment.index,
    });
    const unitEstimate = Number(route.estimated_unit_price);
    const totalEstimate = Number(route.estimated_price);
    const costRoute = {
      ...route,
      execution_unit_count: 1,
      estimated_price: Number.isFinite(unitEstimate)
        ? unitEstimate
        : Number.isFinite(totalEstimate) ? totalEstimate / Math.max(1, plan.execution_unit_count) : null,
    };
    const attempt = repo.nextActionAttempt(db, run.id, 'shot_video', 'shot', shot.scope_id, 'video_generate');
    const actionKey = existingRetryable
      ? `${segment.action_key}:retry-${attempt}`
      : segment.action_key;
    const action = repo.reserveAction(db, {
      run_id: run.id,
      action_key: actionKey,
      stage: 'shot_video', scope_type: 'shot', scope_id: shot.scope_id,
      kind: 'video_generate',
      attempt,
      request,
      parent_action_id: parent.id,
      parent_action_key: parent.action_key,
      segment_index: segment.index,
      reserved_video_seconds: Number(segment.duration),
      cost: accounting.videoReservation(db, run, request, costRoute),
    }).action;
    if (action.status !== 'reserved') return { state: 'waiting_provider', action, shot };
    repo.updateAction(db, action.id, { status: 'submitted' });
    let created;
    try {
      created = await adapters.createVideo(request);
    } catch (error) {
      const failed = repo.updateAction(db, action.id, {
        status: 'failed', error_code: error.code || 'VIDEO_SEGMENT_CREATE_FAILED',
        error_message: error.message, cost_status: 'released',
        result: { fixed_execution_plan_id: plan.plan_id, segment_index: segment.index, dispatch_receipt: dispatchReceipt },
      });
      return { state: 'waiting_review', reason: 'fixed_duration_segment_create_failed', action: failed, shot };
    }
    const waiting = repo.updateAction(db, action.id, {
      status: 'waiting', task_id: created.task_id, generation_id: created.id,
      result: {
        fixed_execution_plan_id: plan.plan_id,
        fixed_execution_segment_index: segment.index,
        parent_action_id: parent.id,
        source_artifact_id: shot.id,
        bundle_artifact_id: bundle.id,
        dispatch_receipt: assertVideoDispatchContract({
          run, shot, route, bundle, request, persistedModel: created.model || null,
        }),
      },
    });
    repo.updateRun(db, run.id, { status: 'waiting_provider', waiting_reason: `video_execution_segment_${segment.index}` });
    return { state: 'waiting_provider', action: waiting, shot, execution_segment: segment };
  }

  async function advanceFixedDurationExecution(run, shot, bundle, parent) {
    const plan = fixedDurationExecutionPlanForAction(parent);
    if (!plan) return null;
    const children = repo.listActions(db, run.id, { page_size: 200 }).items
      .filter((item) => item.parent_action_key === parent.action_key && item.kind === 'video_generate')
      .sort((left, right) => Number(left.segment_index || 0) - Number(right.segment_index || 0));
    for (const segment of plan.segments) {
      let child = children
        .filter((item) => Number(item.segment_index) === Number(segment.index))
        .sort((left, right) => Number(right.id || 0) - Number(left.id || 0))[0];
      if (!child) {
        const predecessor = Number(segment.index) > 1
          ? children.find((item) => Number(item.segment_index) === Number(segment.index) - 1 && item.status === 'completed')
          : null;
        if (Number(segment.index) > 1 && !predecessor?.result?.tail_frame) {
          return { state: 'waiting_review', reason: 'fixed_duration_predecessor_frame_missing', action: parent, shot };
        }
        return submitFixedDurationExecutionSegment({
          run, shot, bundle, parent, plan, segment, tailFrame: predecessor?.result?.tail_frame || null,
        });
      }
      if (['failed', 'ambiguous', 'cancelled'].includes(child.status)) {
        if (child.result?.retry_authorized === true && ['failed', 'cancelled'].includes(child.status)) {
          const predecessor = Number(segment.index) > 1
            ? children
              .filter((item) => Number(item.segment_index) === Number(segment.index) - 1 && item.status === 'completed')
              .sort((left, right) => Number(right.id || 0) - Number(left.id || 0))[0]
            : null;
          if (Number(segment.index) > 1 && !predecessor?.result?.tail_frame) {
            return { state: 'waiting_review', reason: 'fixed_duration_predecessor_frame_missing', action: parent, shot };
          }
          return submitFixedDurationExecutionSegment({
            run: repo.getRun(db, run.id), shot, bundle, parent, plan, segment,
            tailFrame: predecessor?.result?.tail_frame || null,
          });
        }
        repo.updateRun(db, run.id, {
          status: 'waiting_review', waiting_reason: 'fixed_duration_segment_failed',
          error_code: child.error_code || 'VIDEO_SEGMENT_GENERATION_FAILED',
          error_message: child.error_message || `第 ${segment.index} 个视频执行片段未完成，后续片段未提交`,
        });
        return { state: 'waiting_review', reason: 'fixed_duration_segment_failed', action: child, shot };
      }
      if (['reserved', 'submitted', 'waiting'].includes(child.status)) {
        const generation = child.generation_id ? await adapters.getVideo(child.generation_id) : null;
        if (!generation || ['pending', 'processing'].includes(generation.status)) {
          repo.updateRun(db, run.id, { status: 'waiting_provider', waiting_reason: `video_execution_segment_${segment.index}` });
          return { state: 'waiting_provider', reason: `video_execution_segment_${segment.index}`, action: child, generation, shot };
        }
        if (generation.status !== 'completed') {
          child = failVideoActionFromGeneration(child, generation, {
            error_code: 'VIDEO_SEGMENT_GENERATION_FAILED',
            error_message: generation.error_msg || generation.error_message || `第 ${segment.index} 个视频执行片段生成失败`,
          });
          repo.updateRun(db, run.id, {
            status: 'waiting_review', waiting_reason: 'fixed_duration_segment_failed',
            error_code: child.error_code, error_message: child.error_message,
          });
          return { state: 'waiting_review', reason: 'fixed_duration_segment_failed', action: child, generation, shot };
        }
        const receipt = await adapters.validateVideo(generation.local_path || generation.video_url, {
          expected_duration: Number(segment.duration),
          duration_tolerance: Math.max(1.2, Number(segment.duration) * 0.25),
          expected_aspect_ratio: normalizeProductionAspectRatio(run.policy?.aspect_ratio),
        });
        const tailFrame = Number(segment.index) < Number(plan.execution_unit_count)
          ? await adapters.extractContinuityFrame(receipt.relative_path, {
            run_id: run.id, shot_scope_id: shot.scope_id,
            source_action_id: child.id, source_hash: receipt.sha256,
          })
          : null;
        child = repo.updateAction(db, child.id, {
          status: 'completed', error_code: null, error_message: null,
          result: { ...(child.result || {}), receipt, local_path: receipt.relative_path, ...(tailFrame ? { tail_frame: tailFrame } : {}) },
        });
        const currentIndex = children.findIndex((item) => item.id === child.id);
        if (currentIndex >= 0) children[currentIndex] = child;
      }
    }
    const completed = children.filter((item) => item.status === 'completed');
    if (completed.length !== Number(plan.execution_unit_count)) {
      return { state: 'waiting_provider', reason: 'video_execution_segments', action: parent, shot };
    }
    if (parent.result?.artifact_id) {
      return { state: 'progressed', reason: 'fixed_duration_execution_converged', action: parent, artifact: repo.getArtifact(db, parent.result.artifact_id) };
    }
    const paths = completed.map((item) => item.result?.receipt?.relative_path || item.result?.local_path).filter(Boolean);
    const merged = await adapters.mergeVideoSegments(paths, { aspect_ratio: normalizeProductionAspectRatio(run.policy?.aspect_ratio) });
    const mergedReceipt = await adapters.validateVideo(merged.relative_path, {
      expected_duration: Number(plan.planned_duration),
      duration_tolerance: Math.max(2, Number(plan.provider_duration) * 0.25),
      expected_aspect_ratio: normalizeProductionAspectRatio(run.policy?.aspect_ratio),
    });
    const artifact = repo.createArtifact(db, {
      run_id: run.id, stage: 'shot_video', scope_type: 'shot', scope_id: shot.scope_id,
      title: shot.title,
      content: {
        source_artifact_id: shot.id, bundle_artifact_id: bundle.id,
        fixed_duration_execution: {
          plan_id: plan.plan_id, parent_action_id: parent.id,
          child_action_ids: completed.map((item) => item.id),
          provider_generation_ids: completed.map((item) => item.generation_id).filter(Boolean),
          planned_duration: plan.planned_duration,
          provider_duration: plan.provider_duration,
          execution_unit_count: plan.execution_unit_count,
          continuity_mode: completed.slice(1).map((item) => item.request?.fixed_execution_continuity_mode),
        },
        validation: mergedReceipt, included: true,
      },
      status: 'draft', media_path: mergedReceipt.relative_path, mime_type: 'video/mp4',
      content_hash: mergedReceipt.sha256, source_action_id: parent.id,
      depends_on: [shot.id, bundle.id],
    });
    const completedParent = repo.updateAction(db, parent.id, {
      status: 'completed', result: { ...(parent.result || {}), artifact_id: artifact.id, merged_receipt: mergedReceipt },
    });
    repo.updateRun(db, run.id, { status: 'running', waiting_reason: null, error_code: null, error_message: null });
    return { state: 'progressed', reason: 'fixed_duration_execution_converged', action: completedParent, artifact, shot };
  }

  async function ensureShotVideos(run) {
    const shots = scopeShotItems(
      approvedIncluded(db, run.id, 'storyboard_plan').sort(compareShots),
      run
    );
    const targets = currentArtifacts(db, run.id, 'shot_video');
    for (const shot of shots) {
      const target = targets.find((item) => item.scope_id === shot.scope_id);
      const plannedImported = run.policy?.execution_plan?.shots?.find((item) => (
        Number(item.number) === Number(shot.content?.number || shot.scope_id)
        && item.source === 'imported_clip'
      ));
      if (plannedImported) {
        const importedTarget = target || (plannedImported.artifact_id ? repo.getArtifact(db, plannedImported.artifact_id) : null);
        if (importedTarget?.status === 'approved' && importedTarget.media_path && importedTarget.content?.imported === true) {
          // Imported clips are already finished timeline material. They still
          // participate in continuity and final-edit dependency checks, but
          // must never create a paid video-generation action.
          continue;
        }
      }
      if (artifactMatchesSource(target, shot)) continue;
      const rejectedTarget = target && ['rejected', 'failed', 'invalidated'].includes(target.status);
      const fixedExecutionParent = fixedDurationExecutionParent(run.id, shot);
      if (fixedExecutionParent) {
        const fixedBundleId = Number(fixedExecutionParent.request?.bundle_artifact_id || 0);
        const fixedBundle = fixedBundleId > 0
          ? repo.getArtifact(db, fixedBundleId)
          : currentArtifacts(db, run.id, 'reference_bundle').find((item) => item.scope_id === shot.scope_id);
        if (!fixedBundle || fixedBundle.status !== 'approved') {
          return { state: 'waiting_review', reason: 'fixed_duration_reference_bundle_missing', action: fixedExecutionParent, shot };
        }
        return advanceFixedDurationExecution(repo.getRun(db, run.id), shot, fixedBundle, fixedExecutionParent);
      }
      let action = repo.getLatestAction(db, run.id, {
        stage: 'shot_video', scope_type: 'shot', scope_id: shot.scope_id, kind: 'video_generate',
      });
      if (action && !action.parent_action_id && ['failed', 'cancelled'].includes(action.status)
        && !action.result?.retry_authorized) {
        // Re-resolve the live route before reusing a terminal action.  This is
        // the missing link behind the old "I changed the model but retry still
        // called the old one" bug: settings changes happen outside the run
        // route picker, so the old action must be compared with the current
        // catalog/config identity here as well.
        let liveRoute = null;
        try {
          liveRoute = await resolveShotVideoRoute(repo.getRun(db, run.id), shot);
        } catch (error) {
          log.warn?.('Could not refresh live video route while checking failed action', {
            run_id: run.id, shot: shot.scope_id, error: error.message,
          });
        }
        const liveConfig = videoConfigForRun(db, repo.getRun(db, run.id), shot);
        const liveIdentity = identityForConfig(liveConfig);
        const previousIdentity = identityFromSnapshot({
          ...(action.request || {}),
          ...(action.request?.routing_receipt || {}),
        });
        const configuredModel = configuredVideoModelForShot(repo.getRun(db, run.id), shot);
        const previousModel = String(action.request?.model || action.request?.routing_receipt?.model || '').trim();
        const localConfigChanged = previousIdentity && liveIdentity
          ? !sameIdentity(previousIdentity, liveIdentity)
          : (Number(action.request?.video_config_id || 0) > 0
            && liveIdentity?.id != null
            && Number(action.request.video_config_id) !== Number(liveIdentity.id));
        const modelChanged = Boolean(configuredModel && previousModel && configuredModel !== previousModel);
        if (liveRoute && videoActionRouteChanged(action, liveRoute)) {
          action = supersedeTerminalVideoAction(db, action, liveRoute, 'live_model_or_config_changed');
        } else if (localConfigChanged || modelChanged) {
          action = repo.updateAction(db, action.id, {
            status: 'cancelled',
            result: {
              ...(action.result || {}),
              superseded_by_route_change: true,
              retry_authorized: true,
              retry_reason: 'live_model_or_config_changed',
              superseded_at: new Date().toISOString(),
            },
          });
        }
      }
      const explicitRetryGrant = action?.status === 'cancelled' && action.result?.retry_authorized === true;
      if (explicitRetryGrant) action = null;
      const selection = selectGenerationAction(action, shot, rejectedTarget, {
        cancelReserved(staleAction) {
          return repo.updateAction(db, staleAction.id, {
            status: 'cancelled',
            result: {
              ...(staleAction.result || {}),
              source_artifact_id: staleAction.request?.source_artifact_id || null,
              superseded_by_source_change: true,
              superseded_by_artifact_id: shot.id,
              superseded_before_submission: true,
            },
          });
        },
      });
      if (selection.blocked) {
        const reason = selection.blocked === 'ambiguous_external_create'
          ? 'ambiguous_video_create'
          : selection.blocked;
        const blockedAction = selection.blocked === 'ambiguous_external_create'
          ? repo.updateAction(db, selection.action.id, {
            status: 'ambiguous', error_code: 'VIDEO_CREATE_AMBIGUOUS',
            error_message: '旧视频创建请求已经外发但没有任务 ID，无法确认是否扣费，禁止自动重提',
            result: {
              ...(selection.action.result || {}),
              superseded_by_source_change: true,
              superseded_by_artifact_id: shot.id,
            },
          })
          : selection.action;
        return { state: 'waiting_review', reason, action: blockedAction, shot };
      }
      action = selection.action;
      let actionSourceChanged = selection.sourceChanged === true;
      // Cancellation controls are intentionally terminal for the local
      // observer.  Keep the provider task id and accounting receipt readable,
      // but do not call getVideo(), create another child segment, or resume a
      // fallback chain until the user explicitly resumes/retries the action.
      if (actionStoppedLocally(action)) {
        const reason = action.result?.provider_cancel_confirmed === true
          ? 'provider_cancelled_pending_refund'
          : 'local_observation_stopped';
        return { state: 'waiting_review', reason, action, shot };
      }
      // Resume an existing Seedance fallback chain before considering the
      // legacy single-action path. This is important after a browser refresh:
      // the latest action may be a child segment, while the parent owns the
      // immutable plan and final logical-shot artifact.
      if (action && (action.parent_action_id || fallbackPlanForAction(action))) {
        const parentAction = action.parent_action_id ? repo.getAction(db, action.parent_action_id) : action;
        const parentBundleId = Number(parentAction?.request?.bundle_artifact_id || action.request?.bundle_artifact_id || 0);
        const fallbackBundle = parentBundleId > 0
          ? repo.getArtifact(db, parentBundleId)
          : currentArtifacts(db, run.id, 'reference_bundle').find((item) => item.scope_id === shot.scope_id);
        const childGeneration = action.parent_action_id && action.generation_id
          ? await adapters.getVideo(action.generation_id)
          : null;
        if (action.status === 'failed' && !action.parent_action_id && !fallbackPlanForAction(action)) {
          // The parent is handled by the normal provider poll below so that
          // its immutable failure receipt is available to the classifier.
        } else {
          const advanced = await advanceSeedanceFallback(repo.getRun(db, run.id), shot, fallbackBundle, action, childGeneration);
          if (advanced) return advanced;
        }
      }
      let route = action?.request?.routing_receipt
        ? {
          ...action.request.routing_receipt,
          capability: capabilityForRoute(action.request.routing_receipt),
        }
        : null;
      let model = route?.model || '';
      let capability = capabilityForRoute(route);
      let duration = Number(route?.duration || shot.content.duration);
      if (!action) {
        const bundleState = await ensureReferenceBundleForShot(run, shot);
        let bundle = bundleState.artifact;
        route = bundleState.route;
        model = route?.model || '';
        capability = capabilityForRoute(route);
        duration = Number(route?.duration || shot.content.duration);
        if (!model) throw new Error(`镜头 ${shot.scope_id} 没有可用的视频模型`);
        if (!bundle) throw new Error(`Shot ${shot.scope_id} is missing a reference bundle`);
        if (bundleState.state === 'refreshed' || bundle.status !== 'approved') {
          const reason = bundleState.state === 'refreshed'
            ? 'reference_bundle_stale'
            : 'reference_bundle_review_required';
          const bindingChanges = bundleState.comparison?.changed || [];
          const changeSummary = bindingChanges.length
            ? `变化字段：${bindingChanges.map((item) => item.label || item.field).slice(0, 6).join('、')}`
            : '请确认参考包状态和素材依赖';
          repo.updateRun(db, run.id, {
            current_stage: 'reference_bundle',
            current_scope_type: 'shot',
            current_scope_id: String(shot.scope_id),
            status: 'waiting_review',
            waiting_reason: reason,
            error_code: bundleState.state === 'refreshed' ? 'STALE_REFERENCE_BUNDLE' : null,
            error_message: bundleState.state === 'refreshed'
              ? `参考包绑定发生变化，已退回可见审批步骤，未提交视频。${changeSummary}`
              : null,
          });
          repo.appendEvent(db, run.id, 'reference_bundle.review_required', {
            stage: 'reference_bundle', scope_type: 'shot', scope_id: shot.scope_id,
            payload: { artifact_id: bundle.id, reason, binding_changes: bindingChanges },
          });
          return { state: 'waiting_review', reason, artifact: bundle, shot };
        }
        const attempt = repo.nextActionAttempt(db, run.id, 'shot_video', 'shot', shot.scope_id, 'video_generate');
        const sourceAttempt = sourceGenerationAttemptCount(db, run.id, 'shot_video', shot, 'video_generate') + 1;
        if (sourceAttempt > Number(run.budget?.max_video_attempts_per_shot || 2) && !explicitRetryGrant) {
          return { state: 'waiting_review', reason: 'shot_video_attempt_limit', shot, target };
        }
        const key = actionKey('shot_video', shot, attempt);
        const retryEvidence = rejectedVideoEvidence(db, run, shot);
        const promptPlan = await ensureVideoPromptPlan(run, shot, attempt, retryEvidence);
        if (promptPlan.state === 'planned') {
          repo.updateRun(db, run.id, {
            status: 'running', waiting_reason: null, error_code: null, error_message: null,
          });
          return { state: 'progressed', reason: 'video_prompt_planned', action: promptPlan.action, shot };
        }
        if (promptPlan.state !== 'ready') return { ...promptPlan, shot };

        // Catalog and prompt planning are awaited operations. Reload both the
        // run and bundle after them so a concurrent model switch cannot submit
        // the route snapshot captured before the await.
        const validationRun = repo.getRun(db, run.id);
        const validationVersion = Number(validationRun.version);
        const validatedBundleState = await ensureReferenceBundleForShot(validationRun, shot);
        const dispatchRun = repo.getRun(db, run.id);
        const currentBundle = currentArtifacts(db, run.id, 'reference_bundle')
          .find((item) => item.scope_id === shot.scope_id);
        const dispatchStateChanged = Number(dispatchRun.version) !== validationVersion;
        const validatedBundle = validatedBundleState.artifact;
        if (dispatchStateChanged
          || validatedBundleState.state === 'refreshed'
          || !validatedBundle
          || validatedBundle.status !== 'approved'
          || Number(validatedBundle.id) !== Number(bundle.id)) {
          const reviewBundle = currentBundle || validatedBundle || bundle;
          repo.updateRun(db, run.id, {
            current_stage: 'reference_bundle',
            current_scope_type: 'shot',
            current_scope_id: String(shot.scope_id),
            status: 'waiting_review',
            waiting_reason: 'video_dispatch_state_changed',
            error_code: 'VIDEO_DISPATCH_STATE_CHANGED',
            error_message: '视频模型或参考包在提交前发生变化，已停止旧请求并退回参考包核对；未提交视频',
          });
          repo.appendEvent(db, run.id, 'video.dispatch_revalidation_blocked', {
            stage: 'shot_video', scope_type: 'shot', scope_id: shot.scope_id,
            payload: {
              previous_bundle_artifact_id: bundle?.id || null,
              current_bundle_artifact_id: reviewBundle?.id || null,
              previous_model: model || null,
              current_model: validatedBundleState.route?.model || null,
              run_version_changed: dispatchStateChanged,
              paid_submission: false,
            },
          });
          return {
            state: 'waiting_review',
            reason: 'video_dispatch_state_changed',
            artifact: reviewBundle,
            shot,
          };
        }
        bundle = validatedBundle;
        route = validatedBundleState.route;
        model = route?.model || '';
        capability = capabilityForRoute(route);
        duration = Number(route?.duration || shot.content.duration);
        if (!model) throw new Error(`镜头 ${shot.scope_id} 没有可用的视频模型`);
        const dispatchRefs = bundle.content || {};
        const dispatchLimits = dispatchRefs.limits || route.limits || {};
        const dispatchWarnings = [
          ...(Array.isArray(route.contract_warnings) ? route.contract_warnings : []),
          ...(Array.isArray(dispatchRefs.reference_warnings) ? dispatchRefs.reference_warnings : []),
        ];
        for (const [key, warning] of [['images', 'image_count_over_contract'], ['videos', 'video_count_over_contract'], ['audios', 'audio_count_over_contract']]) {
          if (Number.isFinite(Number(dispatchLimits[key])) && (dispatchRefs[key] || []).length > Number(dispatchLimits[key])) dispatchWarnings.push(warning);
        }
        if (!(dispatchRefs.images || []).length) dispatchWarnings.push('reference_image_missing');
        if (route.uses_reference_video && !(dispatchRefs.videos || []).length) dispatchWarnings.push('reference_video_missing');
        if (!route.uses_reference_video && (dispatchRefs.videos || []).length) dispatchWarnings.push('reference_video_not_declared');
        const transitionMode = transitionModeForShot(shot);
        const strictFirstFrame = (dispatchRefs.images || []).find((item) => item.role === 'first_frame');
        const continuityReference = (dispatchRefs.images || []).find((item) => item.source === 'continuity_first_frame');
        if (transitionMode === 'strict_continuation' && !strictFirstFrame?.path) dispatchWarnings.push('strict_first_frame_missing');
        if (transitionMode === 'reference_continuation' && !continuityReference?.path) dispatchWarnings.push('continuity_frame_missing');
        if (strictFirstFrame && !capabilitySupportsRole(capability, 'image', 'first_frame')) dispatchWarnings.push('strict_first_frame_unsupported');
        if (route.requires_director_preview && !(dispatchRefs.videos || []).length) dispatchWarnings.push('director_preview_missing');
        const promptPackage = buildProviderPromptPackage(
          db,
          dispatchRun,
          shot,
          bundle,
          promptPlan.plan.provider_prompt,
          capability
        );
        const dispatchConfig = videoConfigForRun(db, dispatchRun, shot);
        const dispatchConfigIdentity = identityForConfig(dispatchConfig);
        const request = {
          drama_id: dispatchRun.drama_id,
          provider: dispatchRun.policy?.video_provider || 'yinzi',
          video_config_id: dispatchConfigIdentity?.id || dispatchRun.policy?.video_config_id || null,
          video_config_identity_version: dispatchConfigIdentity?.version || null,
          video_config_updated_at: dispatchConfigIdentity?.updated_at || null,
          video_config_fingerprint: dispatchConfigIdentity?.fingerprint || null,
          contract_validation_mode: 'advisory',
          model,
          duration,
          aspect_ratio: dispatchRun.policy?.aspect_ratio || '16:9',
          resolution: dispatchRun.policy?.video_resolution || capability?.resolution || '480p',
          prompt: promptPackage.prompt,
          prompt_contract: promptPackage.receipt,
          prompt_plan_action_id: promptPlan.action?.id || undefined,
          failure_memory: promptPlan.plan.failure_memory || undefined,
          retry_evidence: retryEvidence.length ? retryEvidence : undefined,
          bundle_artifact_id: bundle.id,
          transition_mode: transitionMode,
          watermark: false,
          first_frame_url: strictFirstFrame?.path,
          reference_image_urls: (dispatchRefs.images || [])
            .filter((item) => transitionMode !== 'strict_continuation' || item.role !== 'first_frame')
            .map((item) => item.path),
          reference_video_urls: (dispatchRefs.videos || []).map((item) => item.path),
          reference_audio_urls: (dispatchRefs.audios || []).map((item) => item.path),
          reference_video_budget: dispatchRefs.reference_video_budget || null,
          reference_warnings: [...new Set(dispatchWarnings)],
          routing_receipt: routingReceiptForRoute(route),
          routing_material_signature: routingMaterialSignature(route),
          routing_binding_signature: routingBindingSignature(route),
        };
        const dispatchReceipt = assertVideoDispatchContract({
          run: dispatchRun, shot, route, bundle, request,
        });
        if (Number(route.execution_unit_count || 1) > 1) {
          const parent = createFixedDurationExecutionParent(dispatchRun, shot, bundle, route, request);
          return advanceFixedDurationExecution(dispatchRun, shot, bundle, parent);
        }
        acceptanceSafety.assertVideoSubmitAllowed({
          entry: 'production_shot_video',
          run_id: run.id,
          shot_id: shot.scope_id,
          model: request.model || null,
        });
        action = repo.reserveAction(db, {
          run_id: run.id, action_key: key, stage: 'shot_video', scope_type: 'shot', scope_id: shot.scope_id,
          kind: 'video_generate', attempt, request, reserved_video_seconds: duration,
          cost: accounting.videoReservation(db, dispatchRun, request, route),
        }).action;
        // One last local read closes the race between route resolution and
        // provider submission.  If the settings page changed the selected
        // video config meanwhile, release this reservation and let the next
        // progression build a request from the new live snapshot.
        const liveBeforeSubmitRun = repo.getRun(db, run.id);
        const liveBeforeSubmitConfig = videoConfigForRun(db, liveBeforeSubmitRun, shot);
        const liveBeforeSubmitIdentity = identityForConfig(liveBeforeSubmitConfig);
        const requestIdentity = identityFromSnapshot(request);
        const liveModel = configuredVideoModelForShot(liveBeforeSubmitRun, shot);
        const submitConfigChanged = requestIdentity && liveBeforeSubmitIdentity
          ? !sameIdentity(requestIdentity, liveBeforeSubmitIdentity)
          : (Number(request.video_config_id || 0) > 0
            && liveBeforeSubmitIdentity?.id != null
            && Number(request.video_config_id) !== Number(liveBeforeSubmitIdentity.id));
        const submitModelChanged = Boolean(liveModel && request.model && liveModel !== request.model);
        if (submitConfigChanged || submitModelChanged) {
          const cancelled = repo.cancelReservedAction(db, action.id, {
            superseded_by_route_change: true,
            superseded_before_submission: true,
            retry_authorized: true,
            retry_reason: 'live_model_or_config_changed_before_submit',
          });
          repo.updateRun(db, run.id, {
            status: 'running', waiting_reason: null, error_code: null, error_message: null,
          });
          return { state: 'progressed', reason: 'video_config_changed_before_submit', action: cancelled, shot };
        }
        repo.updateAction(db, action.id, { status: 'submitted' });
        let created;
        try { created = await adapters.createVideo(request); }
        catch (error) {
          repo.updateAction(db, action.id, {
            status: 'failed', error_code: error.code || 'VIDEO_CREATE_FAILED', error_message: error.message,
            cost_status: 'released',
            result: {
              source_artifact_id: shot.id,
              bundle_artifact_id: bundle.id,
              routing_material_signature: routingMaterialSignature(route),
              routing_binding_signature: routingBindingSignature(route),
              dispatch_receipt: dispatchReceipt,
            },
          });
          throw error;
        }
        const persistedDispatchReceipt = assertVideoDispatchContract({
          run: dispatchRun,
          shot,
          route,
          bundle,
          request,
          persistedModel: created.model || null,
        });
        action = repo.updateAction(db, action.id, {
          status: 'waiting', task_id: created.task_id, generation_id: created.id,
          result: {
            source_artifact_id: shot.id,
            bundle_artifact_id: bundle.id,
            routing_material_signature: routingMaterialSignature(route),
            routing_binding_signature: routingBindingSignature(route),
            dispatch_receipt: persistedDispatchReceipt,
          },
        });
        repo.updateRun(db, run.id, { status: 'waiting_provider', waiting_reason: 'video_generation' });
        return { state: 'waiting_provider', action, shot };
      }
      if (!route) route = await resolveShotVideoRoute(repo.getRun(db, run.id), shot);
      model = route?.model || '';
      capability = capabilityForRoute(route);
      duration = Number(route?.duration || shot.content.duration);
      if (!model) throw new Error(`镜头 ${shot.scope_id} 没有可用的视频模型`);
      if (action.status === 'submitted' && !action.generation_id) {
        repo.updateAction(db, action.id, { status: 'ambiguous', error_code: 'VIDEO_CREATE_AMBIGUOUS', error_message: '视频创建结果不明确，禁止自动重提' });
        return { state: 'waiting_review', reason: 'ambiguous_video_create', action: repo.getAction(db, action.id) };
      }
      if (['reserved', 'submitted', 'waiting'].includes(action.status)) {
        const generation = action.generation_id ? await adapters.getVideo(action.generation_id) : null;
        action = repo.getAction(db, action.id) || action;
        if (actionIsDetachedFromSequence(action, shot)) {
          return settleDetachedVideoAction(action, generation, shot);
        }
        const liveShotAfterPoll = currentShotPlan(run.id, shot.scope_id);
        if (liveShotAfterPoll && Number(liveShotAfterPoll.id) !== Number(shot.id)) {
          actionSourceChanged = true;
        }
        const capturedBundleId = Number(action.result?.bundle_artifact_id ?? action.request?.bundle_artifact_id);
        const liveRun = repo.getRun(db, run.id);
        const liveBundle = currentArtifacts(db, run.id, 'reference_bundle')
          .find((item) => item.scope_id === shot.scope_id);
        const configuredModel = configuredVideoModelForShot(liveRun, shot);
        const dispatchedModel = String(action.request?.model || action.request?.routing_receipt?.model || '').trim();
        const actionRouteSuperseded = (Number.isInteger(capturedBundleId)
          && liveBundle
          && Number(liveBundle.id) !== capturedBundleId)
          || (configuredModel && dispatchedModel && configuredModel !== dispatchedModel)
          || actionSourceChanged;
        if (!generation || ['pending', 'processing'].includes(generation.status)) {
          if (generation?.provider_task_id && generation.provider_task_id !== action.provider_id) {
            action = repo.updateAction(db, action.id, { status: 'waiting', provider_id: generation.provider_task_id });
          }
          const waitingReason = actionRouteSuperseded ? 'superseded_video_waiting' : 'video_generation';
          if (liveRun.status !== 'waiting_provider' || liveRun.waiting_reason !== waitingReason) {
            repo.updateRun(db, run.id, { status: 'waiting_provider', waiting_reason: waitingReason });
          }
          return {
            state: 'waiting_provider',
            reason: actionRouteSuperseded ? 'superseded_video_waiting' : 'video_generation',
            action,
            generation,
          };
        }
        if (generation.status !== 'completed' && !actionRouteSuperseded) {
          const errorMessage = generation.error_msg || '视频生成失败';
          const failedAction = failVideoActionFromGeneration(action, generation, {
            error_code: 'VIDEO_GENERATION_FAILED',
            error_message: errorMessage,
          });
          const fallback = await advanceSeedanceFallback(
            repo.getRun(db, run.id), shot, liveBundle || null, failedAction, generation
          );
          if (fallback) return fallback;
          const ambiguous = failedAction.status === 'ambiguous';
          const reason = ambiguous ? 'ambiguous_video_create' : 'video_generation_failed';
          const errorCode = ambiguous ? 'VIDEO_CREATE_AMBIGUOUS' : 'VIDEO_GENERATION_FAILED';
          repo.updateRun(db, run.id, {
            status: 'waiting_review', waiting_reason: reason,
            error_code: errorCode, error_message: errorMessage,
          });
          return { state: 'waiting_review', reason, generation, action: failedAction };
        }
        const completionRun = repo.getRun(db, run.id);
        const completionVersion = Number(completionRun.version);
        const bundleState = await ensureReferenceBundleForShot(completionRun, shot);
        action = repo.getAction(db, action.id) || action;
        if (actionIsDetachedFromSequence(action, shot)) {
          return settleDetachedVideoAction(action, generation, shot);
        }
        const afterBundleRun = repo.getRun(db, run.id);
        const bundle = currentArtifacts(db, run.id, 'reference_bundle')
          .find((item) => item.scope_id === shot.scope_id) || bundleState.artifact;
        const completionStateChanged = Number(afterBundleRun.version) !== completionVersion;
        const staleBundle = completionStateChanged
          || actionSourceChanged
          || !bundle
          || bundleState.state === 'refreshed'
          || bundle.status !== 'approved'
          || !Number.isInteger(capturedBundleId)
          || capturedBundleId !== Number(bundle.id);
        if (staleBundle) {
          const providerFailed = generation.status !== 'completed';
          const staleMessage = providerFailed
            ? (generation.error_msg || '旧模型视频生成失败；当前模型路由已变化，失败只保留为历史')
            : `Reference bundle changed before generation ${generation.id} completed`;
          if (providerFailed) {
            failVideoActionFromGeneration(action, generation, {
              error_code: 'SUPERSEDED_VIDEO_GENERATION_FAILED',
              error_message: staleMessage,
              result: {
                generation_id: generation.id,
                generation_status: generation.status,
                superseded_by_route_change: true,
                superseded_by_source_change: actionSourceChanged,
                superseded_by_artifact_id: actionSourceChanged ? shot.id : null,
                stale_bundle_artifact_id: Number.isInteger(capturedBundleId) ? capturedBundleId : null,
                current_bundle_artifact_id: bundle?.id || null,
              },
            });
          } else {
            repo.updateAction(db, action.id, {
              status: 'completed',
              error_code: null,
              error_message: null,
              result: {
              ...(action.result || {}),
              generation_id: generation.id,
              generation_status: generation.status,
              superseded_by_route_change: true,
              superseded_by_source_change: actionSourceChanged,
              superseded_by_artifact_id: actionSourceChanged ? shot.id : null,
              stale_bundle_artifact_id: Number.isInteger(capturedBundleId) ? capturedBundleId : null,
              current_bundle_artifact_id: bundle?.id || null,
            },
            });
          }
          repo.updateRun(db, run.id, {
            current_stage: bundle?.status === 'approved' ? 'shot_video' : 'reference_bundle',
            current_scope_type: 'shot', current_scope_id: String(shot.scope_id),
            status: 'running', waiting_reason: null, error_code: null, error_message: null,
          });
          repo.appendEvent(db, run.id, 'action.superseded_converged', {
            stage: 'shot_video', scope_type: 'shot', scope_id: shot.scope_id,
            payload: {
              action_id: action.id,
              generation_id: generation.id || action.generation_id || null,
              generation_status: generation.status,
              source_changed: actionSourceChanged,
              old_bundle_artifact_id: Number.isInteger(capturedBundleId) ? capturedBundleId : null,
              current_bundle_artifact_id: bundle?.id || null,
            },
          });
          return { state: 'progressed', reason: 'superseded_video_converged', generation, bundle };
        }
        const completionDispatchReceipt = assertVideoDispatchContract({
          run: afterBundleRun,
          shot,
          route,
          bundle,
          request: action.request,
          persistedModel: generation.model || action.result?.dispatch_receipt?.persisted_generation_model || null,
        });
        const receipt = await adapters.validateVideo(generation.local_path || generation.video_url, {
          expected_duration: duration,
          duration_tolerance: Math.max(1.2, duration * 0.25),
          expected_aspect_ratio: normalizeProductionAspectRatio(afterBundleRun.policy?.aspect_ratio),
        });
        action = repo.getAction(db, action.id) || action;
        if (actionIsDetachedFromSequence(action, shot)) {
          return settleDetachedVideoAction(action, generation, shot, receipt);
        }
        const transitionMode = transitionModeForShot(shot);
        let boundaryValidation = { mode: transitionMode, evaluated: transitionMode === 'opening' ? false : true };
        if (transitionMode === 'strict_continuation') {
          const strictFirstFrame = (bundle.content?.images || []).find((item) => item.role === 'first_frame');
          try {
            boundaryValidation = await adapters.compareStrictFirstFrame(
              strictFirstFrame?.path,
              receipt.relative_path,
              { threshold: Number(afterBundleRun.policy?.strict_first_frame_similarity || 0.9) }
            );
          } catch (error) {
            boundaryValidation = { mode: transitionMode, passed: false, error: error.message };
          }
          if (!boundaryValidation?.passed) {
            const message = boundaryValidation.error
              || `生成视频首帧与指定严格首帧相似度 ${Number(boundaryValidation.similarity || 0).toFixed(4)} 未达到 ${Number(boundaryValidation.threshold || 0.9).toFixed(4)}`;
            repo.updateAction(db, action.id, {
              status: 'failed',
              error_code: 'STRICT_FIRST_FRAME_MISMATCH',
              error_message: message,
              result: { ...(action.result || {}), generation_id: generation.id, boundary_validation: boundaryValidation },
            });
            repo.updateRun(db, run.id, {
              status: 'waiting_review',
              waiting_reason: 'strict_first_frame_mismatch',
              error_code: 'STRICT_FIRST_FRAME_MISMATCH',
              error_message: message,
            });
            return { state: 'waiting_review', reason: 'strict_first_frame_mismatch', generation, boundary_validation: boundaryValidation };
          }
        } else if (transitionMode === 'reference_continuation') {
          const continuityReference = (bundle.content?.images || [])
            .find((item) => item.source === 'continuity_first_frame');
          try {
            const comparison = await adapters.compareStrictFirstFrame(
              continuityReference?.path,
              receipt.relative_path,
              { threshold: 0 }
            );
            boundaryValidation = {
              ...comparison,
              mode: 'reference_continuation',
              passed: undefined,
              threshold: undefined,
              informational_only: true,
              expected_frame_path: continuityReference?.path || comparison.expected_frame_path,
            };
          } catch (error) {
            boundaryValidation = {
              mode: 'reference_continuation',
              informational_only: true,
              probe_error: error.message,
            };
          }
        } else if (transitionMode === 'hard_cut' && bundle.content?.continuity_in_artifact_id) {
          const previousVideo = repo.getArtifact(db, bundle.content.continuity_in_artifact_id);
          if (previousVideo?.media_path) {
            try {
              boundaryValidation = await adapters.probeHardCutBoundary(previousVideo.media_path, receipt.relative_path);
            } catch (error) {
              boundaryValidation = { mode: transitionMode, informational_only: true, probe_error: error.message };
              log.warn?.('Hard-cut boundary probe could not be completed', {
                run_id: run.id, shot: shot.scope_id, error: error.message,
              });
            }
          }
        }
        action = repo.getAction(db, action.id) || action;
        if (actionIsDetachedFromSequence(action, shot)) {
          return settleDetachedVideoAction(action, generation, shot, receipt);
        }
        const finalRun = repo.getRun(db, run.id);
        const finalBundle = currentArtifacts(db, run.id, 'reference_bundle')
          .find((item) => item.scope_id === shot.scope_id);
        const finalConfiguredModel = configuredVideoModelForShot(finalRun, shot);
        const finalRouteChanged = !finalBundle
          || finalBundle.status !== 'approved'
          || Number(finalBundle.id) !== capturedBundleId
          || (finalConfiguredModel && finalConfiguredModel !== dispatchedModel);
        if (finalRouteChanged) {
          const staleMessage = `Reference bundle changed while validating generation ${generation.id}`;
          repo.updateAction(db, action.id, {
            status: 'completed',
            error_code: null,
            error_message: null,
            result: {
              ...(action.result || {}),
              dispatch_receipt: completionDispatchReceipt,
              generation_id: generation.id,
              superseded_by_route_change: true,
              stale_bundle_artifact_id: capturedBundleId,
              current_bundle_artifact_id: finalBundle?.id || null,
            },
          });
          repo.updateRun(db, run.id, {
            current_stage: finalBundle?.status === 'approved' ? 'shot_video' : 'reference_bundle',
            current_scope_type: 'shot', current_scope_id: String(shot.scope_id),
            status: 'running', waiting_reason: null, error_code: null, error_message: null,
          });
          repo.appendEvent(db, run.id, 'action.superseded_converged', {
            stage: 'shot_video', scope_type: 'shot', scope_id: shot.scope_id,
            payload: {
              action_id: action.id,
              generation_id: generation.id || action.generation_id || null,
              generation_status: generation.status,
              source_changed: false,
              old_bundle_artifact_id: capturedBundleId,
              current_bundle_artifact_id: finalBundle?.id || null,
            },
          });
          return { state: 'progressed', reason: 'superseded_video_converged', generation, bundle: finalBundle };
        }
        const artifact = repo.createArtifact(db, {
          run_id: run.id, stage: 'shot_video', scope_type: 'shot', scope_id: shot.scope_id,
          title: shot.title,
          content: {
            source_artifact_id: shot.id,
            bundle_artifact_id: bundle.id,
            provider_generation_id: generation.id,
            routing_receipt: action.request?.routing_receipt || null,
            routing_material_signature: action.request?.routing_material_signature || null,
            aspect_ratio: normalizeProductionAspectRatio(afterBundleRun.policy?.aspect_ratio),
            dispatch_transport: {
              first_frame: action.request?.first_frame_url || null,
              reference_images: action.request?.reference_image_urls || [],
              reference_videos: action.request?.reference_video_urls || [],
              reference_audios: action.request?.reference_audio_urls || [],
            },
            validation: receipt,
            boundary_validation: boundaryValidation,
            prompt_contract: generation.prompt_contract || action.request?.prompt_contract || null,
            provider_prompt_receipt: generation.provider_prompt_receipt || null,
            approval_blockers: generation.provider_prompt_receipt?.status === 'truncated'
              ? ['PROVIDER_PROMPT_TRUNCATED']
              : [],
            included: true,
          },
          status: 'draft', media_path: receipt.relative_path, mime_type: 'video/mp4',
          content_hash: receipt.sha256, source_action_id: action.id,
          source_task_id: generation.task_id, source_generation_id: generation.id,
          depends_on: [shot.id, bundle.id],
        });
        repo.updateAction(db, action.id, {
          status: 'completed',
          result: {
            ...(action.result || {}),
            artifact_id: artifact.id,
            receipt,
            generation_id: generation.id,
            dispatch_receipt: completionDispatchReceipt,
          },
        });
        repo.updateRun(db, run.id, { status: 'running', waiting_reason: null, error_code: null, error_message: null });
        return { state: 'progressed', artifact };
      }
      if (['failed', 'ambiguous', 'cancelled'].includes(action.status)) return { state: 'waiting_review', reason: action.status, action };
    }
    return { state: 'stage_ready', artifacts: currentArtifacts(db, run.id, 'shot_video') };
  }

  return {
    ensureImageStage,
    ensureReferenceBundles,
    ensureReferenceBundleForShot,
    requestDirectorCapture,
    acceptDirectorCapture,
    ensureShotVideos,
    cancelRunAction,
    resolveShotVideoRoute,
    listVideoRoutingOptions,
    selectImageReferences: (run, shot, limit) => selectImageReferences(db, run, shot, limit),
    buildImageReferenceAutoLink: (run, shot, limit, options) => buildImageReferenceAutoLink(db, run, shot, limit, options),
  };
}

module.exports = {
  createProductionMediaService,
  canReuseModelCatalogSnapshot,
  discoveryFromStoredSnapshot,
  discoverVideoCatalogForConfig,
  assertVideoDispatchContract,
  isAmbiguousImageGenerationFailure,
  buildProviderPrompt,
  buildProviderPromptPackage,
  normalizeAutoLinkName,
  PROVIDER_PROMPT_MAX_CHARS,
  PROVIDER_PROMPT_PROFILE,
  compareReferenceBundleBinding,
  referenceBundleComparison,
};
