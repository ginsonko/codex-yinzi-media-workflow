const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { downloadVideoToLocal } = require('../src/services/videoService');
const log = { info() {}, warn() {} };
const data = Buffer.alloc(24000, 7); data.write('ftyp', 4);

for (const mode of ['valid', 'truncated', 'wrong-range', 'changed-entity', 'unauthorized']) test(`artifact fallback: ${mode}`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-range-test-'));
  const calls = [], progress = [];
  try {
    const options = { throw_on_error: true, skip_probe: true, range_chunk_bytes: 4096,
      on_progress: value => progress.push(value), fetch_impl: async (url, init) => {
        assert.equal(init.method, 'GET'); assert.equal(url, 'https://fixture.test/original');
        const range = init.headers.Range; calls.push(range);
        if (mode === 'unauthorized') return new Response('{"message":"denied"}', { status: 401, headers: { 'content-type': 'application/json' } });
        if (!range) throw new DOMException('timed out', 'TimeoutError');
        const match = /bytes=(\d+)-(\d+)/.exec(range), start = Number(match[1]), end = Math.min(data.length - 1, Number(match[2]));
        const body = data.subarray(start, end + (mode === 'truncated' ? 0 : 1));
        return new Response(body, { status: 206, headers: { 'content-type': 'video/mp4',
          'content-range': `bytes ${mode === 'wrong-range' ? start + 1 : start}-${end}/${data.length}`,
          etag: mode === 'changed-entity' && start > 0 ? '"changed"' : '"original"' } });
      } };
    if (mode === 'valid') {
      const relative = await downloadVideoToLocal(root, 'https://fixture.test/original', 1, log, null, options);
      assert.deepEqual(fs.readFileSync(path.join(root, relative)), data);
      assert.equal(progress.at(-1).bytes, data.length); assert.equal(progress.at(-1).mode, 'range');
    } else {
      await assert.rejects(downloadVideoToLocal(root, 'https://fixture.test/original', 1, log, null, options));
      assert.deepEqual(fs.readdirSync(path.join(root, 'videos')), []);
      if (mode === 'unauthorized') assert.equal(calls.length, 1);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
