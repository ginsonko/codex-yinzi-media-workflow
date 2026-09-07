const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyShotRoute,
  listShotVideoRouteOptions,
  selectShotVideoRoute,
  routingMaterialSignature,
  routingBindingSignature,
} = require('../src/services/productionVideoRouter');

function price(model, effective, unit = 'per_second') {
  return {
    model,
    endpoint_types: ['openai-video'],
    groups: ['特价视频分组(即梦)'],
    prices: [{
      group: '特价视频分组(即梦)',
      billing_mode: 'fixed_price',
      billing_unit: unit,
      effective_price: effective,
    }],
  };
}

const catalog = {
  pricing_version: 'fixture-v1',
  fetched_at: '2026-08-07T00:00:00.000Z',
  video: [
    price('cc-seedance2.0 480p-fast-nsp', 0.4656),
    price('cc-seedance2.0 480p-nsp', 0.5148),
    price('mg-seedance2.0 -480p mini', 0.2004),
    price('mg-seedance2.0 -720p fast', 0.4188),
    price('mg-seedance2.0 -480p-fast-gz-15s', 6.9888, 'fixed_duration'),
    price('破甲seedance 720p-fast', 2.1528),
  ],
};

const policy = {
  video_routing_mode: 'auto',
  video_group: '特价视频分组(即梦)',
  video_quality: 'balanced',
};

