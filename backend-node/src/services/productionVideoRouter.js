const crypto = require('node:crypto');
const {
  getYinziVideoCapability,
  listYinziVideoCapabilities,
  capabilitySupportsRoute,
  capabilityAcceptsDuration,
  capabilitySupportsRole,
  providerDurationForCapability,
} = require('./yinziVideoCapabilities');

const ROUTE_PROFILES = Object.freeze({
  SHORT: 'short_image_guided',
  LONG: 'long_previs_guided',
});

function classifyShotRoute(shot, policy = {}) {
  const content = shot?.content || shot || {};
  const plannedDuration = Math.max(1, Math.round(Number(content.duration) || 5));
  const requested = String(content.route_profile || '').trim();
  const profile = requested === ROUTE_PROFILES.SHORT || requested === ROUTE_PROFILES.LONG
    ? requested
    : plannedDuration <= 5 ? ROUTE_PROFILES.SHORT : ROUTE_PROFILES.LONG;
  const shotId = shot?.scope_id ?? content.scope_id ?? content.number;
  const policyPrevisOverrides = policy.video_previs_overrides && typeof policy.video_previs_overrides === 'object'
    ? policy.video_previs_overrides
    : {};
  const policyPrevisMode = shotId == null ? '' : String(policyPrevisOverrides[String(shotId)] || '').trim();
  const contentPrevisMode = ['auto', 'force', 'skip'].includes(content.previs_mode)
    ? content.previs_mode
    : 'auto';
  const requestedPrevisMode = ['force', 'skip'].includes(policyPrevisMode)
    ? policyPrevisMode
    : contentPrevisMode;
  const directorMode = String(policy.director_mode || 'auto') === 'off' ? 'off' : 'auto';
  const previsMode = directorMode === 'off' ? 'skip' : requestedPrevisMode;
  const isLongTake = profile === ROUTE_PROFILES.LONG;
  const transitionMode = String(content.transition_mode || '').trim();
  return {
    profile,
    planned_duration: plannedDuration,
    // `duration` is kept as the currently planned provider unit for backwards
    // compatible receipts. It is materialized again after a concrete model is
    // selected; no global five-second floor is applied here.
    provider_duration: plannedDuration,
    duration: plannedDuration,
    duration_adjusted: false,
    duration_adjustment_reason: null,
    // Reference support is a capability of the chosen model; using it is a
    // per-shot editorial decision. Explicit skip must win for every duration.
    uses_reference_video: isLongTake && previsMode !== 'skip',
    requires_director_preview: previsMode === 'force' || (isLongTake && previsMode !== 'skip'),
    previs_mode: previsMode,
    director_mode: directorMode,
    transition_mode: transitionMode,
    requires_strict_first_frame: transitionMode === 'strict_continuation',
  };
}

function materializeRouteDuration(route, capability) {
  const planned = Math.max(1, Number(route?.planned_duration) || 1);
  if (!capability) {
    return {
      ...route,
      provider_duration: planned,
      execution_unit_count: 1,
      execution_unit_durations: [planned],
      duration: planned,
      duration_adjusted: false,
      duration_adjustment_reason: null,
    };
  }
  const providerDuration = providerDurationForCapability(capability, planned);
  const adjusted = providerDuration !== planned;
  const executionUnitCount = capability.duration_mode === 'fixed' && planned > providerDuration
    ? Math.ceil(planned / providerDuration)
    : 1;
  const reason = !adjusted ? null
    : capability.duration_mode === 'fixed' ? 'provider_fixed_duration'
      : capability.duration_mode === 'enumerated' ? 'provider_enumerated_duration'
        : 'provider_duration_boundary';
  return {
    ...route,
    provider_duration: providerDuration,
    execution_unit_count: executionUnitCount,
    execution_unit_durations: Array.from({ length: executionUnitCount }, () => providerDuration),
    duration: providerDuration,
    duration_adjusted: adjusted,
    duration_adjustment_reason: reason,
  };
}

