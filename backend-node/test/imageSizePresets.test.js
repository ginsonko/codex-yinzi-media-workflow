const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { IMAGE_SIZE_PRESETS, usesImageSizePresets, snapImageSize } = require('../src/services/imageSizePresets');

describe('image size presets for GPT Image 2 / 2.5 and smart-image', () => {
  it('applies to gpt-image-2, 2.5, their site variants and smart-image only', () => {
    for (const m of ['gpt-image-2', 'GPT-Image-2.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'smart-image', 'openai/gpt-image-2']) assert.equal(usesImageSizePresets(m), true, m);
    for (const m of ['gpt-image-1', 'gpt-image-1.5', 'dall-e-3', 'seedream-v5-lite', 'nano-banana-pro', '']) assert.equal(usesImageSizePresets(m), false, m);
  });

  it('keeps every preset unchanged', () => {
    for (const tiers of Object.values(IMAGE_SIZE_PRESETS)) for (const size of Object.values(tiers)) assert.equal(snapImageSize(size), size);
  });

  it('moves sizes the sites cannot route to the nearest preset', () => {
    assert.equal(snapImageSize('1920x1920'), '2048x2048');
    assert.equal(snapImageSize('1920*1920'), '2048x2048');
    assert.equal(snapImageSize('1024x1536'), '1536x2048');
    assert.equal(snapImageSize('1536x1024'), '1536x1024');
    assert.equal(snapImageSize('2240x1680'), '2048x1536');
    assert.equal(snapImageSize('1680x2240'), '1536x2048');
    assert.equal(snapImageSize('2940x1260'), '2560x1088');
    assert.equal(snapImageSize('512x512'), '1024x1024');
    assert.equal(snapImageSize('4096x4096'), '2880x2880');
    assert.equal(snapImageSize('1792x1024'), '1280x720');
  });

  it('builds a size from a tier or aspect ratio, and leaves out what it cannot read', () => {
    assert.equal(snapImageSize('2K', '9:16'), '1440x2560');
    assert.equal(snapImageSize('1k', '1:1'), '1024x1024');
    assert.equal(snapImageSize('', '16:9'), '2560x1440');
    assert.equal(snapImageSize('4K'), '2880x2880');
    assert.equal(snapImageSize('auto'), '');
    assert.equal(snapImageSize(''), '');
  });

  it('matches the frontweb preset table', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../frontweb/src/utils/imageSizes.js'), 'utf8');
    for (const [ratio, tiers] of Object.entries(IMAGE_SIZE_PRESETS)) {
      for (const [tier, size] of Object.entries(tiers)) assert.match(src, new RegExp(`'${ratio}':[^\\n]*'${tier}': '${size}'`), `${ratio} ${tier}`);
    }
  });
});
