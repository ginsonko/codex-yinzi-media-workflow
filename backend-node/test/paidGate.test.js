// 宿主收费闸的付费上下文：只来自发起生成的编排会话，一路传到发送前钩子；两个对话同时出图，各带各的。
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const config = require('../src/config');
const upload = require('../src/services/uploadService');
const realLoadConfig = config.loadConfig;
const realDownload = upload.downloadImageToLocal;
config.loadConfig = () => ({ app: { name: 'paid gate test' }, storage: { local_path: './fixture-unused-storage' }, style: {}, ai: {} });
const imageService = require('../src/services/imageService');
const aiConfig = require('../src/services/aiConfigService');
const { createOrchestrationService } = require('../src/services/orchestrationService');
const { paidContextOf, paidFetch } = require('../src/services/paidGate');
const log = { info() {}, warn() {}, error() {} };
let db, server, baseUrl, requests, orchestration;

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for fixture');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    requests.push({ quote: req.headers['x-parameter-quote'] || '', body: text ? JSON.parse(text) : {}, res });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});

after(async () => {
  config.loadConfig = realLoadConfig;
  upload.downloadImageToLocal = realDownload;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests = [];
  upload.downloadImageToLocal = async () => null;
  db = new Database(':memory:');
  const oldLog = console.log, oldWarn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = oldLog; console.warn = oldWarn; }
  db.pragma('foreign_keys = OFF');
  orchestration = createOrchestrationService(db);
  aiConfig.createConfig(db, log, {
    service_type: 'image', provider: 'openai', api_protocol: 'openai',
    base_url: baseUrl, api_key: 'local-test-only', model: ['fixture'],
    is_default: true, is_active: true,
  });
});

afterEach(async () => {
  delete globalThis.__omniPaidGate;
  for (const request of requests) {
    if (!request.res.writableEnded) {
      request.res.writeHead(500, { 'content-type': 'application/json' });
      request.res.end(JSON.stringify({ error: { message: 'fixture cleanup' } }));
    }
  }
  await until(() => db.prepare("SELECT COUNT(*) AS n FROM async_tasks WHERE status IN ('pending','processing')").get().n === 0);
  db.close();
});

const session = (chat) => orchestration.beginWork({ idempotency_key: `omni-${chat}-image-1`, user_goal: 'fixture', ...(chat ? { source_context: { omni_chat_id: chat } } : {}) }).session.id;

test('付费上下文只从编排会话读：登记了对话 id 才有，没有或会话不存在就是 null', () => {
  const a = session('chat-A');
  assert.deepEqual(paidContextOf(db, a), { omni_chat_id: 'chat-A', orchestration_session_id: a });
  assert.equal(paidContextOf(db, session('')), null);
  assert.equal(paidContextOf(db, 'no-such-session'), null);
  assert.equal(paidContextOf(db, ''), null);
});

test('两个对话同时出图：每个请求带的是自己会话的对话 id，不会串；没登记会话的请求不带', async () => {
  const seen = [];
  globalThis.__omniPaidGate = {
    covers: (url) => String(url).startsWith(baseUrl),
    runRaw: async (req, send) => {
      seen.push({ prompt: req.body?.prompt, chat: req.ctx?.omni_chat_id || null });
      return send({ 'X-Parameter-Quote': `q-${req.ctx?.omni_chat_id || 'none'}` });
    },
  };
  const a = session('chat-A');
  const b = session('chat-B');
  const make = (prompt, sid) => imageService.create(db, log, { drama_id: 1, prompt, model: 'fixture', ...(sid ? { orchestration_session_id: sid } : {}) });
  const jobs = [make('画 A', a), make('画 B', b), make('画 无', '')];
  await until(() => requests.length === 3);
  const byPrompt = Object.fromEntries(requests.map((r) => [String(r.body.prompt).match(/画 (A|B|无)/)[0], r.quote]));
  assert.deepEqual(byPrompt, { '画 A': 'q-chat-A', '画 B': 'q-chat-B', '画 无': 'q-none' });
  for (const s of seen) assert.equal(s.chat, { A: 'chat-A', B: 'chat-B', 无: null }[String(s.prompt).match(/画 (A|B|无)/)[1]]);
  for (const r of requests) {
    r.res.writeHead(200, { 'content-type': 'application/json' });
    r.res.end(JSON.stringify({ data: [{ url: 'https://fixture.invalid/x.png' }] }));
  }
  for (const j of jobs) await until(() => ['completed', 'failed'].includes(db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(j.task_id)?.status));
});

test('paidFetch：闸拿到上下文；超时从真正发出时算，等确认不占超时', async () => {
  const ctxs = [];
  globalThis.__omniPaidGate = {
    covers: () => true,
    runFetch: async (req, send) => {
      ctxs.push(req.ctx);
      await new Promise((r) => setTimeout(r, 120));
      return send({ 'X-Parameter-Quote': 'q1' });
    },
  };
  const p = paidFetch(`${baseUrl}/videos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"model":"v"}' }, { context: { omni_chat_id: 'chat-A' }, timeoutMs: 80 });
  await until(() => requests.length === 1);
  requests[0].res.writeHead(200, { 'content-type': 'application/json' });
  requests[0].res.end('{"id":"t1"}');
  const res = await p;
  assert.equal(res.status, 200);
  assert.equal(requests[0].quote, 'q1');
  assert.deepEqual(ctxs, [{ omni_chat_id: 'chat-A' }]);
  delete globalThis.__omniPaidGate;
  const plain = paidFetch(`${baseUrl}/videos`, { method: 'POST', body: '{}' });
  await until(() => requests.length === 2);
  assert.equal(requests[1].quote, '', '没装闸原样发');
  requests[1].res.end('{}');
  await plain;
});
