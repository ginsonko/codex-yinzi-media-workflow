const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { postJSONWithTimeout } = require('../src/services/aiClient');

for (const sendHeaders of [false, true]) {
  test(`shared HTTP timeout keeps transport facts without claiming image generation (headers=${sendHeaders})`, async () => {
    let received;
    const server = http.createServer((req, res) => {
      received = req.url;
      req.resume();
      if (sendHeaders) { res.writeHead(200, { 'x-request-id': 'local-request-1' }); res.flushHeaders(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await assert.rejects(postJSONWithTimeout(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {}, { messages: [] }, 100), error => {
        assert.equal(error.code, 'HTTP_REQUEST_TIMEOUT');
        assert.equal(error.timeout_ms, 100);
        assert.equal(error.timeout_kind, 'total');
        assert.equal(error.http_status, sendHeaders ? 200 : null);
        assert.equal(error.request_id, sendHeaders ? 'local-request-1' : null);
        assert.doesNotMatch(error.message, /image|vision/i);
        return true;
      });
      assert.equal(received, '/v1/chat/completions');
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
}

test('shared JSON transport preserves status, raw upstream error and request identity', async () => {
  const server = http.createServer((req, res) => { req.resume(); res.writeHead(429, { 'x-request-id': 'quota-request' }); res.end('{"error":"quota exhausted"}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await postJSONWithTimeout(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {}, {}, 1000);
    assert.deepEqual(result, { statusCode: 429, raw: '{"error":"quota exhausted"}', request_id: 'quota-request' });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
