/**
 * GPT Image 2 / 2.5 (and the sites' smart-image route, which dispatches to them) only route the sizes in
 * this table; anything else, e.g. 1920x1920 or 1024x1536, gets "no eligible route" on the site even
 * though the model itself would accept it. Same table as frontweb/src/utils/imageSizes.js.
 */
const IMAGE_SIZE_PRESETS = Object.freeze({
  '1:1': { '1K': '1024x1024', '2K': '2048x2048', '4K': '2880x2880' },
  '3:2': { '1K': '1536x1024', '2K': '2160x1440', '4K': '3456x2304' },
  '16:9': { '1K': '1280x720', '2K': '2560x1440', '4K': '3840x2160' },
  '9:16': { '1K': '720x1280', '2K': '1440x2560', '4K': '2160x3840' },
  '4:3': { '1K': '1024x768', '2K': '2048x1536', '4K': '3200x2400' },
  '3:4': { '1K': '768x1024', '2K': '1536x2048', '4K': '2400x3200' },
  '21:9': { '1K': '1280x544', '2K': '2560x1088', '4K': '3840x1600' },
});
const TIERS = ['1K', '2K', '4K'];
const DEFAULT_TIER = '2K';

const dims = (s) => s.split('x').map(Number);

/** gpt-image-2, gpt-image-2.5 and their site variants (gpt-image-2.5-flare …), plus smart-image. */
function usesImageSizePresets(model) {
  const m = String(model || '').trim().toLowerCase().split('/').pop();
  return m === 'smart-image' || /^gpt-image-2(?:\.5)?(?:-[\w.-]+)?$/.test(m);
}

function parseRatio(value) {
  const m = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*[:/xX*]\s*(\d+(?:\.\d+)?)$/);
  if (!m) return 0;
  const r = Number(m[1]) / Number(m[2]);
  return Number.isFinite(r) && r > 0 ? r : 0;
}

function nearestRatio(r) {
  let best = '1:1';
  let diff = Infinity;
  for (const label of Object.keys(IMAGE_SIZE_PRESETS)) {
    const [w, h] = dims(IMAGE_SIZE_PRESETS[label]['1K']);
    const d = Math.abs(Math.log(r) - Math.log(w / h));
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

/**
 * The supported size closest to what was asked for. `size` may be "1920x1920", "1920*1920", a tier such
 * as "2K", or empty; `aspectRatio` (e.g. "9:16") is used when the size alone has no shape. Returns ''
 * when there is nothing to go on, so the caller leaves size out and the site uses its default.
 */
function snapImageSize(size, aspectRatio) {
  const s = String(size || '').trim().toLowerCase().replace(/\s/g, '');
  const wh = s.match(/^(\d+)[x*×](\d+)$/);
  if (wh && Number(wh[1]) > 0 && Number(wh[2]) > 0) {
    const w = Number(wh[1]);
    const h = Number(wh[2]);
    const label = nearestRatio(w / h);
    return IMAGE_SIZE_PRESETS[label][nearestTier(label, w * h)];
  }
  const ratio = parseRatio(aspectRatio);
  const tier = /^[124]k$/.test(s) ? s.toUpperCase() : '';
  if (!ratio && !tier) return '';
  return IMAGE_SIZE_PRESETS[nearestRatio(ratio || 1)][tier || DEFAULT_TIER];
}

module.exports = { IMAGE_SIZE_PRESETS, usesImageSizePresets, snapImageSize };
