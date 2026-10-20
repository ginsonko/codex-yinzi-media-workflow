'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const d = require('../src/services/videoDurationSupport');

const SITE_SUPPORT = [{ seconds: 5, count: 6 }, { seconds: 10, count: 6 }, { seconds: 15, count: 5 }, { seconds: 30, count: 3 }];
const routes = [
  { model: 'route-a', automatic_eligible: true, capabilities: { duration_mode: 'enumerated', allowed_durations: [5, 10, 15] } },
  { model: 'route-b', automatic_eligible: true, capabilities: { duration_mode: 'range', duration_min: 4, duration_max: 15 } },
  { model: 'route-c', capabilities: { automatic_eligible: true, duration_mode: 'fixed', fixed_duration_seconds: 30 } },
  { model: 'manual-only', automatic_eligible: false, capabilities: { duration_mode: 'fixed', fixed_duration_seconds: 60 } },
];
function config(models, extra = {}) {
  return { id: 1, provider: 'yinzi', api_protocol: 'yinzi', base_url: 'https://relay.example/v1', api_key: 'k-' + Math.random(),
    model: ['smart-video', 'Seedance 2.0-720', 'mystery-model'], default_model: 'smart-video',
    settings: JSON.stringify({ model_catalog_snapshot: { models } }), ...extra };
}
const offline = { fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) };

beforeEach(() => d.resetDurationSupportCache());

test('duration rules read enumerated, fixed and range contracts and stay unknown without data', () => {
  assert.deepEqual(d.durationRule({ duration_mode: 'enumerated', allowed_durations: [15, 5, 10] }), { allowed: [5, 10, 15] });
  assert.deepEqual(d.durationRule({ duration_mode: 'fixed', fixed_duration_seconds: 30, duration_min: 30 }), { allowed: [30] });
  assert.deepEqual(d.durationRule({ allowed_durations: [5, 10] }), { allowed: [5, 10] }, 'a list without a mode is still a list');
  assert.deepEqual(d.durationRule({ duration_mode: 'free', duration_min: 5, duration_max: 15, allowed_durations: null }), { min: 5, max: 15 });
  assert.equal(d.durationRule({ max_images: 3 }), null);
  assert.equal(d.ruleAccepts(null, 10), null);
  assert.equal(d.ruleAccepts({ min: 5, max: 15 }, 8), true);
  assert.equal(d.ruleAccepts({ allowed: [5, 10, 15] }, 8), false);
});

test('site duration_support is found in any envelope and becomes an actionable error hint', () => {
  const error = { error: { message: 'duration 90 unsupported', code: 'unsupported_video_parameters', data: { duration_support: SITE_SUPPORT, recommended_duration: 10 } } };
  assert.equal(d.durationErrorHint(error), '可用时长：5 秒 6 个、10 秒 6 个、15 秒 5 个、30 秒 3 个；建议改为 10 秒');
  assert.equal(d.durationErrorHint({ data: { duration_hint: '智能视频最长 30 秒', recommended_duration: 15 } }), '智能视频最长 30 秒；建议改为 15 秒');
  assert.equal(d.durationErrorHint({ error: { message: 'other failure' } }), '');
  const listed = d.extractDurationSupport({ data: { models: [{ model: 'route-a', duration_support: [[5, 1]] }, { model: 'smart-video', duration_support: [[5, 6], [10, 6]], recommended_duration: 10 }] } });
  assert.deepEqual(listed, { duration_support: [{ seconds: 5, count: 6 }, { seconds: 10, count: 6 }], recommended_duration: 10 });
});

test('route count lookup: listed is exact, beyond the supported range is zero, an unlisted middle value is unknown', () => {
  assert.equal(d.supportCountFor(SITE_SUPPORT, 30), 3);
  assert.equal(d.supportCountFor(SITE_SUPPORT, 90), 0);
  assert.equal(d.supportCountFor(SITE_SUPPORT, 8), null);
  assert.equal(d.recommendFromSupport(SITE_SUPPORT), 5);
});

test('smart-video prefers site support published in the capability catalog', async () => {
  const cfg = config([...routes, { model: 'smart-video', capabilities: { duration_support: SITE_SUPPORT, recommended_duration: 10 } }]);
  const info = await d.modelDurationInfo(cfg, 'smart-video', offline);
  assert.equal(info.source, 'site_catalog');
  assert.equal(info.recommended_duration, 10);
  const blocked = await d.checkVideoDuration(cfg, 'smart-video', 90, offline);
  assert.equal(blocked.supported, false);
  assert.match(blocked.message, /没有支持 90 秒的路由.*建议改为 10 秒/);
  assert.equal((await d.checkVideoDuration(cfg, 'smart-video', 30, offline)).supported, true);
  assert.equal((await d.checkVideoDuration(cfg, 'smart-video', 8, offline)).supported, null);
});

