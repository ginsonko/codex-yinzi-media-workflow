const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { startCanvasHarness } = require('./helpers/canvasHarness');
const { uid } = require('../src/services/creationCanvas/store');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, predicate, timeout = 15000) { const start = Date.now(); let result; do { result = await fn(); if (predicate(result)) return result; await sleep(40); } while (Date.now() - start < timeout); throw new Error('Timed out: ' + JSON.stringify(result)); }
const call = (name, args, id = uid()) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const request = h => async (route, body, method = body ? 'POST' : 'GET') => { const r = await fetch(h.base + '/api/v1/creation-canvases' + route, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }); const v = await r.json(); if (!r.ok) throw Object.assign(Error(v.error.message), { status: r.status, code: v.error.code }); return v.data; };

function addClip(h, nodes) {
  fs.mkdirSync(path.join(h.storage, 'fixtures'), { recursive: true });
  fs.copyFileSync(h.videoPath, path.join(h.storage, 'fixtures', 'clip1.mp4'));
  return nodes;
}

test('extract_frame turns a finished clip boundary into an image node, idempotently', async () => {
  const h = await startCanvasHarness(); const api = request(h);
  try {
    const c = await api('/', { title: 'Drama' });
    addClip(h);
    await api(`/${c.id}/operations`, { request_id: uid(), operations: [{ type: 'add_node', id: 'shot1', kind: 'video', data: { title: '第一镜', media: { local_path: 'fixtures/clip1.mp4', url: '/static/fixtures/clip1.mp4', type: 'video' } } }] });
    const requestId = uid();
    const extracted = await api(`/${c.id}/nodes/shot1/extract-frame`, { request_id: requestId });
    assert.equal(extracted.position, 'last');
    assert.equal(extracted.node.id, 'frame-shot1-last');
    assert.equal(extracted.node.kind, 'image');
    assert.equal(extracted.node.data.provenance.source_node_id, 'shot1');
    const file = path.join(h.storage, 'canvas-frames', c.id, 'shot1-last.png');
    const metadata = await sharp(file).metadata();
    assert.equal(metadata.width, 320); assert.equal(metadata.height, 180);
    const replay = await api(`/${c.id}/nodes/shot1/extract-frame`, { request_id: requestId });
    assert.equal(replay.reused, true);
    assert.equal(replay.node.id, 'frame-shot1-last');
    assert.equal((await api(`/${c.id}`)).nodes.find(n => n.id === 'frame-shot1-last').version, 1, 'a replayed request must not edit again');
    const again = await api(`/${c.id}/nodes/shot1/extract-frame`, { request_id: uid() });
    assert.equal(again.node.id, 'frame-shot1-last');
    let state = await api(`/${c.id}`);
    assert.equal(state.nodes.filter(n => n.id === 'frame-shot1-last').length, 1);
    assert.equal(state.nodes.find(n => n.id === 'frame-shot1-last').version, 2, 're-extract updates the same node');
    const first = await api(`/${c.id}/nodes/shot1/extract-frame`, { request_id: uid(), position: 'first' });
    assert.equal(first.node.id, 'frame-shot1-first');
    state = await api(`/${c.id}`);
    assert.equal(state.nodes.length, 3);
    await assert.rejects(api(`/${c.id}/nodes/nope/extract-frame`, { request_id: uid() }), { code: 'NODE_NOT_FOUND' });
    await api(`/${c.id}/operations`, { request_id: uid(), operations: [{ type: 'add_node', id: 'script', kind: 'text', data: { text: '剧本' } }] });
    await assert.rejects(api(`/${c.id}/nodes/script/extract-frame`, { request_id: uid() }), { code: 'FRAME_SOURCE_NOT_VIDEO' });
    await api(`/${c.id}/operations`, { request_id: uid(), operations: [{ type: 'add_node', id: 'shot2', kind: 'video', data: { title: '第二镜' } }] });
    await assert.rejects(api(`/${c.id}/nodes/shot2/extract-frame`, { request_id: uid() }), { code: 'MEDIA_FILE_MISSING' });
  } finally { await h.close(); }
});

test('extracted tail frame feeds the next shot as a strict first frame', { timeout: 90000 }, async () => {
  const h = await startCanvasHarness(); const api = request(h);
  try {
    const c = await api('/', { title: 'Continuity' });
    addClip(h);
    await api(`/${c.id}/operations`, { request_id: uid(), operations: [
      { type: 'add_node', id: 'shot1', kind: 'video', data: { title: '第一镜', media: { local_path: 'fixtures/clip1.mp4', url: '/static/fixtures/clip1.mp4', type: 'video' } } },
      { type: 'add_node', id: 'shot2', kind: 'video', data: { title: '第二镜', prompt: '继续动作', settings: { video_config_id: h.configs.video.id, model: h.configs.video.default_model, duration: 5 } } },
    ] });
    await api(`/${c.id}/nodes/shot1/extract-frame`, { request_id: uid() });
    await api(`/${c.id}/operations`, { request_id: uid(), operations: [{ type: 'connect', source: 'frame-shot1-last', target: 'shot2', role: 'first_frame' }] });
    const started = await api(`/${c.id}/generate`, { request_id: uid(), node_ids: ['shot2'] });
    const job = await wait(() => api(`/${c.id}/jobs/${started.job_id}`), j => ['failed', 'completed'].includes(j.status), 45000);
    assert.equal(job.status, 'completed', JSON.stringify(job));
    const video = h.submissions.find(s => s.kind === 'video').body;
    assert.equal(video.references[0].role, 'first_frame');
    assert.ok(video.references[0].data_url, 'the extracted frame must travel as bytes');
  } finally { await h.close(); }
});

test('the dedicated Agent can call extract_frame as a tool', { timeout: 30000 }, async () => {
  const h = await startCanvasHarness({ completion: (body, count) => count === 1
    ? { content: '提取上一镜尾帧', tool_calls: [call('extract_frame', { node_id: 'shot1' })] }
    : { content: '尾帧已提取，可作下一镜首帧。' } });
  const api = request(h);
  try {
    const c = await api('/', {});
    addClip(h);
    await api(`/${c.id}/operations`, { request_id: uid(), operations: [{ type: 'add_node', id: 'shot1', kind: 'video', data: { title: '第一镜', media: { local_path: 'fixtures/clip1.mp4', url: '/static/fixtures/clip1.mp4', type: 'video' } } }] });
    const tools = await api('/tools');
    assert.ok(tools.tools.some(t => t.function.name === 'extract_frame'));
    await api(`/${c.id}`, { agent: { config_id: h.configs.text.id, model: 'canvas-fixture-text' } }, 'PATCH');
    const sent = await api(`/${c.id}/messages`, { request_id: uid(), message: '准备第二镜的首帧' });
    const run = await wait(() => api(`/${c.id}/runs/${sent.run_id}`), r => !['queued', 'running'].includes(r.status));
    assert.equal(run.status, 'completed', JSON.stringify(run));
    const state = await api(`/${c.id}`);
    assert.ok(state.nodes.some(n => n.id === 'frame-shot1-last' && n.data.media?.local_path));
  } finally { await h.close(); }
});
