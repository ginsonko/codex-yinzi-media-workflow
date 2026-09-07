const KNOWN_STALE_PRICING_VERSION = 'a42d372ccf0b5dd13ecf71203521f9d2';
const DEFAULT_PRICE_SOURCE = 'yinzi-catalog-2026-08-16';

function normalizeModelName(model) {
  return String(model || '').trim().toLowerCase();
}

function price(model, group, billingUnit, effectivePrice, options = {}) {
  return Object.freeze({
    model,
    group,
    billing_mode: 'fixed_price',
    billing_unit: billingUnit,
    effective_price: effectivePrice,
    effective_input_usd: null,
    effective_output_usd: null,
    fixed_duration_seconds: options.fixedDurationSeconds ?? null,
    allowed_durations: Array.isArray(options.allowedDurations)
      ? Object.freeze([...new Set(options.allowedDurations.map(Number).filter(Number.isFinite))].sort((a, b) => a - b))
      : null,
    currency: options.currency || 'CNY',
    source: DEFAULT_PRICE_SOURCE,
  });
}

const DEFAULT_VIDEO_PRICES = Object.freeze([
  price('官转-seedance2.0 720p-fast', '特价视频分组(即梦)', 'per_second', 1.014),
  price('官转-seedance2.0 720p-pro', '特价视频分组(即梦)', 'per_second', 1.17),
  price('破甲seedance 720p-fast', '特价视频分组(即梦)', 'per_second', 2.1528),
  // Seedance 2.5 is a fixed 30-second, per-request product. The final edit
  // may retain a shorter creative segment, but the provider request unit is
  // always one 30-second generation.
  price('特价seedance-2.5-480p', '特价视频分组(即梦)', 'per_request', 3.5, { fixedDurationSeconds: 30, allowedDurations: [30] }),
  price('特价seedance-2.5-720p', '特价视频分组(即梦)', 'per_request', 3.5, { fixedDurationSeconds: 30, allowedDurations: [30] }),
  price('af-seedance-2.0', '特价视频分组(即梦)', 'per_request', 0.3484),
  price('af-seedance-2.0-fast', '特价视频分组(即梦)', 'per_request', 0.2587),
  price('ca-seedance 2.0 720pro-15s', '特价视频分组(即梦)', 'per_request', 3.874),
  price('cav2-seedance 2.0 720pro-15s', '特价视频分组(即梦)', 'per_request', 3.874),
  price('mg-seedance2.0 -480p', '特价视频分组(即梦)', 'per_second', 0.3484),
  price('mg-seedance2.0 -480p fast', '特价视频分组(即梦)', 'per_second', 0.2145),
  price('mg-seedance2.0 -480p mini', '特价视频分组(即梦)', 'per_second', 0.1664),
  price('mg-seedance2.0 -720p fast', '特价视频分组(即梦)', 'per_second', 0.3484),
  price('mg-seedance2.0 -720p mini', '特价视频分组(即梦)', 'per_second', 0.2574),
  price('mg-seedance2.0 -720p pro', '特价视频分组(即梦)', 'per_second', 0.4784),
  price('seedance-2.5-480p', '特价视频分组(即梦)', 'per_request', 3.5, { fixedDurationSeconds: 30, allowedDurations: [30] }),
  price('seedance-2.5-720p', '特价视频分组(即梦)', 'per_request', 3.5, { fixedDurationSeconds: 30, allowedDurations: [30] }),
  price('seedance2.0 -720p-15s', '特价视频分组(即梦)', 'per_request', 6.344),
  price('seedance2.0 -720p-gz-15s', '特价视频分组(即梦)', 'per_request', 6.474),
  price('cm-seedance2.0 -720p-15s', '特价视频分组(即梦)', 'per_request', 8.0808),
  price('cm-seedance2.0特价fast-720p-gz-15s', '特价视频分组(即梦)', 'per_request', 4.68, { fixedDurationSeconds: 15 }),
  price('seedance2.0 -720p-fast-15s', '特价视频分组(即梦)', 'per_request', 5.58),
  price('seedance2.0 720p-pro-nv-nsp', '特价视频分组(即梦)', 'per_request', 0.44928),
  price('seedance2.0特价pro-720p-gz-15s', '特价视频分组(即梦)', 'fixed_duration', 6.24, { fixedDurationSeconds: 15 }),
  price('seedance2.0特价pro-720p-gz-15s-nsp', '特价视频分组(即梦)', 'per_request', 5.16, { fixedDurationSeconds: 15 }),
  price('grok-imagine-video', '视频模型渠道', 'per_request', 0.1125),
  price('MiniMax-H3-2k', 'minimax/可灵视频', 'per_second', 0.20475),
  price('MiniMax-H3-4k', 'minimax/可灵视频', 'per_request', 0.325),
  price('Kling VIDEO 3.0 Omni', 'minimax/可灵视频', 'per_request', 0.25),
  price('Kling VIDEO 3.0 Omni-1080p', 'minimax/可灵视频', 'per_second', 0.325),
  price('Kling VIDEO 3.0 Omni-4k', 'minimax/可灵视频', 'per_second', 0.4225),
]);

const DEFAULT_VIDEO_PRICE_BY_MODEL = new Map(
  DEFAULT_VIDEO_PRICES.map((item) => [normalizeModelName(item.model), item])
);

function getDefaultYinziVideoPrice(model) {
  const item = DEFAULT_VIDEO_PRICE_BY_MODEL.get(normalizeModelName(model));
  if (!item) return null;
  const { model: _model, ...priceFields } = item;
  return priceFields;
}

function listDefaultYinziVideoPrices() {
  return DEFAULT_VIDEO_PRICES.map((item) => ({ ...item }));
}

function validVideoPrice(price) {
  return ['per_request', 'per_second', 'per_generation', 'fixed_duration'].includes(String(price?.billing_unit || '').toLowerCase())
    && Number.isFinite(Number(price?.effective_price));
}

function resolveYinziVideoPrices(model, livePrices, pricingVersion) {
  const validLive = (Array.isArray(livePrices) ? livePrices : []).filter(validVideoPrice);
  const fallback = getDefaultYinziVideoPrice(model);
  if (fallback && (pricingVersion === KNOWN_STALE_PRICING_VERSION || !validLive.length)) {
    return [fallback];
  }
  return validLive.length ? validLive : fallback ? [fallback] : [];
}

module.exports = {
  DEFAULT_PRICE_SOURCE,
  DEFAULT_VIDEO_PRICES,
  KNOWN_STALE_PRICING_VERSION,
  getDefaultYinziVideoPrice,
  listDefaultYinziVideoPrices,
  resolveYinziVideoPrices,
};
