const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  getYinziVideoCapability,
  listYinziVideoCapabilities,
  capabilitySupportsRole,
  capabilityAcceptsDuration,
  CURRENT_YINZI_JIMENG_MODELS,
} = require('../src/services/yinziVideoCapabilities');
const { getDefaultYinziVideoPrice } = require('../src/services/yinziVideoDefaults');

const CURRENT_YINZI_VIDEO_MODELS = [
  'af-seedance-2.0',
  'af-seedance-2.0-fast',
  'ca-seedance 2.0 720pro-15s',
  'cav2-seedance 2.0 720pro-15s',
  'grok-imagine-video',
  'Kling VIDEO 3.0 Omni',
  'Kling VIDEO 3.0 Omni-1080p',
  'Kling VIDEO 3.0 Omni-4k',
  'mg-seedance2.0 -480p',
  'mg-seedance2.0 -480p fast',
  'mg-seedance2.0 -480p mini',
  'mg-seedance2.0 -720p fast',
  'mg-seedance2.0 -720p mini',
  'mg-seedance2.0 -720p pro',
  'MiniMax-H3-2k',
  'MiniMax-H3-4k',
  'seedance2.0 -720p-15s',
  'seedance2.0 -720p-gz-15s',
  'seedance-2.5-480p',
  'seedance-2.5-720p',
  '官转-seedance2.0 720p-fast',
  '官转-seedance2.0 720p-pro',
  '破甲seedance 720p-fast',
  '特价seedance-2.5-480p',
  '特价seedance-2.5-720p',
];

