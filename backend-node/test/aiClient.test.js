const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfigService = require('../src/services/aiConfigService');
const aiClient = require('../src/services/aiClient');

let db;
let server;
let baseUrl;
const log = { info() {}, warn() {}, error() {} };

function migrateQuietly() {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrateQuietly();
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-local',
        choices: [{ message: { content: JSON.stringify({ shots: [{ number: 1, title: '本地 mock 分镜' }] }) } }],
        received_stream: body.stream,
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
  aiConfigService.createConfig(db, log, {
    service_type: 'text', provider: 'yinzi', name: 'local text',
    base_url: baseUrl, api_key: 'local-test-key', model: ['gpt-5.6-sol'],
    default_model: 'gpt-5.6-sol', is_default: true,
  });
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

describe('AI client explicit response mode', () => {
  it('sends stream:false and parses a normal OpenAI JSON response', async () => {
    const result = await aiClient.generateText(
      db,
      log,
      'text',
      '请返回一个 JSON 分镜对象',
      '你是分镜规划器',
      {
        model: 'gpt-5.6-sol',
        json_mode: true,
        stream: false,
        timeout_ms: 3000,
      },
    );
    const parsed = JSON.parse(result);
    assert.deepEqual(parsed.shots, [{ number: 1, title: '本地 mock 分镜' }]);
  });

  it('keeps the historical stream default opt-in for existing callers', async () => {
    // This server returns a single SSE event; the assertion is intentionally
    // limited to the successful protocol path and does not exercise paid or
    // provider-specific behavior.
    await new Promise((resolve) => {
      server.close(() => {
        server = http.createServer((req, res) => {
          const chunks = [];
          req.on('data', (chunk) => chunks.push(chunk));
          req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            assert.equal(body.stream, true);
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
          });
        });
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          baseUrl = `http://127.0.0.1:${address.port}/v1`;
          db.prepare('UPDATE ai_service_configs SET base_url = ? WHERE service_type = ?').run(baseUrl, 'text');
          resolve();
        });
      });
    });
    const result = await aiClient.generateText(db, log, 'text', 'ping', '', {
      model: 'gpt-5.6-sol', silence_timeout_ms: 3000,
    });
    assert.equal(result, 'ok');
  });
});
