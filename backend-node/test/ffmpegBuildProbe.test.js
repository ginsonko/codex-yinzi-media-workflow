const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  ANLMDN_FILTER,
  ANLMDN_PROBE_KEY,
  executableIdentity,
  identityKey,
  prepareAnlmdnBuild,
  resetProbeCache,
  writePcmWav,
} = require('../src/services/ffmpegBuildProbe');

function fakeSpawn({ code = 0, signal = null, stderr = '', delay = 5, hang = false } = {}) {
  const calls = [];
  const spawnImpl = (executable, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setTimeout(() => child.emit('close', null, 'SIGTERM'), 1);
    };
    calls.push({ executable, args });
    if (!hang) {
      setTimeout(() => {
        if (stderr) child.stderr.emit('data', Buffer.from(stderr));
        child.emit('close', code, signal);
      }, delay);
    }
    return child;
  };
  return { spawnImpl, calls };
}

test('success is cached by executable identity and concurrent callers share one spawn', async () => {
  resetProbeCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-probe-ok-'));
  const ffmpeg = path.join(root, 'ffmpeg.exe');
  fs.writeFileSync(ffmpeg, 'ok-build');
  const { spawnImpl, calls } = fakeSpawn({ code: 0 });
  const [a, b] = await Promise.all([
    prepareAnlmdnBuild({ ffmpeg, spawnImpl }),
    prepareAnlmdnBuild({ ffmpeg, spawnImpl }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.includes(ANLMDN_FILTER), true);
  assert.equal(calls[0].args.includes('-f') && calls[0].args.includes('null'), true);
  assert.ok(!calls[0].args.includes(path.resolve('user.wav')));
  const reused = await prepareAnlmdnBuild({ ffmpeg, spawnImpl });
  assert.equal(reused.reused, true);
  assert.equal(calls.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('nonzero status is preserved, cached, and never treated as success', async () => {
  resetProbeCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-probe-fail-'));
  const ffmpeg = path.join(root, 'ffmpeg.exe');
  fs.writeFileSync(ffmpeg, 'bad-build');
  const { spawnImpl, calls } = fakeSpawn({ code: 3221226356, stderr: 'heap corruption' });
  await assert.rejects(
    () => prepareAnlmdnBuild({ ffmpeg, spawnImpl }),
    error => {
      assert.equal(error.code, 'ANLMDN_BUILD_UNAVAILABLE');
      assert.equal(error.original_code, 3221226356);
      assert.equal(error.original_hex, '0xc0000374');
      assert.match(error.message, /afftdn/);
      assert.match(error.message, /不会自动替换滤镜/);
      return true;
    }
  );
  await assert.rejects(() => prepareAnlmdnBuild({ ffmpeg, spawnImpl }), { code: 'ANLMDN_BUILD_UNAVAILABLE' });
  assert.equal(calls.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('file identity change invalidates cache and timeout kills the child', async () => {
  resetProbeCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-probe-id-'));
  const ffmpeg = path.join(root, 'ffmpeg.exe');
  fs.writeFileSync(ffmpeg, 'first');
  const first = fakeSpawn({ code: 0 });
  await prepareAnlmdnBuild({ ffmpeg, spawnImpl: first.spawnImpl });
  assert.equal(first.calls.length, 1);
  const before = identityKey(executableIdentity(ffmpeg));
  const laterStamp = new Date(Date.now() + 2000);
  fs.writeFileSync(ffmpeg, 'second-build-bytes');
  fs.utimesSync(ffmpeg, laterStamp, laterStamp);
  const after = identityKey(executableIdentity(ffmpeg));
  assert.notEqual(after, before);
  const later = fakeSpawn({ hang: true });
  await assert.rejects(
    () => prepareAnlmdnBuild({ ffmpeg, spawnImpl: later.spawnImpl, timeoutMs: 30 }),
    error => error.timed_out === true && error.code === 'ANLMDN_BUILD_UNAVAILABLE'
  );
  assert.equal(later.calls.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('fixture is a two-second WAV and independent of user audio', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-probe-wav-'));
  const file = writePcmWav(path.join(root, 'probe.wav'), { durationSec: 2, sampleRate: 48000 });
  assert.equal(fs.statSync(file).size, 44 + 48000 * 2 * 2);
  assert.equal(ANLMDN_PROBE_KEY, 'anlmdn:2s-wav:null');
  fs.rmSync(root, { recursive: true, force: true });
});