describe('Yinzi video capability contract', () => {
  it('exposes the bounded Seedance 2.0 reference and prompt contract', () => {
    const capability = getYinziVideoCapability('mg-seedance2.0 -480p mini');
    assert.equal(capability.provider_contract, 'aizzz-video-v1');
    assert.equal(capability.max_images, 4);
    assert.equal(capability.max_videos, 3);
    assert.equal(capability.max_audios, 1);
    assert.equal(capability.max_prompt_chars, 4000);
    assert.equal(capability.provider_prompt_hard_max_chars, 4096);
    assert.equal(capability.reference_video_safety_margin_seconds, 1.2);
    assert.equal(capability.max_reference_video_seconds_total, 15);
    assert.equal(capabilitySupportsRole(capability, 'image', 'reference'), true);
    assert.equal(capabilitySupportsRole(capability, 'video', 'reference'), true);
    assert.equal(capabilitySupportsRole(capability, 'audio', 'reference'), true);
    assert.equal(capabilitySupportsRole(capability, 'image', 'first_frame'), false);
  });

  it('keeps unknown providers outside the Yinzi-specific prompt ceiling', () => {
    assert.equal(getYinziVideoCapability('unknown-model'), null);
  });

  it('models free-duration image-only Seedance routes without inventing video support', () => {
    const capability = getYinziVideoCapability('cc-seedance2.0 480p-fast-nsp');
    assert.equal(capability.duration_mode, 'free');
    assert.equal(capability.max_images, 9);
    assert.equal(capability.max_videos, 0);
    assert.equal(capability.max_audios, 3);
    assert.equal(capability.duration_min, 5);
    assert.equal(capability.duration_max, 15);
    assert.equal(capability.requires_director_preview, false);
    assert.equal(capabilitySupportsRole(capability, 'video', 'reference'), false);
    assert.equal(capabilityAcceptsDuration(capability, 4, { automatic: true }), false);
    assert.equal(capabilityAcceptsDuration(capability, 5, { automatic: true }), true);
    assert.equal(capabilityAcceptsDuration(capability, 15, { automatic: true }), true);
  });

  it('keeps fixed-duration and expensive bypass products outside automatic routing', () => {
    const fixed = getYinziVideoCapability('mg-seedance2.0 -480p-fast-gz-15s');
    const bypass = getYinziVideoCapability('破甲seedance 720p-fast');
    assert.equal(fixed.duration_mode, 'fixed');
    assert.equal(fixed.fixed_duration_seconds, 15);
    assert.equal(fixed.automatic_eligible, false);
    assert.equal(bypass.expensive_bypass, true);
    assert.equal(bypass.automatic_eligible, false);
  });

  it('registers every current YinziAPI video model without inventing broad capabilities', () => {
    const registered = new Set(listYinziVideoCapabilities().map((item) => item.model));
    for (const model of CURRENT_YINZI_VIDEO_MODELS) {
      assert.equal(registered.has(model), true, `missing capability: ${model}`);
    }

    const seedance25 = getYinziVideoCapability('特价seedance-2.5-720p');
    assert.equal(seedance25.max_images, 30);
    assert.equal(seedance25.max_videos, 10);
    assert.equal(seedance25.max_audios, 10);
    assert.equal(seedance25.max_reference_video_seconds_total, 29);
    assert.equal(seedance25.duration_mode, 'fixed');
    assert.equal(seedance25.fixed_duration_seconds, 30);
    assert.deepEqual(seedance25.allowed_durations, [30]);
    assert.equal(seedance25.duration_min, 30);
    assert.equal(seedance25.duration_max, 30);

    const grok = getYinziVideoCapability('grok-imagine-video');
    assert.equal(grok.automatic_eligible, true);
    for (const model of [
      'MiniMax-H3-2k', 'MiniMax-H3-4k', 'Kling VIDEO 3.0 Omni',
      'Kling VIDEO 3.0 Omni-1080p', 'Kling VIDEO 3.0 Omni-4k',
    ]) {
      const capability = getYinziVideoCapability(model);
      assert.equal(capability.automatic_eligible, false);
      assert.equal(capability.manual_eligible, true);
      assert.equal(capability.automatic_availability, 'temporarily_unavailable');
      assert.equal(capability.max_images, 1);
      assert.equal(capability.max_videos, 0);
      assert.equal(capability.max_audios, 0);
      assert.equal(capabilitySupportsRole(capability, 'image', 'first_frame'), false);
    }
    assert.equal(getYinziVideoCapability('seedance2.0 720p-pro-nv-nsp').automatic_eligible, false);
    assert.equal(getYinziVideoCapability('seedance2.0特价pro-720p-gz-15s-nsp').automatic_eligible, false);
    assert.equal(getYinziVideoCapability('Kling VIDEO 3.0 Omni-1080p').resolution, '1080p');
    assert.equal(getYinziVideoCapability('Kling VIDEO 3.0 Omni-4k').resolution, '4k');
  });

  it('matches the current ten-model YinziAPI offer matrix and local CNY prices', () => {
    const expected = {
      '官转-seedance2.0 720p-fast': { media: [9, 3, 3], duration: ['free', 5, 15], price: ['per_second', 1.014] },
      '官转-seedance2.0 720p-pro': { media: [9, 3, 3], duration: ['free', 5, 15], price: ['per_second', 1.17] },
      '破甲seedance 720p-fast': { media: [9, 3, 3], duration: ['free', 5, 15], price: ['per_second', 2.1528] },
      'cm-seedance2.0 -720p-15s': { media: [9, 3, 3], duration: ['free', 5, 15], price: ['per_request', 8.0808] },
      'cm-seedance2.0特价fast-720p-gz-15s': { media: [9, 3, 3], duration: ['fixed', 15, 15], price: ['per_request', 4.68] },
      'seedance-2.5-720p': { media: [30, 10, 10], duration: ['fixed', 30, 30], price: ['per_request', 3.5] },
      'seedance2.0 -720p-fast-15s': { media: [9, 3, 3], duration: ['free', 5, 15], price: ['per_request', 5.58] },
      'seedance2.0 720p-pro-nv-nsp': { media: [9, 0, 3], duration: ['free', 5, 15], price: ['per_request', 0.44928] },
      'seedance2.0特价pro-720p-gz-15s': { media: [9, 3, 3], duration: ['fixed', 15, 15], price: ['fixed_duration', 6.24] },
      'seedance2.0特价pro-720p-gz-15s-nsp': { media: [9, 0, 3], duration: ['fixed', 15, 15], price: ['per_request', 5.16] },
    };

    assert.deepEqual([...CURRENT_YINZI_JIMENG_MODELS], Object.keys(expected));
    for (const [model, contract] of Object.entries(expected)) {
      const capability = getYinziVideoCapability(model);
      const price = getDefaultYinziVideoPrice(model);
      assert.ok(capability, `missing capability: ${model}`);
      assert.ok(price, `missing price: ${model}`);
      assert.deepEqual(
        [capability.max_images, capability.max_videos, capability.max_audios],
        contract.media,
        `media mismatch: ${model}`,
      );
      assert.deepEqual(
        [capability.duration_mode, capability.duration_min, capability.duration_max],
        contract.duration,
        `duration mismatch: ${model}`,
      );
      assert.deepEqual([price.billing_unit, price.effective_price], contract.price, `price mismatch: ${model}`);
      assert.equal(price.currency, 'CNY');
    }

    const seedance25 = getYinziVideoCapability('seedance-2.5-720p');
    assert.equal(capabilityAcceptsDuration(seedance25, 4), false);
    assert.equal(capabilityAcceptsDuration(seedance25, 4, { automatic: true }), false);
    assert.equal(capabilityAcceptsDuration(seedance25, 30, { automatic: true }), true);
    assert.equal(capabilityAcceptsDuration(seedance25, 15, { automatic: true }), false);
    assert.equal(getYinziVideoCapability('破甲seedance 720p-fast').automatic_eligible, false);
  });
});