function normalizeCatalog(catalog) {
  const items = Array.isArray(catalog) ? catalog : Array.isArray(catalog?.video) ? catalog.video : [];
  return items.map((item) => ({
    ...item,
    model: String(item?.model || item?.model_name || '').trim(),
    endpoint_types: item?.endpoint_types || item?.supported_endpoint_types || [],
    groups: item?.groups || item?.enable_groups || [],
    prices: Array.isArray(item?.prices) ? item.prices : [],
  })).filter((item) => item.model);
}

function capabilityForCatalogItem(item) {
  return capabilityResolutionForCatalogItem(item).capability;
}

function capabilityResolutionForCatalogItem(item) {
  const hasExplicitContract = Object.prototype.hasOwnProperty.call(item || {}, 'capabilities');
  const explicitCapability = hasExplicitContract && item?.capabilities && typeof item.capabilities === 'object'
    ? item.capabilities
    : null;
  if (explicitCapability) {
    return {
      capability: explicitCapability,
      capability_source: item?.capability_source || 'model_catalog_snapshot',
      contract_status: item?.contract_status || 'known',
      contract_warnings: [],
      legacy_fallback: false,
    };
  }
  const builtin = getYinziVideoCapability(item?.model);
  if (hasExplicitContract && !explicitCapability && builtin) {
    return {
      capability: builtin,
      capability_source: 'builtin_legacy_fallback',
      contract_status: item?.contract_status || 'missing',
      contract_warnings: ['unknown_contract', 'legacy_capability_fallback'],
      legacy_fallback: true,
    };
  }
  return {
    capability: builtin,
    capability_source: builtin ? 'builtin' : 'unknown',
    contract_status: item?.contract_status || (builtin ? 'known' : 'missing'),
    contract_warnings: [],
    legacy_fallback: false,
  };
}

function shotModelOverride(shot, policy = {}) {
  const contentOverride = String(shot?.content?.video_model_override || '').trim();
  if (contentOverride) return contentOverride;
  const shotId = shot?.scope_id ?? shot?.content?.number;
  if (shotId == null) return '';
  const overrides = policy.video_model_overrides && typeof policy.video_model_overrides === 'object'
    ? policy.video_model_overrides
    : {};
  return String(overrides[String(shotId)] || '').trim();
}

function priceForCatalogItem(item, group, duration = null) {
  const prices = Array.isArray(item?.prices) ? item.prices : [];
  const matching = group ? prices.filter((price) => price.group === group) : prices;
  const usable = (matching.length ? matching : prices)
    .filter((price) => estimatePrice(price, duration) != null);
  if (!usable.length) return null;
  return usable.sort((left, right) => {
    const estimatedDiff = Number(estimatePrice(left, duration)) - Number(estimatePrice(right, duration));
    if (estimatedDiff !== 0) return estimatedDiff;
    return String(left.billing_unit || '').localeCompare(String(right.billing_unit || ''));
  })[0];
}

function estimatePrice(price, duration) {
  if (!price || !Number.isFinite(Number(price.effective_price))) return null;
  if (price.billing_unit === 'per_second') {
    if (!Number.isFinite(Number(duration))) return null;
    return Number((Number(price.effective_price) * Number(duration)).toFixed(4));
  }
  if (['per_request', 'per_generation', 'fixed_duration'].includes(price.billing_unit)) {
    return Number(Number(price.effective_price).toFixed(4));
  }
  return null;
}

function estimateRoutePrice(price, route) {
  const unit = estimatePrice(price, route?.provider_duration ?? route?.duration);
  if (unit == null) return { unit: null, total: null };
  const count = Math.max(1, Number(route?.execution_unit_count) || 1);
  return { unit, total: Number((unit * count).toFixed(4)) };
}

function qualityPreferenceRank(capability, qualityPolicy) {
  const tier = capability?.quality_tier;
  const policyOrder = {
    quality: ['quality', 'balanced', 'fast', 'economy'],
    speed: ['fast', 'balanced', 'economy', 'quality'],
    economy: ['economy', 'fast', 'balanced', 'quality'],
    balanced: ['balanced', 'fast', 'quality', 'economy'],
  };
  const order = policyOrder[qualityPolicy] || policyOrder.balanced;
  const index = order.indexOf(tier);
  return index === -1 ? order.length : index;
}

