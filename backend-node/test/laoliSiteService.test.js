const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const service = require('../src/services/laoliSiteService');
const aiConfig = require('../src/services/aiConfigService');
const createRoutes = require('../src/routes/aiConfig');

const log = { info() {}, warn() {}, error() {} };
let db;
beforeEach(() => { db = new Database(':memory:'); runMigrationsAndEnsure(db); });

describe('老李 NewAPI 三 Key 兼容配置', () => {
  it('限制站点地址并归一化 /v1', () => {
    assert.equal(service.normalizeLaoliBaseUrl('https://video.laoliimage2.win'), 'https://video.laoliimage2.win/v1');
    assert.equal(service.normalizeLaoliBaseUrl('https://video.laoliimage2.win/v1/'), 'https://video.laoliimage2.win/v1');
    assert.throws(() => service.normalizeLaoliBaseUrl('https://api.yinziapi.top/v1'), /必须是/);
    assert.throws(() => service.normalizeLaoliBaseUrl('http://video.laoliimage2.win/v1'), /HTTPS/);
  });

  it('保持三类 Key 隔离并预置 3.5/3.0 别名能力', () => {
    const defs = service.definitions({
      text_base_url: 'https://text.example/v1',
      image_base_url: 'https://video.laoliimage2.win/v1',
      video_base_url: 'https://video.laoliimage2.win/v1',
      text_api_key: 't', image_api_key: 'i', video_api_key: 'v',
    });
    assert.equal(defs.length, 4);
    assert.equal(defs[0].api_key, 't');
    assert.equal(defs[0].base_url, 'https://text.example/v1');
    assert.equal(defs[1].api_key, 'i');
    assert.equal(defs[2].api_key, 'i');
    assert.equal(defs[1].base_url, 'https://video.laoliimage2.win/v1');
    assert.equal(defs[2].base_url, 'https://video.laoliimage2.win/v1');
    assert.equal(defs[3].api_key, 'v');
    assert.equal(defs[3].base_url, 'https://video.laoliimage2.win/v1');
    assert.equal(defs[3].default_model, '3.5');
    const settings = JSON.parse(defs[3].settings);
    assert.deepEqual(settings.model_capabilities['3.5'].allowed_durations, [30]);
    assert.deepEqual(settings.model_capabilities['3.0'].allowed_durations, [5, 10, 15]);
  });

  it('分别保存三组 URL，并且旧 base_url 只兼容迁移到媒体服务', () => {
    const defs = service.definitions({
      text_base_url: 'https://text.example/v1',
      image_base_url: 'https://video.laoliimage2.win/v1',
      video_base_url: 'https://video.laoliimage2.win/v1',
      text_api_key: 't', image_api_key: 'i', video_api_key: 'v',
    });
    assert.notEqual(defs[0].base_url, defs[1].base_url);
    assert.equal(defs[1].base_url, defs[2].base_url);
    assert.throws(() => service.definitions({ base_url: 'https://video.laoliimage2.win/v1', text_api_key: 't', image_api_key: 'i', video_api_key: 'v' }), /文本服务 Base URL/);
    const migrated = service.definitions({ base_url: 'https://video.laoliimage2.win/v1', text_base_url: 'https://text.example/v1', text_api_key: 't', image_api_key: 'i', video_api_key: 'v' });
    assert.equal(migrated[0].base_url, 'https://text.example/v1');
    assert.equal(migrated[1].base_url, 'https://video.laoliimage2.win/v1');
    assert.equal(migrated[3].base_url, 'https://video.laoliimage2.win/v1');
  });

  it('setup 幂等更新自己的 profile，不覆盖其它 provider 默认配置', () => {
    aiConfig.createConfig(db, log, { service_type: 'video', provider: 'other', name: 'other', base_url: 'https://other.example/v1', api_key: 'x', model: ['x'], default_model: 'x', is_default: true });
    const input = { text_base_url: 'https://text.example/v1', image_base_url: 'https://video.laoliimage2.win/v1', video_base_url: 'https://video.laoliimage2.win/v1' };
    service.setup(db, log, { ...input, text_api_key: 't', image_api_key: 'i', video_api_key: 'v' });
    const result = service.setup(db, log, { ...input, text_api_key: 't2', image_api_key: 'i2', video_api_key: 'v2' });
    assert.equal(result.configured.length, 4);
    const rows = aiConfig.listConfigs(db);
    assert.equal(rows.filter((row) => row.settings?.includes('laoli_newapi_seedance_alias_v1')).length, 4);
    assert.equal(rows.find((row) => row.provider === 'other').is_default, true);
    const video = rows.find((row) => row.service_type === 'video' && row.settings?.includes('laoli_newapi_seedance_alias_v1'));
    assert.equal(video.api_key, 'v2');
    assert.equal(aiConfig.toPublicConfig(video).api_key, '');
  });

  it('路由返回脱敏结果并拒绝缺少 Key', async () => {
    const routes = createRoutes(db, log, {});
    const bad = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(v) { this.body = v; return this; } };
    await routes.setupLaoli({ body: { text_base_url: 'https://text.example/v1', image_base_url: 'https://video.laoliimage2.win/v1', video_base_url: 'https://video.laoliimage2.win/v1', text_api_key: 't', image_api_key: 'i' } }, bad);
    assert.equal(bad.statusCode, 400);
    assert.match(JSON.stringify(bad.body), /视频 Key/);
  });

  it('缺少文本地址或任一媒体地址时给出具体字段错误', async () => {
    assert.throws(() => service.definitions({ text_api_key: 't', image_api_key: 'i', video_api_key: 'v' }), /文本服务 Base URL/);
    assert.throws(() => service.definitions({ text_base_url: 'https://text.example/v1', image_base_url: '', video_base_url: 'https://video.laoliimage2.win/v1', text_api_key: 't', image_api_key: 'i', video_api_key: 'v' }), /图片服务 Base URL/);
  });

  it('返回每类服务的独立地址摘要且不泄露凭据', () => {
    const result = service.setup(db, log, {
      text_base_url: 'https://text.example/v1',
      image_base_url: 'https://video.laoliimage2.win/v1',
      video_base_url: 'https://video.laoliimage2.win/v1',
      text_api_key: 'text-secret', image_api_key: 'image-secret', video_api_key: 'video-secret',
    });
    assert.equal(result.text_base_url, 'https://text.example/v1');
    assert.equal(result.image_base_url, 'https://video.laoliimage2.win/v1');
    assert.equal(result.video_base_url, 'https://video.laoliimage2.win/v1');
    assert.equal(JSON.stringify(result).includes('secret'), false);
  });
});
