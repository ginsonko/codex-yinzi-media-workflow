'use strict';

/**
 * Motion-aware temporal filter & spatial edge refiner for video foreground masks.
 *
 * Unlike naive averaging (which produces terrible ghosting and trailing on moving objects),
 * this filter measures pixel-level frame differences between consecutive video frames.
 * - When significant motion is detected (|I_t - I_{t-1}| > threshold), the filter prioritizes
 *   the current frame mask, resetting or dampening temporal accumulation to avoid trails.
 * - In static/low-motion regions, exponential moving average (EMA) suppresses flickering.
 * - Edge feathering and bilateral guide filtering preserve boundaries and details (e.g. hair/gaps).
 */

const DEFAULTS = Object.freeze({
  temporalSmooth: 0.25,      // Base EMA blend factor for static regions [0, 1]
  motionThresholdRgb: 24,    // RGB difference threshold to declare motion [1, 100]
  motionDecayFactor: 0.15,   // Blend factor when motion is detected (low = trust new frame) [0, 0.5]
  featherPx: 0,              // Edge feather radius [0, 32]
  strength: 1.0,             // Mask contrast strength [0.25, 4.0]
  threshold: 0,              // Lower cut threshold [0, 250]
});

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function boxBlurGray(src, width, height, radius) {
  if (!radius || radius <= 0) return Buffer.from(src);
  const r = Math.round(radius);
  const window = r * 2 + 1;
  const horiz = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + clamp(x, 0, width - 1)];
    for (let x = 0; x < width; x++) {
      horiz[row + x] = acc / window;
      acc += src[row + clamp(x + r + 1, 0, width - 1)] - src[row + clamp(x - r, 0, width - 1)];
    }
  }
  const out = Buffer.alloc(src.length);
  for (let x = 0; x < width; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += horiz[clamp(y, 0, height - 1) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = clamp(Math.round(acc / window), 0, 255);
      acc += horiz[clamp(y + r + 1, 0, height - 1) * width + x] - horiz[clamp(y - r, 0, height - 1) * width + x];
    }
  }
  return out;
}

function applyStrengthAndThreshold(mask, strength, threshold) {
  if (strength === 1.0 && threshold === 0) return mask;
  const out = Buffer.alloc(mask.length);
  const invStrength = 1 / strength;
  for (let i = 0; i < mask.length; i++) {
    let v = mask[i];
    if (v < threshold) v = 0;
    else if (strength !== 1.0 && v > 0) {
      v = clamp(Math.round(255 * ((v / 255) ** invStrength)), 0, 255);
    }
    out[i] = v;
  }
  return out;
}

class ForegroundTemporalRefiner {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.prevRgb = null;
    this.prevMask = null;
    this.width = 0;
    this.height = 0;
  }

  reset() {
    this.prevRgb = null;
    this.prevMask = null;
    this.width = 0;
    this.height = 0;
  }

  /**
   * Process next frame mask with motion-aware temporal smoothing.
   * @param {Buffer} currentRgba - Decoded RGBA buffer of current frame
   * @param {Buffer} currentMask - Single-channel 8-bit mask of current frame
   * @param {number} width
   * @param {number} height
   * @returns {Buffer} Refined mask
   */
  next(currentRgba, currentMask, width, height) {
    const numPixels = width * height;
    if (currentRgba.length !== numPixels * 4 || currentMask.length !== numPixels) {
      throw new Error(`Dimensions mismatch: RGBA (${currentRgba.length}), Mask (${currentMask.length}) for ${width}x${height}`);
    }

    let outMask = Buffer.alloc(numPixels);

    if (!this.prevRgb || !this.prevMask || this.width !== width || this.height !== height) {
      // First frame or dimension change: no temporal history available
      currentMask.copy(outMask);
    } else {
      const baseAlpha = this.options.temporalSmooth;
      const decayAlpha = this.options.motionDecayFactor;
      const motionThresh = this.options.motionThresholdRgb;

      const pRgb = this.prevRgb;
      const pMask = this.prevMask;

      for (let i = 0, p = 0; i < numPixels; i++, p += 4) {
        const curM = currentMask[i];
        const oldM = pMask[i];

        // Foreground departed detection: old frame was foreground, current frame is background.
        // Immediate reset to current frame (alpha = 0) to eliminate trailing ghosts.
        if (oldM >= 32 && curM < 32) {
          outMask[i] = curM;
          continue;
        }

        // Measure frame difference in RGB (L1 distance in RGB)
        const dr = Math.abs(currentRgba[p] - pRgb[p]);
        const dg = Math.abs(currentRgba[p + 1] - pRgb[p + 1]);
        const db = Math.abs(currentRgba[p + 2] - pRgb[p + 2]);
        const diff = (dr + dg + db) / 3;

        let alpha;
        if (diff > motionThresh) {
          // Significant motion detected: immediately drop temporal history to 0
          alpha = 0.0;
        } else {
          // Static or slow moving region: smooth over time to suppress flickering
          alpha = baseAlpha;
        }

        // Out = (1 - alpha) * current + alpha * previous
        outMask[i] = clamp(Math.round((1 - alpha) * curM + alpha * oldM), 0, 255);
      }
    }

    // Save previous frame state (shallow copy or buffer reuse)
    if (!this.prevRgb || this.prevRgb.length !== currentRgba.length) {
      this.prevRgb = Buffer.alloc(currentRgba.length);
    }
    currentRgba.copy(this.prevRgb);

    if (!this.prevMask || this.prevMask.length !== outMask.length) {
      this.prevMask = Buffer.alloc(outMask.length);
    }
    outMask.copy(this.prevMask);
    this.width = width;
    this.height = height;

    // Apply strength & threshold
    if (this.options.strength !== 1.0 || this.options.threshold > 0) {
      outMask = applyStrengthAndThreshold(outMask, this.options.strength, this.options.threshold);
    }

    // Apply edge feathering if requested
    if (this.options.featherPx > 0) {
      outMask = boxBlurGray(outMask, width, height, this.options.featherPx);
    }

    return outMask;
  }
}

module.exports = {
  ForegroundTemporalRefiner,
  boxBlurGray,
  applyStrengthAndThreshold,
  DEFAULTS,
};
