const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { startCanvasHarness } = require('./helpers/canvasHarness');
const { createCanvasService } = require('../src/services/creationCanvas/service');
const { createCanvasAgent } = require('../src/services/creationCanvas/agent');
const { uid } = require('../src/services/creationCanvas/store');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, predicate, timeout = 20000) { const start = Date.now(); let value; do { value = await fn(); if (predicate(value)) return value; await sleep(30); } while (Date.now() - start < timeout); throw Error('Timeout: ' + JSON.stringify(value)); }
const edits = (s, id, operations) => s.operate(id, { request_id: uid(), operations });
function batches() {
  const rows = new Map(); let created = 0;
  return { rows, get created() { return created; }, create() { const row = { id: 'batch-' + ++created, items: [{ id: 'item-' + created, status: 'processing' }] }; rows.set(row.id, row); return row; },
    get: id => rows.get(id), pause() {}, resume() {}, done(id, suffix) { Object.assign(rows.get(id).items[0], { status: 'completed', local_path: suffix + '.png', media_url: 'https://fixture.invalid/' + suffix + '.png' }); } };
}

test('canvas videos default to 720p unless the node or the model name sets a resolution', () => {
  const { defaultVideoResolution } = require('../src/services/creationCanvas/graph');
  assert.equal(defaultVideoResolution({}), '720p');
  assert.equal(defaultVideoResolution({ model: 'smart-video' }), '720p');
  assert.equal(defaultVideoResolution({ resolution: '1080p' }), '1080p');
  assert.equal(defaultVideoResolution({ model: 'Kling VIDEO 3.0 Omni-1080p' }), undefined);
  assert.equal(defaultVideoResolution({ model: 'mg-seedance2.0 -720p fast' }), undefined);
  assert.equal(defaultVideoResolution({ model: 'veo-4k' }), undefined);
});

