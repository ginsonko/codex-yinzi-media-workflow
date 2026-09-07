const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { fixAgnesImageSize, isAgnesImageConfig } = require('../src/services/imageClient');

describe('fixAgnesImageSize', () => {
  it('maps 9:16 project size to Agnes portrait preset', () => {
    assert.equal(fixAgnesImageSize('1440x2560'), '1024x1792');
  });

  it('maps 16:9 project size to Agnes landscape preset', () => {
    assert.equal(fixAgnesImageSize('2560x1440'), '1792x1024');
  });

  it('maps 1:1 project size to Agnes square preset', () => {
    assert.equal(fixAgnesImageSize('1920x1920'), '1024x1024');
  });
});

describe('isAgnesImageConfig', () => {
  it('detects agnes provider even when api_protocol is openai', () => {
    assert.equal(
      isAgnesImageConfig({ provider: 'agnes', base_url: 'https://apihub.agnes-ai.com/v1', api_protocol: 'openai' }, 'agnes-image-2.1-flash'),
      true
    );
  });
});