function yinziFamilyPreferenceRank(model) {
  const value = String(model || '').trim().toLowerCase();
  if (value.includes('seedance') && !value.includes('破甲')) return 0;
  if (value.includes('seedance')) return 2;
  return 10;
}

function modelProtocolSnapshot(item = {}, capability = null) {
  const profile = capability || item.capabilities || null;
  const value = (key) => String(item[key] || profile?.[key] || '').trim();
  const snapshot = {
    contract: value('provider_contract') || null,
    create_path: value('provider_create_path') || null,
    query_path: value('provider_query_path') || null,
    content_path: value('provider_content_path') || null,
  };
  return Object.values(snapshot).some(Boolean) ? snapshot : null;
}

function materialRoutePayload(route) {
  return {
    profile: route.profile,
    model: route.model,
    planned_duration: route.planned_duration,
    provider_duration: route.provider_duration,
    execution_unit_count: route.execution_unit_count || 1,
    execution_unit_durations: route.execution_unit_durations || [route.provider_duration || route.duration],
    duration: route.duration,
    duration_adjusted: route.duration_adjusted,
    resolution: route.resolution,
    requires_director_preview: route.requires_director_preview,
    uses_reference_video: route.uses_reference_video,
    director_mode: route.director_mode,
    transition_mode: route.transition_mode,
    requires_strict_first_frame: route.requires_strict_first_frame,
    group: route.group || null,
    group_available: route.group_available !== false,
    video_config_id: route.video_config_id == null ? null : Number(route.video_config_id),
    video_config_updated_at: route.video_config_updated_at || null,
    video_config_fingerprint: route.video_config_fingerprint || null,
    smart_routing_candidate: route.smart_routing_candidate === true,
    provider_protocol_snapshot: route.provider_protocol_snapshot || null,
    contract_status: route.contract_status || (route.capability ? 'known' : 'missing'),
    contract_warnings: route.contract_warnings || [],
    limits: route.limits,
    roles: route.roles,
  };
}

function routingMaterialSignature(route) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(materialRoutePayload(route)))
    .digest('hex');
}

// Stable identity for an approved reference bundle.  Unlike the complete
// material signature (which is diagnostic and includes volatile catalog data),
// this contains only request-binding facts that make the selected references
// applicable to the provider call.
function routingBindingPayload(route) {
  const providerDuration = route?.provider_duration ?? route?.duration ?? null;
  return {
    profile: route?.profile || null,
    model: String(route?.model || '').trim(),
    planned_duration: Number.isFinite(Number(route?.planned_duration)) ? Number(route.planned_duration) : null,
    provider_duration: Number.isFinite(Number(providerDuration)) ? Number(providerDuration) : null,
    execution_unit_count: Number.isFinite(Number(route?.execution_unit_count))
      ? Number(route.execution_unit_count)
      : 1,
    resolution: route?.resolution || null,
    requires_director_preview: route?.requires_director_preview === true,
    uses_reference_video: route?.uses_reference_video === true,
    previs_mode: route?.previs_mode || null,
    director_mode: route?.director_mode || null,
    transition_mode: route?.transition_mode || null,
    requires_strict_first_frame: route?.requires_strict_first_frame === true,
    group: route?.group || null,
    video_config_id: route?.video_config_id == null ? null : Number(route.video_config_id),
    // `updated_at` alone is not a binding fact: saving unrelated settings or
    // refreshing a catalog can advance it while the URL/key/model identity is
    // unchanged. The fingerprint (when present) is the authoritative config
    // revision and is enough to detect a real provider configuration change.
    video_config_fingerprint: route?.video_config_fingerprint || null,
    provider_protocol_snapshot: route?.provider_protocol_snapshot || null,
  };
}

function routingBindingSignature(route) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(routingBindingPayload(route)))
    .digest('hex');
}

function applyRouteSignatures(route) {
  route.material_signature = routingMaterialSignature(route);
  route.routing_binding_signature = routingBindingSignature(route);
  return route;
}

