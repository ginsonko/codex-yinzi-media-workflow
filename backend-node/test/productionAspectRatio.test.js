const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeProductionAspectRatio,
  productionAspectPrompt,
  validateProductionMediaAspect,
} = require('../src/services/productionAspectRatio');

describe('production aspect ratio contract', () => {
  it('normalizes known ratios and safely falls back for historical invalid values', () => {
    assert.equal(normalizeProductionAspectRatio('9：16'), '9:16');
    assert.equal(normalizeProductionAspectRatio('unknown'), '16:9');
    assert.match(productionAspectPrompt('9:16'), /竖向构图/);
  });

  it('accepts matching pixels and rejects a landscape image for a portrait task', () => {
    const receipt = validateProductionMediaAspect(720, 1280, '9:16');
    assert.equal(receipt.aspect_ratio_valid, true);
    assert.equal(receipt.expected_aspect_ratio, '9:16');
    assert.throws(
      () => validateProductionMediaAspect(1280, 720, '9:16'),
      (error) => error.code === 'PRODUCTION_ASPECT_RATIO_MISMATCH'
    );
  });
});
