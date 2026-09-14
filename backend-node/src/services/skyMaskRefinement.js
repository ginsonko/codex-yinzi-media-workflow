'use strict';

/**
 * Isolated sky-mask edge refinement. Scene-agnostic: sky/foreground colors
 * are measured from the current frame, never from a named hue or file path.
 */

const DEFAULTS = Object.freeze({
  maxShiftPx: 8,
  edgeBandPx: 12,
  coreErodePx: 3,
  windowRadius: 28,
  minLocalCount: 10,
  colorSigma: 26,
  minMeanSeparation: 16,
  skyThreshold: 128,
  confidenceLow: 0.42,
  confidenceHigh: 0.58,
  edgeFeatherPx: 1,
  maxWorkingPixels: 1_200_000,
  maxStatsPixels: 480_000,
  temporalMaxMix: 0.25,
  temporalMotionRgb: 28,
  temporalMaskJump: 80,
  protectCore: true,
  hardenInput: true,
  guideRadius: 2,
});

const OPTION_BOUNDS = Object.freeze({
  maxShiftPx: [0, 32],
  edgeBandPx: [0, 64],
  coreErodePx: [0, 16],
  windowRadius: [2, 96],
  minLocalCount: [1, 256],
  colorSigma: [4, 80],
  minMeanSeparation: [0, 80],
  skyThreshold: [1, 254],
  confidenceLow: [0, 0.5],
  confidenceHigh: [0.5, 1],
  edgeFeatherPx: [0, 8],
  maxWorkingPixels: [4_096, 8_000_000],
  maxStatsPixels: [4_096, 2_000_000],
  temporalMaxMix: [0, 1],
  temporalMotionRgb: [1, 180],
  temporalMaskJump: [1, 255],
  guideRadius: [0, 8],
});

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function resolveOptions(input = {}) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    throw fail('INVALID_PARAMETERS', 'options 必须是对象');
  }
  const out = { ...DEFAULTS };
  for (const [key, bounds] of Object.entries(OPTION_BOUNDS)) {
    if (input[key] == null) continue;
    const n = Number(input[key]);
    if (!Number.isFinite(n) || n < bounds[0] || n > bounds[1]) {
      throw fail('INVALID_PARAMETERS', `参数 ${key} 应在 ${bounds[0]} 到 ${bounds[1]} 之间`);
    }
    out[key] = n;
  }
  if (input.protectCore != null) out.protectCore = Boolean(input.protectCore);
  if (input.hardenInput != null) out.hardenInput = Boolean(input.hardenInput);
  if (!(out.confidenceLow < out.confidenceHigh)) {
    throw fail('INVALID_PARAMETERS', 'confidenceLow 必须小于 confidenceHigh');
  }
  return out;
}

function pixelCount(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw fail('SKY_MASK_INVALID', '宽高必须是正整数');
  }
  return width * height;
}

function splitRgb(rgba, width, height) {
  const n = pixelCount(width, height);
  const channels = rgba.length === n * 4 ? 4 : rgba.length === n * 3 ? 3 : 0;
  if (!channels) {
    throw fail('SKY_MASK_INVALID', `RGB 缓冲长度 ${rgba.length} 与 ${width}x${height} 不匹配`);
  }
  const r = new Uint8Array(n);
  const g = new Uint8Array(n);
  const b = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += channels) {
    r[i] = rgba[p];
    g[i] = rgba[p + 1];
    b[i] = rgba[p + 2];
  }
  return { r, g, b, channels };
}

function asMask(mask, width, height) {
  const n = pixelCount(width, height);
  if (!mask || mask.length !== n) {
    throw fail('SKY_MASK_INVALID', `蒙版长度 ${mask && mask.length} 与 ${width}x${height} 不匹配`);
  }
  return mask;
}

function rgbDist2(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return dr * dr + dg * dg + db * db;
}

function colorDist2(r1, g1, b1, r2, g2, b2) {
  const s1 = r1 + g1 + b1 + 1e-6;
  const s2 = r2 + g2 + b2 + 1e-6;
  const dr = r1 / s1 - r2 / s2;
  const dg = g1 / s1 - g2 / s2;
  const db = b1 / s1 - b2 / s2;
  const l1 = 0.2126 * r1 + 0.7152 * g1 + 0.0722 * b1;
  const l2 = 0.2126 * r2 + 0.7152 * g2 + 0.0722 * b2;
  return (dr * dr + dg * dg + db * db) * 65025 + 0.15 * (l1 - l2) * (l1 - l2);
}

