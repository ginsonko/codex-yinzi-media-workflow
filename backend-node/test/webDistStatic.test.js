const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { mountWebDist } = require('../src/app');

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('packaged web distribution routing', () => {
  it('serves media ranges, keeps SPA deep links, and never turns missing files into HTML', async () => {
    const webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-web-dist-'));
    const media = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
    try {
      fs.mkdirSync(path.join(webDist, 'demo'), { recursive: true });
      fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><title>Yinzi workflow</title>');
      fs.writeFileSync(path.join(webDist, 'demo', 'director-preview.mp4'), media);

      const app = express();
      mountWebDist(app, webDist);
      app.use((req, res) => res.status(404).type('text/plain').send('Not Found'));

      await withServer(app, async (origin) => {
        const ranged = await fetch(`${origin}/demo/director-preview.mp4`, {
          headers: { Range: 'bytes=0-7' },
        });
        assert.equal(ranged.status, 206);
        assert.match(ranged.headers.get('content-type') || '', /^video\/mp4\b/);
        assert.equal(ranged.headers.get('content-range'), `bytes 0-7/${media.length}`);
        assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), media.subarray(0, 8));

        const missing = await fetch(`${origin}/demo/missing.mp4`, {
          headers: { Accept: 'video/*' },
        });
        assert.equal(missing.status, 404);
        assert.doesNotMatch(missing.headers.get('content-type') || '', /text\/html/);
        assert.equal(await missing.text(), 'Not Found');

        const deepLink = await fetch(`${origin}/guided-demo`, {
          headers: { Accept: 'text/html' },
        });
        assert.equal(deepLink.status, 200);
        assert.match(deepLink.headers.get('content-type') || '', /text\/html/);
        assert.match(await deepLink.text(), /Yinzi workflow/);
      });
    } finally {
      fs.rmSync(webDist, { recursive: true, force: true });
    }
  });
});
