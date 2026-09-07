const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  KNOWN_STALE_PRICING_VERSION,
  listDefaultYinziVideoPrices,
  resolveYinziVideoPrices,
} = require('../src/services/yinziVideoDefaults');

describe('Yinzi video defaults', () => {
  it('keeps unique positive fallback prices and includes the current default video catalog', () => {
    const prices = listDefaultYinziVideoPrices();
    const modelNames = prices.map((item) => item.model.toLowerCase());
    const requiredModels = [
      '官转-seedance2.0 720p-fast',
      '官转-seedance2.0 720p-pro',
      '破甲seedance 720p-fast',
      'cm-seedance2.0 -720p-15s',
      'cm-seedance2.0特价fast-720p-gz-15s',
      'seedance-2.5-720p',
      'seedance2.0 -720p-fast-15s',
      'seedance2.0 720p-pro-nv-nsp',
      'seedance2.0特价pro-720p-gz-15s',
      'seedance2.0特价pro-720p-gz-15s-nsp',
      'grok-imagine-video',
      'MiniMax-H3-2k',
      'MiniMax-H3-4k',
      'Kling VIDEO 3.0 Omni',
      'Kling VIDEO 3.0 Omni-1080p',
      'Kling VIDEO 3.0 Omni-4k',
    ].map((model) => model.toLowerCase());
    assert.equal(new Set(modelNames).size, prices.length);
    assert.equal(requiredModels.every((model) => modelNames.includes(model)), true);
    assert.equal(
      prices.every((item) => ['per_request', 'per_second', 'per_generation', 'fixed_duration'].includes(item.billing_unit)),
      true,
    );
    assert.equal(prices.every((item) => item.effective_price > 0), true);
  });

  it('uses a new valid live price after the stale catalog revision changes', () => {
    const live = [{
      group: '特价视频分组(即梦)', billing_mode: 'fixed_price',
      billing_unit: 'per_second', effective_price: 0.1234,
    }];
    assert.equal(
      resolveYinziVideoPrices('mg-seedance2.0 -480p mini', live, KNOWN_STALE_PRICING_VERSION)[0].effective_price,
      0.1664
    );
    assert.equal(
      resolveYinziVideoPrices('mg-seedance2.0 -480p mini', live, 'new-live-revision')[0].effective_price,
      0.1234
    );
  });
});
