const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  identityForConfig,
  identityFromSnapshot,
  sameIdentity,
} = require('../src/services/productionConfigIdentity');
const { buildProviderConfigSnapshot } = require('../src/services/videoClient');
const { routingMaterialSignature } = require('../src/services/productionVideoRouter');

describe('production configuration identity', () => {
  const base = {
    id: 7,
    service_type: 'video',
    provider: 'yinzi',
    api_protocol: 'openai',
    base_url: 'https://api.example/v1',
    endpoint: '/videos',
    query_endpoint: '/videos/{taskId}',
    model: ['mg-seedance-2.5-720p'],
    default_model: 'mg-seedance-2.5-720p',
    settings: JSON.stringify({ routing_mode: 'group', api_key: 'secret-a' }),
    api_key: 'secret-a',
    is_active: true,
    updated_at: '2026-08-24T00:00:00.000Z',
  };

  it('creates a secret-free identity and detects settings/model revisions', () => {
    const first = identityForConfig(base);
    const changed = identityForConfig({
      ...base,
      model: ['mg-seedance-2.5-1080p'],
      default_model: 'mg-seedance-2.5-1080p',
      settings: JSON.stringify({ routing_mode: 'group', api_key: 'secret-b' }),
      updated_at: '2026-08-24T00:00:01.000Z',
    });
    assert.equal(first.id, 7);
    assert.equal(first.version, 1);
    assert.equal(sameIdentity(first, identityFromSnapshot({
      config_id: first.id,
      config_updated_at: first.updated_at,
      config_fingerprint: first.fingerprint,
    })), true);
    assert.equal(sameIdentity(first, changed), false);
    assert.notEqual(first.fingerprint, changed.fingerprint);
  });

  it('freezes the video config revision in provider snapshots', () => {
    const snapshot = buildProviderConfigSnapshot(base, base.default_model, { automatic_route: true });
    assert.equal(snapshot.config_id, 7);
    assert.equal(snapshot.config_updated_at, base.updated_at);
    assert.equal(typeof snapshot.config_fingerprint, 'string');
    assert.equal(snapshot.api_key, undefined);
  });

  it('makes a route signature change when only the live config identity changes', () => {
    const route = {
      profile: 'short_image_guided', model: 'mg-seedance-2.5-720p', duration: 5,
      planned_duration: 5, resolution: '720p', requires_director_preview: false,
      uses_reference_video: false, director_mode: 'off', transition_mode: 'opening',
      requires_strict_first_frame: false, group: 'video', limits: { images: 4, videos: 0, audios: 0 },
      roles: { image: ['reference'] }, contract_status: 'known', contract_warnings: [],
      video_config_id: 7, video_config_updated_at: base.updated_at,
      video_config_fingerprint: identityForConfig(base).fingerprint,
    };
    const changed = { ...route, video_config_updated_at: '2026-08-24T00:00:01.000Z' };
    assert.notEqual(routingMaterialSignature(route), routingMaterialSignature(changed));
  });

  it('does not change the config fingerprint when only the discovered catalog snapshot changes', () => {
    const first = identityForConfig({
      ...base,
      settings: JSON.stringify({ routing_mode: 'smart', model_catalog_snapshot: { fetched_at: 't1', models: [{ model: 'a' }] } }),
      updated_at: '2026-08-24T00:00:00.000Z',
    });
    const refreshed = identityForConfig({
      ...base,
      settings: JSON.stringify({ routing_mode: 'smart', model_catalog_snapshot: { fetched_at: 't2', models: [{ model: 'b' }] } }),
      updated_at: '2026-08-24T00:00:01.000Z',
    });
    assert.equal(first.fingerprint, refreshed.fingerprint);
  });
});
