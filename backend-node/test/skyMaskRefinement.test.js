'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  DEFAULTS,
  resolveOptions,
  refineSkyMask,
  alignTemporalMask,
  createRefinementSession,
  workingSize,
} = require('../src/services/skyMaskRefinement');

function fillRect(buf, width, x0, y0, x1, y1, value) {
  for (let y = y0; y < y1; y++) buf.fill(value, y * width + x0, y * width + x1);
}

function makeRgb(width, height, paint) {
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = paint(x, y);
      const p = (y * width + x) * 4;
      rgba[p] = c[0];
      rgba[p + 1] = c[1];
      rgba[p + 2] = c[2];
    }
  }
  return rgba;
}

function count(mask, pred) {
  let n = 0;
  for (const v of mask) if (pred(v)) n++;
  return n;
}

test('defaults have no personal paths and no named hue constants', () => {
  const text = JSON.stringify(DEFAULTS);
  assert.equal(text.includes('C:/'), false);
  assert.equal(text.includes('house'), false);
  assert.equal(text.includes('blue'), false);
  assert.equal(text.includes('\\Users\\'), false);
  assert.ok(DEFAULTS.maxShiftPx <= 16);
  assert.ok(DEFAULTS.edgeFeatherPx <= 2);
});

test('options reject out-of-range values without mutating defaults', () => {
  assert.throws(() => resolveOptions({ maxShiftPx: 99 }), { code: 'INVALID_PARAMETERS' });
  assert.throws(() => resolveOptions({ confidenceLow: 0.8, confidenceHigh: 0.2 }), { code: 'INVALID_PARAMETERS' });
  const a = resolveOptions({ maxShiftPx: 4 });
  const b = resolveOptions({});
  assert.equal(a.maxShiftPx, 4);
  assert.equal(b.maxShiftPx, DEFAULTS.maxShiftPx);
});

test('landscape, portrait and non-square rims recover sky without eating interior foreground', () => {
  const cases = [
    { width: 96, height: 48, horizon: 18 },
    { width: 48, height: 96, horizon: 40 },
    { width: 80, height: 50, horizon: 20 },
  ];
  for (const { width, height, horizon } of cases) {
    const rgba = makeRgb(width, height, (x, y) => {
      if (y < horizon) return [90, 150, 230];
      return [70, 55, 40];
    });
    const coarse = Buffer.alloc(width * height, 0);
    // Inset sky mask by 3 rows: leftover original-sky labeled as foreground.
    fillRect(coarse, width, 0, 0, width, Math.max(1, horizon - 3), 255);
    const { mask } = refineSkyMask(rgba, coarse, width, height, { maxShiftPx: 6, edgeBandPx: 8, coreErodePx: 1, windowRadius: 12 });
    const recovered = count(mask, v => v >= 128) - count(coarse, v => v >= 128);
    assert.ok(recovered > width, `${width}x${height} recovered ${recovered}`);
    const interior = (horizon + Math.floor((height - horizon) / 2)) * width + Math.floor(width / 2);
    assert.ok(mask[interior] < 40, `${width}x${height} interior became sky ${mask[interior]}`);
    const skyCore = 4 * width + Math.floor(width / 2);
    assert.ok(mask[skyCore] > 200, `${width}x${height} sky core dropped ${mask[skyCore]}`);
  }
});

test('orange sky plus green ground is recovered without a blue-sky assumption', () => {
  const width = 64, height = 40, horizon = 16;
  const rgba = makeRgb(width, height, (x, y) => (y < horizon ? [220, 90, 30] : [20, 90, 35]));
  const coarse = Buffer.alloc(width * height, 0);
  fillRect(coarse, width, 0, 0, width, horizon - 3, 255);
  const { mask, globalSky } = refineSkyMask(rgba, coarse, width, height, {
    maxShiftPx: 6, edgeBandPx: 8, coreErodePx: 1, windowRadius: 10,
  });
  assert.ok(globalSky.r > globalSky.b, `sky mean was not orange-like ${JSON.stringify(globalSky)}`);
  const leftover = [];
  for (let x = 0; x < width; x++) leftover.push(mask[(horizon - 2) * width + x]);
  const recovered = leftover.filter(v => v >= 128).length;
  assert.ok(recovered > width * 0.6, `orange rim recovered ${recovered}/${width}`);
  assert.ok(mask[(horizon + 8) * width + 20] < 40);
});

test('oversized sky mask recedes from a compact chimney instead of swallowing it', () => {
  const width = 60, height = 40;
  const rgba = makeRgb(width, height, (x, y) => {
    const chimney = x >= 26 && x < 34 && y >= 12 && y < 22;
    if (chimney) return [150, 70, 50];
    if (y < 22) return [100, 160, 230];
    return [50, 90, 40];
  });
  const mask = Buffer.alloc(width * height, 0);
  fillRect(mask, width, 0, 0, width, 22, 255);
  const refined = refineSkyMask(rgba, mask, width, height, {
    maxShiftPx: 8, edgeBandPx: 10, coreErodePx: 1, windowRadius: 8, minLocalCount: 4, edgeFeatherPx: 0,
  }).mask;
  const cx = 30, cy = 18;
  assert.ok(refined[cy * width + cx] < 80, `chimney interior still sky ${refined[cy * width + cx]}`);
  assert.ok(refined[2 * width + 8] > 200, 'far sky should remain sky');
});

