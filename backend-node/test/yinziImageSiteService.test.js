const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const service = require('../src/services/yinziImageSiteService');
const aiConfig = require('../src/services/aiConfigService');

let db;
const log = { info() {}, warn() {}, error() {} };
beforeEach(() => { db = new Database(':memory:'); runMigrationsAndEnsure(db); });

describe('image.yinziapi.top three-key profile', () => {
  it('normalizes only the image.yinziapi.top HTTPS host', () => {
    assert.equal(service.normalizeImageYinziBaseUrl('https://image.yinziapi.top'), 'https://image.yinziapi.top/v1');
    assert.equal(service.normalizeImageYinziBaseUrl('https://image.yinziapi.top/v1/'), 'https://image.yinziapi.top/v1');
    assert.throws(() => service.normalizeImageYinziBaseUrl('https://api.yinziapi.top/v1'), /必须是/);
    assert.throws(() => service.normalizeImageYinziBaseUrl('http://image.yinziapi.top/v1'), /HTTPS/);
    assert.throws(() => service.normalizeImageYinziBaseUrl('https://image.yinziapi.top/proxy/v1'), /只能是/);
  });
  it('builds separate text/image/video keys and advisory duration contracts', () => {
    const defs = service.definitions({ text_api_key: 't', image_api_key: 'i', video_api_key: 'v' });
    assert.equal(defs.length, 4);
    assert.equal(defs[0].api_key, 't');
    assert.equal(defs[1].api_key, 'i');
    assert.equal(defs[3].api_key, 'v');
    assert.equal(defs[3].default_model, 'Seedance 2.5-720');
    const settings = JSON.parse(defs[3].settings);
    assert.equal(settings.smart_routing_enabled, false);
    assert.deepEqual(settings.model_capabilities['Seedance 2.5-720'].allowed_durations, [30]);
    assert.deepEqual(settings.model_capabilities['Seedance 2.0-720'].allowed_durations, [5, 10, 15]);
  });
  it('does not steal an existing default and updates only its own profile idempotently', () => {
    aiConfig.createConfig(db, log, { service_type: 'video', provider: 'other', name: 'other', base_url: 'https://other.example/v1', api_key: 'x', model: ['x'], default_model: 'x', is_default: true });
    const first = service.setup(db, log, { text_api_key: 't', image_api_key: 'i', video_api_key: 'v' });
    const second = service.setup(db, log, { text_api_key: 't2', image_api_key: 'i2', video_api_key: 'v2' });
    assert.equal(first.configured.length, 4);
    assert.equal(second.configured.length, 4);
    const rows = aiConfig.listConfigs(db);
    const media = rows.filter((row) => row.provider === 'yinzi');
    assert.equal(media.length, 4);
    assert.equal(media.find((row) => row.service_type === 'video').api_key, 'v2');
    assert.equal(rows.find((row) => row.provider === 'other' && row.service_type === 'video').is_default, true);
  });
  it('requires all three keys', () => {
    assert.throws(() => service.definitions({ text_api_key: 't', image_api_key: 'i' }), /视频 Key/);
  });
});