test('smart-video reads the site media capabilities once and caches it', async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, 'https://relay.example/api/media/capabilities');
    assert.match(options.headers.Authorization, /^Bearer k-/);
    return { ok: true, json: async () => ({ data: { video: { 'smart-video': { duration_support: SITE_SUPPORT, recommended_duration: 15 } } } }) };
  };
  const cfg = config(routes);
  const first = await d.smartVideoSupport(cfg, 'smart-video', { fetchImpl });
  const second = await d.smartVideoSupport(cfg, 'smart-video', { fetchImpl });
  assert.equal(first.source, 'site');
  assert.equal(second.recommended_duration, 15);
  assert.equal(calls, 1);
});

test('without site data smart-video falls back to the saved automatic routes, which only block beyond the longest route', async () => {
  const cfg = config(routes);
  const info = await d.modelDurationInfo(cfg, 'smart-video', offline);
  assert.equal(info.source, 'catalog_routes');
  assert.deepEqual(info.duration_support, [{ seconds: 4, count: 1 }, { seconds: 5, count: 2 }, { seconds: 10, count: 2 }, { seconds: 15, count: 2 }, { seconds: 30, count: 1 }]);
  assert.equal((await d.checkVideoDuration(cfg, 'smart-video', 90, offline)).supported, false);
  assert.equal((await d.checkVideoDuration(cfg, 'smart-video', 20, offline)).supported, null, 'a gap inside the estimate never blocks');
  assert.equal((await d.checkVideoDuration(config([]), 'smart-video', 90, offline)).supported, null, 'no data means unknown');
});

test('a site error teaches the support of that route for later checks', async () => {
  const cfg = config([]);
  d.rememberObservedSupport(cfg, 'smart-video', { error: { code: 'unsupported_video_parameters', data: { duration_support: SITE_SUPPORT, recommended_duration: 10 } } });
  const check = await d.checkVideoDuration(cfg, 'smart-video', 60, offline);
  assert.equal(check.supported, false);
  assert.equal(check.source, 'site_error');
});

test('an unsupported-duration rejection carries the supported durations into the visible error', async () => {
  const { callYinziVideoApi } = require('../src/services/videoClient');
  const originalFetch = global.fetch;
  const cfg = { base_url: 'https://relay.example/v1', api_key: 'not-a-real-key', endpoint: '/videos', provider: 'yinzi', api_protocol: 'yinzi' };
  global.fetch = async () => ({ ok: false, status: 400, headers: { get: () => null },
    text: async () => JSON.stringify({ error: { message: '没有可提供 90 秒视频的路由', code: 'unsupported_video_parameters', data: { duration_support: SITE_SUPPORT, recommended_duration: 10 } } }) });
  try {
    const log = { info() {}, warn() {}, error() {} };
    const result = await callYinziVideoApi(null, cfg, log, { model: 'smart-video', prompt: 'test', duration: 90, aspect_ratio: '16:9', video_gen_id: 1 });
    assert.equal(result.submission_status, 'rejected');
    assert.match(result.error, /HTTP 400/);
    assert.match(result.error, /可用时长：5 秒 6 个、10 秒 6 个、15 秒 5 个、30 秒 3 个；建议改为 10 秒/);
    assert.equal((await d.checkVideoDuration(cfg, 'smart-video', 90, offline)).supported, false, 'the rejection is remembered');
  } finally { global.fetch = originalFetch; }
});

test('the capability catalog keeps smart-video duration support', () => {
  const { normalizeYinziCapabilityCatalog } = require('../src/services/yinziService');
  const catalog = normalizeYinziCapabilityCatalog({ data: [{ model: 'smart-video', endpoint_types: ['openai-video'],
    capabilities: { generation: { duration: { duration_support: SITE_SUPPORT, recommended_duration: 10 } } } }] }, 'fixture');
  assert.deepEqual(catalog.video[0].capabilities.duration_support, SITE_SUPPORT);
  assert.equal(catalog.video[0].capabilities.recommended_duration, 10);
});

test('concrete models follow their resolved contract; unknown models stay unknown', async () => {
  const cfg = config(routes);
  const blocked = await d.checkVideoDuration(cfg, 'Seedance 2.0-720', 30, offline);
  assert.equal(blocked.supported, false);
  assert.equal(blocked.recommended_duration, 15);
  assert.equal((await d.checkVideoDuration(cfg, 'Seedance 2.0-720', 10, offline)).supported, true);
  assert.equal((await d.checkVideoDuration(cfg, 'mystery-model', 90, offline)).supported, null);
  assert.equal((await d.checkVideoDuration({ ...cfg, provider: 'openai', api_protocol: 'openai' }, 'Seedance 2.0-720', 30, offline)).supported, null);
  const summary = await d.configDurationSummary(cfg, offline);
  assert.equal(summary['Seedance 2.0-720'], '5 / 10 / 15 秒');
  assert.equal(summary['mystery-model'], undefined);
  assert.equal(summary['smart-video'].source, '本地路由估算');
});