function fixedModelRoute(shot, model, policy = {}, capabilityInput = undefined, capabilityStatus = null, capabilityMeta = {}) {
  const classified = classifyShotRoute(shot, policy);
  const capability = capabilityInput === undefined ? getYinziVideoCapability(model) : capabilityInput;
  if (!capability) {
    const route = {
      ...classified,
      model: String(model || '').trim(),
      capability: null,
      execution_unit_count: 1,
      execution_unit_durations: [classified.provider_duration],
      capability_source: 'unknown',
      catalog_verified: false,
      automatic: false,
      resolution: policy.video_resolution || null,
      limits: null,
      roles: null,
      reason_codes: ['fixed_unknown_contract'],
      contract_status: 'missing',
      contract_warnings: ['unknown_contract'],
      estimated_price: null,
      billing_unit: null,
      provider_protocol_snapshot: modelProtocolSnapshot({}, capability),
    };
    return applyRouteSignatures(route);
  }
  const materialized = materializeRouteDuration(classified, capability);
  const contractWarnings = [...(capabilityMeta.contract_warnings || [])];
  if (!capabilityAcceptsDuration(capability, materialized.duration)) contractWarnings.push('duration_mismatch');
  if (materialized.uses_reference_video && Number(capability.max_videos) < 1) contractWarnings.push('video_reference_unsupported');
  if (materialized.requires_strict_first_frame && !capabilitySupportsRole(capability, 'image', 'first_frame')) contractWarnings.push('strict_first_frame_unsupported');
  const route = {
    ...materialized,
    model: String(model || '').trim(),
    capability,
    capability_source: capabilityMeta.capability_source || 'builtin',
    catalog_verified: false,
    automatic: false,
    resolution: policy.video_resolution || capability.resolution,
    limits: {
      images: capability.max_images,
      videos: classified.uses_reference_video ? capability.max_videos : 0,
      audios: capability.max_audios,
    },
    roles: capability.roles,
    reason_codes: ['fixed_model_override'],
    contract_status: capabilityStatus || 'known',
    contract_warnings: contractWarnings,
    estimated_price: null,
    billing_unit: null,
    provider_protocol_snapshot: modelProtocolSnapshot({}, capability),
  };
  return applyRouteSignatures(route);
}