function chamferDistance(isSeed, width, height) {
  const n = width * height;
  const dist = new Float32Array(n);
  const INF = 1e8;
  for (let i = 0; i < n; i++) dist[i] = isSeed[i] ? 0 : INF;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let d = dist[i];
      if (x > 0) d = Math.min(d, dist[i - 1] + 3);
      if (y > 0) {
        d = Math.min(d, dist[i - width] + 3);
        if (x > 0) d = Math.min(d, dist[i - width - 1] + 4);
        if (x + 1 < width) d = Math.min(d, dist[i - width + 1] + 4);
      }
      dist[i] = d;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      let d = dist[i];
      if (x + 1 < width) d = Math.min(d, dist[i + 1] + 3);
      if (y + 1 < height) {
        d = Math.min(d, dist[i + width] + 3);
        if (x + 1 < width) d = Math.min(d, dist[i + width + 1] + 4);
        if (x > 0) d = Math.min(d, dist[i + width - 1] + 4);
      }
      dist[i] = d;
    }
  }
  for (let i = 0; i < n; i++) dist[i] = dist[i] / 3;
  return dist;
}

function distToBoundary(isSkyPixel, distSky, distFg, i) {
  return isSkyPixel ? distFg[i] : distSky[i];
}

function boxBlurGray(src, width, height, radius) {
  if (!radius) return Buffer.from(src);
  const window = radius * 2 + 1;
  const horiz = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let acc = 0;
    for (let x = -radius; x <= radius; x++) acc += src[row + Math.min(width - 1, Math.max(0, x))];
    for (let x = 0; x < width; x++) {
      horiz[row + x] = acc / window;
      acc += src[row + Math.min(width - 1, x + radius + 1)] - src[row + Math.max(0, x - radius)];
    }
  }
  const out = Buffer.alloc(src.length);
  for (let x = 0; x < width; x++) {
    let acc = 0;
    for (let y = -radius; y <= radius; y++) acc += horiz[Math.min(height - 1, Math.max(0, y)) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = Math.max(0, Math.min(255, Math.round(acc / window)));
      acc += horiz[Math.min(height - 1, y + radius + 1) * width + x] - horiz[Math.max(0, y - radius) * width + x];
    }
  }
  return out;
}

function featherEdgeOnly(mask, width, height, radius) {
  if (!radius) return Buffer.from(mask);
  const n = width * height;
  const isSky = new Uint8Array(n);
  const isFg = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const sky = mask[i] >= 128;
    isSky[i] = sky ? 1 : 0;
    isFg[i] = sky ? 0 : 1;
  }
  const distSky = chamferDistance(isSky, width, height);
  const distFg = chamferDistance(isFg, width, height);
  const blurred = boxBlurGray(mask, width, height, Math.round(radius));
  const out = Buffer.from(mask);
  const lim = radius + 0.51;
  for (let i = 0; i < n; i++) {
    if (distToBoundary(isSky[i], distSky, distFg, i) <= lim) out[i] = blurred[i];
  }
  return out;
}

function integralFrom(src, width, height) {
  const W = width + 1;
  const ii = new Float64Array((width + 1) * (height + 1));
  for (let y = 1; y <= height; y++) {
    let run = 0;
    const row = (y - 1) * width;
    const dst = y * W;
    const prev = (y - 1) * W;
    for (let x = 1; x <= width; x++) {
      run += src[row + (x - 1)];
      ii[dst + x] = ii[prev + x] + run;
    }
  }
  return { ii, W };
}

function rectSum(pack, x0, y0, x1, y1) {
  const { ii, W } = pack;
  return ii[y1 * W + x1] - ii[y0 * W + x1] - ii[y1 * W + x0] + ii[y0 * W + x0];
}

function clampRect(x, y, radius, width, height) {
  return {
    x0: Math.max(0, x - radius),
    y0: Math.max(0, y - radius),
    x1: Math.min(width, x + radius + 1),
    y1: Math.min(height, y + radius + 1),
  };
}

function weightedMean(r, g, b, weight, n) {
  let wr = 0, wg = 0, wb = 0, w = 0;
  for (let i = 0; i < n; i++) {
    const m = weight[i];
    if (!m) continue;
    wr += r[i] * m;
    wg += g[i] * m;
    wb += b[i] * m;
    w += m;
  }
  if (w <= 0) return { r: 0, g: 0, b: 0, count: 0 };
  return { r: wr / w, g: wg / w, b: wb / w, count: w };
}

