const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startCanvasHarness } = require('./helpers/canvasHarness');
const { uid } = require('../src/services/creationCanvas/store');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, predicate, timeout = 15000) { const start = Date.now(); let result; do { result = await fn(); if (predicate(result)) return result; await sleep(40); } while (Date.now() - start < timeout); throw new Error('Timed out: ' + JSON.stringify(result)); }
const call = (name, args, id = uid()) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const request = h => async (route, body, method = body ? 'POST' : 'GET') => { const r = await fetch(h.base + '/api/v1/creation-canvases' + route, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }); const v = await r.json(); if (!r.ok) throw Object.assign(Error(v.error.message), { status: r.status, code: v.error.code }); return v.data; };

test('canvas edits are atomic, scoped, secret-redacted, version-aware and idempotent', async () => {
  const h = await startCanvasHarness({ video: false }); const api = request(h);
  try {
    const c = await api('/', { title: 'Story' }), other = await api('/', { title: 'Other' });
    const op = { request_id: uid(), operations: [{ type: 'add_node', id: 'script', kind: 'text', data: { text: 'fixture-secret-never-export', settings: { api_key: 'hidden' } } }] };
    await api(`/${c.id}/operations`, op); assert.equal((await api(`/${c.id}/operations`, op)).reused, true);
    await assert.rejects(api(`/${c.id}/operations`, { ...op, operations: [] }), { code: 'REQUEST_CONFLICT' });
    await api(`/${c.id}/operations`, { request_id: uid(), operations: [{ type: 'update_node', id: 'script', expected_version: 1, data: { text: 'user edit' } }] });
    await assert.rejects(api(`/${c.id}/operations`, { request_id: uid(), operations: [{ type: 'add_node', id: 'temp', kind: 'text' }, { type: 'update_node', id: 'script', expected_version: 1, data: { text: 'stale agent' } }] }), { code: 'NODE_VERSION_CONFLICT' });
    const state = await api(`/${c.id}`); assert.equal(state.nodes.length, 1); assert.equal(state.nodes[0].data.text, 'user edit');
    assert.ok(!JSON.stringify(state).includes('hidden')); assert.ok(!JSON.stringify(state).includes('fixture-secret'));
    assert.equal((await api(`/${other.id}`)).nodes.length, 0);
    assert.ok(!JSON.stringify(await api('/models')).includes('fixture-secret'));
  } finally { await h.close(); }
});