test('large images work at a bounded resolution then re-guide at full size', () => {
  const width = 200, height = 160;
  const rgba = makeRgb(width, height, (x, y) => (y < 50 ? [80, 140, 220] : [40, 80, 30]));
  const coarse = Buffer.alloc(width * height, 0);
  fillRect(coarse, width, 0, 0, width, 47, 255);
  const { mask, working } = refineSkyMask(rgba, coarse, width, height, {
    maxWorkingPixels: 8_000,
    maxShiftPx: 6,
    edgeBandPx: 8,
    coreErodePx: 1,
  });
  assert.ok(working.width * working.height <= 8_000 + 80);
  assert.ok(working.width < width);
  assert.equal(mask.length, width * height);
  assert.ok(count(mask, v => v >= 128) > count(coarse, v => v >= 128));
  const size = workingSize(4000, 3000, 1_200_000);
  assert.ok(size.width * size.height <= 1_200_000 + 2000);
});

test('temporal mix is gated when the current RGB edge moves', () => {
  const width = 48, height = 24;
  const sky = [80, 140, 220];
  const fg = [60, 50, 40];
  function frame(cut) {
    return makeRgb(width, height, (x, y) => (x < cut ? sky : fg));
  }
  function maskAt(cut) {
    const m = Buffer.alloc(width * height, 0);
    for (let y = 0; y < height; y++) fillRect(m, width, 0, y, cut, y + 1, 255);
    return m;
  }
  const prevRgba = frame(28);
  const prevMask = maskAt(28);
  const curRgba = frame(20);
  const curMask = maskAt(20);
  const aligned = alignTemporalMask({
    previousMask: prevMask,
    previousRgba: prevRgba,
    mask: curMask,
    rgba: curRgba,
    width,
    height,
    options: { temporalMaxMix: 0.45, temporalMotionRgb: 20, temporalMaskJump: 80, edgeBandPx: 10, maxShiftPx: 8 },
  });
  // Pixels that became foreground (20..27) must stay near 0, not a 0.45 EMA trail of old sky.
  let trail = 0;
  for (let y = 4; y < 20; y++) {
    for (let x = 21; x < 27; x++) trail = Math.max(trail, aligned.mask[y * width + x]);
  }
  assert.ok(trail < 40, `motion trail ${trail}`);
  assert.ok(aligned.gated > 0);
});

test('session keeps still edges mixed but does not persist a previous sky over new foreground', () => {
  const width = 40, height = 20;
  const session = createRefinementSession({
    maxShiftPx: 5,
    edgeBandPx: 8,
    coreErodePx: 1,
    windowRadius: 8,
    temporalMaxMix: 0.4,
    temporalMotionRgb: 18,
    edgeFeatherPx: 0,
  });
  const still = makeRgb(width, height, (x, y) => (y < 8 ? [90, 150, 230] : [50, 80, 30]));
  const stillMask = Buffer.alloc(width * height, 0);
  fillRect(stillMask, width, 0, 0, width, 8, 255);
  const a = session.next(still, stillMask, width, height);
  assert.equal(a.mask.length, width * height);

  const moved = makeRgb(width, height, (x, y) => (y < 12 ? [90, 150, 230] : [50, 80, 30]));
  const movedMask = Buffer.alloc(width * height, 0);
  fillRect(movedMask, width, 0, 0, width, 12, 255);
  const b = session.next(moved, movedMask, width, height);
  // Row 9-11 used to be foreground, now sky in the current frame. Old EMA
  // would keep a dark previous value; current-frame alignment should accept sky.
  const row10 = b.mask[10 * width + 8];
  assert.ok(row10 > 160, `current-frame sky suppressed by old mask ${row10}`);
});

test('interior foreground far from the sky edge is not reclassified even if it is bright', () => {
  const width = 80, height = 50, horizon = 12;
  const rgba = makeRgb(width, height, (x, y) => {
    if (y < horizon) return [90, 150, 230];
    if (x >= 30 && x < 50 && y >= 28 && y < 40) return [180, 200, 230];
    return [70, 55, 40];
  });
  const coarse = Buffer.alloc(width * height, 0);
  fillRect(coarse, width, 0, 0, width, horizon, 255);
  const { mask } = refineSkyMask(rgba, coarse, width, height, {
    maxShiftPx: 6, edgeBandPx: 8, coreErodePx: 1, windowRadius: 12, guideRadius: 2,
  });
  assert.equal(mask[34 * width + 40], 0, `interior pane became sky ${mask[34 * width + 40]}`);
  assert.ok(mask[2 * width + 10] > 200);
});

test('size mismatch fails closed', () => {
  const rgba = Buffer.alloc(12, 10);
  assert.throws(() => refineSkyMask(rgba, Buffer.alloc(2), 2, 2), { code: 'SKY_MASK_INVALID' });
});