function hardenMask(mask, threshold) {
  const out = Buffer.alloc(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] >= threshold ? 255 : 0;
  return out;
}

function jointBilateralMask(mask, r, g, b, width, height, radius, sigmaColor, active) {
  if (!radius) return Buffer.from(mask);
  const out = Buffer.from(mask);
  const s2 = 2 * sigmaColor * sigmaColor;
  const spat2 = 2 * (radius * 0.65) * (radius * 0.65);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (active && !active[i]) continue;
      let num = 0;
      let den = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        const row = yy * width;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const j = row + xx;
          const dc = colorDist2(r[i], g[i], b[i], r[j], g[j], b[j]);
          const w = Math.exp(-dc / s2 - (dx * dx + dy * dy) / spat2);
          num += w * mask[j];
          den += w;
        }
      }
      out[i] = den > 0 ? Math.max(0, Math.min(255, Math.round(num / den))) : mask[i];
    }
  }
  return out;
}

function closerClassWeights(r, g, b, weight, own, other, n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!weight[i]) continue;
    const dOwn = colorDist2(r[i], g[i], b[i], own.r, own.g, own.b);
    const dOther = colorDist2(r[i], g[i], b[i], other.r, other.g, other.b);
    if (dOwn <= dOther * 1.15) out[i] = 1;
  }
  return out;
}

function workingSize(width, height, maxPixels) {
  const n = width * height;
  if (n <= maxPixels) return { width, height, scale: 1 };
  const scale = Math.sqrt(maxPixels / n);
  return {
    width: Math.max(8, Math.round(width * scale)),
    height: Math.max(8, Math.round(height * scale)),
    scale,
  };
}

function downscalePlanes(r, g, b, mask, srcW, srcH, dstW, dstH) {
  const nr = new Uint8Array(dstW * dstH);
  const ng = new Uint8Array(dstW * dstH);
  const nb = new Uint8Array(dstW * dstH);
  const nm = new Uint8Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    const y0 = Math.floor(y * srcH / dstH);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * srcH / dstH));
    for (let x = 0; x < dstW; x++) {
      const x0 = Math.floor(x * srcW / dstW);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * srcW / dstW));
      let sr = 0, sg = 0, sb = 0, sm = 0, c = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * srcW;
        for (let xx = x0; xx < x1; xx++) {
          const i = row + xx;
          sr += r[i]; sg += g[i]; sb += b[i]; sm += mask[i]; c++;
        }
      }
      const j = y * dstW + x;
      nr[j] = Math.round(sr / c);
      ng[j] = Math.round(sg / c);
      nb[j] = Math.round(sb / c);
      nm[j] = Math.round(sm / c);
    }
  }
  return { r: nr, g: ng, b: nb, mask: nm };
}

