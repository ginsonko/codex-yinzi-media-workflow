const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const orchestrationRoutes = require('../src/routes/orchestration');
const response = require('../src/response');

let db; let server; let baseUrl;
const log = { info() {}, warn() {}, error() {} };

async function request(path, options = {}) {
  const result = await fetch(`${baseUrl}${path}`, options);
  return { status: result.status, body: await result.json() };
}

beforeEach(async () => {
  db = new Database(':memory:');
  const oldLog = console.log; const oldWarn = console.warn; console.log = () => {}; console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = oldLog; console.warn = oldWarn; }
  const routes = orchestrationRoutes(db, log);
  const app = express(); app.use(express.json());
  app.get('/api/modules', routes.listModules);
  app.get('/api/modules/:moduleId', routes.getModule);
  app.get('/api/onboarding', routes.onboarding);
  app.get('/api/experiences', routes.listMediaExperiences);
  app.get('/api/experiences/:experienceId', routes.getMediaExperience);
  app.post('/api/experiences', routes.recordMediaExperience);
  app.get('/api/sessions', routes.listSessions);
  app.post('/api/sessions', routes.createSession);
  app.get('/api/sessions/:id', routes.getSession);
  app.patch('/api/sessions/:id', routes.updateSession);
  app.put('/api/sessions/:id/plan', routes.submitPlan);
  app.post('/api/sessions/:id/confirm', routes.confirmPlan);
  app.post('/api/sessions/:id/start', routes.startSession);
  app.patch('/api/sessions/:id/nodes/:nodeId', routes.updateNode);
  app.post('/api/sessions/:id/nodes/:nodeId/retry', routes.retryNode);
  app.post('/api/sessions/:id/nodes/:nodeId/actions/:action', routes.actOnNode);
  app.post('/api/sessions/:id/nodes/:nodeId/external-request', routes.reserveExternalRequest);
  app.post('/api/sessions/:id/pause', routes.pauseSession);
  app.post('/api/sessions/:id/resume', routes.resumeSession);
  app.post('/api/sessions/:id/checkpoint', routes.saveCheckpoint);
  app.get('/api/sessions/:id/export', routes.exportSession);
  app.post('/api/sessions/:id/events', routes.recordEvent);
  app.get('/api/sessions/:id/artifacts', routes.artifacts);
  app.post('/api/sessions/:id/artifacts', routes.registerArtifact);
  app.get('/api/sessions/:id/feedback', routes.feedback);
  app.post('/api/sessions/:id/feedback', routes.recordFeedback);
  app.get('/api/sessions/:id/delivery', routes.delivery);
  app.post('/api/sessions/:id/delivery', routes.prepareDelivery);
  app.use((_req, res) => response.notFound(res, 'not found'));
  server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});
afterEach(async () => { await new Promise((resolve) => server.close(resolve)); db.close(); });

