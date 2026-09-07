const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { fixOpenAIImageSize } = require('../src/services/imageClient');

describe('fixOpenAIImageSize for Yinzi gpt-image models', () => {
  it('maps project aspect ratios to supported GPT Image sizes', () => {
    assert.equal(fixOpenAIImageSize('2560x1440'), '1536x1024');
    assert.equal(fixOpenAIImageSize('1440x2560'), '1024x1536');
    assert.equal(fixOpenAIImageSize('1920x1920'), '1024x1024');
  });
});
