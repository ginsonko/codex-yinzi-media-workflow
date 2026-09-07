const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const {
  durationFromPackets,
  resolveLocalMediaPath,
  validateImage,
  validateVideo,
} = require('../src/services/productionMediaValidation');
const {
  getFfmpegPath,
  hasLocalFfmpeg,
  hasLocalFfprobe,
} = require('../src/utils/ffmpegPath');

let storageDir;
let cfg;

beforeEach(() => {
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'production-media-path-'));
  fs.mkdirSync(path.join(storageDir, 'projects', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(storageDir, 'projects', 'demo', 'shot.mp4'), 'media');
  cfg = {
    storage: {
      local_path: storageDir,
      base_url: 'http://127.0.0.1:5679/static',
    },
  };
});

afterEach(() => fs.rmSync(storageDir, { recursive: true, force: true }));

describe('production local media path resolution', () => {
  it('treats /static paths as storage-relative on Windows and Unix', () => {
    const resolved = resolveLocalMediaPath(cfg, '/static/projects/demo/shot.mp4');
    assert.equal(resolved.absolute_path, path.join(storageDir, 'projects', 'demo', 'shot.mp4'));
    assert.equal(resolved.relative_path, 'projects/demo/shot.mp4');
  });

  it('resolves configured storage URLs and absolute paths inside the storage root', () => {
    const fromUrl = resolveLocalMediaPath(cfg, 'http://127.0.0.1:5679/static/projects/demo/shot.mp4');
    const fromAbsolute = resolveLocalMediaPath(cfg, path.join(storageDir, 'projects', 'demo', 'shot.mp4'));
    assert.equal(fromUrl.absolute_path, fromAbsolute.absolute_path);
  });

  it('rejects traversal, paths outside storage, and unarchived remote URLs', () => {
    assert.throws(() => resolveLocalMediaPath(cfg, '/static/../outside.mp4'), /超出项目存储目录/);
    assert.throws(() => resolveLocalMediaPath(cfg, path.join(storageDir, '..', 'outside.mp4')), /超出项目存储目录/);
    assert.throws(() => resolveLocalMediaPath(cfg, 'https://example.com/video.mp4'), /必须先下载到项目存储目录/);
  });
});

describe('production video duration validation', () => {
  it('derives encoded duration from packet end timestamps', () => {
    assert.equal(durationFromPackets([
      { pts_time: '0.000', dts_time: 'N/A', duration_time: '0.033' },
      { pts_time: '4.967', dts_time: '4.967', duration_time: '0.033' },
      { pts_time: 'invalid', dts_time: '2.000', duration_time: '0.040' },
      { pts_time: 'N/A', dts_time: 'N/A', duration_time: '9.000' },
    ]), 5);
    assert.equal(durationFromPackets(null), 0);
    assert.equal(durationFromPackets([{ pts_time: 'N/A', dts_time: 'N/A' }]), 0);
  });

  it('accepts a real live WebM whose container omits duration metadata', {
    skip: !hasLocalFfmpeg() || !hasLocalFfprobe(),
    timeout: 30000,
  }, async () => {
    const mediaPath = path.join(storageDir, 'projects', 'demo', 'browser-live.webm');
    const generated = spawnSync(getFfmpegPath(), [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30',
      '-t', '5', '-an', '-c:v', 'libvpx-vp9', '-deadline', 'realtime',
      '-f', 'webm', '-live', '1', '-y', mediaPath,
    ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    assert.equal(generated.status, 0, generated.stderr);

    const receipt = await validateVideo(cfg, 'projects/demo/browser-live.webm', {
      expected_duration: 5,
      duration_tolerance: 1,
      expected_aspect_ratio: '4:3',
    });
    assert.ok(receipt.duration >= 4.9 && receipt.duration <= 5.1, receipt.duration);
    assert.equal(receipt.video_codec, 'vp9');
    assert.equal(receipt.nonblank, true);
    assert.equal(receipt.expected_aspect_ratio, '4:3');
    assert.equal(receipt.aspect_ratio_valid, true);
  });
});

describe('production media aspect validation', () => {
  it('accepts portrait pixels and rejects landscape pixels for a portrait task', async () => {
    const portraitPath = path.join(storageDir, 'projects', 'demo', 'portrait.png');
    const landscapePath = path.join(storageDir, 'projects', 'demo', 'landscape.png');
    await sharp({
      create: { width: 360, height: 640, channels: 3, background: { r: 40, g: 90, b: 130 } },
    }).png().toFile(portraitPath);
    await sharp({
      create: { width: 640, height: 360, channels: 3, background: { r: 130, g: 90, b: 40 } },
    }).png().toFile(landscapePath);

    const receipt = await validateImage(cfg, 'projects/demo/portrait.png', {
      expected_aspect_ratio: '9:16',
      allow_uniform: true,
    });
    assert.equal(receipt.expected_aspect_ratio, '9:16');
    assert.equal(receipt.aspect_ratio_valid, true);
    await assert.rejects(
      () => validateImage(cfg, 'projects/demo/landscape.png', {
        expected_aspect_ratio: '9:16',
        allow_uniform: true,
      }),
      (error) => error.code === 'PRODUCTION_ASPECT_RATIO_MISMATCH'
    );
  });
});
