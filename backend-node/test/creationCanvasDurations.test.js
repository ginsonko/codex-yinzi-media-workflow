const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startCanvasHarness } = require('./helpers/canvasHarness');
const { uid } = require('../src/services/creationCanvas/store');
const aiConfigService = require('../src/services/aiConfigService');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, predicate, timeout = 15000) { const start = Date.now(); let result; do { result = await fn(); if (predicate(result)) return result; await sleep(40); } while (Date.now() - start < timeout); throw new Error('Timed out: ' + JSON.stringify(result)); }
const call = (name, args, id = uid()) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const request = h => async (route, body, method = body ? 'POST' : 'GET') => { const r = await fetch(h.base + '/api/v1/creation-canvases' + route, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }); const v = await r.json(); if (!r.ok) throw Object.assign(Error(v.error.message), { status: r.status, code: v.error.code }); return v.data; };
const SITE_SUPPORT = [{ seconds: 5, count: 6 }, { seconds: 10, count: 6 }, { seconds: 15, count: 5 }, { seconds: 30, count: 3 }];

function addRoutedVideoConfig(h) {
  return aiConfigService.createConfig(h.db, h.log, { service_type: 'video', provider: 'yinzi', api_protocol: 'yinzi', name: '时长验收 video',
    base_url: h.base + '/provider/v1', api_key: 'fixture-secret-never-export', model: ['smart-video', 'Seedance 2.0-720', 'canvas-fixture-video'],
    default_model: 'smart-video', endpoint: '/videos', is_default: false,
    settings: JSON.stringify({ model_catalog_snapshot: { models: [{ model: 'smart-video', capabilities: { duration_support: SITE_SUPPORT, recommended_duration: 10 } }] } }) });
}
function videoNode(id, config, model, duration) {
  return { type: 'add_node', id, kind: 'video', data: { title: id, prompt: 'shot', settings: { video_config_id: config.id, model, duration } } };
}
async function runAgent(h, api, canvasId, calls) {
  const sent = await api(`/${canvasId}/messages`, { request_id: uid(), message: '生成视频' });
  const run = await wait(() => api(`/${canvasId}/runs/${sent.run_id}`), r => !['queued', 'running'].includes(r.status));
  assert.equal(run.status, 'completed', JSON.stringify(run));
  const toolResults = h.completions.at(-1).request.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
  assert.equal(toolResults.length, calls);
  return toolResults;
}

test('list_models gives the assistant per-model single-generation durations and smart-video route counts', async () => {
  const h = await startCanvasHarness({ video: false, completion: (_body, count) => count === 1 ? { tool_calls: [call('list_models', {})] } : { content: '已读取模型' } });
  const api = request(h);
  try {
    const config = addRoutedVideoConfig(h);
    const c = await api('/', {});
    const [models] = await runAgent(h, api, c.id, 1);
    const video = models.items.find(item => item.id === config.id);
    assert.deepEqual(video.video_durations['smart-video'], { duration_support: SITE_SUPPORT, recommended_duration: 10, source: '站点' });
    assert.equal(video.video_durations['Seedance 2.0-720'], '5 / 10 / 15 秒');
    assert.equal(video.video_durations['canvas-fixture-video'], undefined, 'unknown models carry no invented duration');
    assert.ok(!JSON.stringify(models).includes('fixture-secret'));
    assert.match(h.completions[0].request.messages[0].content, /成片总时长.*不是单个节点的时长/);
  } finally { await h.close(); }
});

test('assistant generation with a duration no route supports is stopped with the fix; supported and unknown durations proceed', async () => {
  let config;
  const h = await startCanvasHarness({ completion: (_body, count) => count === 1 ? { tool_calls: [
    call('generate_nodes', { node_ids: ['long-smart'] }),
    call('generate_nodes', { node_ids: ['long-seedance'] }),
    call('generate_nodes', { node_ids: ['ok-smart'] }),
    call('generate_nodes', { node_ids: ['unknown-model'] }),
  ] } : { content: '已处理' } });
  const api = request(h);
  try {
    config = addRoutedVideoConfig(h);
    const c = await api('/', {});
    await api(`/${c.id}/operations`, { request_id: uid(), operations: [
      videoNode('long-smart', config, 'smart-video', 90), videoNode('long-seedance', config, 'Seedance 2.0-720', 30),
      videoNode('ok-smart', config, 'smart-video', 10), videoNode('unknown-model', config, 'canvas-fixture-video', 90),
    ] });
    const [smart, seedance, okSmart, unknown] = await runAgent(h, api, c.id, 4);
    assert.equal(smart.code, 'VIDEO_DURATION_UNSUPPORTED');
    assert.match(smart.error, /没有支持 90 秒的路由.*建议改为 10 秒/);
    assert.match(smart.error, /export_video/);
    assert.equal(smart.details.nodes[0].recommended_duration, 10);
    assert.equal(seedance.code, 'VIDEO_DURATION_UNSUPPORTED');
    assert.match(seedance.error, /5 \/ 10 \/ 15 秒.*建议改为 15 秒/);
    assert.ok(okSmart.job_id, JSON.stringify(okSmart));
    assert.ok(unknown.job_id, 'an unknown capability never blocks: ' + JSON.stringify(unknown));
    const state = await api(`/${c.id}`);
    assert.equal(state.nodes.find(n => n.id === 'long-smart').attempts.length, 0, 'nothing was submitted for the blocked node');
    assert.equal(state.jobs.length, 2);
    for (const job of state.jobs) await wait(() => api(`/${c.id}/jobs/${job.id}`), j => ['failed', 'completed'].includes(j.status), 45000);
  } finally { await h.close(); }
});

test('a manual generation with the same unsupported duration is not blocked', async () => {
  const h = await startCanvasHarness();
  const api = request(h);
  try {
    const config = addRoutedVideoConfig(h);
    const c = await api('/', {});
    await api(`/${c.id}/operations`, { request_id: uid(), operations: [videoNode('manual', config, 'smart-video', 90)] });
    const started = await api(`/${c.id}/generate`, { request_id: uid(), node_ids: ['manual'] });
    assert.ok(started.job_id);
    assert.equal((await wait(() => api(`/${c.id}/jobs/${started.job_id}`), j => ['failed', 'completed'].includes(j.status), 45000)).status, 'completed');
    assert.equal(h.submissions.at(-1).body.duration, 90, 'the user request is submitted as asked');
    const capabilities = await (await fetch(`${h.base}/api/v1/ai-configs/${config.id}/model-capabilities`)).json();
    const smart = capabilities.data.models.find(m => m.model === 'smart-video');
    assert.equal(smart.duration_info.recommended_duration, 10);
    assert.deepEqual(capabilities.data.models.find(m => m.model === 'Seedance 2.0-720').duration_info.durations, [5, 10, 15]);
  } finally { await h.close(); }
});