function sampleBilinear(src, srcW, srcH, x, y) {
  const xx = Math.min(srcW - 1, Math.max(0, x));
  const yy = Math.min(srcH - 1, Math.max(0, y));
  const x0 = Math.floor(xx);
  const y0 = Math.floor(yy);
  const x1 = Math.min(srcW - 1, x0 + 1);
  const y1 = Math.min(srcH - 1, y0 + 1);
  const tx = xx - x0;
  const ty = yy - y0;
  const a = src[y0 * srcW + x0];
  const b = src[y0 * srcW + x1];
  const c = src[y1 * srcW + x0];
  const d = src[y1 * srcW + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

function skyProbability(pr, pg, pb, sky, fg, sigma, minSep) {
  const sep2 = colorDist2(sky.r, sky.g, sky.b, fg.r, fg.g, fg.b);
  if (sky.count <= 0 || fg.count <= 0 || sep2 < minSep * minSep) return null;
  const dSky = colorDist2(pr, pg, pb, sky.r, sky.g, sky.b);
  const dFg = colorDist2(pr, pg, pb, fg.r, fg.g, fg.b);
  const s2 = 2 * sigma * sigma;
  const wSky = Math.exp(-dSky / s2);
  const wFg = Math.exp(-dFg / s2);
  const sum = wSky + wFg;
  if (sum <= 1e-12) return null;
  return wSky / sum;
}

function refineAtResolution(r, g, b, mask, width, height, options) {
  const n = width * height;
  const threshold = options.skyThreshold;
  const workMask = options.hardenInput ? hardenMask(mask, threshold) : Buffer.from(mask);
  const isSky = new Uint8Array(n);
  const isFg = new Uint8Array(n);
  let skyN = 0;
  for (let i = 0; i < n; i++) {
    const sky = workMask[i] >= threshold;
    isSky[i] = sky ? 1 : 0;
    isFg[i] = sky ? 0 : 1;
    if (sky) skyN++;
  }
  if (skyN === 0 || skyN === n) {
    return { mask: Buffer.from(workMask), changed: 0, skipped: true, width, height };
  }

  const distSky = chamferDistance(isSky, width, height);
  const distFg = chamferDistance(isFg, width, height);
  const coreSkyW = new Float32Array(n);
  const coreFgW = new Float32Array(n);
  const coreErode = options.coreErodePx;
  for (let i = 0; i < n; i++) {
    if (isSky[i] && distFg[i] > coreErode) coreSkyW[i] = 1;
    else if (isFg[i] && distSky[i] > coreErode) coreFgW[i] = 1;
  }

  let globalSky = weightedMean(r, g, b, coreSkyW, n);
  let globalFg = weightedMean(r, g, b, coreFgW, n);
  if (globalSky.count <= 0 || globalFg.count <= 0) {
    return { mask: Buffer.from(workMask), changed: 0, skipped: true, reason: 'empty_core', width, height };
  }
  const robustSkyW = closerClassWeights(r, g, b, coreSkyW, globalSky, globalFg, n);
  const robustFgW = closerClassWeights(r, g, b, coreFgW, globalFg, globalSky, n);
  const robustSky = weightedMean(r, g, b, robustSkyW, n);
  const robustFg = weightedMean(r, g, b, robustFgW, n);
  if (robustSky.count > 0) globalSky = robustSky;
  if (robustFg.count > 0) globalFg = robustFg;
  const skyW = robustSky.count > 0 ? robustSkyW : coreSkyW;
  const fgW = robustFg.count > 0 ? robustFgW : coreFgW;

  const skyCountI = integralFrom(skyW, width, height);
  const fgCountI = integralFrom(fgW, width, height);
  const skyRI = integralFrom(mulPlane(r, skyW), width, height);
  const skyGI = integralFrom(mulPlane(g, skyW), width, height);
  const skyBI = integralFrom(mulPlane(b, skyW), width, height);
  const fgRI = integralFrom(mulPlane(r, fgW), width, height);
  const fgGI = integralFrom(mulPlane(g, fgW), width, height);
  const fgBI = integralFrom(mulPlane(b, fgW), width, height);

  const out = Buffer.from(workMask);
  const maxShift = options.maxShiftPx + 0.51;
  const band = Math.max(options.edgeBandPx, maxShift);
  const win = Math.round(options.windowRadius);
  const minLocal = options.minLocalCount;
  const sigma = options.colorSigma;
  const minSep = options.minMeanSeparation;
  const lo = options.confidenceLow;
  const hi = options.confidenceHigh;
  let changed = 0;
  let considered = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const dEdge = distToBoundary(isSky[i], distSky, distFg, i);
      if (dEdge > band) continue;
      considered++;

      const rect = clampRect(x, y, win, width, height);
      const skyC = rectSum(skyCountI, rect.x0, rect.y0, rect.x1, rect.y1);
      const fgC = rectSum(fgCountI, rect.x0, rect.y0, rect.x1, rect.y1);
      const localSky = skyC >= minLocal
        ? {
          r: rectSum(skyRI, rect.x0, rect.y0, rect.x1, rect.y1) / skyC,
          g: rectSum(skyGI, rect.x0, rect.y0, rect.x1, rect.y1) / skyC,
          b: rectSum(skyBI, rect.x0, rect.y0, rect.x1, rect.y1) / skyC,
          count: skyC,
        }
        : globalSky;
      const localFg = fgC >= minLocal
        ? {
          r: rectSum(fgRI, rect.x0, rect.y0, rect.x1, rect.y1) / fgC,
          g: rectSum(fgGI, rect.x0, rect.y0, rect.x1, rect.y1) / fgC,
          b: rectSum(fgBI, rect.x0, rect.y0, rect.x1, rect.y1) / fgC,
          count: fgC,
        }
        : globalFg;

      const p = skyProbability(r[i], g[i], b[i], localSky, localFg, sigma, minSep);
      if (p == null) continue;

      let next = out[i];
      if (p >= hi && distSky[i] <= maxShift) next = 255;
      else if (p <= lo && distFg[i] <= maxShift) next = 0;
      else if (p > lo && p < hi && dEdge <= maxShift) {
        next = Math.max(0, Math.min(255, Math.round(p * 255)));
      }
      if (options.protectCore && dEdge > maxShift) next = workMask[i];
      if (next !== out[i]) {
        out[i] = next;
        changed++;
      }
    }
  }

  const guideR = Math.round(options.guideRadius);
  let guided = out;
  if (guideR > 0) {
    const active = new Uint8Array(n);
    const lim = Math.max(options.edgeBandPx, options.maxShiftPx) + guideR;
    for (let i = 0; i < n; i++) {
      if (distToBoundary(isSky[i], distSky, distFg, i) <= lim) active[i] = 1;
    }
    guided = jointBilateralMask(out, r, g, b, width, height, guideR, options.colorSigma, active);
  }

  return {
    mask: guided,
    changed,
    considered,
    skipped: false,
    width,
    height,
    globalSky,
    globalFg,
    distSky,
    distFg,
  };
}