test('download states and deduplicated completion survive restart and reach assistant context', async () => {
  const h = await startCanvasHarness({ video: false }); await h.canvas.close();
  const b = batches(); let s = createCanvasService(h.db, h.cfg, h.log, b, { terminalPollMs: 0 }), agent;
  try {
    const c = s.create(); edits(s, c.id, [{ type: 'add_node', id: 'video', kind: 'video', data: { title: '原视频', prompt: 'test' } }]);
    const job = s.generate(c.id, { request_id: uid(), node_ids: ['video'] }); s.pump();
    const item = b.rows.get('batch-1').items[0];
    Object.assign(item, { status: 'needs_review', generation_status: 'completed', download_status: 'failed', download_error: 'timeout' });
    s.pump(); s.pump();
    assert.equal(s.store.read('job', job.job_id).status, 'running');
    assert.equal(s.get(c.id).nodes[0].attempts[0].delivery.download_status, 'failed');
    assert.equal(s.messages(c.id).filter(m => m.phase === 'download_recovery').length, 1);
    Object.assign(item, { status: 'processing', download_status: 'downloading', progress_message: '分段下载 2/3 MB' }); s.pump();
    Object.assign(item, { status: 'completed', download_status: 'completed', local_path: 'videos/original.mp4', download_url: '/api/v1/assets/1/download' });
    s.pump(); await s.stop(); s = createCanvasService(h.db, h.cfg, h.log, b, { terminalPollMs: 0 }); s.pump(); s.pump();
    const notices = s.messages(c.id).filter(m => m.phase === 'completed');
    assert.equal(notices.length, 1); assert.equal(notices[0].results[0].url, '/api/v1/assets/1/download');
    assert.equal(b.created, 1);
    s.configure(c.id, { agent: { config_id: h.configs.text.id } }); agent = createCanvasAgent(s);
    const run = agent.send(c.id, { request_id: uid(), message: '查询现有结果，不生成' });
    await wait(() => agent.get(c.id, run.run_id), r => r.status === 'completed');
    const request = h.completions.at(-1).request;
    assert.ok(request.messages.some(m => m.content?.includes('后台实际交付通知') && m.content.includes('已生成并下载到本地')));
    assert.ok(request.messages[0].content.includes('videos/original.mp4'));
    assert.equal(b.created, 1);
  } finally { await agent?.close(); await s.stop(); await h.close(); }
});
test('library and real research report imports preserve sources, pagination and idempotency', async () => {
  const h = await startCanvasHarness({ video: false }); await h.canvas.close();
  const research = require('../src/services/productResearchJobs').createResearchJobs({ root: path.join(h.root, 'research'), sessionManager: {} });
  const s = createCanvasService(h.db,h.cfg,h.log,batches(),{research});
  try {
    fs.writeFileSync(path.join(h.storage,'library.png'),h.image);
    const asset = require('../src/services/assetService').create(h.db,h.log,{name:'角色素材',type:'image',local_path:'library.png'},h.cfg);
    const {job} = research.create({request_key:'canvas-import',mode:'import',query:{product:'帆布包',platforms:['douyin']},items:Array.from({length:101},(_,i)=>({id:'video'+i,platform:'douyin',url:'https://www.douyin.com/video/'+i,title:'示例参考',observed_at:'2026-10-10T10:00:00Z',metrics:{likes:i},evidence:{kind:'platform_page'},analysis_basis:'metadata_only'}))});
    await research.settle(job.id);
    const c=s.create(),input={request_id:uid(),asset_ids:[asset.id]};s.importAssets(c.id,input);s.importAssets(c.id,input);
    const request={request_id:uid(),job_id:job.id};s.importResearch(c.id,request);s.importResearch(c.id,request);
    const nodes=s.get(c.id).nodes;assert.equal(nodes.length,2);
    assert.equal(nodes[0].data.provenance.asset_id,asset.id);assert.equal(s.mediaFile(c.id,nodes[0].id).size,h.image.length);
    assert.equal(nodes[1].data.title,'研究：帆布包');assert.equal(nodes[1].data.provenance.imported,100);
    assert.equal(nodes[1].data.provenance.total,101);assert.equal(nodes[1].data.provenance.next_offset,100);
    assert.equal(JSON.parse(nodes[1].data.text).items[0].analysis_basis,'metadata_only');
  } finally { await s.stop(); await h.close(); }
});
test('late downloads reconcile and old attempts cannot replace newer or manually replaced media', async () => {
  const h = await startCanvasHarness({ video: false }); await h.canvas.close();
  const b = batches(), s = createCanvasService(h.db, h.cfg, h.log, b, { terminalPollMs: 0 });
  try {
    const c = s.create(); edits(s, c.id, [{ type: 'add_node', id: 'image', kind: 'image', data: { prompt: 'test' } }]);
    const first = s.generate(c.id, { request_id: uid(), node_ids: ['image'] }); s.pump();
    b.rows.get('batch-1').items[0].status = 'needs_review'; s.pump();
    assert.equal(s.store.read('job', first.job_id).status, 'failed');
    b.done('batch-1', 'recovered'); s.pump();
    assert.equal(s.get(c.id).nodes[0].data.media.local_path, 'recovered.png');
    assert.equal(s.store.read('job', first.job_id).status, 'completed'); assert.equal(b.created, 1);
    s.generate(c.id, { request_id: uid(), node_ids: ['image'] }); s.pump();
    s.generate(c.id, { request_id: uid(), node_ids: ['image'] }); s.pump();
    b.done('batch-3', 'latest'); s.pump(); b.done('batch-2', 'older'); s.pump();
    assert.equal(s.get(c.id).nodes[0].data.media.local_path, 'latest.png');
    s.generate(c.id, { request_id: uid(), node_ids: ['image'] }); s.pump();
    const node = s.get(c.id).nodes[0];
    edits(s, c.id, [{ type: 'update_node', id: node.id, expected_version: node.version, data: { media: { local_path: 'manual.png' } } }]);
    b.done('batch-4', 'late'); s.pump();
    assert.equal(s.get(c.id).nodes[0].data.media.local_path, 'manual.png');
    assert.equal(s.get(c.id).nodes[0].attempts.length, 4);
  } finally { await s.stop(); await h.close(); }
});
test('persistent recovery keeps submitted batch identity, interrupts text run and honours dependency pause/resume', async () => {
  const h = await startCanvasHarness({ video: false }); await h.canvas.close();
  const b = batches(); let s = createCanvasService(h.db, h.cfg, h.log, b, { terminalPollMs: 0 }), agent;
  try {
    const c = s.create(); edits(s, c.id, [
      { type: 'add_node', id: 'image', kind: 'image', data: { prompt: 'ref' } },
      { type: 'add_node', id: 'video', kind: 'video', data: { prompt: 'motion' } },
      { type: 'connect', source: 'image', target: 'video', role: 'first_frame' },
    ]);
    const input = { request_id: uid(), node_ids: ['image', 'video'] }, job = s.generate(c.id, input); s.pump();
    s.controlJob(c.id, job.job_id, 'pause'); b.done('batch-1', 'ref'); s.pump();
    assert.equal(b.created, 1);
    s.store.record('run', { id: 'interrupted-text', canvas_id: c.id, status: 'running', history: [] });
    await s.stop();
    s = createCanvasService(h.db, h.cfg, h.log, b, { terminalPollMs: 0 }); agent = createCanvasAgent(s);
    assert.equal(agent.get(c.id, 'interrupted-text').status, 'interrupted');
    assert.equal(s.generate(c.id, input).job_id, job.job_id); s.pump(); assert.equal(b.created, 1);
    s.controlJob(c.id, job.job_id, 'resume'); s.pump(); assert.equal(b.created, 2);
    const videoRequest = s.store.read('job', job.job_id).steps.find(step => step.node_id === 'video').request;
    assert.equal(videoRequest.first_frame_url, 'ref.png');
    assert.equal(videoRequest.resolution, '720p');
    s.pump(); assert.equal(b.created, 2);
    assert.equal(h.completions.length, 0);
    const other = s.create(); assert.throws(() => s.store.read('job', job.job_id, other.id), { code: 'CANVAS_RECORD_NOT_FOUND' });
    edits(s, c.id, [{ type: 'connect', source: 'video', target: 'image' }]);
    assert.throws(() => s.generate(c.id, { request_id: uid(), node_ids: ['image', 'video'] }), /循环|cycle/i);
  } finally { await agent?.close(); await s.stop(); await h.close(); }
});
test('real video analysis, concurrent FFmpeg exports and download are connected', { timeout: 90000 }, async () => {
  const h = await startCanvasHarness(); const s = h.canvas.service;
  try {
    const local = path.join(h.storage, 'input.mp4'); fs.copyFileSync(h.videoPath, local);
    const c = s.create(); edits(s, c.id, [{ type: 'add_node', id: 'video', kind: 'video', data: { title: 'real clip', media: { local_path: 'input.mp4' } } }]);
    const analysis = await require('../src/services/creationCanvas/analysis').inspectMedia(s, c.id, 'video');
    assert.ok(analysis.analysis); assert.ok(analysis.vision_paths.length > 0, JSON.stringify(analysis));
    const jobs = [0,1].map(() => s.exportVideo(c.id, { request_id: uid(), node_ids: ['video','video'] }));
    const done = await wait(() => jobs.map(j => s.store.read('job', j.job_id)), items => items.every(j => ['completed','failed'].includes(j.status)), 60000);
    assert.ok(done.every(j => j.status === 'completed'), JSON.stringify(done));
    assert.notEqual(done[0].media.local_path, done[1].media.local_path);
    for (const job of done) { const file = s.mediaFile(c.id, null, job.id); assert.ok(file.size > 8192); }
  } finally { await h.close(); }
});
test('export shutdown interrupts a stalled child download promptly and preserves recoverable record', { timeout: 15000 }, async () => {
  const h = await startCanvasHarness({ video: false }); const s = h.canvas.service;
  // This standalone listener deliberately never sends headers.
  const stalled = require('node:http').createServer(() => {});
  await new Promise(r => stalled.listen(0, '127.0.0.1', r));
  try {
    const c = s.create(); edits(s, c.id, [{ type: 'add_node', id: 'video', kind: 'video', data: { media: { url: 'http://127.0.0.1:' + stalled.address().port + '/wait.mp4' } } }]);
    const job = s.exportVideo(c.id, { request_id: uid(), node_ids: ['video'] }); s.pump(); await sleep(500);
    const start = Date.now(); await s.stop(); assert.ok(Date.now() - start < 5000);
    assert.equal(s.store.read('job', job.job_id).status, 'interrupted');
  } finally { stalled.closeAllConnections(); await new Promise(r => stalled.close(r)); await h.close(); }
});
test('MCP stdio creates, configures, edits, messages and reads the same canvas backend', { timeout: 30000 }, async () => {
  const h = await startCanvasHarness({ video: false });
  const server = path.resolve(__dirname, '../../codex-yinzi-universal-video-workflow/plugins/codex-yinzi-universal-video-workflow/mcp/server.mjs');
  const child = spawn(process.execPath, [server], { env: { ...process.env, YINZI_WORKFLOW_URL: h.base }, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  let seq = 0, buffer = ''; const pending = new Map();
  child.stdout.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0,end); buffer = buffer.slice(end+1); const reply = JSON.parse(line); pending.get(reply.id)?.(reply); pending.delete(reply.id); } });
  async function rpc(method, params) { const id = ++seq, response = new Promise(resolve => pending.set(id, resolve)); child.stdin.write(JSON.stringify({ jsonrpc:'2.0', id, method, params })+'\n'); const reply = await response; assert.ok(!reply.error, JSON.stringify(reply)); return reply.result; }
  async function call(action, canvas_id, input) { const result = await rpc('tools/call', { name: 'creation_canvas', arguments: { action, canvas_id, input } }); assert.ok(!result.isError, JSON.stringify(result)); return JSON.parse(result.content[0].text); }
  try {
    await rpc('initialize', {}); assert.ok((await rpc('tools/list')).tools.some(t => t.name === 'creation_canvas'));
    const c = await call('create', undefined, { title: 'MCP canvas' });
    await call('configure', c.id, { agent: { config_id: h.configs.text.id, model: h.configs.text.default_model } });
    await call('operations', c.id, { request_id: uid(), operations: [{ type:'add_node', id:'mcp-script', kind:'text', data:{text:'scene'} }] });
    const sent = await call('send', c.id, { request_id: uid(), message:'review script' });
    await wait(() => h.canvas.agent.get(c.id, sent.run_id), r => r.status === 'completed');
    assert.equal((await call('get', c.id)).nodes[0].id, 'mcp-script');
    assert.ok((await call('messages', c.id, {})).items.some(m => m.role === 'assistant'));
  } finally { child.kill(); await new Promise(r => child.once('exit', r)); await h.close(); }
});
