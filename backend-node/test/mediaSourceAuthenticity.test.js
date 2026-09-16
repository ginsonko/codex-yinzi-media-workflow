'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const {
  executeNative: executeDownload,
  downloadDirect,
  sniffMediaType,
  isFormatAllowed,
  verifyDecodedMedia
} = require('../src/services/mediaDownload');
const { traverseDirectory } = require('../src/services/mediaIndex');

const os = require('node:os');
const BACKEND_NODE_DIR = path.resolve(__dirname, '..');
const installed = require('../src/services/componentRuntime').readState('media.ffmpeg');
const FFMPEG = process.env.YINZI_TEST_FFMPEG || installed?.executables?.ffmpeg || 'ffmpeg';
const FFPROBE = process.env.YINZI_TEST_FFPROBE || installed?.executables?.ffprobe || 'ffprobe';
const sharpModule = require('sharp');
const D_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-source-authenticity-'));
test.after(() => fs.rmSync(D_ROOT, {recursive:true,force:true}));
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeWav() {
  const sampleRate = 8000;
  const numSamples = 8000;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + numSamples * 2, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(numSamples * 2, 40);
  return Buffer.concat([header, Buffer.alloc(numSamples * 2)]);
}

function makeFtyp() {
  const buf = Buffer.alloc(32);
  buf.writeUInt32BE(buf.length, 0);
  buf.write('ftyp', 4);
  buf.write('isom', 8);
  return buf;
}

const PNG8 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR42mP8z8BQDwAE/AF/PosskwAAAABJRU5ErkJggg==', 'base64');

const http = require('node:http');

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        stop: () => new Promise(r => server.close(r))
      });
    });
  });
}

function serveBuffer(buffer, mime) {
  const etag = `"${sha256(buffer).slice(0, 16)}"`;
  return (req, res) => {
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': String(buffer.length),
      ETag: etag
    });
    res.end(buffer);
  };
}

async function runDownload(jobName, items, parameters = {}) {
  const job = path.join(D_ROOT, jobName);
  fs.mkdirSync(job, { recursive: true });
  const input = path.join(job, 'manifest.json');
  const output = path.join(job, 'result.json');
  fs.writeFileSync(input, JSON.stringify({ items }));
  const result = await executeDownload({
    inputPath: input,
    outputPath: output,
    parameters,
    allowLoopback: true,
    components: { 'media.ffmpeg': { executables: { ffmpeg: FFMPEG, ffprobe: FFPROBE } } },
    sharp: sharpModule
  });
  return { job, result };
}