describe('production video router', () => {
  it('uses a key-discovered unknown model as an advisory automatic fallback', () => {
    const route = selectShotVideoRoute({
      shot: { content: { duration: 5, previs_mode: 'skip', route_profile: 'short_image_guided' } },
      catalog: {
        pricing_version: 'smart-route-v1',
        fetched_at: '2026-08-19T00:00:00.000Z',
        video: [{
          model: 'new-smart-route-video',
          endpoint_types: ['openai-video'],
          groups: ['智能路由'],
          prices: [{ group: '智能路由', billing_unit: 'per_second', effective_price: 0.1, currency: 'CNY' }],
          capabilities: null,
          contract_status: 'missing',
          availability_scope: 'credential',
          scope_verified: true,
        }],
      },
      policy: { video_routing_mode: 'auto', video_quality: 'balanced', director_mode: 'off' },
    });
    assert.equal(route.model, 'new-smart-route-video');
    assert.equal(route.automatic, true);
    assert.equal(route.catalog_verified, true);
    assert.equal(route.availability_scope, 'credential');
    assert.equal(route.scope_verified, true);
    assert.equal(route.contract_status, 'missing');
    assert.equal(route.estimated_price, 0.5);
    assert.ok(route.reason_codes.includes('automatic_discovered_model_fallback'));
    assert.ok(route.contract_warnings.includes('unknown_contract'));
  });

  it('does not treat an unverified static unknown model as an automatic candidate', () => {
    assert.throws(
      () => selectShotVideoRoute({
        shot: { content: { duration: 5, previs_mode: 'skip', route_profile: 'short_image_guided' } },
        catalog: {
          pricing_version: 'static-list-v1',
          video: [{
            ...price('static-unknown-video', 0.01),
            capabilities: null,
            contract_status: 'missing',
            availability_scope: 'public',
            scope_verified: false,
          }],
        },
        policy: { video_routing_mode: 'auto', video_quality: 'balanced', director_mode: 'off' },
      }),
      (error) => error?.code === 'VIDEO_ROUTE_NO_ELIGIBLE_MODEL',
    );
  });

  it('prefers an available Seedance model over a cheaper Grok model', () => {
    const route = selectShotVideoRoute({
      shot: { content: { duration: 5, previs_mode: 'skip', route_profile: 'short_image_guided' } },
      catalog: {
        pricing_version: 'smart-route-v2',
        video: [
          { ...price('grok-imagine-video', 0.01, 'per_request'), credential_verified: true, availability_scope: 'credential', scope_verified: true },
          { ...price('mg-seedance2.0 -480p mini', 0.2), credential_verified: true, availability_scope: 'credential', scope_verified: true },
        ],
      },
      policy: { video_routing_mode: 'auto', video_quality: 'balanced', director_mode: 'off' },
    });
    assert.equal(route.model, 'mg-seedance2.0 -480p mini');
  });

  it('never auto-routes a public-only Seedance model over the current-key Grok model', () => {
    const route = selectShotVideoRoute({
      shot: { content: { duration: 5, previs_mode: 'skip', route_profile: 'short_image_guided' } },
      catalog: {
        pricing_version: 'smart-route-v3',
        video: [
          { ...price('grok-imagine-video', 0.1125, 'per_request'), credential_verified: true, availability_scope: 'credential', scope_verified: true },
          { ...price('mg-seedance2.0 -480p mini', 0.01), credential_verified: false, public_catalog: true, manual_only: true, availability_scope: 'public', scope_verified: false },
        ],
      },
      policy: { video_routing_mode: 'auto', video_quality: 'balanced', director_mode: 'off' },
    });
    assert.equal(route.model, 'grok-imagine-video');
  });

  it('ignores stale public smart-candidate flags and keeps the current-key model automatic', () => {
    const route = selectShotVideoRoute({
      shot: { content: { duration: 5, previs_mode: 'skip', route_profile: 'short_image_guided' } },
      catalog: {
        pricing_version: 'smart-route-v4',
        video: [
          { ...price('grok-imagine-video', 0.1125, 'per_request'), credential_verified: true, availability_scope: 'credential', scope_verified: true },
          {
            ...price('seedance2.0 720p-pro-nv-nsp', 0.44928, 'per_request'),
            credential_verified: false,
            smart_routing_candidate: true,
            public_catalog: true,
            availability_scope: 'public',
            scope_verified: false,
          },
          {
            ...price('seedance-2.5-720p', 0.672),
            credential_verified: false,
            smart_routing_candidate: true,
            public_catalog: true,
            availability_scope: 'public',
            scope_verified: false,
          },
        ],
      },
      policy: { video_routing_mode: 'auto', video_quality: 'balanced', director_mode: 'off' },
    });
    assert.equal(route.model, 'grok-imagine-video');
    assert.equal(route.smart_routing_candidate, false);
    const options = listShotVideoRouteOptions({
      shot: { content: { duration: 5, previs_mode: 'skip', route_profile: 'short_image_guided' } },
      catalog: {
        pricing_version: 'smart-route-v4',
        video: [price('seedance2.0 720p-pro-nv-nsp', 0.44928, 'per_request')],
      },
      policy: { video_routing_mode: 'fixed', video_model: 'seedance2.0 720p-pro-nv-nsp' },
    });
    assert.equal(options[0].selectable, true);
    assert.equal(options[0].automatic_eligible, false);
    assert.ok(options[0].warnings.includes('channel_temporarily_unavailable'));
  });
  it('keeps a two-second creative plan when provider capability is unknown', () => {
    const route = classifyShotRoute({ content: { duration: 2, shot_type: '特写' } });
    assert.equal(route.profile, 'short_image_guided');
    assert.equal(route.planned_duration, 2);
    assert.equal(route.duration, 2);
    assert.equal(route.duration_adjusted, false);
    assert.equal(route.requires_director_preview, false);
    assert.equal(route.uses_reference_video, false);
  });

  it('selects the lowest estimated total price using the concrete provider unit', () => {
    const route = selectShotVideoRoute({
      shot: { content: { duration: 2, shot_type: '特写' } }, catalog, policy,
    });
    assert.equal(route.model, 'mg-seedance2.0 -480p mini');
    assert.equal(route.planned_duration, 2);
    assert.equal(route.duration, 5);
    assert.equal(route.duration_adjusted, true);
    assert.equal(route.duration_adjustment_reason, 'provider_duration_boundary');
    assert.equal(route.limits.videos, 0);
    assert.equal(route.estimated_price, 1.002);
    assert.equal(route.catalog_verified, true);
  });

  it('selects the economical reference model for an eight-second take', () => {
    const route = selectShotVideoRoute({
      shot: { content: { duration: 8, camera_movement: 'continuous follow' } }, catalog, policy,
    });
    assert.equal(route.model, 'mg-seedance2.0 -480p mini');
    assert.equal(route.requires_director_preview, true);
    assert.equal(route.uses_reference_video, true);
    assert.equal(route.limits.videos, 3);
    assert.equal(route.estimated_price, 1.6032);
  });

  it('lets an eight-second shot explicitly skip director preview and reference video', () => {
    const route = selectShotVideoRoute({
      shot: { content: { duration: 8, camera_movement: 'continuous follow', previs_mode: 'skip' } },
      catalog,
      policy,
    });
    assert.equal(route.model, 'mg-seedance2.0 -480p mini');
    assert.equal(route.previs_mode, 'skip');
    assert.equal(route.requires_director_preview, false);
    assert.equal(route.uses_reference_video, false);
    assert.equal(route.limits.videos, 0);
  });

  it('lets a persisted shot routing choice skip a storyboard default without editing the approved script', () => {
    const route = selectShotVideoRoute({
      shot: { scope_id: '6', content: { duration: 12, previs_mode: 'auto' } },
      catalog,
      policy: { ...policy, video_previs_overrides: { 6: 'skip' } },
    });
    assert.equal(route.previs_mode, 'skip');
    assert.equal(route.requires_director_preview, false);
    assert.equal(route.uses_reference_video, false);
    assert.equal(route.limits.videos, 0);
    assert.ok(route.reason_codes.includes('director_preview_skipped_by_user'));
  });

  it('lets auto remove a persisted shot override and return to the storyboard setting', () => {
    const route = selectShotVideoRoute({
      shot: { scope_id: '6', content: { duration: 12, previs_mode: 'force' } },
      catalog,
      policy: { ...policy, video_previs_overrides: { 6: 'auto' } },
    });
    assert.equal(route.previs_mode, 'force');
    assert.equal(route.requires_director_preview, true);
    assert.equal(route.uses_reference_video, true);
  });

  it('can force a local director preview for a short shot without uploading it', () => {
    const route = selectShotVideoRoute({
      shot: { content: { duration: 2, shot_type: 'close-up', previs_mode: 'force' } },
      catalog,
      policy,
    });
    assert.equal(route.model, 'mg-seedance2.0 -480p mini');
    assert.equal(route.previs_mode, 'force');
    assert.equal(route.requires_director_preview, true);
    assert.equal(route.uses_reference_video, false);
    assert.equal(route.limits.videos, 0);
  });

  it('does not select fixed-duration or expensive bypass products automatically', () => {
    const route = selectShotVideoRoute({
      shot: { content: { duration: 15 } }, catalog, policy,
    });
    assert.equal(route.model, 'mg-seedance2.0 -480p mini');
    assert.equal(route.candidates.some((item) => item.model.includes('gz-15s')), false);
    assert.notEqual(route.model, '破甲seedance 720p-fast');
  });

  it('uses the provider capability boundary for a fixed compatible model', () => {
    const route = selectShotVideoRoute({
      shot: { content: { duration: 2 } }, catalog,
      policy: { video_routing_mode: 'fixed', video_model: 'mg-seedance2.0 -480p-fast-gz-15s' },
    });
    assert.equal(route.planned_duration, 2);
    assert.equal(route.duration, 15);
    assert.equal(route.duration_adjustment_reason, 'provider_fixed_duration');
    assert.equal(route.catalog_verified, true);
    assert.equal(route.estimated_price, 6.9888);
  });

  it('lets a shot override win over a project fixed model', () => {
    const route = selectShotVideoRoute({
      shot: { scope_id: '5', content: { duration: 5 } },
      catalog,
      policy: {
        ...policy,
        video_routing_mode: 'fixed',
        video_model: 'cc-seedance2.0 480p-fast-nsp',
        video_model_overrides: { 5: 'cc-seedance2.0 480p-nsp' },
      },
    });
    assert.equal(route.model, 'cc-seedance2.0 480p-nsp');
    assert.deepEqual(route.reason_codes, ['shot_model_override']);
  });

  it('keeps a fixed cross-group model selectable and records the catalog warning', () => {
    const route = selectShotVideoRoute({
      shot: { content: { duration: 5 } },
      catalog,
      policy: { video_routing_mode: 'fixed', video_model: 'cc-seedance2.0 480p-nsp', video_group: '不存在的分组' },
    });
    assert.equal(route.model, 'cc-seedance2.0 480p-nsp');
    assert.equal(route.group_available, false);
    assert.ok(route.contract_warnings.includes('group_unavailable'));
  });

  it('keeps an unregistered fixed model authoritative when the live catalog is empty', () => {
    const route = selectShotVideoRoute({
      shot: { content: { duration: 7, previs_mode: 'skip' } },
      catalog: { pricing_version: 'empty', fetched_at: null, video: [] },
      policy: { video_routing_mode: 'fixed', video_model: 'brand-new-video-model', video_group: 'custom-group' },
    });
    assert.equal(route.model, 'brand-new-video-model');
    assert.equal(route.catalog_verified, false);
    assert.equal(route.group_available, false);
    assert.equal(route.contract_status, 'missing');
    assert.equal(route.limits, null);
    assert.equal(route.estimated_price, null);
    assert.ok(route.contract_warnings.includes('unknown_contract'));
    assert.ok(route.contract_warnings.includes('model_not_in_catalog'));
  });

  it('lists incompatible and expensive manual choices without hiding them', () => {
    const options = listShotVideoRouteOptions({
      shot: { scope_id: '5', content: { duration: 5 } }, catalog, policy,
    });
    const fixed15 = options.find((item) => item.model.includes('gz-15s'));
    const expensive = options.find((item) => item.model === '破甲seedance 720p-fast');
    assert.equal(fixed15.selectable, true);
    assert.equal(fixed15.compatible, true);
    assert.equal(fixed15.incompatibility_code, null);
    assert.equal(expensive.selectable, true);
    assert.equal(expensive.requires_explicit_confirmation, true);
    assert.ok(expensive.warnings.includes('expensive_bypass'));
  });

  it('uses a local capability hint for manual routing while preserving its advisory status', () => {
    const localCatalog = {
      pricing_version: 'local-v1',
      video: [{
        ...price('new-local-video', 0.2),
        contract_status: 'local',
        capability_source: 'local',
        capabilities: {
          duration_mode: 'range', duration_min: 5, duration_max: 12,
          max_images: 6, max_videos: 2, max_audios: 1,
          resolution: '720p', quality_tier: 'balanced', automatic_eligible: false,
          route_profiles: ['short_image_guided', 'long_previs_guided'],
          roles: { image: ['reference', 'first_frame'], video: ['reference'], audio: ['reference'] },
        },
      }],
    };
    const route = selectShotVideoRoute({
      shot: { content: { duration: 8 } },
      catalog: localCatalog,
      policy: { video_routing_mode: 'fixed', video_model: 'new-local-video', video_group: '特价视频分组(即梦)' },
    });
    assert.equal(route.model, 'new-local-video');
    assert.equal(route.contract_status, 'local');
    assert.equal(route.limits.images, 6);
    const option = listShotVideoRouteOptions({
      shot: { content: { duration: 8 } }, catalog: localCatalog, policy,
    })[0];
    assert.equal(option.selectable, true);
    assert.equal(option.contract_status, 'local');
  });

  it('requires explicit automatic authorization before a local hint can enter auto routing', () => {
    const capability = {
      duration_mode: 'range', duration_min: 5, duration_max: 12,
      max_images: 6, max_videos: 2, max_audios: 1,
      resolution: '720p', quality_tier: 'balanced', automatic_eligible: false,
      route_profiles: ['short_image_guided', 'long_previs_guided'],
      roles: { image: ['reference', 'first_frame'], video: ['reference'], audio: ['reference'] },
    };
    const localCatalog = {
      pricing_version: 'local-v1',
      video: [{ ...price('new-local-video', 0.2), contract_status: 'local', capabilities: capability }],
    };
    assert.throws(
      () => selectShotVideoRoute({ shot: { content: { duration: 8 } }, catalog: localCatalog, policy }),
      /没有满足媒体、时长和费用策略/,
    );
    localCatalog.video[0].capabilities = { ...capability, automatic_eligible: true };
    const route = selectShotVideoRoute({ shot: { content: { duration: 8 } }, catalog: localCatalog, policy });
    assert.equal(route.model, 'new-local-video');
  });

  it('accepts a standard provider capability without local route profile labels', () => {
    const standardCatalog = {
      pricing_version: 'standard-contract-v1',
      video: [{
        ...price('standard-seedance-video', 0.2),
        credential_verified: true,
        availability_scope: 'credential',
        scope_verified: true,
        contract_status: 'active',
        capability_source: 'key_scoped_contract',
        capabilities: {
          duration_mode: 'range', duration_min: 5, duration_max: 15,
          max_images: 30, max_videos: 0, max_audios: 10,
          resolution: '720p', quality_tier: 'balanced', automatic_eligible: true,
          roles: { image: ['reference'], video: [], audio: ['reference'] },
        },
      }],
    };
    const route = selectShotVideoRoute({
      shot: { content: { duration: 5, route_profile: 'short_image_guided', previs_mode: 'skip' } },
      catalog: standardCatalog,
      policy,
    });
    assert.equal(route.model, 'standard-seedance-video');
    assert.equal(route.contract_status, 'active');
    assert.equal(route.reason_codes.includes('profile_mismatch'), false);
  });

  it('lets the project-level director switch override a forced long-shot preview', () => {
    const route = selectShotVideoRoute({
      shot: { content: { duration: 8, route_profile: 'long_previs_guided', previs_mode: 'force' } },
      catalog,
      policy: { ...policy, director_mode: 'off' },
    });
    assert.equal(route.director_mode, 'off');
    assert.equal(route.previs_mode, 'skip');
    assert.equal(route.requires_director_preview, false);
    assert.equal(route.uses_reference_video, false);
    assert.ok(route.reason_codes.includes('director_disabled_for_run'));
  });

  it('keeps commercial-only catalog changes out of the material signature', () => {
    const first = selectShotVideoRoute({ shot: { content: { duration: 2 } }, catalog, policy });
    const changed = structuredClone(catalog);
    changed.pricing_version = 'fixture-v2';
    changed.video[2].prices[0].effective_price = 0.25;
    const second = selectShotVideoRoute({ shot: { content: { duration: 2 } }, catalog: changed, policy });
    assert.equal(routingMaterialSignature(first), routingMaterialSignature(second));
    assert.notEqual(first.estimated_price, second.estimated_price);
  });

  it('keeps the approved bundle binding stable across catalog metadata refreshes', () => {
    const first = selectShotVideoRoute({ shot: { content: { duration: 2 } }, catalog, policy });
    const changed = structuredClone(first);
    changed.catalog_version = 'fixture-v2';
    changed.catalog_fetched_at = '2026-08-31T00:00:00.000Z';
    changed.contract_warnings = ['catalog_refresh_notice'];
    changed.catalog_verified = false;
    assert.notEqual(routingMaterialSignature(first), routingMaterialSignature(changed));
    assert.equal(routingBindingSignature(first), routingBindingSignature(changed));
  });

  it('changes the binding when the selected provider execution contract changes', () => {
    const first = selectShotVideoRoute({ shot: { content: { duration: 2 } }, catalog, policy });
    const changed = { ...first, provider_duration: Number(first.provider_duration || first.duration) + 1 };
    assert.notEqual(routingBindingSignature(first), routingBindingSignature(changed));
  });

  it('uses a bounded Seedance 2.5 fallback for an explicit missing server contract and plans two units for sixty seconds', () => {
    const route = selectShotVideoRoute({
      shot: { content: { duration: 60, previs_mode: 'skip' } },
      catalog: {
        pricing_version: 'missing-contract-v1',
        video: [{
          model: 'Seedance 2.5-720',
          capabilities: null,
          capability_source: 'unknown',
          contract_status: 'missing',
          catalog_verified: true,
          credential_verified: true,
          groups: ['限时特价即梦分组'],
          prices: [{ group: '限时特价即梦分组', billing_unit: 'per_request', effective_price: 3.5 }],
        }],
      },
      policy: {
        video_routing_mode: 'fixed', video_model: 'Seedance 2.5-720',
        video_group: '限时特价即梦分组', director_mode: 'off',
      },
    });
    assert.equal(route.planned_duration, 60);
    assert.equal(route.provider_duration, 30);
    assert.equal(route.duration, 30);
    assert.equal(route.execution_unit_count, 2);
    assert.deepEqual(route.execution_unit_durations, [30, 30]);
    assert.equal(route.contract_status, 'missing');
    assert.equal(route.capability_source, 'builtin_legacy_fallback');
    assert.ok(route.contract_warnings.includes('unknown_contract'));
    assert.ok(route.contract_warnings.includes('legacy_capability_fallback'));
  });

  it('leaves a genuinely unknown missing-contract model open and unmodified', () => {
    const route = selectShotVideoRoute({
      shot: { content: { duration: 60, previs_mode: 'skip' } },
      catalog: { video: [{ model: 'future-video-model', capabilities: null, groups: [] }] },
      policy: { video_routing_mode: 'fixed', video_model: 'future-video-model', director_mode: 'off' },
    });
    assert.equal(route.capability, null);
    assert.equal(route.duration, 60);
    assert.equal(route.provider_duration, 60);
    assert.equal(route.execution_unit_count, 1);
    assert.equal(route.contract_status, 'missing');
  });
});
