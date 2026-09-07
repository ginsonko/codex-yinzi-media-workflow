const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mergeDiscoveredCatalog } = require('../src/services/aiConfigService');

describe('key-scoped capability catalog merge', () => {
  it('does not invent a builtin profile when the verified catalog marks a model missing', () => {
    const result = mergeDiscoveredCatalog(
      { models: [{ model: 'mg-seedance2.0 -480p mini' }], availability_scope: 'credential', snapshot: { scope_verified: true } },
      {
        catalog_verified: true,
        video: [{
          model: 'mg-seedance2.0 -480p mini', groups: ['video'], capabilities: null,
          capability_source: 'unknown', contract_status: 'missing', prices: [],
        }],
      },
      { provider: 'yinzi', service_type: 'video' }
    );
    assert.equal(result.video[0].capabilities, null);
    assert.equal(result.video[0].contract_status, 'missing');
    assert.equal(result.video[0].catalog_verified, true);
    assert.equal(result.video[0].automatic_eligible, false);
  });

  it('keeps legacy builtin compatibility only for an explicitly unverified fallback', () => {
    const result = mergeDiscoveredCatalog(
      { models: [{ model: 'mg-seedance2.0 -480p mini' }] },
      { catalog_verified: false, source: 'legacy_fallback', video: [] },
      { provider: 'yinzi', service_type: 'video' }
    );
    assert.equal(result.video[0].capabilities.family, 'mg-seedance2-reference');
    assert.equal(result.video[0].catalog_verified, false);
  });

  it('filters a typed mixed smart-key catalog and adds public video models as manual choices', () => {
    const result = mergeDiscoveredCatalog(
      {
        availability_scope: 'credential',
        source_url: 'https://api.yinziapi.top/v1/models',
        snapshot: { scope_verified: true },
        models: [
          { model: 'gpt-5.6-sol', endpoint_types: ['openai'] },
          { model: 'gpt-image-2', endpoint_types: ['openai', 'image-generation'] },
          { model: 'grok-imagine-video', endpoint_types: ['openai', 'openai-video'] },
        ],
      },
      {
        catalog_verified: false,
        public_catalog: {
          source: 'https://yinziapi.top/api/pricing',
          video: [
            { model: 'grok-imagine-video', endpoint_types: ['openai-video'], groups: ['video'], prices: [] },
            { model: 'seedance-2.5-720p', endpoint_types: ['openai-video'], groups: ['jimeng'], prices: [] },
          ],
        },
        video: [],
      },
      { provider: 'yinzi', service_type: 'video', include_public_catalog: true }
    );
    assert.deepEqual(result.video.map((item) => item.model), ['grok-imagine-video', 'seedance-2.5-720p']);
    assert.equal(result.video[0].credential_verified, true);
    assert.equal(result.video[0].manual_only, false);
    assert.equal(result.video[1].credential_verified, false);
    assert.equal(result.video[1].public_catalog, true);
    assert.equal(result.video[1].manual_only, true);
    assert.equal(result.video[1].automatic_eligible, false);
    assert.equal(result.video[1].smart_routing_candidate, false);
  });

  it('keeps a key-scoped contract model that is absent from the legacy models response', () => {
    const result = mergeDiscoveredCatalog(
      {
        availability_scope: 'credential',
        snapshot: { scope_verified: true },
        models: [{ model: 'grok-imagine-video', endpoint_types: ['openai-video'] }],
      },
      {
        catalog_verified: true,
        scope_verified: true,
        video: [
          {
            model: 'grok-imagine-video', endpoint_types: ['openai-video'], capabilities: null,
            contract_status: 'missing', prices: [],
          },
          {
            model: 'seedance-2.5-720p', endpoint_types: ['openai-video'],
            contract_status: 'active', automatic_eligible: true,
            capabilities: { automatic_eligible: true, max_images: 30, max_videos: 10, max_audios: 10 },
            prices: [], capability_source: 'key_scoped_contract',
          },
        ],
      },
      { provider: 'yinzi', service_type: 'video' }
    );
    const seedance = result.video.find((item) => item.model === 'seedance-2.5-720p');
    assert.ok(seedance);
    assert.equal(seedance.credential_verified, false);
    assert.equal(seedance.availability_scope, 'credential');
    assert.equal(seedance.capabilities.max_images, 30);
    assert.equal(seedance.automatic_eligible, false);
    assert.equal(seedance.smart_routing_candidate, false);
    assert.equal(seedance.manual_only, true);
  });
});
