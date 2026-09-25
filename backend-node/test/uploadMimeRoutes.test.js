const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sharp = require('sharp');
const upload = require('../src/routes/upload');

const log = { info() {}, error() {}, warn() {} };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1kAAAAASUVORK5CYII=', 'base64');
let storage, server, base, requestCount = 0;

before(async () => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-upload-mime-route-'));
  const app = express();
  const handlers = upload.routes({ storage: { local_path: storage } }, log);
  app.use((_req, _res, next) => { requestCount++; next(); });
  app.post('/upload/image', upload.multerSingle, handlers.uploadImage);
  app.post('/upload/reference-media', upload.multerReferenceMediaSingle, handlers.uploadReferenceMedia);
  app.post('/upload/audio', upload.multerAudioSingle, (req, res) => res.json({ mime_type: req.file?.mimetype }));
  app.use((error, _req, res, _next) => res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.message }));
  server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  assert.equal(path.dirname(storage), path.resolve(os.tmpdir()));
  fs.rmSync(storage, { recursive: true, force: true });
});

async function post(route, bytes, filename, mime) {
  const boundary = 'yinzi-local-upload-test-boundary';
  // Raw multipart lets us omit the part Content-Type exactly as script clients do.
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n${mime == null ? '' : `Content-Type: ${mime}\r\n`}\r\n`),
    bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const before = requestCount;
  const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body });
  const result = await response.json();
  assert.equal(requestCount, before + 1, 'the first request is sufficient; no retry or alternate protocol');
  return { status: response.status, ...result };
}

for (const route of ['/upload/image', '/upload/reference-media']) {
  for (const [filename, mime] of [
    ['powershell.png', 'application/octet-stream'],
    ['missing-type.png', null],
    ['mislabeled.jpg', 'image/jpeg'],
    ['extensionless', 'binary/octet-stream'],
  ]) {
    test(`${route}: PNG ${filename} (${mime || 'no MIME'}) succeeds on first multipart request`, async () => {
      const result = await post(route, png, filename, mime);
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.equal(result.data.mime_type, 'image/png');
      assert.match(result.data.local_path, /\.png$/);
      assert.deepEqual(fs.readFileSync(path.join(storage, result.data.local_path)), png);
      if (route.includes('reference')) assert.equal(result.data.media_type, 'image');
    });
  }
}

test('actual JPEG and WebP bytes with generic MIME are recognized and copied unchanged', async () => {
  for (const [format, mime, extension] of [['jpeg', 'image/jpeg', 'jpg'], ['webp', 'image/webp', 'webp']]) {
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#145678' } })[format]().toBuffer();
    const result = await post('/upload/reference-media', bytes, 'reference.bin', 'application/octet-stream');
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.data.mime_type, mime);
    assert.ok(result.data.local_path.endsWith('.' + extension));
    assert.deepEqual(fs.readFileSync(path.join(storage, result.data.local_path)), bytes);
  }
});

test('MP4 container and WAV media headers are recognized without client MIME hints', async () => {
  const mp4 = Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypisom'), 0, 0, 2, 0, ...Buffer.from('isomiso2')]);
  const wav = Buffer.alloc(46);
  wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2, 40);
  for (const [bytes, mime, type, ext] of [[mp4, 'video/mp4', 'video', 'mp4'], [wav, 'audio/wav', 'audio', 'wav']]) {
    const result = await post('/upload/reference-media', bytes, 'reference.bin', null);
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.data.mime_type, mime);
    assert.equal(result.data.media_type, type);
    assert.ok(result.data.local_path.endsWith('.' + ext));
    assert.deepEqual(fs.readFileSync(path.join(storage, result.data.local_path)), bytes);
  }
  const audio = await post('/upload/audio', wav, 'reference.wav', 'application/octet-stream');
  assert.equal(audio.status, 200);
  assert.equal(audio.mime_type, 'audio/wav');
});

test('an extension alone never turns arbitrary bytes into an image', async () => {
  for (const route of ['/upload/image', '/upload/reference-media']) {
    const result = await post(route, Buffer.from('not a PNG file'), 'fake.png', 'application/octet-stream');
    assert.equal(result.status, 400);
  }
});

test('correct declared vendor media keeps its existing compatibility', async () => {
  const result = await post('/upload/reference-media', Buffer.from('vendor media fixture'), 'clip.vendor', 'video/x-vendor');
  assert.equal(result.status, 200);
  assert.equal(result.data.mime_type, 'video/x-vendor');
});

test('byte inspection retains the image upload size limit', async () => {
  const result = await post('/upload/image', Buffer.concat([png, Buffer.alloc(16 * 1024 * 1024)]), 'large.png', 'application/octet-stream');
  assert.equal(result.status, 413);
});
