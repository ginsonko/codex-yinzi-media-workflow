const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  getFfmpegPath,
  hasLocalFfmpeg,
  hasLocalFfprobe,
} = require('../src/utils/ffmpegPath');
const {
  prepareYinziReferenceVideo,
  probeReferenceVideo,
  providerSafeMp4,
  parseFrameRate,
} = require('../src/services/yinziReferenceMedia');

const mediaToolsAvailable = hasLocalFfmpeg() && hasLocalFfprobe();

function makeVideo(filePath, codec, size = '320x180', fps = 24, duration = 1) {
  const result = spawnSync(getFfmpegPath(), [
    '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x1c6f78:s=${size}:r=${fps}:d=${duration}`,
    '-c:v', codec, '-pix_fmt', 'yuv420p', '-r', String(fps), '-an', '-y', filePath,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

describe('Yinzi local reference-video preparation', () => {
  it('parses rational frame rates and rejects invalid rates', () => {
    assert.equal(parseFrameRate('24/1'), 24);
    assert.equal(parseFrameRate('24000/1001'), 24000 / 1001);
    assert.equal(parseFrameRate('0/0'), 0);
    assert.equal(parseFrameRate('not-a-rate'), 0);
  });

  it('normalizes VP9 WebM to provider-safe H.264 MP4 and reuses the cache', {
    skip: !mediaToolsAvailable,
  }, () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-reference-media-'));
    try {
      const source = path.join(storage, 'director-preview.webm');
      makeVideo(source, 'libvpx-vp9');
      const first = prepareYinziReferenceVideo(source, { storage_root: storage, aspect_ratio: '16:9' });
      assert.equal(first.normalized, true);
      assert.match(first.file_path, /\.provider-reference-cache[\\/]yinzi[\\/][a-f0-9]{64}-yinzi-ref-v3-fps24-1280x720\.mp4$/);
      const probe = probeReferenceVideo(first.file_path);
      assert.equal(probe.video_codec, 'h264');
      assert.equal(probe.pixel_format, 'yuv420p');
      assert.equal(probe.width, 1280);
      assert.equal(probe.height, 720);
      assert.equal(probe.r_frame_rate, 24);
      assert.equal(probe.avg_frame_rate, 24);
      assert.ok(probe.duration > 0.8);
      const mtime = fs.statSync(first.file_path).mtimeMs;

      const second = prepareYinziReferenceVideo(source, { storage_root: storage, aspect_ratio: '16:9' });
      assert.equal(second.file_path, first.file_path);
      assert.equal(second.cache_reused, true);
      assert.equal(fs.statSync(second.file_path).mtimeMs, mtime);
    } finally {
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it('reuses an already compatible H.264 MP4 without creating a cache file', {
    skip: !mediaToolsAvailable,
  }, () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-reference-h264-'));
    try {
      const source = path.join(storage, 'approved-shot.mp4');
      makeVideo(source, 'libx264', '1280x720');
      const prepared = prepareYinziReferenceVideo(source, { storage_root: storage, aspect_ratio: '16:9' });
      assert.equal(prepared.file_path, source);
      assert.equal(prepared.normalized, false);
      assert.equal(fs.existsSync(path.join(storage, '.provider-reference-cache')), false);
    } finally {
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it('normalizes a larger H.264 MP4 to the exact provider request canvas', {
    skip: !mediaToolsAvailable,
  }, () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-reference-large-h264-'));
    try {
      const source = path.join(storage, 'approved-shot-4k.mp4');
      makeVideo(source, 'libx264', '2560x1440');
      const prepared = prepareYinziReferenceVideo(source, { storage_root: storage, aspect_ratio: '16:9' });
      assert.equal(prepared.normalized, true);
      assert.notEqual(prepared.file_path, source);
      assert.equal(prepared.probe.width, 1280);
      assert.equal(prepared.probe.height, 720);
      assert.equal(prepared.probe.r_frame_rate, 24);
      assert.equal(prepared.probe.avg_frame_rate, 24);
      assert.match(prepared.file_path, /yinzi-ref-v3-fps24-1280x720\.mp4$/);
    } finally {
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it('normalizes an otherwise compatible 30fps H.264 MP4 to exact 24fps CFR', {
    skip: !mediaToolsAvailable,
  }, () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-reference-30fps-'));
    try {
      const source = path.join(storage, 'approved-shot-30fps.mp4');
      makeVideo(source, 'libx264', '1280x720', 30);
      const sourceProbe = probeReferenceVideo(source);
      assert.equal(sourceProbe.r_frame_rate, 30);
      assert.equal(sourceProbe.avg_frame_rate, 30);
      assert.equal(providerSafeMp4(source, sourceProbe, { width: 1280, height: 720 }), false);

      const prepared = prepareYinziReferenceVideo(source, { storage_root: storage, aspect_ratio: '16:9' });
      assert.equal(prepared.normalized, true);
      assert.equal(prepared.probe.r_frame_rate, 24);
      assert.equal(prepared.probe.avg_frame_rate, 24);
      assert.match(prepared.file_path, /yinzi-ref-v3-fps24-1280x720\.mp4$/);
    } finally {
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it('extracts and caches a provider-safe tail window without changing the source', {
    skip: !mediaToolsAvailable,
  }, () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-reference-window-'));
    try {
      const source = path.join(storage, 'approved-shot.mp4');
      makeVideo(source, 'libx264', '1280x720', 24, 4);
      const sourceHash = require('node:crypto').createHash('sha256').update(fs.readFileSync(source)).digest('hex');
      const first = prepareYinziReferenceVideo(source, {
        storage_root: storage,
        aspect_ratio: '16:9',
        clip_start_seconds: 1.25,
        clip_duration_seconds: 2.25,
      });
      assert.notEqual(first.file_path, source);
      assert.match(first.file_path, new RegExp(`${sourceHash}-yinzi-ref-v3-fps24-1280x720-clip-s1250-d2250\\.mp4$`));
      assert.ok(first.probe.duration > 2.0 && first.probe.duration < 2.5);
      assert.equal(first.probe.width, 1280);
      assert.equal(first.probe.height, 720);
      assert.equal(first.probe.video_codec, 'h264');
      assert.equal(first.probe.r_frame_rate, 24);
      assert.equal(first.probe.avg_frame_rate, 24);
      const second = prepareYinziReferenceVideo(source, {
        storage_root: storage,
        aspect_ratio: '16:9',
        clip_start_seconds: 1.25,
        clip_duration_seconds: 2.25,
      });
      assert.equal(second.file_path, first.file_path);
      assert.equal(second.cache_reused, true);
      const afterHash = require('node:crypto').createHash('sha256').update(fs.readFileSync(source)).digest('hex');
      assert.equal(afterHash, sourceHash);
    } finally {
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });
});
