const aiConfigService = require('./aiConfigService');
const { getYinziVideoCapability } = require('./yinziVideoCapabilities');
const { resolveYinziVideoPrices } = require('./yinziVideoDefaults');
const { selectShotVideoRoute } = require('./productionVideoRouter');
const crypto = require('node:crypto');
const { resolveDistributionProfile, getDistributionProfile } = require('./distributionProfiles');

const YINZI_CATALOG_URL = 'https://yinziapi.top/api/pricing';
const YINZI_DEFAULT_BASE_URL = 'https://api.yinziapi.top/v1';
const YINZI_CAPABILITY_ACCEPT = 'application/vnd.yinzi.model-capability+json;version=1, application/json;q=0.9';
const CATALOG_TTL_MS = 5 * 60 * 1000;
const CAPABILITY_CATALOG_TTL_MS = 60 * 1000;
const MAX_CAPABILITY_CATALOG_CACHE_ENTRIES = 32;

let catalogCache = null;
const capabilityCatalogCache = new Map();

function normalizeYinziBaseUrl(value) {
  const raw = String(value || YINZI_DEFAULT_BASE_URL).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error('Base URL 格式无效');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Base URL 仅支持 http 或 https');
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error('Base URL 不能包含账号、密码或锚点');
  }
  parsed.search = '';
  let path = parsed.pathname.replace(/\/+$/, '');
  if (!path) path = '/v1';
  parsed.pathname = path;
  return parsed.toString().replace(/\/$/, '');
}

function normalizeOpaqueModel(value) {
  return String(value || '').trim();
}

function normalizeYinziRoutingMode(value) {
  return String(value || '').trim().toLowerCase() === 'smart' ? 'smart' : 'group';
}

function resolveYinziRoutingMode(input = {}) {
  if (!input || typeof input !== 'object') return 'group';
  let settings = input.settings;
  if (typeof settings === 'string') {
    try { settings = JSON.parse(settings); } catch (_) { settings = {}; }
  }
  return normalizeYinziRoutingMode(
    input.routing_mode
      || input.yinzi_routing_mode
      || settings?.routing_mode
      || settings?.yinzi_routing_mode
      || (input.smart_routing === true || settings?.smart_routing === true ? 'smart' : 'group')
  );
}

function isYinziSmartRoutingConfig(config) {
  if (!config) return false;
  let settings = config.settings;
  if (typeof settings === 'string') {
    try { settings = JSON.parse(settings); } catch (_) { settings = {}; }
  }
  return normalizeYinziRoutingMode(settings?.routing_mode || settings?.yinzi_routing_mode) === 'smart'
    || settings?.smart_routing === true;
}

function normalizePricing(item) {
  const groupPricing = item && item.group_pricing && typeof item.group_pricing === 'object'
    ? Object.values(item.group_pricing)
    : [];
  return groupPricing.map((price) => ({
    group: String(price.group || ''),
    billing_mode: String(price.billing_mode || ''),
    billing_unit: String(price.billing_unit || ''),
    effective_price: price.effective_model_price != null && Number.isFinite(Number(price.effective_model_price))
      ? Number(price.effective_model_price)
      : null,
    effective_input_usd: price.effective_input_usd != null && Number.isFinite(Number(price.effective_input_usd))
      ? Number(price.effective_input_usd)
      : null,
    effective_output_usd: price.effective_output_usd != null && Number.isFinite(Number(price.effective_output_usd))
      ? Number(price.effective_output_usd)
      : null,
    fixed_duration_seconds: price.fixed_duration_seconds != null && Number.isFinite(Number(price.fixed_duration_seconds))
      ? Number(price.fixed_duration_seconds)
      : null,
    currency: 'CNY',
  }));
}

function normalizeEndpointTypes(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean))];
}

function normalizeCatalogItem(item, pricingVersion = '') {
  const reportedEndpointTypes = normalizeEndpointTypes(
    item?.endpoint_types || item?.supported_endpoint_types || item?.endpoints || []
  );
  const builtinCapability = getYinziVideoCapability(item?.model_name);
  // An explicit endpoint declaration is authoritative. Some older public
  // catalog snapshots omitted endpoint metadata for exact, locally
  // contracted video products; only that metadata-free case may use the
  // bounded registry hint. Never turn an explicitly `openai` text model into
  // video merely because its name exists in the local compatibility table.
  const endpointTypes = reportedEndpointTypes.length
    ? reportedEndpointTypes
    : builtinCapability
      ? ['openai-video']
      : [];
  const videoCapability = builtinCapability
    && (endpointTypes.includes('openai-video') || reportedEndpointTypes.length === 0)
    ? builtinCapability
    : null;
  const normalizedPrices = normalizePricing(item);
  const prices = endpointTypes.includes('openai-video')
    ? resolveYinziVideoPrices(item?.model_name, normalizedPrices, String(pricingVersion || ''))
    : normalizedPrices;
  const fixedPrices = prices
    .map((p) => p.effective_price)
    .filter((p) => Number.isFinite(p));
  return {
    model: normalizeOpaqueModel(item?.model_name),
    endpoint_types: endpointTypes,
    groups: Array.isArray(item?.enable_groups) ? item.enable_groups.map((v) => String(v)) : [],
    prices,
    cheapest_effective_price: fixedPrices.length ? Math.min(...fixedPrices) : null,
    capabilities: videoCapability,
    capability_source: videoCapability ? 'builtin_exact_contract' : 'unknown',
    contract_status: videoCapability ? 'known' : 'missing',
    automatic_eligible: videoCapability?.automatic_eligible === true,
    reported_endpoint_types: reportedEndpointTypes,
    public_catalog: true,
    credential_verified: false,
  };
}