test.describe('素材真实性与恢复最小修复候选', () => {
  test.before(() => {
    fs.mkdirSync(D_ROOT, { recursive: true });
  });

  test('截断 ftyp 不得登记为成功视频', async () => {
    const srv = await startServer(serveBuffer(makeFtyp(), 'video/mp4'));
    try {
      const { result } = await runDownload('trunc-ftyp', [{ id: 't', url: `${srv.baseUrl}/clip.mp4` }], { allowed_formats: ['video'] });
      const item = result.summary.items[0];
      assert.equal(item.status, 'failed');
      assert.equal(item.error_code, 'MEDIA_UNDECODABLE');
      assert.equal(result.assets.length, 0);
    } finally {
      await srv.stop();
    }
  });

  test('损坏 PNG 不得登记为成功图像', async () => {
    const srv = await startServer(serveBuffer(PNG8.subarray(0, 16), 'image/png'));
    try {
      const { result } = await runDownload('trunc-png', [{ id: 'p', url: `${srv.baseUrl}/cover.png` }], { allowed_formats: ['image'] });
      const item = result.summary.items[0];
      assert.equal(item.status, 'failed');
      assert.equal(item.error_code, 'MEDIA_UNDECODABLE');
    } finally {
      await srv.stop();
    }
  });

  test('未知二进制不得登记为 document', async () => {
    const blob = Buffer.concat([Buffer.from([0, 1, 2, 3]), crypto.randomBytes(40)]);
    const srv = await startServer(serveBuffer(blob, 'application/octet-stream'));
    try {
      const { result } = await runDownload('unknown-bin', [{ id: 'b', url: `${srv.baseUrl}/blob.bin` }]);
      const item = result.summary.items[0];
      assert.equal(item.status, 'failed');
      assert.ok(['UNKNOWN_MEDIA', 'FORMAT_DISALLOWED'].includes(item.error_code));
      assert.equal(result.assets.length, 0);
      assert.equal(sniffMediaType(blob, 'application/octet-stream').category, 'unknown');
      assert.equal(isFormatAllowed({ category: 'unknown' }, null), false);
    } finally {
      await srv.stop();
    }
  });

  test('allowed_formats=audio 接受真实 m4a', async () => {
    const m4aPath = path.join(D_ROOT, 'voice.m4a');
    const built = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', '-b:a', '32k', m4aPath], { encoding: 'utf8', windowsHide: true });
    assert.equal(built.status, 0, built.stderr);
    const body = fs.readFileSync(m4aPath);
    const srv = await startServer(serveBuffer(body, 'audio/mp4'));
    try {
      const { result } = await runDownload('m4a', [{ id: 'voice', url: `${srv.baseUrl}/clip.m4a` }], { allowed_formats: ['audio'] });
      const item = result.summary.items[0];
      assert.equal(item.status, 'succeeded');
      assert.equal(item.media_type, 'audio');
      assert.equal(item.format, 'm4a');
    } finally {
      await srv.stop();
    }
  });

  test('无 meta 残留文件不能冒认另一 URL', async () => {
    const a = Buffer.from('CACHE-A-' + 'A'.repeat(80));
    const b = Buffer.from('CACHE-B-' + 'B'.repeat(80));
    const target = path.join(D_ROOT, 'orphan.bin');
    const srvA = await startServer(serveBuffer(a, 'application/octet-stream'));
    await downloadDirect(`${srvA.baseUrl}/a.bin`, target, { allowLoopback: true });
    await srvA.stop();
    fs.unlinkSync(target + '.meta.json');
    const srvB = await startServer(serveBuffer(b, 'application/octet-stream'));
    const second = await downloadDirect(`${srvB.baseUrl}/b.bin`, target, { allowLoopback: true });
    await srvB.stop();
    assert.equal(second.reused, false);
    assert.deepEqual(fs.readFileSync(target), b);
  });

  test('同 URL 换版本后 Range 续传不得拼接两份文件', async () => {
    const a = Buffer.concat([Buffer.from('AAAA-HEAD-'), crypto.randomBytes(20 * 1024)]);
    const b = Buffer.concat([Buffer.from('BBBB-HEAD-'), crypto.randomBytes(20 * 1024)]);
    let current = a;
    let disconnectAt = 8 * 1024;
    const etagOf = buf => `"${sha256(buf).slice(0, 16)}"`;
    const srv = await startServer((req, res) => {
      const buf = current;
      const etag = etagOf(buf);
      const range = req.headers.range;
      if (!range) {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(buf.length),
          ETag: etag,
          'Accept-Ranges': 'bytes'
        });
        if (disconnectAt != null) {
          res.write(buf.subarray(0, disconnectAt));
          setTimeout(() => req.socket.destroy(), 15);
          return;
        }
        res.end(buf);
        return;
      }
      const ifRange = req.headers['if-range'];
      if (ifRange && ifRange !== etag) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length), ETag: etag });
        res.end(buf);
        return;
      }
      const start = Number(/^bytes=(\d+)-/.exec(range)[1]);
      const chunk = buf.subarray(start);
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${start}-${buf.length - 1}/${buf.length}`,
        'Content-Length': String(chunk.length),
        ETag: etag
      });
      res.end(chunk);
    });
    const target = path.join(D_ROOT, 'splice.bin');
    try { fs.unlinkSync(target); } catch {}
    try { fs.unlinkSync(target + '.part'); } catch {}
    try { fs.unlinkSync(target + '.part.meta.json'); } catch {}
    await assert.rejects(() => downloadDirect(`${srv.baseUrl}/x.bin`, target, { allowLoopback: true }));
    current = b;
    disconnectAt = null;
    const second = await downloadDirect(`${srv.baseUrl}/x.bin`, target, { allowLoopback: true });
    await srv.stop();
    assert.equal(second.reused, false);
    assert.deepEqual(fs.readFileSync(target), b);
  });

  test('yt-dlp 默认不关闭 TLS，大 JSON 走文件而非 1MB stdout 切片', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/mediaDownload.js'), 'utf8');
    assert.equal(src.includes('--no-check-certificates'), false);
    assert.match(src, /runProcessToFile/);
    assert.match(src, /dump-single-json/);
    assert.doesNotMatch(src, /JSON\.parse\(metaResult\.stdout\)/);
  });

  test('follow_symlinks 跟随根内文件链接，拒绝根外 junction', () => {
    const root = path.join(D_ROOT, 'links');
    const inside = path.join(root, 'in');
    const outside = path.join(D_ROOT, 'outside');
    fs.mkdirSync(inside, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const wav = makeWav();
    const localWav = path.join(inside, 'local.wav');
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(localWav, wav);
    fs.writeFileSync(secret, 'no');
    const alias = path.join(inside, 'alias.wav');
    const leakDir = path.join(inside, 'leak');
    try { fs.unlinkSync(alias); } catch {}
    try { fs.rmSync(leakDir, { recursive: true, force: true }); } catch {}
    fs.symlinkSync(localWav, alias, 'file');
    fs.symlinkSync(outside, leakDir, 'junction');
    const authorized = fs.realpathSync(root);
    const files = traverseDirectory(root, {
      followSymlinks: true,
      includeKinds: ['audio', 'document'],
      authorizedRoots: [authorized]
    }, { count: 0, visitedRealPaths: new Set() });
    const names = files.map(f => path.basename(f.path)).sort();
    assert.ok(names.includes('alias.wav'));
    assert.ok(names.includes('local.wav'));
    assert.equal(names.includes('secret.txt'), false);
  });

  test('decode 探针拒绝截断 ftyp 文件', async () => {
    const p = path.join(D_ROOT, 'bare.mp4');
    fs.writeFileSync(p, makeFtyp());
    await assert.rejects(
      () => verifyDecodedMedia(p, { category: 'video', format: 'mp4' }, { ffprobeBin: FFPROBE, sharp: sharpModule }),
      err => err.code === 'MEDIA_UNDECODABLE'
    );
  });

  test('JSON 报错回归仍失败且不逃逸', async () => {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"error":"upstream_failed"}');
    });
    try {
      const { job, result } = await runDownload('json-mp4', [{ id: '../../outside-job', url: `${srv.baseUrl}/media.mp4` }], { allowed_formats: ['audio'] });
      const item = result.summary.items[0];
      assert.equal(item.status, 'failed');
      assert.equal(item.error_code, 'UPSTREAM_ERROR_PAYLOAD');
      assert.equal(result.assets.length, 0);
      assert.equal(fs.existsSync(path.join(job, '..', 'outside-job.mp4')), false);
    } finally {
      await srv.stop();
    }
  });
});
