const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { executeNative } = require('../src/services/skyReplaceVideo');

function bin(name) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  return r.stdout.trim().split(/\r?\n/)[0];
}

test('user-mask short video keeps an audio stream and black mask stays unchanged', async t => {
  const ffmpeg = bin('ffmpeg'), ffprobe = bin('ffprobe');
  if (!ffmpeg || !ffprobe) { t.skip('ffmpeg not on PATH'); return; }
  const repo = path.resolve(__dirname, '..');
  const sharp = createRequire(path.join(repo, 'package.json'))('sharp');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-sky-vid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scene = path.join(root, 'scene.mp4');
  const sky = path.join(root, 'sky.png');
  const mask = path.join(root, 'mask.png');
  const black = path.join(root, 'black.png');
  await sharp({ create: { width: 160, height: 96, channels: 3, background: { r: 80, g: 140, b: 220 } } }).png().toFile(path.join(root, 'top.png'));
  const mk = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=0x508cdc:s=160x96:d=1:r=8',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-pix_fmt', 'yuv420p', '-shortest', scene], { encoding: 'utf8' });
  assert.equal(mk.status, 0, mk.stderr.slice(-400));
  await sharp({ create: { width: 160, height: 96, channels: 3, background: { r: 220, g: 90, b: 20 } } }).png().toFile(sky);
  const maskBuf = Buffer.alloc(160 * 96, 0); for (let y = 0; y < 40; y++) maskBuf.fill(255, y * 160, (y + 1) * 160);
  await sharp(maskBuf, { raw: { width: 160, height: 96, channels: 1 } }).png().toFile(mask);
  await sharp({ create: { width: 160, height: 96, channels: 3, background: 'black' } }).png().toFile(black);
  const components = {
    'media.sharp': { directory: repo },
    'vision.sky-seg': { directory: path.resolve(__dirname, '../components/sky-seg') },
    'media.ffmpeg': { executables: { ffmpeg, ffprobe } },
  };
  const out = path.join(root, 'out.mp4');
  const details = await executeNative({
    inputPath: scene, outputPath: out,
    parameters: { sky_source: 0, mask_source: 1, route: 'user_mask', temporal_smooth: 0.3, feather_px: 2 },
    components, sources: [{ path: sky }, { path: mask }, { path: scene }],
  });
  assert.equal(details.route, 'user_mask');
  assert.equal(details.after.has_audio, true);
  assert.match(details.quality_note, /用户蒙版/);
  const probe = JSON.parse(spawnSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out], { encoding: 'utf8' }).stdout);
  assert.ok(probe.streams.some(s => s.codec_type === 'audio'));
  assert.ok(Number(probe.format.duration) > 0.3);
  const unchanged = await executeNative({
    inputPath: scene, outputPath: path.join(root, 'unchanged.mp4'),
    parameters: { sky_source: 0, mask_source: 1, route: 'user_mask' },
    components, sources: [{ path: sky }, { path: black }, { path: scene }],
  });
  assert.equal(unchanged.status, 'unchanged');
  assert.equal(unchanged.no_sky, true);
  assert.match(unchanged.quality_note, /不是分割失败/);
  assert.equal(unchanged.after.has_audio, true);
});

test('streaming video longer than 8s keeps exact frame count, duration and audio', async t => {
  const ffmpeg = bin('ffmpeg'), ffprobe = bin('ffprobe');
  if (!ffmpeg || !ffprobe) { t.skip('ffmpeg not on PATH'); return; }
  const repo = path.resolve(__dirname, '..');
  const sharp = createRequire(path.join(repo, 'package.json'))('sharp');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-sky-long-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scene = path.join(root, 'scene.mp4');
  const sky = path.join(root, 'sky.png');
  const mask = path.join(root, 'mask.png');
  const mk = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=0x508cdc:s=160x96:d=9.5:r=8',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=9.5', '-pix_fmt', 'yuv420p', '-shortest', scene], { encoding: 'utf8' });
  assert.equal(mk.status, 0, mk.stderr.slice(-400));
  await sharp({ create: { width: 160, height: 96, channels: 3, background: { r: 220, g: 90, b: 20 } } }).png().toFile(sky);
  const maskBuf = Buffer.alloc(160 * 96, 0); for (let y = 0; y < 40; y++) maskBuf.fill(255, y * 160, (y + 1) * 160);
  await sharp(maskBuf, { raw: { width: 160, height: 96, channels: 1 } }).png().toFile(mask);
  const components = {
    'media.sharp': { directory: repo },
    'vision.sky-seg': { directory: path.resolve(__dirname, '../components/sky-seg') },
    'media.ffmpeg': { executables: { ffmpeg, ffprobe } },
  };
  const details = await executeNative({
    inputPath: scene, outputPath: path.join(root, 'out.mp4'),
    parameters: { sky_source: 0, mask_source: 1, route: 'user_mask', chunk_frames: 16, temporal_smooth: 0.2, feather_px: 1, horizon_blend_px: 2 },
    components, sources: [{ path: sky }, { path: mask }, { path: scene }],
  });
  assert.ok(details.before.duration > 8);
  assert.equal(details.frame_count,76);
  assert.equal(details.processing,'streaming');
  assert.equal(details.after.has_audio, true);
  assert.ok(Math.abs(details.after.duration - details.before.duration) < 0.01);
  assert.ok(!fs.existsSync(path.join(root, 'sky-stream')));
});