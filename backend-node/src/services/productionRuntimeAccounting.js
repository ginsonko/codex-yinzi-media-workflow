const aiClient = require('./aiClient');
const imageClient = require('./imageClient');
const costs = require('./productionCostLedger');

function parseSettings(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return {}; }
}

function approximateTokens(value) {
  const text = String(value || '');
  if (!text) return 0;
  // Chinese is often close to one token per character; using the character
  // count is intentionally conservative for a hard spending ceiling.
  return Math.max(1, text.length);
}

function groupFromConfig(config, fallback = '') {
  const settings = parseSettings(config?.settings);
  return String(settings.group_name || settings.billing_group || fallback || '').trim();
}

function textReservation(db, run, input = {}) {
  const route = aiClient.resolveTextRoute(db, 'text', {
    model: input.model || undefined,
    scene_key: input.scene_key || undefined,
  });
  const provider = route?.provider || String(input.provider || '').trim().toLowerCase();
  const model = route?.model || String(input.model || '').trim();
  const groupName = groupFromConfig(route?.config, run?.policy?.text_group);
  const price = costs.findPrice(db, { provider, service_type: 'text', model, group_name: groupName });
  const usage = {
    input_tokens: approximateTokens(`${input.system || ''}\n${input.user || ''}`),
    output_tokens: Math.max(1, Number(input.max_tokens) || 1),
    estimate_kind: 'conservative_character_bound',
  };
  return {
    provider,
    service_type: 'text',
    model,
    group_name: groupName,
    billing_unit: price?.billing_unit || 'unknown',
    units: 1,
    usage,
    price,
    allow_unknown_price: run?.budget?.allow_unknown_price === true,
    note: price ? '文本费用按保守 token 上限预留' : '模型价格未知，费用未定价',
  };
}

function textSettlement(db, actionId, input = {}) {
  const entry = costs.getByAction(db, actionId);
  const usage = {
    input_tokens: approximateTokens(`${input.system || ''}\n${input.user || ''}`),
    output_tokens: approximateTokens(input.output || ''),
    usage_source: 'estimated_from_characters',
  };
  if (!entry || entry.status === 'unpriced') return { usage, note: '第三方未返回 token usage；保持未定价' };
  const actual = costs.estimateMicrousd(entry.price_snapshot, usage);
  return {
    usage,
    ...(actual == null ? {} : { actual_microusd: actual }),
    note: '第三方未返回 token usage；按实际文本字符数估算',
  };
}

function imageReservation(db, run, request = {}) {
  const serviceType = request.image_service_type || 'image';
  let config = null;
  try {
    config = imageClient.getDefaultImageConfig(
      db,
      request.model,
      null,
      serviceType,
      request.image_config_id,
    );
  } catch (_) {}
  const models = Array.isArray(config?.model) ? config.model : config?.model ? [config.model] : [];
  const provider = String(config?.provider || request.provider || '').trim().toLowerCase();
  const model = String(request.model || config?.default_model || models[0] || '').trim();
  const groupName = groupFromConfig(config, run?.policy?.image_group);
  const price = costs.findPrice(db, { provider, service_type: 'image', model, group_name: groupName })
    || costs.findPrice(db, { provider, service_type: serviceType, model, group_name: groupName });
  return {
    provider,
    service_type: 'image',
    model,
    group_name: groupName,
    billing_unit: price?.billing_unit || 'unknown',
    units: 1,
    usage: { units: 1, image_service_type: serviceType },
    price,
    allow_unknown_price: run?.budget?.allow_unknown_price === true,
    note: price ? '单张图片生成费用预留' : '图片模型价格未知，费用未定价',
  };
}

function videoReservation(db, run, request = {}, route = {}) {
  const provider = String(request.provider || run?.policy?.video_provider || '').trim().toLowerCase();
  const model = String(request.model || route.model || '').trim();
  const groupName = String(run?.policy?.video_group || route.group || '').trim();
  const storedPrice = db ? costs.findPrice(db, {
    provider, service_type: 'video', model, group_name: groupName,
  }) : null;
  const routeUnit = ['per_request', 'per_second'].includes(String(route.billing_unit || ''))
    ? String(route.billing_unit)
    : 'unknown';
  // A bounded fallback chain carries an explicit price snapshot from the
  // immutable plan.  It must win over an older catalog row (for example a
  // stale per-second Seedance 2.0 price), otherwise the child action could
  // reserve the wrong amount while the UI claims a per-request product.
  const explicitPrice = route?.price_override && typeof route.price_override === 'object'
    ? route.price_override : null;
  const billingUnit = explicitPrice?.billing_unit || storedPrice?.billing_unit || routeUnit;
  const durationSeconds = Math.max(0, Number(request.duration) || 0);
  const units = billingUnit === 'per_request' ? 1
    : billingUnit === 'per_second' ? durationSeconds
      : 0;
  const routePrice = explicitPrice || (!storedPrice && Number.isFinite(Number(route.unit_price)) && billingUnit !== 'unknown'
    ? {
      provider,
      service_type: 'video',
      model,
      group_name: groupName,
      billing_unit: billingUnit,
      unit_price_microusd: costs.toMicrousd(route.unit_price),
      source: 'frozen_video_route',
      source_version: route.catalog_version || '',
    }
    : null);
  const price = explicitPrice || storedPrice || routePrice;
  const estimatedMicrousd = price
    ? costs.estimateMicrousd(price, { units })
    : Number.isFinite(Number(route.estimated_price))
      ? costs.toMicrousd(route.estimated_price)
      : null;
  return {
    provider,
    service_type: 'video',
    model,
    group_name: groupName,
    billing_unit: billingUnit,
    units,
    usage: { units, duration_seconds: durationSeconds },
    ...(price ? { price } : {}),
    ...(estimatedMicrousd != null ? { estimated_microusd: estimatedMicrousd } : {}),
    allow_unknown_price: run?.budget?.allow_unknown_price === true,
    note: estimatedMicrousd != null ? '按镜头路由和计价单位冻结的价格预留' : '视频路由价格未知，费用未定价',
  };
}

module.exports = {
  approximateTokens,
  imageReservation,
  textReservation,
  textSettlement,
  videoReservation,
};