function recommendedRank(kind, model) {
  const recommendations = {
    text: ['gpt-5.6-sol', 'gpt-5.4-mini', 'deepseek-v4-flash', 'gpt-5.6-terra', 'gpt-5.4'],
    image: ['gpt-image-2', 'flux-2-pro', 'seedream-v5-lite'],
    video: [
      'seedance-2.5-720p',
      'seedance2.0 -720p-fast-15s',
      'cm-seedance2.0特价fast-720p-gz-15s',
      '官转-seedance2.0 720p-fast',
      'seedance2.0 720p-pro-nv-nsp',
    ],
  };
  const index = (recommendations[kind] || []).indexOf(model);
  return index === -1 ? 1000 : index;
}

function sortCatalogItems(kind, items) {
  return items.sort((a, b) => {
    const rankDiff = recommendedRank(kind, a.model) - recommendedRank(kind, b.model);
    if (rankDiff !== 0) return rankDiff;
    return a.model.localeCompare(b.model, 'zh-CN');
  });
}

function normalizeYinziCatalog(payload) {
  if (!payload || payload.success === false || !Array.isArray(payload.data)) {
    throw new Error('模型目录返回格式异常');
  }
  const all = payload.data
    .map((item) => normalizeCatalogItem(item, payload.pricing_version))
    .filter((item) => item.model);
  const image = sortCatalogItems('image', all.filter((item) => item.endpoint_types.includes('image-generation')));
  const video = sortCatalogItems('video', all.filter((item) => item.endpoint_types.includes('openai-video')));
  const text = sortCatalogItems(
    'text',
    all.filter((item) => item.endpoint_types.includes('openai')
      && !item.endpoint_types.includes('image-generation')
      && !item.endpoint_types.includes('openai-video'))
  );
  return {
    source: YINZI_CATALOG_URL,
    pricing_version: String(payload.pricing_version || ''),
    fetched_at: new Date().toISOString(),
    text,
    image,
    video,
  };
}

