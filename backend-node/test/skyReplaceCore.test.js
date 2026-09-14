const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parametersFor, findSkyClassIds, maskStats, assertMaskUsable, classifyMask, blur2d, temporalSmooth,
  maskFromLogits, luminanceMask, compositeSky, modelCandidates,
} = require('../src/services/skyReplaceCore');
const { ADE20K_ID2LABEL, VOC_ID2LABEL } = require('../src/services/ade20kLabels');

test('ADE20K labels expose sky and VOC labels fail closed', () => {
  assert.deepEqual(findSkyClassIds(ADE20K_ID2LABEL), [2]);
  assert.throws(() => findSkyClassIds(VOC_ID2LABEL), { code: 'SKY_LABEL_MISSING' });
  assert.throws(() => findSkyClassIds({ 0: 'background', 1: 'person' }), { code: 'SKY_LABEL_MISSING' });
});

test('schema rejects missing sky_source and invalid route', () => {
  assert.throws(() => parametersFor({}), { code: 'INVALID_PARAMETERS' });
  assert.throws(() => parametersFor({ sky_source: 0, route: 'magic' }), { code: 'INVALID_PARAMETERS' });
  assert.throws(() => parametersFor({ sky_source: 0, route: 'user_mask' }), { code: 'INVALID_PARAMETERS' });
  const ok = parametersFor({ sky_source: 1, feather_px: 4 });
  assert.equal(ok.route, 'auto');
  assert.equal(ok.sky_source, 1);
});

test('black masks are unchanged and full-frame sky remains a valid mask', () => {
  const empty = Buffer.alloc(100, 0);
  const emptyVerdict = classifyMask(maskStats(empty), parametersFor({ sky_source: 0 }));
  assert.equal(emptyVerdict.unchanged, true);
  assert.equal(emptyVerdict.code, 'SKY_UNCHANGED');
  assert.throws(() => assertMaskUsable(maskStats(empty), parametersFor({ sky_source: 0 })), { code: 'SKY_UNCHANGED' });
  const full = Buffer.alloc(100, 255);
  const fullVerdict = classifyMask(maskStats(full), parametersFor({ sky_source: 0 }));
  assert.equal(fullVerdict.unchanged, false);
  assert.equal(fullVerdict.usable, true);
  assert.equal(assertMaskUsable(maskStats(full), parametersFor({sky_source:0})).mean,1);
  assert.throws(()=>maskStats(Buffer.alloc(0)),{code:'SKY_MASK_EMPTY'});
  const mixed = Buffer.from([0, 0, 255, 255, 128, 0, 0, 200, 10, 40]);
  const stats = assertMaskUsable(maskStats(mixed), parametersFor({ sky_source: 0 }));
  assert.ok(stats.mean > 0.01 && stats.mean < 0.985);
});

test('model candidates follow explicit paths and include no implicit personal directory', () => {
  const path = require('node:path');
  const previous=process.env.YINZI_SKY_MODEL_DIR;
  try {
    delete process.env.YINZI_SKY_MODEL_DIR;
    assert.deepEqual(modelCandidates('component'),[path.join('component','models')]);
    process.env.YINZI_SKY_MODEL_DIR='configured/models';
    const p=parametersFor({sky_source:1,model_dir:'user/models'});
    assert.deepEqual(modelCandidates('component',p),['user/models','configured/models',path.join('component','models')]);
  }finally{if(previous===undefined)delete process.env.YINZI_SKY_MODEL_DIR;else process.env.YINZI_SKY_MODEL_DIR=previous;}
});

test('NCHW logits pick the sky class without treating argmax of VOC-sized tensors as success', () => {
  const h = 2, w = 2, c = 3, spatial = h * w;
  const logits = new Float32Array(c * spatial);
  // class 2 is sky; pixel 0/1 sky, 2/3 ground
  logits[2 * spatial + 0] = 4; logits[0] = 1;
  logits[2 * spatial + 1] = 5; logits[1] = 0;
  logits[0 * spatial + 2] = 6; logits[2 * spatial + 2] = 0;
  logits[1 * spatial + 3] = 7; logits[2 * spatial + 3] = 0;
  const { mask } = maskFromLogits(logits, [1, c, h, w], [2]);
  assert.deepEqual([...mask], [255, 255, 0, 0]);
});

test('temporal smoothing mixes previous mask and composite tints sky region', () => {
  const prev = Buffer.from([0, 0, 0, 0]);
  const cur = Buffer.from([255, 255, 255, 255]);
  const mixed = temporalSmooth(prev, cur, 0.5);
  assert.deepEqual([...mixed], [128, 128, 128, 128]);
  const width = 2, height = 1;
  const base = Buffer.from([10, 20, 30, 255, 10, 20, 30, 255]);
  const sky = Buffer.from([200, 10, 10, 255, 200, 10, 10, 255]);
  const mask = Buffer.from([255, 0]);
  const out = compositeSky({ baseRgba: base, skyRgba: sky, mask, width, height, ambientStrength: 0 });
  assert.equal(out[0], 200);
  assert.equal(out[4], 10);
});

test('luminance mask uses brightness not alpha-only holes', () => {
  const rgba = Buffer.from([0, 0, 0, 255, 255, 255, 255, 255]);
  assert.deepEqual([...luminanceMask(rgba, 2, 1)], [0, 255]);
});

test('feather blur does not empty a compact sky patch', () => {
  const width = 8, height = 8;
  const mask = Buffer.alloc(width * height, 0);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 8; x++) mask[y * width + x] = 255;
  const blurred = blur2d(mask, width, height, 1);
  assert.ok(blurred[1 * width + 3] > 200);
  assert.ok(blurred[4 * width + 3] < 80);
});