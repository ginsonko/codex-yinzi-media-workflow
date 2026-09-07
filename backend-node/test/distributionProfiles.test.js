const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const profiles = require('../src/services/distributionProfiles');
const imageSite = require('../src/services/yinziImageSiteService');
const aiConfig = require('../src/services/aiConfigService');
const createAiConfigRoutes = require('../src/routes/aiConfig');

const log = { info() {}, warn() {}, error() {} };

function captureResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}

describe('distribution profiles', () => {
  it('normalizes unknown values to the universal profile without rejecting onboarding', () => {
    assert.equal(profiles.normalizeDistributionProfile('yinzi'), 'yinzi');
    assert.equal(profiles.normalizeDistributionProfile('UNIVERSAL'), 'universal');
    assert.equal(profiles.normalizeDistributionProfile('future-edition'), 'universal');
    assert.equal(profiles.resolveDistributionProfile({ distribution_profile: 'yinzi' }), 'yinzi');
  });

  it('exposes both editions with the same non-smart image site metadata', () => {
    const yinzi = profiles.getDistributionProfile('yinzi');
    const universal = profiles.getDistributionProfile('universal');
    for (const profile of [yinzi, universal]) {
      const site = profile.sites.image_yinzi;
      assert.equal(site.base_url, 'https://image.yinziapi.top/v1');
      assert.equal(site.smart_routing, false);
      assert.equal(site.routing_mode, 'group');
      assert.equal(site.credential_mode, 'three_keys');
      assert.deepEqual(site.defaults, {
        text_model: 'gpt-5.6-sol', image_model: 'gpt-image-2', video_model: 'Seedance 2.5-720',
      });
      assert.deepEqual(site.model_capabilities['Seedance 2.5-720'].allowed_durations, [30]);
      assert.deepEqual(site.model_capabilities['Seedance 2.0-720'].allowed_durations, [5, 10, 15]);
    }
    assert.equal(yinzi.smart_routing_entry, true);
    assert.equal(universal.smart_routing_entry, false);
    assert.equal(universal.preferred_site, 'laoli');
    assert.equal(universal.sites.laoli.smart_routing, false);
    assert.equal(universal.sites.laoli.text_base_url, '');
    assert.equal(universal.sites.laoli.image_base_url, 'https://video.laoliimage2.win/v1');
    assert.equal(universal.sites.laoli.video_base_url, 'https://video.laoliimage2.win/v1');
    assert.equal(universal.sites.laoli.defaults.video_model, '3.5');
    assert.deepEqual(universal.sites.laoli.model_capabilities['3.5'].allowed_durations, [30]);
    assert.deepEqual(universal.sites.laoli.model_capabilities['3.0'].allowed_durations, [5, 10, 15]);
  });

  it('persists the selected edition in image site settings while preserving key isolation', () => {
    const yinziDefs = imageSite.definitions({
      distribution_profile: 'yinzi', text_api_key: 'text-key', image_api_key: 'image-key', video_api_key: 'video-key',
      image_model: 'future-image-model', video_model: 'future-video-model',
    });
    assert.equal(JSON.parse(yinziDefs[0].settings).distribution_profile, 'yinzi');
    assert.equal(yinziDefs[1].api_key, 'image-key');
    assert.equal(yinziDefs[2].api_key, 'image-key');
    assert.equal(yinziDefs[3].api_key, 'video-key');
    assert.ok(yinziDefs[3].model.includes('future-video-model'));

    const universalDefs = imageSite.definitions({
      distribution_profile: 'universal', text_api_key: 't2', image_api_key: 'i2', video_api_key: 'v2',
    });
    assert.equal(JSON.parse(universalDefs[3].settings).distribution_profile, 'universal');
    assert.equal(universalDefs[3].default_model, 'Seedance 2.5-720');
  });

  it('returns a redacted profile endpoint and setup response for either edition', async () => {
    const db = createDb();
    const routes = createAiConfigRoutes(db, log, {});
    for (const edition of ['yinzi', 'universal']) {
      const profileResponse = captureResponse();
      routes.distributionProfile({ query: { profile: edition } }, profileResponse);
      assert.equal(profileResponse.statusCode, 200);
      assert.equal(profileResponse.body.data.id, edition);
      assert.equal(JSON.stringify(profileResponse.body).includes('api_key'), false);

      const setupResponse = captureResponse();
      await routes.setupImageYinzi({ body: {
        distribution_profile: edition,
        text_api_key: `${edition}-text-secret`,
        image_api_key: `${edition}-image-secret`,
        video_api_key: `${edition}-video-secret`,
      } }, setupResponse);
      assert.equal(setupResponse.statusCode, 200);
      assert.equal(setupResponse.body.data.distribution_profile, edition);
      assert.equal(setupResponse.body.data.smart_routing, false);
      assert.equal(JSON.stringify(setupResponse.body).includes('-secret'), false);
    }
    const rows = db.prepare('SELECT service_type, settings FROM ai_service_configs WHERE deleted_at IS NULL ORDER BY service_type').all();
    assert.equal(rows.length, 4);
    assert.ok(rows.every((row) => JSON.parse(row.settings).distribution_profile === 'universal'));
    assert.equal(aiConfig.listConfigs(db).filter((row) => row.provider === 'yinzi').length, 4);
  });
});
