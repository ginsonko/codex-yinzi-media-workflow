const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { finalizeGeneratedImageSize } = require('../src/services/imageService');
const log = { info() {}, warn() {} };

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-output-size-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'provider.png');
  await sharp({ create: { width: 32, height: 48, channels: 3, background: '#7ea0c2' } }).png().toFile(file);
  return file;
}

test('ordinary provider image keeps exact bytes when the requested aspect differs', async t => {
  const file = await fixture(t);
  const before = fs.readFileSync(file);
  const result = await finalizeGeneratedImageSize(file, '40x50', log, { storyboard_id: null });
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(result.actual, { width: 32, height: 48 });
  assert.deepEqual(result.requested, { width: 40, height: 50 });
  assert.equal(result.matches_requested, false);
  assert.equal(result.layout_required, true);
  assert.equal(result.policy, 'preserve_provider_output');
});

test('matching ordinary output remains byte-identical without a layout warning', async t => {
  const file = await fixture(t);
  const before = fs.readFileSync(file);
  const result = await finalizeGeneratedImageSize(file, '32x48', log);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(result.matches_requested, true);
  assert.equal(result.layout_required, false);
});

test('storyboard output retains the existing cover sizing without black padding', async t => {
  const file = await fixture(t);
  const result = await finalizeGeneratedImageSize(file, '40x50', log, { storyboard_id: 1 });
  assert.deepEqual(result.actual, { width: 40, height: 50 });
  assert.equal(result.matches_requested, true);
  const { data } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data.every(value => value > 100));
});