function mulPlane(channel, weight) {
  const out = new Float32Array(channel.length);
  for (let i = 0; i < channel.length; i++) out[i] = channel[i] * weight[i];
  return out;
}

function guideFullRes(full, work, options) {
  const { r, g, b, mask, width, height } = full;
  const n = width * height;
  const workMask = options.hardenInput ? hardenMask(mask, options.skyThreshold) : Buffer.from(mask);
  const out = Buffer.from(workMask);
  const maxShift = options.maxShiftPx;
  const band = Math.max(options.edgeBandPx, maxShift);
  const sigma = options.colorSigma;
  const minSep = options.minMeanSeparation;
  const lo = options.confidenceLow;
  const hi = options.confidenceHigh;
  const sky = work.globalSky;
  const fg = work.globalFg;
  if (!sky || !fg) return { mask: out, changed: 0 };

  const isSky = new Uint8Array(n);
  const isFg = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const s = mask[i] >= options.skyThreshold;
    isSky[i] = s ? 1 : 0;
    isFg[i] = s ? 0 : 1;
  }
  const distSky = chamferDistance(isSky, width, height);
  const distFg = chamferDistance(isFg, width, height);
  let changed = 0;
  const srcW = work.width;
  const srcH = work.height;

  for (let y = 0; y < height; y++) {
    const sy = (y + 0.5) * srcH / height - 0.5;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const dEdge = distToBoundary(isSky[i], distSky, distFg, i);
      if (dEdge > band) continue;
      const sx = (x + 0.5) * srcW / width - 0.5;
      const up = sampleBilinear(work.mask, srcW, srcH, sx, sy);
      const pColor = skyProbability(r[i], g[i], b[i], sky, fg, sigma, minSep);
      const shift = maxShift + 0.51;
      let next = out[i];
      if (pColor == null) {
        if (dEdge <= shift) next = Math.max(0, Math.min(255, Math.round(up)));
      } else if (pColor >= hi && distSky[i] <= shift) next = 255;
      else if (pColor <= lo && distFg[i] <= shift) next = 0;
      else if (dEdge <= shift) {
        next = Math.max(0, Math.min(255, Math.round(0.5 * up + 0.5 * pColor * 255)));
      }
      if (next !== out[i]) {
        out[i] = next;
        changed++;
      }
    }
  }
  const guideR = Math.round(options.guideRadius);
  if (guideR > 0) {
    const active = new Uint8Array(n);
    const lim = Math.max(options.edgeBandPx, options.maxShiftPx) + guideR;
    for (let i = 0; i < n; i++) {
      if (distToBoundary(isSky[i], distSky, distFg, i) <= lim) active[i] = 1;
    }
    return { mask: jointBilateralMask(out, r, g, b, width, height, guideR, options.colorSigma, active), changed, distSky, distFg };
  }
  return { mask: out, changed, distSky, distFg };
}