describe('Codex orchestration HTTP contract', () => {
  it('experience HTTP requests distinguish reuse, conflicts and missing correction targets', async () => {
    const post=body=>request('/experiences',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const body={request_key:'local-method-one',title:'真实本地处理记录',source:'agent_note',guidance:{method:'保留同一作业恢复'}};
    const first=await post(body);assert.equal(first.status,201);
    const reused=await post(body);assert.equal(reused.body.data.id,first.body.data.id);assert.equal(reused.body.data.reused,true);
    const conflict=await post({...body,title:'different'});assert.equal(conflict.status,409);assert.equal(conflict.body.error.code,'EXPERIENCE_REQUEST_CONFLICT');
    const absent=await post({...body,request_key:'correction',supersedes_id:'missing'});assert.equal(absent.status,404);
    const spoof=await post({...body,request_key:'spoof',source:'system_receipt'});assert.equal(spoof.status,400);
    assert.equal((await request('/experiences')).body.data.total,1);
    assert.equal((await request('/experiences/'+first.body.data.id)).body.data.guidance.method,body.guidance.method);
  });
  it('returns a secret-free low-gate onboarding snapshot', async () => {
    const onboarding = await request('/onboarding');
    assert.equal(onboarding.status, 200);
    assert.equal(onboarding.body.data.open_world, true);
    assert.equal(onboarding.body.data.connected, true);
    assert.equal(onboarding.body.data.active_config_counts.text, 0);
    assert.match(onboarding.body.data.next_steps.join(' '), /Codex/);
    assert.doesNotMatch(JSON.stringify(onboarding.body.data), /api_key|Bearer|sk-/i);
  });

  it('records structured events once and rejects secret or oversized payloads', async () => {
    const created = await request('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idempotency_key: 'event-session', user_goal: '记录事件' }) });
    const id = created.body.data.session.id;
    const body = { event_type: 'decision', event_idempotency_key: 'decision-1', actor: 'codex', payload: { summary: '复用用户视频', confidence: 0.9 } };
    const first = await request(`/sessions/${id}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(first.status, 200);
    assert.equal(first.body.data.reused, false);
    const second = await request(`/sessions/${id}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(second.status, 200);
    assert.equal(second.body.data.reused, true);
    assert.equal(second.body.data.event.id, first.body.data.event.id);
    const secret = await request(`/sessions/${id}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event_type: 'fact', event_idempotency_key: 'secret-1', payload: { token: 'sk-abcdefghijklmnop' } }) });
    assert.equal(secret.status, 400);
    assert.equal(secret.body.error.code, 'EVENT_SECRET_REJECTED');
    const oversized = await request(`/sessions/${id}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event_type: 'fact', event_idempotency_key: 'large-1', payload: { text: 'x'.repeat(8001) } }) });
    assert.equal(oversized.status, 400);
    assert.equal(oversized.body.error.code, 'EVENT_PAYLOAD_TOO_LARGE');
    const events = await request(`/sessions/${id}`);
    assert.equal(events.body.data.events.filter((event) => event.event_type === 'decision').length, 1);
  });

  it('runs a zero-cost dynamic lifecycle with conflict and recovery readback', async () => {
    const modules = await request('/modules');
    assert.equal(modules.status, 200);
    assert.equal(modules.body.data.open_world, true);
    const missing = await request('/modules/future.video.module');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'MODULE_CONTRACT_MISSING');

    const created = await request('/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotency_key: 'route-e2e', title: '电商验收', user_goal: '分析一个商品并复用已有视频' }),
    });
    assert.equal(created.status, 201);
    const id = created.body.data.session.id;
    const plan = await request(`/sessions/${id}/plan`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true, expected_revision: 0, nodes: [
        { node_key: 'facts', module_id: 'product.extract-facts' },
        { node_key: 'clip', module_id: 'video.import', depends_on: ['facts'] },
      ] }),
    });
    assert.equal(plan.status, 200);
    assert.equal(plan.body.data.session.plan_revision, 1);
    const conflict = await request(`/sessions/${id}/plan`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: 0, nodes: [{ node_key: 'wrong', module_id: 'manual.override' }] }),
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'PLAN_REVISION_CONFLICT');
    assert.equal((await request(`/sessions/${id}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 200);
    const started = await request(`/sessions/${id}`);
    const facts = started.body.data.nodes.find((node) => node.node_key === 'facts');
    assert.equal(facts.status, 'ready');
    const actionStarted = await request(`/sessions/${id}/nodes/${facts.id}/actions/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(actionStarted.body.data.node.status, 'running');
    await request(`/sessions/${id}/nodes/${facts.id}/actions/complete`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '事实提取完成' }),
    });
    const readback = await request(`/sessions/${id}`);
    assert.equal(readback.body.data.nodes.find((node) => node.node_key === 'clip').status, 'ready');
    assert.equal((await request(`/sessions/${id}/checkpoint`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checkpoint: { summary: '下一步导入片段' } }) })).status, 200);
    assert.equal((await request(`/sessions/${id}/pause`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 200);
    assert.equal((await request(`/sessions/${id}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 200);
    const exported = await request(`/sessions/${id}/export`);
    assert.equal(exported.body.data.schema, 'yinzi.codex-video-orchestration/v1');
    assert.match(JSON.stringify(exported.body.data), /下一步导入片段/);
  });

  it('atomically binds a stable hash before one external submission and requires reconciliation on reuse', async () => {
    const created = await request('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idempotency_key: 'external-once', user_goal: '生成一张验收图' }) });
    const id = created.body.data.session.id;
    await request(`/sessions/${id}/plan`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true, nodes: [{ node_key: 'image', module_id: 'image.generate' }] }) });
    await request(`/sessions/${id}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const first = await request(`/sessions/${id}/nodes/image/external-request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request_hash: 'sha256-one' }) });
    assert.equal(first.status, 200);
    assert.equal(first.body.data.reserved, true);
    const second = await request(`/sessions/${id}/nodes/image/external-request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request_hash: 'sha256-one' }) });
    assert.equal(second.body.data.reused, true);
    assert.equal(second.body.data.reconciliation_required, true);
    const conflict = await request(`/sessions/${id}/nodes/image/external-request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request_hash: 'sha256-two' }) });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'REQUEST_HASH_CONFLICT');
  });

  it('serves artifact, feedback and delivery routes with stable idempotent readback', async () => {
    const created = await request('/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotency_key: 'experience-routes', user_goal: '验收成果展示' }),
    });
    const id = created.body.data.session.id;
    const plan = await request(`/sessions/${id}/plan`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true, expected_revision: 0, nodes: [{ node_key: 'preview', module_id: 'image.generate' }] }),
    });
    assert.equal(plan.status, 200);
    const started = await request(`/sessions/${id}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(started.status, 200);
    const artifactBody = { artifact_id: 'preview-1', type: 'image', title: '预览图', url: '/static/preview.png', status: 'ready', validation: { status: 'passed' } };
    const artifact = await request(`/sessions/${id}/artifacts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(artifactBody) });
    assert.equal(artifact.status, 201);
    assert.equal(artifact.body.data.reused, false);
    const artifactAgain = await request(`/sessions/${id}/artifacts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...artifactBody, title: '不应覆盖' }) });
    assert.equal(artifactAgain.body.data.reused, true);
    assert.equal(artifactAgain.body.data.artifact.title, '预览图');
    const listed = await request(`/sessions/${id}/artifacts`);
    assert.equal(listed.body.data.schema_version, 1);
    assert.equal(listed.body.data.items.length, 1);

    const feedbackBody = { message: '请暂停并保留这个版本', pause: true, idempotency_key: 'feedback-route-1', actor: 'user' };
    const feedback = await request(`/sessions/${id}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(feedbackBody) });
    assert.equal(feedback.status, 201);
    assert.equal(feedback.body.data.reused, false);
    const feedbackAgain = await request(`/sessions/${id}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...feedbackBody, message: '不得覆盖' }) });
    assert.equal(feedbackAgain.body.data.reused, true);
    assert.equal(feedbackAgain.body.data.feedback.message, feedbackBody.message);

    const deliveryBody = { artifact_ids: ['preview-1'], format: 'preview', idempotency_key: 'delivery-route-1', actor: 'user' };
    const delivery = await request(`/sessions/${id}/delivery`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(deliveryBody) });
    assert.equal(delivery.status, 201);
    assert.equal(delivery.body.data.delivery.status, 'ready');
    assert.equal(delivery.body.data.delivery.items.length, 1);
    const deliveryAgain = await request(`/sessions/${id}/delivery`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...deliveryBody, artifact_ids: ['missing'] }) });
    assert.equal(deliveryAgain.body.data.reused, true);
    const current = await request(`/sessions/${id}/delivery`);
    assert.equal(current.body.data.status, 'ready');
    assert.equal(current.body.data.items[0].artifact_id, 'preview-1');
    const bundle = await request(`/sessions/${id}`);
    assert.equal(bundle.body.data.session.status, 'paused');
  });
});
