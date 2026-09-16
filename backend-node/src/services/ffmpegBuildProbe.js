'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const cache = new Map();
const inflight = new Map();

function unsignedStatus(code) {
  if (typeof code !== 'number') return null;
  return code < 0 ? code >>> 0 : code;
}

function statusHex(code) {
  const status = unsignedStatus(code);
  return status == null ? null : '0x' + status.toString(16);
}

function executableIdentity(file) {
  const resolved = path.resolve(file);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || !stat.size) {
    throw Object.assign(new Error('FFmpeg 可执行文件不是可读取的非空文件'), { code: 'FFMPEG_EXECUTABLE_MISSING', path: resolved });
  }
  fs.accessSync(resolved, fs.constants.R_OK);
  return {
    path: resolved,
    size: stat.size,
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs,
    ino: stat.ino,
  };
}

function identityKey(identity) {
  return [identity.path, identity.size, identity.mtime_ms, identity.ctime_ms, identity.ino].join('|');
}

function cacheKey(identity, probeKey) {
  return identityKey(identity) + '::' + probeKey;
}

function writePcmWav(file, { durationSec = 2, sampleRate = 48000, frequency = 440 } = {}) {
  const frames = Math.round(sampleRate * durationSec);
  const dataBytes = frames * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 16000);
    buffer.writeInt16LE(sample, 44 + i * 2);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
  return file;
}

function defaultFixturePath() {
  return path.join(os.tmpdir(), 'yinzi-ffmpeg-probe', 'anlmdn-2s-48000-mono.wav');
}

function ensureTwoSecondFixture(file = defaultFixturePath()) {
  const expected = 44 + 48000 * 2 * 2;
  try {
    const stat = fs.statSync(file);
    if (stat.isFile() && stat.size === expected) return file;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return writePcmWav(file, { durationSec: 2, sampleRate: 48000, frequency: 440 });
}

function spawnOnce(executable, args, { timeoutMs = 15000, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch {}
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1024 * 1024); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1024 * 1024); });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        code,
        signal,
        timedOut,
        unsigned: unsignedStatus(code),
        hex: statusHex(code),
      });
    });
  });
}

function failProbe(result, { identity, probeKey, filter, timeoutMs }) {
  const status = result.timedOut ? 'timeout' : (result.hex || String(result.code));
  const original = result.timedOut
    ? `探测超时（>${timeoutMs}ms），已结束子进程`
    : `本地进程未完成 (${result.code}${result.hex ? '/' + result.hex : ''}${result.signal ? '/' + result.signal : ''})`;
  const error = new Error(
    `${original}: ${String(result.stderr || '').slice(-1500) || '无 stderr'}。当前 FFmpeg 构建的 ${probeKey} 不可用；请改用 local.audio.afftdn，或更换可完成该滤镜的 FFmpeg 后再试。不会自动替换滤镜。`
  );
  error.code = 'ANLMDN_BUILD_UNAVAILABLE';
  error.original_code = result.code;
  error.original_status = result.unsigned;
  error.original_hex = result.hex;
  error.signal = result.signal;
  error.timed_out = Boolean(result.timedOut);
  error.stderr = result.stderr;
  error.filter = filter;
  error.ffmpeg = identity;
  error.probe_key = probeKey;
  error.status = status;
  return error;
}

async function probeExecutable({
  executable,
  args,
  probeKey,
  timeoutMs = 15000,
  spawnImpl,
  identityFn = executableIdentity,
}) {
  const identity = identityFn(executable);
  const key = cacheKey(identity, probeKey);
  if (cache.has(key)) {
    const hit = cache.get(key);
    if (hit.ok) return { ...hit, reused: true };
    throw hit.error;
  }
  if (inflight.has(key)) return inflight.get(key);
  const pending = (async () => {
    const result = await spawnOnce(executable, args, { timeoutMs, spawnImpl });
    if (result.timedOut || result.code !== 0 || result.signal) {
      const error = failProbe(result, { identity, probeKey, filter: args.join(' '), timeoutMs });
      cache.set(key, { ok: false, error, identity, probeKey });
      throw error;
    }
    const value = { ok: true, identity, probeKey, code: 0, reused: false };
    cache.set(key, value);
    return value;
  })();
  inflight.set(key, pending);
  try {
    return await pending;
  } finally {
    inflight.delete(key);
  }
}

const ANLMDN_FILTER = 'anlmdn=s=0.00005:p=0.002:r=0.006:m=11:o=o';
const ANLMDN_PROBE_KEY = 'anlmdn:2s-wav:null';

async function prepareAnlmdnBuild({ ffmpeg, timeoutMs = 15000, spawnImpl, fixturePath, identityFn } = {}) {
  if (!ffmpeg) throw Object.assign(new Error('缺少实际选定的 FFmpeg 可执行文件'), { code: 'FFMPEG_EXECUTABLE_MISSING' });
  const fixture = ensureTwoSecondFixture(fixturePath);
  const args = [
    '-nostdin', '-y', '-v', 'error', '-threads', '2', '-filter_threads', '2',
    '-protocol_whitelist', 'file,pipe', '-i', fixture, '-vn', '-af', ANLMDN_FILTER, '-f', 'null', '-',
  ];
  return probeExecutable({
    executable: ffmpeg,
    args,
    probeKey: ANLMDN_PROBE_KEY,
    timeoutMs,
    spawnImpl,
    identityFn,
  });
}

function resetProbeCache() {
  cache.clear();
  inflight.clear();
}

module.exports = {
  ANLMDN_FILTER,
  ANLMDN_PROBE_KEY,
  executableIdentity,
  identityKey,
  ensureTwoSecondFixture,
  prepareAnlmdnBuild,
  probeExecutable,
  resetProbeCache,
  statusHex,
  unsignedStatus,
  writePcmWav,
};