async function fetchYinziCatalog(fetchImpl = fetch, options = {}) {
  const now = Date.now();
  const useCache = options.use_cache !== false && fetchImpl === fetch;
  if (useCache && catalogCache && now - catalogCache.cachedAt < CATALOG_TTL_MS) {
    return catalogCache.value;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetchImpl(YINZI_CATALOG_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`模型目录请求失败: HTTP ${res.status}`);
    const normalized = normalizeYinziCatalog(await res.json());
    if (useCache) catalogCache = { cachedAt: now, value: normalized };
    return normalized;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('模型目录请求超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function capabilityCatalogUrl(baseUrl) {
  const normalized = normalizeYinziBaseUrl(baseUrl);
  return `${normalized.replace(/\/+$/, '')}/model-capabilities`;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'number' && typeof value !== 'string') continue;
    if (typeof value === 'string' && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return undefined;
}

function stringList(value) {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function setKnown(target, key, value) {
  if (value !== undefined) target[key] = value;
}

function normalizeCapabilityProfile(contract, entry = {}) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return null;
  const generation = objectValue(contract.generation);
  const duration = objectValue(generation.duration);
  const references = objectValue(contract.references);
  const referenceLimits = objectValue(references.limits);
  const referenceRoles = objectValue(references.roles || contract.roles);
  const images = objectValue(references.images);
  const videos = objectValue(references.videos);
  const audios = objectValue(references.audios);
  const referenceFiles = objectValue(references.files);
  const referenceVideo = objectValue(references.video);
  const routing = objectValue(contract.routing);
  const provider = objectValue(contract.provider);
  const provenance = objectValue(contract.provenance);
  const transport = objectValue(entry.transport || contract.transport);
  const consumerTransport = objectValue(transport.consumer);
  const create = objectValue(provider.create || transport.create || consumerTransport.create);
  const query = objectValue(provider.query || provider.poll || transport.query || consumerTransport.query);
  const content = objectValue(provider.content || provider.download || transport.content || transport.download || consumerTransport.content);
  const prompt = objectValue(generation.prompt);
  const profile = {};

  setKnown(profile, 'provider_contract', firstText(provider.protocol, transport.protocol));
  setKnown(profile, 'provider_create_path', firstText(create.path, provider.create_path));
  setKnown(profile, 'provider_query_path', firstText(query.path, query.path_template, provider.query_path));
  setKnown(profile, 'provider_content_path', firstText(content.path, content.path_template, provider.content_path));
  const providerEndpointTypes = stringList(provider.endpoint_types)
    || stringList(contract.endpoint_types)
    || stringList(entry.endpoint_types)
    || stringList(entry.supported_endpoint_types);
  setKnown(profile, 'provider_endpoint_types', providerEndpointTypes);

  setKnown(profile, 'duration_mode', firstText(duration.mode, contract.duration_mode));
  setKnown(profile, 'duration_min', firstFiniteNumber(duration.min, duration.min_seconds, contract.duration_min));
  setKnown(profile, 'duration_max', firstFiniteNumber(duration.max, duration.max_seconds, contract.duration_max));
  setKnown(profile, 'duration_step', firstFiniteNumber(duration.step, duration.step_seconds, contract.duration_step));
  setKnown(profile, 'fixed_duration_seconds', firstFiniteNumber(duration.fixed, duration.fixed_seconds, contract.fixed_duration_seconds));
  setKnown(profile, 'max_images', firstFiniteNumber(images.max, referenceLimits.images, references.max_images, contract.max_images));
  setKnown(profile, 'max_videos', firstFiniteNumber(videos.max, referenceLimits.videos, references.max_videos, contract.max_videos));
  setKnown(profile, 'max_audios', firstFiniteNumber(audios.max, referenceLimits.audios, references.max_audios, contract.max_audios));
  setKnown(profile, 'max_total_references', firstFiniteNumber(references.max_total, referenceLimits.total, contract.max_total_references));
  setKnown(profile, 'max_reference_video_seconds_total', firstFiniteNumber(
    videos.max_total_duration_seconds,
    referenceVideo.max_total_duration_seconds,
    contract.max_reference_video_seconds_total
  ));
  setKnown(profile, 'max_prompt_chars', firstFiniteNumber(references.prompt_max_chars, prompt.max_chars, contract.max_prompt_chars));
  setKnown(profile, 'max_image_bytes', firstFiniteNumber(referenceFiles.max_image_bytes, contract.max_image_bytes));
  setKnown(profile, 'max_video_bytes', firstFiniteNumber(referenceFiles.max_video_bytes, contract.max_video_bytes));
  setKnown(profile, 'max_audio_bytes', firstFiniteNumber(referenceFiles.max_audio_bytes, contract.max_audio_bytes));

  const resolutions = stringList(generation.resolutions);
  const qualities = stringList(generation.qualities);
  setKnown(profile, 'resolution', resolutions?.[0] || firstText(contract.resolution));
  setKnown(profile, 'quality_tier', firstText(generation.quality, qualities?.[0], contract.quality_tier));
  const automaticEligible = typeof routing.automatic_eligible === 'boolean'
    ? routing.automatic_eligible : contract.automatic_eligible;
  if (typeof automaticEligible === 'boolean') {
    profile.automatic_eligible = automaticEligible && routing.manual_only !== true && contract.manual_only !== true;
  }
  const expensive = typeof routing.expensive === 'boolean' ? routing.expensive : contract.expensive_bypass;
  if (typeof expensive === 'boolean') profile.expensive_bypass = expensive;
  const requiresPreview = typeof routing.requires_explicit_confirmation === 'boolean'
    ? routing.requires_explicit_confirmation : contract.requires_director_preview;
  if (typeof requiresPreview === 'boolean') {
    profile.requires_director_preview = requiresPreview;
  }
  setKnown(profile, 'route_profiles', stringList(routing.route_profiles) || stringList(contract.route_profiles));

  const roles = {};
  const imageRoles = stringList(images.roles) || stringList(referenceRoles.image);
  const videoRoles = stringList(videos.roles) || stringList(referenceRoles.video);
  const audioRoles = stringList(audios.roles) || stringList(referenceRoles.audio);
  setKnown(roles, 'image', imageRoles);
  setKnown(roles, 'video', videoRoles);
  setKnown(roles, 'audio', audioRoles);
  if (Object.keys(roles).length) profile.roles = roles;

  setKnown(profile, 'contract_revision', firstText(entry.contract_revision, contract.revision));
  setKnown(profile, 'validation_status', firstText(entry.validation_status, provenance.validation_status));
  const unknownFields = stringList(entry.unknown_fields);
  setKnown(profile, 'unknown_fields', unknownFields);
  return Object.keys(profile).length ? profile : null;
}

function normalizeCapabilityPrice(entry, defaultGroup = '') {
  const price = entry?.local_pricing && typeof entry.local_pricing === 'object' ? entry.local_pricing : {};
  const consumer = entry?.capabilities?.commercial?.consumer_offer && typeof entry.capabilities.commercial.consumer_offer === 'object'
    ? entry.capabilities.commercial.consumer_offer : {};
  const standard = objectValue(entry?.pricing);
  const standardConsumer = objectValue(standard.consumer_offer);
  const standardLocal = objectValue(standard.local_pricing);
  const effective = price.use_price === true && Number.isFinite(Number(price.model_price))
    ? Number(price.model_price)
    : firstFiniteNumber(
      consumer.unit_price,
      standard.unit_price,
      standardConsumer.unit_price,
      standardLocal.unit_price,
      standardLocal.model_price
    ) ?? null;
  const unit = String(
    consumer.billing_unit
      || standard.billing_unit
      || standardConsumer.billing_unit
      || standardLocal.billing_unit
      || price.task_profile?.unit
      || ''
  );
  return {
    group: String(entry.group || defaultGroup || ''),
    billing_mode: String(price.billing_mode || ''),
    billing_unit: unit,
    effective_price: effective,
    effective_input_usd: null,
    effective_output_usd: null,
    fixed_duration_seconds: firstFiniteNumber(
      entry.capabilities?.generation?.duration?.fixed,
      entry.capabilities?.generation?.duration?.fixed_seconds
    ) ?? null,
    currency: String(consumer.currency || standard.currency || standardConsumer.currency || standardLocal.currency || 'CNY'),
    source: 'key_scoped_capability_catalog',
  };
}

function capabilityEntryEndpointTypes(entry, legacyModelsFormat) {
  const reported = normalizeEndpointTypes(
    entry?.endpoint_types || entry?.supported_endpoint_types || entry?.endpoints || []
  );
  if (reported.length) return reported;
  if (legacyModelsFormat) return ['openai-video'];
  const transport = objectValue(entry?.transport);
  const provider = objectValue(entry?.capabilities?.provider);
  const create = objectValue(transport.create || transport.consumer?.create || provider.create);
  const protocol = firstText(transport.protocol, provider.protocol, entry?.capabilities?.provider_contract) || '';
  const createPath = firstText(create.path, create.path_template, provider.create_path) || '';
  if (/video/i.test(protocol) || /\/videos(?:\/|$)/i.test(createPath) || getYinziVideoCapability(entry?.id || entry?.model)) {
    return ['openai-video'];
  }
  return [];
}

function normalizeYinziCapabilityCatalog(payload, source) {
  const entries = Array.isArray(payload?.models)
    ? payload.models
    : Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.data?.models) ? payload.data.models : null;
  if (!entries) {
    throw new Error('Yinzi 能力目录返回格式异常');
  }
  const legacyModelsFormat = Array.isArray(payload.models);
  const capabilityDataAvailable = payload?.capability_data_available !== false;
  const advisory = String(payload?.advisory || '').trim();
  const byModel = new Map();
  const defaultGroup = String(payload?.scope?.group || '').trim();
  for (const entry of entries) {
    const model = normalizeOpaqueModel(entry?.model || entry?.id);
    if (!model) continue;
    const modelKey = model.toLowerCase();
    let item = byModel.get(modelKey);
    if (!item) {
      const reportedEndpoints = capabilityEntryEndpointTypes(entry, legacyModelsFormat);
      item = {
        model,
        endpoint_types: reportedEndpoints,
        groups: [],
        prices: [],
        capabilities: null,
        capability_source: 'unknown',
        contract_status: 'missing',
        validation_status: String(entry?.validation_status || ''),
        automatic_eligible: false,
        unknown_fields: stringList(entry?.unknown_fields) || [],
      };
      byModel.set(modelKey, item);
    }
    const group = String(entry?.group || defaultGroup || '').trim();
    if (group && !item.groups.includes(group)) item.groups.push(group);
    if (entry?.local_pricing || entry?.pricing || entry?.capabilities?.commercial?.consumer_offer) {
      item.prices.push(normalizeCapabilityPrice(entry, defaultGroup));
    }
    if (entry.capabilities) {
      const profile = normalizeCapabilityProfile(entry.capabilities, entry);
      if (profile) {
        item.capabilities = profile;
        item.provider_contract = profile.provider_contract;
        item.provider_create_path = profile.provider_create_path;
        item.provider_query_path = profile.provider_query_path;
        item.provider_content_path = profile.provider_content_path;
        item.capability_source = 'key_scoped_contract';
        item.contract_status = String(entry.contract_status || 'active');
        item.validation_status = String(entry.validation_status || profile.validation_status || '');
        item.unknown_fields = stringList(entry.unknown_fields) || profile.unknown_fields || [];
        item.automatic_eligible = typeof entry.automatic_eligible === 'boolean'
          ? entry.automatic_eligible && profile.automatic_eligible !== false
          : profile.automatic_eligible === true;
      }
    } else {
      item.contract_status = String(entry?.contract_status || item.contract_status || 'missing');
    }
  }
  const video = sortCatalogItems('video', [...byModel.values()]
    .filter((item) => item.endpoint_types.includes('openai-video'))
    .map((item) => ({
      ...item,
      cheapest_effective_price: item.prices.map((p) => p.effective_price).filter(Number.isFinite).length
        ? Math.min(...item.prices.map((p) => p.effective_price).filter(Number.isFinite)) : null,
    })));
  return {
    source,
    schema_version: String(payload.schema_version || ''),
    pricing_version: String(payload.catalog_revision || ''),
    fetched_at: new Date().toISOString(),
    // A degraded catalog deliberately returns HTTP 200 so model discovery can
    // continue.  The body flag, not the status code, is the capability truth.
    catalog_verified: capabilityDataAvailable,
    capability_data_available: capabilityDataAvailable,
    advisory,
    availability_scope: 'credential',
    scope_verified: true,
    scope: objectValue(payload.scope),
    catalog_format: Array.isArray(payload.models) ? 'models'
      : Array.isArray(payload?.data?.models) ? 'data.models' : 'data',
    text: [],
    image: [],
    video,
    warnings: advisory ? [advisory] : [],
  };
}

function capabilityCacheKey(config) {
  const base = normalizeYinziBaseUrl(config?.base_url);
  const keyHash = crypto.createHash('sha256').update(String(config?.api_key || '')).digest('hex');
  return `${base}\x00${keyHash}`;
}

function setCapabilityCatalogCache(cacheKey, value) {
  capabilityCatalogCache.delete(cacheKey);
  capabilityCatalogCache.set(cacheKey, value);
  while (capabilityCatalogCache.size > MAX_CAPABILITY_CATALOG_CACHE_ENTRIES) {
    capabilityCatalogCache.delete(capabilityCatalogCache.keys().next().value);
  }
}

async function fetchYinziCapabilityCatalog(config, fetchImpl = fetch, options = {}) {
  const apiKey = String(config?.api_key || '').trim();
  if (!apiKey) throw new Error('能力目录需要 API Key');
  const url = capabilityCatalogUrl(config?.base_url);
  const cacheKey = capabilityCacheKey(config);
  const now = Date.now();
  const cached = capabilityCatalogCache.get(cacheKey);
  if (cached && options.force_refresh !== true && now - cached.cachedAt < CAPABILITY_CATALOG_TTL_MS) {
    return cached.value;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const headers = { Accept: YINZI_CAPABILITY_ACCEPT, Authorization: `Bearer ${apiKey}` };
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    const res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
    if (res.status === 304) {
      if (!cached?.value) {
        const error = new Error('能力目录返回 304，但本地没有可复用缓存');
        error.status = 304;
        throw error;
      }
      const value = {
        ...cached.value,
        cache_status: 'not_modified',
        revalidated_at: new Date().toISOString(),
      };
      setCapabilityCatalogCache(cacheKey, { ...cached, cachedAt: now, value });
      return value;
    }
    if (!res.ok) {
      const error = new Error(`能力目录请求失败: HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    const normalized = normalizeYinziCapabilityCatalog(await res.json(), url);
    const etag = typeof res.headers?.get === 'function'
      ? String(res.headers.get('etag') || '').trim()
      : String(res.headers?.etag || res.headers?.ETag || '').trim();
    const value = etag ? { ...normalized, etag } : normalized;
    setCapabilityCatalogCache(cacheKey, { cachedAt: now, value, etag: etag || null });
    return value;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('能力目录请求超时');
      timeoutError.code = 'CAPABILITY_CATALOG_NETWORK';
      throw timeoutError;
    }
    if (error?.status == null) error.code = error.code || 'CAPABILITY_CATALOG_NETWORK';
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchYinziCatalogForConfig(config, fetchImpl = fetch, options = {}) {
  try {
    const catalog = await fetchYinziCapabilityCatalog(config, fetchImpl);
    const warnings = Array.isArray(catalog.warnings) ? [...catalog.warnings] : [];
    if (catalog.catalog_verified !== true) {
      warnings.unshift('当前 Key 的视频能力目录暂不可用；自动选择仅使用 Key 已发现模型，站点公开报价仍可手动选择');
    }
    let publicCatalog = null;
    if (options.include_public_catalog === true) {
      try {
        publicCatalog = await fetchYinziCatalog(fetchImpl, { use_cache: fetchImpl === fetch });
      } catch (error) {
        warnings.push(`公开视频目录暂不可用（${error?.message || '请求失败'}），仍保留当前 Key 模型`);
      }
    }
    return {
      ...catalog,
      public_catalog: publicCatalog,
      capability_outcome: catalog.catalog_verified === true ? 'active' : 'deferred',
      warnings,
    };
  } catch (capabilityError) {
    const fallbackReason = capabilityError?.message || 'capability catalog unavailable';
    const warning = `模型能力合同暂不可用（${fallbackReason}），已按当前 Key 的模型目录继续配置`;
    try {
      const legacy = await fetchYinziCatalog(fetchImpl, { use_cache: fetchImpl === fetch });
      return {
        ...legacy,
        source: 'legacy_fallback',
        catalog_verified: false,
        capability_outcome: 'deferred',
        fallback_reason: fallbackReason,
        warnings: [warning],
        public_catalog: legacy,
      };
    } catch (pricingError) {
      return {
        source: 'discovery_only',
        pricing_version: '',
        fetched_at: new Date().toISOString(),
        catalog_verified: false,
        availability_scope: 'credential',
        scope_verified: false,
        capability_outcome: 'deferred',
        fallback_reason: fallbackReason,
        pricing_fallback_reason: pricingError?.message || 'public pricing catalog unavailable',
        warnings: [warning, '公开价格目录暂不可用，已保留当前 Key 返回的全部模型；稍后可重新同步价格'],
        public_catalog: null,
        text: [],
        image: [],
        video: [],
      };
    }
  }
}

function normalizeModelList(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '').split(/[\n,，]/);
  const seen = new Set();
  return raw.map(normalizeOpaqueModel).filter((model) => {
    const key = model.toLowerCase();
    if (!model || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveYinziKeys(input = {}) {
  const universalKey = String(input.api_key || input.universal_api_key || '').trim();
  const textKey = String(input.text_api_key || '').trim() || universalKey;
  const imageKey = String(input.image_api_key || '').trim() || universalKey;
  const videoKey = String(input.video_api_key || '').trim() || universalKey;
  if (!textKey || !imageKey || !videoKey) {
    throw new Error('请填写一个通用 API Key；只有不同分组时才需要在高级设置覆盖各环节 Key');
  }
  return { universalKey, textKey, imageKey, videoKey };
}

function resolveYinziBaseUrls(input = {}) {
  const universal = normalizeYinziBaseUrl(input.base_url || YINZI_DEFAULT_BASE_URL);
  return {
    universal,
    text: normalizeYinziBaseUrl(input.text_base_url || universal),
    image: normalizeYinziBaseUrl(input.image_base_url || universal),
    video: normalizeYinziBaseUrl(input.video_base_url || universal),
  };
}

function endpointTypes(item) {
  return normalizeEndpointTypes(item?.endpoint_types || item?.supported_endpoint_types || item?.endpoints || []);
}

function isKnownYinziVideoModel(model) {
  return Boolean(getYinziVideoCapability(model));
}

function modelsForService(items, serviceType) {
  return (Array.isArray(items) ? items : []).filter((item) => {
    const endpoints = endpointTypes(item);
    if (serviceType === 'video') {
      if (endpoints.includes('openai-video')) return true;
      // Some OpenAI-compatible relays omit endpoint metadata for a known
      // Yinzi video product. Exact registry membership is a bounded hint;
      // arbitrary names are never classified as video.
      return !endpoints.length && isKnownYinziVideoModel(item?.model);
    }
    if (serviceType === 'image') return endpoints.includes('image-generation');
    return endpoints.includes('openai')
      && !endpoints.includes('openai-video')
      && !endpoints.includes('image-generation');
  });
}

function preferredModel(requested, available, preferred, fallback) {
  const requestedModel = normalizeOpaqueModel(requested);
  if (requestedModel) return requestedModel;
  const names = (available || []).map((item) => normalizeOpaqueModel(item.model)).filter(Boolean);
  return names.find((model) => model === preferred) || names[0] || fallback;
}

function chooseDefaultYinziVideoModel(videoCatalog, requested = '') {
  const requestedModel = normalizeOpaqueModel(requested);
  if (requestedModel) return requestedModel;
  const items = Array.isArray(videoCatalog) ? videoCatalog : [];
  if (!items.length) return '';
  const routableItems = items.filter((item) => item.credential_verified === true
    || (item.scope_verified === true && item.availability_scope === 'credential')
    || item.smart_routing_candidate === true);
  const seedance = sortCatalogItems('video', routableItems.filter((item) => (
    /seedance/i.test(String(item.model || ''))
    && item.capabilities?.automatic_eligible !== false
    && item.capabilities?.expensive_bypass !== true
  )))[0];
  if (seedance) return seedance.model;
  try {
    return selectShotVideoRoute({
      shot: { content: { duration: 5, previs_mode: 'skip', route_profile: 'short_image_guided' } },
      catalog: { video: items, fetched_at: new Date().toISOString(), pricing_version: '' },
      policy: { video_routing_mode: 'auto', video_quality: 'balanced', director_mode: 'off' },
    }).model;
  } catch (_) {
    return routableItems.find((item) => item.capabilities?.automatic_eligible === true)?.model
      || routableItems.find((item) => item.capabilities?.expensive_bypass !== true)?.model
      || routableItems[0]?.model
      || items[0]?.model
      || '';
  }
}

async function prepareYinziSetupInput(input = {}, fetchImpl = fetch) {
  const baseUrls = resolveYinziBaseUrls(input);
  const baseUrl = baseUrls.universal;
  const routingMode = resolveYinziRoutingMode(input);
  const smartRouting = routingMode === 'smart';
  const distributionProfile = resolveDistributionProfile(input);
  const { universalKey, textKey, imageKey, videoKey } = resolveYinziKeys(input);
  const discoveryByKey = new Map();
  const discover = async (apiKey, serviceType, serviceBase, fallbackModel) => {
    // A universal key/base should make one read-only request and then be
    // classified for text/image/video locally. Distinct per-service URLs or
    // keys naturally get their own scoped request.
    const cacheKey = `${serviceBase}|${apiKey}`;
    if (!discoveryByKey.has(cacheKey)) {
      discoveryByKey.set(cacheKey, aiConfigService.discoverModels({
        base_url: serviceBase,
        api_key: apiKey,
        provider: 'yinzi',
        service_type: serviceType,
        model: fallbackModel ? [fallbackModel] : [],
        default_model: fallbackModel,
      }, { fetchImpl }));
    }
    try {
      return await discoveryByKey.get(cacheKey);
    } catch (error) {
      return aiConfigService.buildDiscoveryFallback({
        base_url: serviceBase,
        api_key: apiKey,
        provider: 'yinzi',
        service_type: serviceType,
        model: [fallbackModel],
        default_model: fallbackModel,
      }, error, { service_type: serviceType, fallback_model: fallbackModel });
    }
  };

  const [textDiscovery, imageDiscovery, videoDiscovery] = await Promise.all([
    discover(textKey, 'text', baseUrls.text, normalizeOpaqueModel(input.text_model) || 'gpt-5.6-sol'),
    discover(imageKey, 'image', baseUrls.image, normalizeOpaqueModel(input.image_model) || 'gpt-image-2'),
    discover(videoKey, 'video', baseUrls.video, normalizeOpaqueModel(input.video_model) || 'Seedance 2.5-720'),
  ]);
  // Capability contracts and public prices enrich the key-scoped /models
  // result, but never decide whether a valid key can be configured.
  const pricingCatalog = await fetchYinziCatalogForConfig(
    { base_url: baseUrls.video, api_key: videoKey },
    fetchImpl,
    { include_public_catalog: true }
  );
  const textEntries = modelsForService(textDiscovery.models, 'text');
  const imageEntries = modelsForService(imageDiscovery.models, 'image');
  const videoEntries = modelsForService(videoDiscovery.models, 'video');
  const mergedVideoCatalog = aiConfigService.mergeDiscoveredCatalog(videoDiscovery, pricingCatalog, {
    provider: 'yinzi',
    service_type: 'video',
    include_public_catalog: true,
    smart_routing: smartRouting,
    distribution_profile: distributionProfile,
  });
  const videoCatalog = (mergedVideoCatalog.video || []).filter((item) => endpointTypes(item).includes('openai-video'));
  const credentialVideoCatalog = videoCatalog.filter((item) => item.credential_verified === true);
  const routableVideoCatalog = smartRouting
    ? videoCatalog.filter((item) => item.credential_verified === true || item.smart_routing_candidate === true)
    : credentialVideoCatalog;

  const textModel = preferredModel(input.text_model, textEntries, 'gpt-5.6-sol', 'gpt-5.6-sol');
  const imageModel = preferredModel(input.image_model, imageEntries, 'gpt-image-2', 'gpt-image-2');
  const videoModel = chooseDefaultYinziVideoModel(routableVideoCatalog, input.video_model) || 'Seedance 2.5-720';
  const warnings = [];
  if (!routableVideoCatalog.length) warnings.push('目录未提供视频候选，已保留指定模型；实际生成结果以提交回执为准');
  warnings.push(...(Array.isArray(pricingCatalog.warnings) ? pricingCatalog.warnings : []));
  if (!textEntries.length) warnings.push('当前文本 Key 未返回文本模型，已保留 gpt-5.6-sol 默认值');
  if (!imageEntries.length) warnings.push('当前生图 Key 未返回生图模型，已保留 gpt-image-2 默认值');

  return {
    ...input,
    base_url: baseUrl,
    text_base_url: baseUrls.text,
    image_base_url: baseUrls.image,
    video_base_url: baseUrls.video,
    routing_mode: routingMode,
    smart_routing: smartRouting,
    api_key: universalKey,
    text_api_key: textKey,
    image_api_key: imageKey,
    video_api_key: videoKey,
    text_model: textModel,
    image_model: imageModel,
    video_model: videoModel,
    text_models: normalizeModelList([...textEntries.map((item) => item.model), textModel]),
    image_models: normalizeModelList([...imageEntries.map((item) => item.model), imageModel]),
    video_models: normalizeModelList([...videoCatalog.map((item) => item.model), videoModel]),
    setup_catalog: {
      fetched_at: videoDiscovery.snapshot?.fetched_at || pricingCatalog.fetched_at || new Date().toISOString(),
      availability_scope: videoDiscovery.snapshot?.availability_scope || videoDiscovery.availability_scope || 'credential',
      scope_verified: videoDiscovery.snapshot?.scope_verified === true,
      pricing_version: pricingCatalog.pricing_version || '',
      capability_outcome: pricingCatalog.capability_outcome || (pricingCatalog.catalog_verified ? 'active' : 'deferred'),
      catalog_source: pricingCatalog.source || '',
      routing_mode: routingMode,
      smart_routing_enabled: smartRouting,
      distribution_profile: distributionProfile,
      text_model_count: textEntries.length,
      image_model_count: imageEntries.length,
      video_model_count: videoCatalog.length,
      credential_video_model_count: credentialVideoCatalog.length,
      public_video_model_count: videoCatalog.filter((item) => item.public_catalog === true && item.credential_verified !== true).length,
      selected_video_model: videoModel,
      selection_mode: smartRouting ? 'smart_seedance_preferred_then_cost' : 'credential_seedance_preferred_then_cost',
      selection_reason: normalizeOpaqueModel(input.video_model)
        ? 'user_selected'
        : /seedance/i.test(videoModel) ? 'current_key_seedance_preferred'
          : routableVideoCatalog.length === 1 ? 'only_current_key_video_model'
            : 'current_key_compatible_model',
      warnings: [
        ...warnings,
        ...[textDiscovery, imageDiscovery, videoDiscovery]
          .filter((item) => item?.partial)
          .map((item) => `${item.diagnostic?.code || 'MODEL_DISCOVERY_FAILED'}: ${item.diagnostic?.message || '模型目录暂不可用'}（已保留手动模型）`),
      ],
      models: videoCatalog.map((item) => ({
        model: item.model,
        name: item.name || item.model,
        endpoint_types: endpointTypes(item),
        groups: Array.isArray(item.groups) ? item.groups : [],
        prices: Array.isArray(item.prices) ? item.prices : [],
        cheapest_effective_price: Number.isFinite(Number(item.cheapest_effective_price))
          ? Number(item.cheapest_effective_price) : null,
        capabilities: item.capabilities || null,
        provider_contract: item.provider_contract || item.capabilities?.provider_contract || '',
        provider_create_path: item.provider_create_path || item.capabilities?.provider_create_path || '',
        provider_query_path: item.provider_query_path || item.capabilities?.provider_query_path || '',
        provider_content_path: item.provider_content_path || item.capabilities?.provider_content_path || '',
        capability_source: item.capability_source || 'unknown',
        contract_status: item.contract_status || (item.capabilities ? 'known' : 'missing'),
        automatic_eligible: item.automatic_eligible === true,
        catalog_verified: item.catalog_verified === true,
        availability_scope: item.availability_scope || videoDiscovery.snapshot?.availability_scope || 'credential',
        scope_verified: item.scope_verified === true,
        credential_verified: item.credential_verified === true,
        smart_routing_candidate: item.smart_routing_candidate === true,
        public_catalog: item.public_catalog === true,
        manual_only: item.manual_only === true,
      })),
    },
  };
}

function yinziConfigDefinitions(input) {
  const baseUrls = resolveYinziBaseUrls(input);
  const baseUrl = baseUrls.universal;
  const routingMode = resolveYinziRoutingMode(input);
  const smartRouting = routingMode === 'smart';
  const distributionProfile = resolveDistributionProfile(input);
  const { textKey, imageKey, videoKey } = resolveYinziKeys(input);
  const textModel = normalizeOpaqueModel(input.text_model);
  const imageModel = normalizeOpaqueModel(input.image_model);
  const videoModel = normalizeOpaqueModel(input.video_model);
  if (!textModel || !imageModel || !videoModel) throw new Error('文本、图片、视频模型均为必填');
  const textModels = normalizeModelList([...(normalizeModelList(input.text_models)), textModel]);
  const imageModels = normalizeModelList([...(normalizeModelList(input.image_models)), imageModel]);
  const videoModels = normalizeModelList([
    ...(normalizeModelList(input.video_models)),
    videoModel,
  ]);
  const shared = { provider: 'yinzi', priority: 100, is_default: true };
  const commonSettings = {
    catalog_url: YINZI_CATALOG_URL,
    local_media_persistence: true,
    routing_mode: routingMode,
    smart_routing_enabled: smartRouting,
    distribution_profile: distributionProfile,
  };
  const settings = JSON.stringify(commonSettings);
  const videoSettings = JSON.stringify({
    ...commonSettings,
    auto_model_selection: true,
    model_catalog_snapshot: input.setup_catalog || null,
  });
  return [
    { ...shared, base_url: baseUrls.text, service_type: 'text', name: 'YinziAPI 文本', api_protocol: 'openai', api_key: textKey, model: textModels, default_model: textModel, endpoint: '/chat/completions', query_endpoint: '', settings },
    { ...shared, base_url: baseUrls.image, service_type: 'image', name: 'YinziAPI 文本生图', api_protocol: 'openai', api_key: imageKey, model: imageModels, default_model: imageModel, endpoint: '/images/generations', query_endpoint: '', settings },
    { ...shared, base_url: baseUrls.image, service_type: 'storyboard_image', name: 'YinziAPI 分镜图', api_protocol: 'openai', api_key: imageKey, model: imageModels, default_model: imageModel, endpoint: '/images/generations', query_endpoint: '', settings },
    { ...shared, base_url: baseUrls.video, service_type: 'video', name: 'YinziAPI 视频', api_protocol: 'yinzi', api_key: videoKey, model: videoModels, default_model: videoModel, endpoint: '/videos', query_endpoint: '/videos/{taskId}', settings: videoSettings },
  ];
}

function upsertYinziConfigs(db, log, input) {
  const definitions = yinziConfigDefinitions(input || {});
  const apply = db.transaction(() => definitions.map((definition) => {
    const existing = db.prepare(
      `SELECT id FROM ai_service_configs
       WHERE deleted_at IS NULL AND provider = 'yinzi' AND service_type = ?
       ORDER BY is_default DESC, updated_at DESC, id DESC`
    ).all(definition.service_type);
    let config;
    if (existing.length) {
      config = aiConfigService.updateConfig(db, log, existing[0].id, definition);
      const duplicateIds = existing.slice(1).map((row) => row.id);
      if (duplicateIds.length) {
        const now = new Date().toISOString();
        const softDelete = db.prepare('UPDATE ai_service_configs SET deleted_at = ? WHERE id = ?');
        for (const id of duplicateIds) softDelete.run(now, id);
      }
    } else {
      config = aiConfigService.createConfig(db, log, definition);
    }
    return {
      id: config.id,
      service_type: config.service_type,
      name: config.name,
      model: config.default_model,
      is_default: config.is_default,
    };
  }));
  const configured = apply();
  return {
    provider: 'yinzi',
    base_url: definitions[0].base_url,
    text_base_url: definitions.find((item) => item.service_type === 'text')?.base_url || '',
    image_base_url: definitions.find((item) => item.service_type === 'image')?.base_url || '',
    video_base_url: definitions.find((item) => item.service_type === 'video')?.base_url || '',
    routing_mode: resolveYinziRoutingMode(input),
    distribution_profile: resolveDistributionProfile(input),
    distribution: getDistributionProfile(input),
    catalog: input.setup_catalog || null,
    configured,
  };
}

module.exports = {
  YINZI_CATALOG_URL,
  YINZI_DEFAULT_BASE_URL,
  normalizeYinziBaseUrl,
  resolveYinziBaseUrls,
  normalizeYinziRoutingMode,
  resolveYinziRoutingMode,
  isYinziSmartRoutingConfig,
  normalizeYinziCatalog,
  fetchYinziCatalog,
  fetchYinziCapabilityCatalog,
  fetchYinziCatalogForConfig,
  normalizeYinziCapabilityCatalog,
  normalizeModelList,
  chooseDefaultYinziVideoModel,
  prepareYinziSetupInput,
  yinziConfigDefinitions,
  upsertYinziConfigs,
};
