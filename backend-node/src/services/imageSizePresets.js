/**
 * Image sizes. 1K / 2K / 4K mean the long edge (1024 / 2048 / 4096); the other edge follows the aspect
 * ratio, both edges are a multiple of the model's step and stay inside its edge and pixel limits.
 *
 * GPT Image 2 / 2.5 (and the sites' smart-image route, which dispatches to them) only route one size
 * per shape and tier; anything else, e.g. 1920x1920 or 1024x1536, gets "no eligible route" on the site
 * even though the model itself would accept it, so their sizes snap to IMAGE_SIZE_PRESETS. The table is
 * built from the same rule (a portrait 1440x2560 was scaled by the gateway to the invalid 2048x3641).
 * Same table as frontweb/src/utils/imageSizes.js.
 */
const TIER_EDGE = Object.freeze({ '1K': 1024, '2K': 2048, '4K': 4096 });
const TIERS = Object.keys(TIER_EDGE);
const DEFAULT_TIER = '2K';
const RATIOS = Object.freeze({ '1:1': 1, '3:2': 3 / 2, '16:9': 16 / 9, '9:16': 9 / 16, '4:3': 4 / 3, '3:4': 3 / 4, '21:9': 21 / 9 });

const PRESET_SPEC = Object.freeze({ step: 16, maxEdge: 3840, maxPixels: 8294400, minPixels: 655360 });
const DEFAULT_SPEC = Object.freeze({ step: 16, maxEdge: 4096, maxPixels: 4096 * 4096, minPixels: 0 });

const dims = (s) => s.split('x').map(Number);

/** gpt-image-2, gpt-image-2.5 and their site variants (gpt-image-2.5-flare …), plus smart-image. */
function usesImageSizePresets(model) {
  const m = String(model || '').trim().toLowerCase().split('/').pop();
  return m === 'smart-image' || /^gpt-image-2(?:\.5)?(?:-[\w.-]+)?$/.test(m);
}

/** w x h scaled to fit the spec, both edges a multiple of its step; the shape drifts by at most half a step. */
function fit(w, h, spec) {
  const { step, maxEdge, maxPixels, minPixels } = spec;
  const r = (v) => Math.max(step, Math.round(v / step) * step);
  let s = Math.min(1, maxEdge / Math.max(w, h), Math.sqrt(maxPixels / (w * h)));
  if (w * h * s * s < minPixels) s = Math.sqrt(minPixels / (w * h));
  let [W, H] = [r(w * s), r(h * s)];
  for (let i = 0; i < 200 && (Math.max(W, H) > maxEdge || W * H > maxPixels); i++) [W, H] = [r(w * (s *= 0.995)), r(h * s)];
  for (let i = 0; i < 200 && W * H < minPixels; i++) [W, H] = [r(w * (s *= 1.005)), r(h * s)];
  return `${W}x${H}`;
}

const forTier = (ratio, tier, spec) => (ratio >= 1 ? fit(TIER_EDGE[tier], TIER_EDGE[tier] / ratio, spec) : fit(TIER_EDGE[tier] * ratio, TIER_EDGE[tier], spec));

const IMAGE_SIZE_PRESETS = (() => {
  const out = {};
  for (const [label, ratio] of Object.entries(RATIOS)) {
    out[label] = {};
    for (const tier of TIERS) out[label][tier] = forTier(ratio, tier, PRESET_SPEC);
    Object.freeze(out[label]);
  }
  return Object.freeze(out);
})();

function parseRatio(value) {
  const m = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*[:/xX*]\s*(\d+(?:\.\d+)?)$/);
  if (!m) return 0;
  const r = Number(m[1]) / Number(m[2]);
  return Number.isFinite(r) && r > 0 ? r : 0;
}

function nearestRatio(r) {
  let best = '1:1';
  let diff = Infinity;
  for (const [label, ratio] of Object.entries(RATIOS)) {
    const d = Math.abs(Math.log(r) - Math.log(ratio));
    if (d < diff - 1e-9) {
      diff = d;
      best = label;
    }
  }
  return best;
}

/** The tier whose pixel count is closest; a tie goes to the larger one so a picture is never shrunk. */
function nearestTier(label, pixels) {
  let best = DEFAULT_TIER;
  let diff = Infinity;
  for (const tier of TIERS) {
    const [w, h] = dims(IMAGE_SIZE_PRESETS[label][tier]);
    const d = Math.abs(Math.log(pixels) - Math.log(w * h));
    if (d <= diff + 1e-9) {
      diff = d;
      best = tier;
    }
  }
  return best;
}

const readSize = (size) => {
  const s = String(size || '').trim().toLowerCase().replace(/\s/g, '');
  const wh = s.match(/^(\d+)[x*×](\d+)$/);
  if (wh && Number(wh[1]) > 0 && Number(wh[2]) > 0) return { w: Number(wh[1]), h: Number(wh[2]) };
  return { tier: /^[124]k$/.test(s) ? s.toUpperCase() : '' };
};

/**
 * The supported size closest to what was asked for. `size` may be "1920x1920", "1920*1920", a tier such
 * as "2K", or empty; `aspectRatio` (e.g. "9:16") is used when the size alone has no shape. Returns ''
 * when there is nothing to go on, so the caller leaves size out and the site uses its default.
 */
function snapImageSize(size, aspectRatio) {
  const { w, h, tier } = readSize(size);
  if (w) {
    const label = nearestRatio(w / h);
    return IMAGE_SIZE_PRESETS[label][nearestTier(label, w * h)];
  }
  const ratio = parseRatio(aspectRatio);
  if (!ratio && !tier) return '';
  return IMAGE_SIZE_PRESETS[nearestRatio(ratio || 1)][tier || DEFAULT_TIER];
}

/**
 * The WxH to send to `model`: the preset for GPT Image 2 / 2.5 and smart-image, else the same rule with
 * the model's own shape (a given WxH keeps its shape, a tier takes `aspectRatio`). '' = leave size out.
 */
function imageSizeFor(model, size, aspectRatio) {
  if (usesImageSizePresets(model)) return snapImageSize(size, aspectRatio);
  const { w, h, tier } = readSize(size);
  if (w) return fit(w, h, DEFAULT_SPEC);
  const ratio = parseRatio(aspectRatio);
  if (!ratio && !tier) return '';
  return forTier(ratio || 1, tier || DEFAULT_TIER, DEFAULT_SPEC);
}

module.exports = { IMAGE_SIZE_PRESETS, TIER_EDGE, usesImageSizePresets, snapImageSize, imageSizeFor };