function selectShotVideoRoute(input) {
  const { shot, catalog, policy = {} } = input || {};
  const classified = classifyShotRoute(shot, policy);
  const routingMode = policy.video_routing_mode
    ? String(policy.video_routing_mode)
    : String(policy.video_model || '').trim() ? 'fixed' : 'auto';
  const manualModel = shotModelOverride(shot, policy);
  const catalogItems = normalizeCatalog(catalog);
  if (routingMode === 'fixed' || manualModel) {
    const selectedModel = manualModel || policy.video_model;
    const catalogItem = catalogItems.find((item) => item.model.toLowerCase() === String(selectedModel || '').toLowerCase());
    const capabilityResolution = catalogItem
      ? capabilityResolutionForCatalogItem(catalogItem)
      : {
        capability: getYinziVideoCapability(selectedModel),
        capability_source: getYinziVideoCapability(selectedModel) ? 'builtin' : 'unknown',
        contract_status: getYinziVideoCapability(selectedModel) ? 'known' : 'missing',
        contract_warnings: [],
      };
    const fixed = fixedModelRoute(
      shot,
      selectedModel,
      policy,
      capabilityResolution.capability,
      capabilityResolution.contract_status,
      capabilityResolution,
    );
    const group = String(policy.video_group || '').trim();
    const groupAvailable = !group || Boolean(catalogItem?.groups?.includes(group));
    const price = catalogItem ? priceForCatalogItem(catalogItem, group, fixed.duration) : null;
    const estimated = estimateRoutePrice(price, fixed);
    fixed.reason_codes = manualModel ? ['shot_model_override'] : fixed.reason_codes;
    fixed.catalog_verified = Boolean(catalogItem) && catalogItem.catalog_verified !== false;
    fixed.capability_source = capabilityResolution.capability_source;
    fixed.contract_status = catalogItem?.contract_status || fixed.contract_status;
    fixed.catalog_version = String(catalog?.pricing_version || '');
    fixed.catalog_fetched_at = catalog?.fetched_at || null;
    fixed.group = group || price?.group || catalogItem?.groups?.[0] || null;
    fixed.group_available = groupAvailable;
    fixed.contract_warnings = [
      ...(fixed.contract_warnings || []),
      ...(!catalogItem ? ['model_not_in_catalog'] : []),
      ...(group && !groupAvailable ? ['group_unavailable'] : []),
    ];
    fixed.billing_unit = price?.billing_unit || null;
    fixed.unit_price = price?.effective_price ?? null;
    fixed.estimated_unit_price = estimated.unit;
    fixed.estimated_price = estimated.total;
    fixed.currency = price?.currency || null;
    fixed.provider_protocol_snapshot = modelProtocolSnapshot(catalogItem || {}, fixed.capability);
    applyRouteSignatures(fixed);
    return fixed;
  }

  if (!catalogItems.length) {
    const error = new Error('实时视频模型目录不可用，自动路由已在付费提交前停止');
    error.code = 'VIDEO_ROUTE_CATALOG_UNAVAILABLE';
    throw error;
  }
  const qualityPolicy = String(policy.video_quality || 'balanced');
  const group = String(policy.video_group || '').trim();
  const allowBypass = policy.allow_expensive_bypass === true;
  const hasCredentialEvidence = catalogItems.some((item) => (
    item.credential_verified !== undefined
    || item.public_catalog !== undefined
    || item.availability_scope === 'public'
  ));
  const evaluated = [];
  for (const item of catalogItems) {
    const capabilityResolution = capabilityResolutionForCatalogItem(item);
    const capability = capabilityResolution.capability;
    const candidateRoute = capability ? materializeRouteDuration(classified, capability) : classified;
    const reasons = [];
    if (!capability) reasons.push('unknown_contract');
    if (capability && !capabilitySupportsRoute(capability, candidateRoute.profile)) reasons.push('profile_mismatch');
    if (capability && !capabilityAcceptsDuration(capability, candidateRoute.duration, { automatic: true })) reasons.push('duration_mismatch');
    if (capability && candidateRoute.uses_reference_video && capability.max_videos < 1) reasons.push('video_reference_required');
    if (capability && candidateRoute.requires_strict_first_frame
      && !capabilitySupportsRole(capability, 'image', 'first_frame')) reasons.push('strict_first_frame_required');
    if (capability && !capability.automatic_eligible) reasons.push(capability.exclusion_reason || 'not_automatic');
    if (capability?.expensive_bypass && !allowBypass) reasons.push('expensive_bypass_disabled');
    const credentialVerified = item.credential_verified === true
      || (item.scope_verified === true && item.availability_scope === 'credential');
    // Old snapshots may have promoted a public price offer to a Smart Router
    // candidate. Re-assert the evidence boundary at dispatch time so upgrading
    // the app cannot auto-submit an unavailable model from a stale snapshot.
    const smartRoutingCandidate = item.smart_routing_candidate === true
      && item.public_catalog !== true
      && item.manual_only !== true;
    if (hasCredentialEvidence && !credentialVerified && !smartRoutingCandidate) reasons.push('credential_unverified');
    if (group && Array.isArray(item.groups) && !item.groups.includes(group)) reasons.push('group_unavailable');
    const price = priceForCatalogItem(item, group, candidateRoute.duration);
    // Price against the concrete provider execution unit. For a fixed 30s
    // product this must not use the shorter creative/planned duration.
    const estimatedReceipt = estimateRoutePrice(price, candidateRoute);
    const estimated = estimatedReceipt.total;
    if (estimated == null) reasons.push('price_unknown');
    const shortMultimodalPenalty = capability
      && !classified.uses_reference_video
      && capability.max_videos > 0
      && classified.profile === ROUTE_PROFILES.SHORT ? 5 : 0;
    evaluated.push({
      item,
      capabilityResolution,
      capability,
      route: candidateRoute,
      price,
      estimated,
      estimated_unit: estimatedReceipt.unit,
      reasons: [...new Set(reasons)],
      credential_verified: credentialVerified,
      smart_routing_candidate: smartRoutingCandidate,
      family_rank: yinziFamilyPreferenceRank(item.model),
      quality_rank: qualityPreferenceRank(capability, qualityPolicy),
      short_multimodal_penalty: shortMultimodalPenalty,
    });
  }
  let eligible = evaluated.filter((candidate) => candidate.reasons.length === 0)
    .sort((left, right) => left.family_rank - right.family_rank
      || Number(left.estimated) - Number(right.estimated)
      || left.quality_rank - right.quality_rank
      || left.short_multimodal_penalty - right.short_multimodal_penalty
      || Number(left.capability?.preference_rank || 1000) - Number(right.capability?.preference_rank || 1000)
      || left.item.model.localeCompare(right.item.model));
  if (!eligible.length) {
    // The key-scoped /models directory proves availability. Missing local
    // contracts are advisory: prefer a priced unknown model, then the stable
    // directory order, and let the upstream protocol return the real limits.
    eligible = evaluated.filter((candidate) => !candidate.capability
      && (candidate.credential_verified === true || candidate.smart_routing_candidate === true)
      && !candidate.reasons.includes('group_unavailable'))
      .sort((left, right) => {
        const leftPrice = left.estimated == null ? Number.POSITIVE_INFINITY : Number(left.estimated);
        const rightPrice = right.estimated == null ? Number.POSITIVE_INFINITY : Number(right.estimated);
        return left.family_rank - right.family_rank
          || leftPrice - rightPrice
          || left.item.model.localeCompare(right.item.model);
      });
  }
  if (!eligible.length) {
    const error = new Error(`${classified.duration} 秒镜头没有满足媒体、时长和费用策略的视频模型`);
    error.code = 'VIDEO_ROUTE_NO_ELIGIBLE_MODEL';
    error.details = evaluated.map((candidate) => ({ model: candidate.item.model, reasons: candidate.reasons }));
    throw error;
  }
  const selected = eligible[0];
  const capability = selected.capability;
  if (!capability) {
    const route = fixedModelRoute(shot, selected.item.model, policy, null, selected.item.contract_status || 'missing');
    route.automatic = true;
    route.catalog_verified = selected.item.catalog_verified !== false;
    route.capability_source = selected.item.capability_source || 'unknown';
    route.availability_scope = selected.item.availability_scope;
    route.scope_verified = selected.item.scope_verified === true;
    route.smart_routing_candidate = selected.smart_routing_candidate === true;
    route.catalog_version = String(catalog?.pricing_version || '');
    route.catalog_fetched_at = catalog?.fetched_at || null;
    route.group = group || selected.price?.group || selected.item.groups?.[0] || null;
    route.group_available = true;
    route.billing_unit = selected.price?.billing_unit || null;
    route.unit_price = selected.price?.effective_price ?? null;
    route.estimated_price = selected.estimated;
    route.currency = selected.price?.currency || null;
    route.reason_codes = ['automatic_discovered_model_fallback', 'unknown_contract_advisory',
      ...(selected.smart_routing_candidate ? ['smart_routing_public_candidate'] : [])];
    route.contract_warnings = [...new Set([...(route.contract_warnings || []), 'unknown_contract'])];
    route.provider_protocol_snapshot = modelProtocolSnapshot(selected.item, null);
    route.candidates = eligible.slice(0, 4).map((candidate) => ({
      model: candidate.item.model,
      estimated_price: candidate.estimated,
      billing_unit: candidate.price?.billing_unit || null,
      currency: candidate.price?.currency || null,
      resolution: null,
      quality_tier: null,
      contract_status: candidate.item.contract_status || 'missing',
      smart_routing_candidate: candidate.smart_routing_candidate,
    }));
    return applyRouteSignatures(route);
  }
  const route = {
    ...materializeRouteDuration(selected.route || classified, capability),
    model: selected.item.model,
    capability,
    capability_source: selected.capabilityResolution.capability_source,
    contract_status: selected.capabilityResolution.contract_status,
    catalog_verified: selected.item.catalog_verified !== false,
    catalog_version: String(catalog?.pricing_version || ''),
    catalog_fetched_at: catalog?.fetched_at || null,
    group: group || selected.price?.group || selected.item.groups?.[0] || null,
    automatic: true,
    smart_routing_candidate: selected.smart_routing_candidate === true,
    provider_protocol_snapshot: modelProtocolSnapshot(selected.item, capability),
    resolution: policy.video_resolution || capability.resolution,
    limits: {
      images: capability.max_images,
      videos: classified.uses_reference_video ? capability.max_videos : 0,
      audios: capability.max_audios,
    },
    roles: capability.roles,
    billing_unit: selected.price?.billing_unit || null,
    unit_price: selected.price?.effective_price ?? null,
    estimated_price: selected.estimated,
    estimated_unit_price: selected.estimated_unit,
    currency: selected.price?.currency || null,
    queue_signal: 'unknown',
    contract_warnings: [...new Set(selected.capabilityResolution.contract_warnings || [])],
    reason_codes: classified.profile === ROUTE_PROFILES.SHORT
      ? [
        'short_complete_visual_beat',
        ...(classified.duration_adjusted ? ['provider_duration_adjusted'] : ['free_duration_exact_fit']),
        'image_references_only',
        ...(classified.director_mode === 'off' ? ['director_disabled_for_run'] : []),
        ...(classified.previs_mode === 'force' ? ['director_preview_forced_locally'] : []),
        ...(selected.capabilityResolution.legacy_fallback ? ['legacy_capability_fallback'] : []),
      ]
      : classified.previs_mode === 'skip'
        ? [
          'long_continuous_take',
          classified.director_mode === 'off' ? 'director_disabled_for_run' : 'director_preview_skipped_by_user',
          'image_references_only',
          ...(classified.duration_adjusted ? ['provider_duration_adjusted'] : []),
        ]
        : [
          'long_continuous_take', 'reference_video_supported', 'director_preview_required',
          ...(selected.capabilityResolution.legacy_fallback ? ['legacy_capability_fallback'] : []),
        ],
    candidates: eligible.slice(0, 4).map((candidate) => ({
      model: candidate.item.model,
      estimated_price: candidate.estimated,
      billing_unit: candidate.price?.billing_unit || null,
      currency: candidate.price?.currency || null,
      resolution: candidate.capability.resolution,
      quality_tier: candidate.capability.quality_tier,
      smart_routing_candidate: candidate.smart_routing_candidate,
    })),
  };
  return applyRouteSignatures(route);
}