function refineSkyMask(rgba, mask, width, height, optionsInput) {
  const options = resolveOptions(optionsInput);
  const rgb = splitRgb(rgba, width, height);
  const srcMask = asMask(mask, width, height);
  const work = workingSize(width, height, Math.round(options.maxWorkingPixels));

  let refined;
  if (work.width === width && work.height === height) {
    refined = refineAtResolution(rgb.r, rgb.g, rgb.b, srcMask, width, height, options);
  } else {
    const low = downscalePlanes(rgb.r, rgb.g, rgb.b, srcMask, width, height, work.width, work.height);
    const lowOptions = {
      ...options,
      maxShiftPx: Math.max(1, Math.round(options.maxShiftPx * work.width / width)),
      edgeBandPx: Math.max(1, Math.round(options.edgeBandPx * work.width / width)),
      coreErodePx: Math.max(1, Math.round(options.coreErodePx * work.width / width)),
      windowRadius: Math.max(4, Math.round(options.windowRadius * work.width / width)),
    };
    const lowRefined = refineAtResolution(low.r, low.g, low.b, low.mask, work.width, work.height, lowOptions);
    const guided = guideFullRes(
      { r: rgb.r, g: rgb.g, b: rgb.b, mask: srcMask, width, height },
      { ...lowRefined, width: work.width, height: work.height },
      options,
    );
    refined = {
      ...lowRefined,
      mask: guided.mask,
      changed: guided.changed,
      skipped: false,
      width,
      height,
      working: { width: work.width, height: work.height },
    };
  }

  const feathered = featherEdgeOnly(refined.mask, width, height, options.edgeFeatherPx);
  return {
    mask: feathered,
    changed: refined.changed || 0,
    skipped: Boolean(refined.skipped),
    working: refined.working || { width, height },
    globalSky: refined.globalSky || null,
    globalFg: refined.globalFg || null,
    options,
  };
}

function rgbDeltaAt(a, b, i, channelsA, channelsB) {
  const pa = i * channelsA;
  const pb = i * channelsB;
  return Math.sqrt(rgbDist2(a[pa], a[pa + 1], a[pa + 2], b[pb], b[pb + 1], b[pb + 2]));
}

function alignTemporalMask({
  previousMask,
  previousRgba,
  mask,
  rgba,
  width,
  height,
  options: optionsInput,
}) {
  const options = resolveOptions(optionsInput);
  const current = asMask(mask, width, height);
  if (!previousMask || options.temporalMaxMix <= 0) {
    return { mask: Buffer.from(current), mixUsed: 0, gated: 0 };
  }
  if (previousMask.length !== current.length) {
    throw fail('SKY_MASK_INVALID', '上一帧蒙版尺寸与当前帧不一致');
  }

  const n = width * height;
  const ch = rgba.length === n * 4 ? 4 : 3;
  const prevCh = previousRgba && (previousRgba.length === n * 4 ? 4 : previousRgba.length === n * 3 ? 3 : 0);
  const isSky = new Uint8Array(n);
  const isFg = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const s = current[i] >= options.skyThreshold;
    isSky[i] = s ? 1 : 0;
    isFg[i] = s ? 0 : 1;
  }
  const distSky = chamferDistance(isSky, width, height);
  const distFg = chamferDistance(isFg, width, height);
  const band = Math.max(options.edgeBandPx, options.maxShiftPx);
  const out = Buffer.from(current);
  let mixUsed = 0;
  let gated = 0;

  for (let i = 0; i < n; i++) {
    const dEdge = distToBoundary(isSky[i], distSky, distFg, i);
    if (dEdge > band) continue;
    const jump = Math.abs(previousMask[i] - current[i]);
    let mix = options.temporalMaxMix;
    if (jump >= options.temporalMaskJump) {
      mix = 0;
      gated++;
    } else if (prevCh) {
      const motion = rgbDeltaAt(previousRgba, rgba, i, prevCh, ch);
      if (motion >= options.temporalMotionRgb) {
        mix = 0;
        gated++;
      } else {
        mix *= 1 - motion / options.temporalMotionRgb;
      }
    }
    if (mix <= 0) continue;
    out[i] = Math.round(previousMask[i] * mix + current[i] * (1 - mix));
    mixUsed++;
  }

  return { mask: out, mixUsed, gated, options };
}

function createRefinementSession(optionsInput) {
  const options = resolveOptions(optionsInput);
  let previousMask = null;
  let previousRgba = null;
  return {
    options,
    next(rgba, mask, width, height) {
      const refined = refineSkyMask(rgba, mask, width, height, options);
      const aligned = alignTemporalMask({
        previousMask,
        previousRgba,
        mask: refined.mask,
        rgba,
        width,
        height,
        options,
      });
      previousMask = Buffer.from(aligned.mask);
      previousRgba = Buffer.from(rgba);
      return {
        mask: aligned.mask,
        refined,
        temporal: aligned,
      };
    },
    reset() {
      previousMask = null;
      previousRgba = null;
    },
  };
}

module.exports = {
  DEFAULTS,
  OPTION_BOUNDS,
  resolveOptions,
  refineSkyMask,
  alignTemporalMask,
  createRefinementSession,
  chamferDistance,
  distToBoundary,
  featherEdgeOnly,
  boxBlurGray,
  workingSize,
  hardenMask,
  jointBilateralMask,
};