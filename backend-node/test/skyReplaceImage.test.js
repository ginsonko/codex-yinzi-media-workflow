const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { ADE20K_ID2LABEL } = require('../src/services/ade20kLabels');

function sharpFromRepo() {
  const repo = path.resolve(__dirname, '..');
  return createRequire(path.join(repo, 'package.json'))('sharp');
}

test('square inference masks preserve normalized landmarks in landscape and portrait images', async () => {
  const sharp = sharpFromRepo();
  const { upsampleGray } = require('../src/services/skyReplaceCore');
  const size = 64, mask = Buffer.alloc(size * size);
  for (let y = 0; y < size / 4; y++) mask.fill(255, y * size, (y + 1) * size);
  for (const [width, height] of [[192, 96], [96, 192], [128, 128]]) {
    const output = await upsampleGray(sharp, mask, size, size, width, height);
    const x = Math.floor(width / 2);
    let edge = 0;
    while (edge < height && output[edge * width + x] >= 128) edge++;
    assert.ok(Math.abs(edge - height / 4) <= 1, `${width}x${height}: landmark at ${edge}`);
  }
});

test('user-mask still-image replace feathers the horizon and does not overwrite sources', async t => {
  const sharp = sharpFromRepo();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-sky-img-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'scene.png');
  const sky = path.join(root, 'sky.png');
  const mask = path.join(root, 'mask.png');
  const width = 80, height = 48;
  const scene = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3;
    if (y < 18) { scene[i] = 90; scene[i + 1] = 140; scene[i + 2] = 220; }
    else { scene[i] = 40; scene[i + 1] = 90; scene[i + 2] = 40; }
  }
  await sharp(scene, { raw: { width, height, channels: 3 } }).png().toFile(input);
  await sharp({ create: { width, height, channels: 3, background: { r: 220, g: 80, b: 20 } } }).png().toFile(sky);
  const maskBuf = Buffer.alloc(width * height, 0);
  for (let y = 0; y < 18; y++) maskBuf.fill(255, y * width, (y + 1) * width);
  await sharp(maskBuf, { raw: { width, height, channels: 1 } }).png().toFile(mask);
  const before = [input, sky, mask].map(file => fs.readFileSync(file));
  const { processFile } = require('../src/services/skyReplaceImage');
  const output = path.join(root, 'result.png');
  const result = await processFile({
    inputPath: input, outputPath: output,
    parameters: { sky_source: 0, mask_source: 1, route: 'user_mask', feather_px: 2, ambient_strength: 0.1, horizon_blend_px: 4 },
    requireComponent: createRequire(path.join(path.resolve(__dirname, '..'), 'package.json')),
    sources: [{ path: sky, role: 'sky' }, { path: mask, role: 'mask' }, { path: input, role: 'primary' }],
  });
  assert.equal(result.route, 'user_mask');
  assert.match(result.quality_note, /用户蒙版/);
  assert.ok(result.mask_coverage.mean > 0.2 && result.mask_coverage.mean < 0.6);
  const top = await sharp(output).extract({ left: 10, top: 4, width: 1, height: 1 }).raw().toBuffer();
  const ground = await sharp(output).extract({ left: 10, top: 40, width: 1, height: 1 }).raw().toBuffer();
  assert.ok(top[0] > 160 && top[2] < 80, `sky pixel ${[...top]}`);
  assert.ok(ground[1] > 60 && ground[0] < 80, `ground pixel ${[...ground]}`);
  assert.ok(fs.readFileSync(input).equals(before[0]));
  assert.ok(fs.readFileSync(sky).equals(before[1]));
  assert.ok(fs.readFileSync(mask).equals(before[2]));
  assert.equal(ADE20K_ID2LABEL[2], 'sky');
});

test('black user mask returns unchanged original pixels instead of failing as segmentation error', async t => {
  const sharp = sharpFromRepo();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-sky-unchanged-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'scene.png');
  const sky = path.join(root, 'sky.png');
  const mask = path.join(root, 'black.png');
  const width = 32, height = 24;
  await sharp({ create: { width, height, channels: 3, background: { r: 12, g: 90, b: 18 } } }).png().toFile(input);
  await sharp({ create: { width, height, channels: 3, background: { r: 220, g: 20, b: 20 } } }).png().toFile(sky);
  await sharp({ create: { width, height, channels: 3, background: 'black' } }).png().toFile(mask);
  const before = fs.readFileSync(input);
  const { processFile } = require('../src/services/skyReplaceImage');
  const output = path.join(root, 'out.png');
  const result = await processFile({
    inputPath: input, outputPath: output,
    parameters: { sky_source: 0, mask_source: 1, route: 'user_mask' },
    requireComponent: createRequire(path.join(path.resolve(__dirname, '..'), 'package.json')),
    sources: [{ path: sky }, { path: mask }],
  });
  assert.equal(result.status, 'unchanged');
  assert.equal(result.no_sky, true);
  assert.match(result.quality_note, /不是分割失败/);
  const outPng = await sharp(output).removeAlpha().raw().toBuffer();
  const inPng = await sharp(input).removeAlpha().raw().toBuffer();
  assert.ok(outPng.equals(inPng));
  assert.ok(fs.readFileSync(input).equals(before));
});

test('auto route without model records SKY_MODEL_MISSING instead of succeeding', async t => {
  const sharp = sharpFromRepo();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-sky-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'scene.png');
  const sky = path.join(root, 'sky.png');
  await sharp({ create: { width: 32, height: 24, channels: 3, background: 'blue' } }).png().toFile(input);
  await sharp({ create: { width: 32, height: 24, channels: 3, background: 'red' } }).png().toFile(sky);
  const { processFile } = require('../src/services/skyReplaceImage');
  await assert.rejects(processFile({
    inputPath: input, outputPath: path.join(root, 'out.png'),
    parameters: { sky_source: 0, route: 'auto', model_dir: path.join(root, 'no-model') },
    requireComponent: () => { throw Object.assign(Error('onnx missing'), { code: 'SKY_MODEL_MISSING' }); },
    sources: [{ path: sky }],
  }), err => err.code === 'SKY_MODEL_MISSING' || err.code === 'INVALID_PARAMETERS' || /尚未准备|onnx/.test(err.message));
});