function listShotVideoRouteOptions(input) {
  const { shot, catalog, policy = {} } = input || {};
  const items = normalizeCatalog(catalog);
  const group = String(policy.video_group || '').trim();
  const projectMode = policy.video_routing_mode
    ? String(policy.video_routing_mode)
    : String(policy.video_model || '').trim() ? 'fixed' : 'auto';
  const currentModel = shotModelOverride(shot, policy)
    || (projectMode === 'fixed' ? String(policy.video_model || '').trim() : '');
  return items.map((item) => {
    const capabilityResolution = capabilityResolutionForCatalogItem(item);
    const capability = capabilityResolution.capability;
    const groupAvailable = !group || item.groups.includes(group);
    let route = null;
    let error = null;
    try {
      route = fixedModelRoute(
        shot, item.model, policy, capabilityResolution.capability,
        capabilityResolution.contract_status, capabilityResolution
      );
    } catch (caught) {
      error = caught;
    }
    const price = priceForCatalogItem(item, group, route?.duration);
    const warnings = [];
    if (capability?.expensive_bypass) warnings.push('expensive_bypass');
    if (capability?.duration_mode === 'fixed') warnings.push('fixed_duration_product');
    if (capability?.automatic_availability === 'temporarily_unavailable') {
      warnings.push(capability.exclusion_reason || 'channel_temporarily_unavailable');
    }
    if (!capability) warnings.push('unknown_contract');
    if (!groupAvailable) warnings.push('group_unavailable');
    warnings.push(...(route?.contract_warnings || []));
    const advisoryOnlyWarnings = new Set(['unknown_contract', 'legacy_capability_fallback']);
    const contractIssue = (route?.contract_warnings || []).find((warning) => !advisoryOnlyWarnings.has(warning)) || null;
    // A manually selected model is always an allowed attempt.  Compatibility
    // remains advisory so automatic routing and the UI can explain what is
    // known locally, but an unregistered or cross-group model must not be
    // hidden behind a local contract gate.
    const compatible = Boolean(route && capability && groupAvailable && !contractIssue);
    return {
      model: item.model,
      name: item.name || item.model,
      contract_status: capabilityResolution.contract_status,
      capability_source: capabilityResolution.capability_source,
      groups: item.groups,
      group,
      group_available: groupAvailable,
      compatible,
      selectable: true,
      incompatibility_code: !groupAvailable
        ? 'VIDEO_ROUTE_GROUP_UNAVAILABLE'
        : error?.code
          || (!capability ? 'VIDEO_ROUTE_UNKNOWN_CONTRACT' : null)
          || (contractIssue === 'duration_mismatch' ? 'VIDEO_ROUTE_DURATION_UNSUPPORTED'
            : contractIssue === 'video_reference_unsupported' ? 'VIDEO_ROUTE_REFERENCE_UNSUPPORTED'
              : contractIssue === 'strict_first_frame_unsupported' ? 'STRICT_FIRST_FRAME_UNSUPPORTED' : null),
      incompatibility_reason: !groupAvailable
        ? `不在当前分组 ${group}`
        : error?.message
          || (!capability ? '本地尚未登记该模型的能力提示；手动选择仍可提交' : null)
          || (contractIssue ? `本地能力提示：${contractIssue}` : null),
      warnings: [...new Set(warnings)],
      requires_explicit_confirmation: capability?.expensive_bypass === true,
      automatic_eligible: capability?.automatic_eligible === true,
      resolution: capability?.resolution || null,
      quality_tier: capability?.quality_tier || null,
      duration_mode: capability?.duration_mode || null,
      duration_min: capability?.duration_min ?? null,
      duration_max: capability?.duration_max ?? null,
      fixed_duration_seconds: capability?.fixed_duration_seconds ?? null,
      limits: capability ? {
        images: capability.max_images,
        videos: route?.uses_reference_video ? capability.max_videos : 0,
        audios: capability.max_audios,
      } : null,
      roles: capability?.roles || null,
      billing_unit: price?.billing_unit || null,
      unit_price: price?.effective_price ?? null,
      currency: price?.currency || null,
      estimated_price: route ? estimatePrice(price, route.duration) : null,
      route: route ? {
        profile: route.profile,
        planned_duration: route.planned_duration,
        provider_duration: route.provider_duration,
        execution_unit_count: route.execution_unit_count || 1,
        duration: route.duration,
        uses_reference_video: route.uses_reference_video,
        requires_director_preview: route.requires_director_preview,
      } : null,
      selected: item.model === currentModel,
    };
  });
}

function staticRoutePreview(shot, policy = {}) {
  const catalog = {
    pricing_version: '',
    fetched_at: null,
    video: listYinziVideoCapabilities().map(({ model, capability }) => ({
      model,
      endpoint_types: ['openai-video'],
      groups: [],
      prices: [],
      capabilities: capability,
    })),
  };
  const previewPolicy = { ...policy, video_group: '' };
  const route = selectShotVideoRoute({ shot, catalog, policy: previewPolicy });
  return { ...route, catalog_verified: false, reason_codes: [...route.reason_codes, 'static_catalog_preview'] };
}

module.exports = {
  ROUTE_PROFILES,
  classifyShotRoute,
  capabilityForCatalogItem,
  capabilityResolutionForCatalogItem,
  fixedModelRoute,
  shotModelOverride,
  selectShotVideoRoute,
  listShotVideoRouteOptions,
  routingMaterialSignature,
  routingBindingPayload,
  routingBindingSignature,
  staticRoutePreview,
};