test('real HTTP upload -> image generation -> dependent video uses generated reference and keeps explicit versions', { timeout: 90000 }, async () => {
  const h = await startCanvasHarness(); const api = request(h);
  try {
    const c = await api('/', { title: 'Integration' });
    const form = new FormData(); form.append('file', new Blob([h.image], { type: 'image/png' }), 'reference.png');
    const uploaded = (await (await fetch(h.base + '/api/v1/upload/reference-media', { method: 'POST', body: form })).json()).data;
    await api(`/${c.id}/operations`, { request_id: uid(), operations: [
      { type: 'add_node', id: 'ref', kind: 'image', data: { title: '参考', media: { local_path: uploaded.local_path, url: uploaded.url } } },
      { type: 'add_node', id: 'image', kind: 'image', data: { prompt: 'Create the character', settings: { image_config_id: h.configs.image.id, model: 'gpt-image-2', size: '1024x1024' } } },
      { type: 'add_node', id: 'video', kind: 'video', data: { prompt: 'Move the character', settings: { video_config_id: h.configs.video.id, model: h.configs.video.default_model, duration: 3 } } },
      { type: 'connect', source: 'ref', target: 'image' }, { type: 'connect', source: 'image', target: 'video', role: 'first_frame' },
    ] });
    const intent = { request_id: uid(), node_ids: ['video', 'image'] };
    const started = await api(`/${c.id}/generate`, intent);
    const job = await wait(() => api(`/${c.id}/jobs/${started.job_id}`), j => ['failed', 'completed'].includes(j.status), 45000);
    assert.equal(job.status, 'completed', JSON.stringify(job)); assert.equal(h.submissions.length, 2);
    assert.match(h.submissions.find(s => s.kind === 'image').body.image[0], /^data:image\//, 'Uploaded references must be transported as bytes, never a localhost URL');
    const video = h.submissions.find(s => s.kind === 'video').body;
    assert.equal(video.references[0].role, 'first_frame'); assert.ok(video.references[0].data_url);
    const repeated = await api(`/${c.id}/generate`, intent); assert.equal(repeated.job_id, started.job_id); assert.equal(h.submissions.length, 2);
    const second = await api(`/${c.id}/generate`, { request_id: uid(), node_ids: ['image'] });
    assert.equal((await wait(() => api(`/${c.id}/jobs/${second.job_id}`), j => ['failed', 'completed'].includes(j.status), 30000)).status, 'completed');
    const state = await api(`/${c.id}`); assert.equal(state.nodes.find(n => n.id === 'image').attempts.length, 2);
    const imageNode = state.nodes.find(n => n.id === 'image');
    await api(`/${c.id}/operations`, { request_id: uid(), operations: [{ type: 'select_attempt', id: 'image', expected_version: imageNode.version, attempt_id: imageNode.attempts[0].id }] });
    const gotMedia = await fetch(h.base + `/api/v1/creation-canvases/${c.id}/nodes/image/media`); assert.equal(gotMedia.status, 200);
  } finally { await h.close(); }
});

test('dedicated Agent uses the selected config, executes real tool loop and survives reload; stop prevents later tools', { timeout: 30000 }, async () => {
  let release; const deferred = new Promise(r => { release = r; });
  const h = await startCanvasHarness({ video: false, completion: async (body, count) => {
    if (body.model === 'stop-model') { await deferred; return { tool_calls: [call('edit_canvas', { operations: [{ type: 'add_node', id: 'should-not-exist', kind: 'text' }] })] }; }
    return count === 1 ? { content: '开始整理剧本', tool_calls: [call('edit_canvas', { operations: [{ type: 'add_node', id: 'agent-script', kind: 'text', data: { text: 'Opening shot' } }] })] } : { content: '剧本已添加到画布。' };
  } }); const api = request(h);
  try {
    const c = await api('/', {});
    await api(`/${c.id}`, { agent: { config_id: h.configs.text.id, model: 'canvas-fixture-text' } }, 'PATCH');
    const input = { request_id: uid(), message: '写开场' }, sent = await api(`/${c.id}/messages`, input);
    assert.equal((await api(`/${c.id}/messages`, input)).run_id, sent.run_id);
    const run = await wait(() => api(`/${c.id}/runs/${sent.run_id}`), r => !['queued', 'running'].includes(r.status));
    assert.equal(run.status, 'completed', JSON.stringify(run)); assert.equal((await api(`/${c.id}`)).nodes[0].id, 'agent-script');
    assert.equal(h.completions.length, 2); assert.equal(h.completions[0].authorization, 'Bearer fixture-secret-never-export');
    assert.ok(!JSON.stringify(await api(`/${c.id}/messages`)).includes('fixture-secret'));
    await api(`/${c.id}`, { agent: { model: 'stop-model' } }, 'PATCH');
    const stopped = await api(`/${c.id}/messages`, { request_id: uid(), message: '稍后停止' });
    await wait(() => h.completions.length, n => n === 3);
    await api(`/${c.id}/runs/${stopped.run_id}/stop`, {}); release();
    await sleep(100); assert.ok(!(await api(`/${c.id}`)).nodes.some(n => n.id === 'should-not-exist'));
    assert.equal((await api(`/${c.id}/runs/${stopped.run_id}`)).status, 'cancelled');
  } finally { release(); await h.close(); }
});

test('JSON-action compatibility and empty/provider failures are visible without fabricated completion', async () => {
  const h = await startCanvasHarness({ video: false, completion: (body, count) => {
    if (body.model === 'empty') return { content: '' };
    if (body.model === 'error') return { httpStatus: 503, body: { error: { message: 'fixture-secret-never-export unavailable' } } };
    return { content: JSON.stringify(count === 1 ? { message: '添加场景', actions: [{ name: 'edit_canvas', arguments: { operations: [{ type: 'add_node', kind: 'text', data: { title: '场景' } }] } }] } : { message: '已添加', actions: [] }) };
  } }); const api = request(h);
  try {
    const c = await api('/', {});
    for (const model of ['json', 'empty', 'error']) {
      await api(`/${c.id}`, { agent: { config_id: h.configs.text.id, model, mode: model === 'json' ? 'json_actions' : 'tools' } }, 'PATCH');
      const r = await api(`/${c.id}/messages`, { request_id: uid(), message: model });
      const done = await wait(() => api(`/${c.id}/runs/${r.run_id}`), r => !['queued', 'running'].includes(r.status));
      assert.equal(done.status, model === 'json' ? 'completed' : 'failed');
      assert.ok(!JSON.stringify(done).includes('fixture-secret'));
    }
    assert.equal((await api(`/${c.id}`)).nodes.length, 1);
  } finally { await h.close(); }
});
