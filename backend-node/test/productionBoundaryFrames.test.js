const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const { getFfmpegPath, hasLocalFfmpeg, hasLocalFfprobe } = require('../src/utils/ffmpegPath');
const {
  extractTailFrame,
  compareStrictFirstFrame,
  probeHardCutBoundary,
} = require('../src/services/productionBoundaryFrames');

const mediaToolsAvailable = hasLocalFfmpeg() && hasLocalFfprobe();

function createTwoStateVideo(filePath, first = 'red', second = 'blue') {
  const result = spawnSync(getFfmpegPath(), [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${first}:s=320x180:r=24:d=0.5`,
    '-f', 'lavfi', '-i', `color=c=${second}:s=320x180:r=24:d=0.5`,
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', filePath,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

describe('production boundary frame utilities', () => {
  it('extracts the actual final decoded frame and reuses its deterministic cache', {
    skip: !mediaToolsAvailable,
  }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-frame-test-'));
    const cfg = { storage: { local_path: root } };
    try {
      fs.mkdirSync(path.join(root, 'videos'), { recursive: true });
      createTwoStateVideo(path.join(root, 'videos', 'two-state.mp4'));
      const input = {
        run_id: 'run-a', shot_scope_id: '2', source_artifact_id: 10, source_hash: 'a'.repeat(64),
      };
      const first = await extractTailFrame(cfg, 'videos/two-state.mp4', input);
      const pixel = await sharp(first.absolute_path).removeAlpha().resize(1, 1).raw().toBuffer();
      assert.ok(pixel[2] > pixel[0] * 2, `expected blue tail frame, received rgb(${pixel[0]},${pixel[1]},${pixel[2]})`);
      const cached = await extractTailFrame(cfg, 'videos/two-state.mp4', input);
      assert.equal(cached.relative_path, first.relative_path);
      assert.equal(cached.cache_reused, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes a strict first-frame match and records hard-cut similarity without treating it as approval', {
    skip: !mediaToolsAvailable,
  }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-probe-test-'));
    const cfg = { storage: { local_path: root } };
    try {
      fs.mkdirSync(path.join(root, 'videos'), { recursive: true });
      fs.mkdirSync(path.join(root, 'images'), { recursive: true });
      createTwoStateVideo(path.join(root, 'videos', 'blue-to-red.mp4'), 'blue', 'red');
      await sharp({
        create: { width: 320, height: 180, channels: 3, background: { r: 0, g: 0, b: 254 } },
      }).png().toFile(path.join(root, 'images', 'blue.png'));
      const strict = await compareStrictFirstFrame(cfg, 'images/blue.png', 'videos/blue-to-red.mp4', { threshold: 0.9 });
      assert.equal(strict.passed, true);
      assert.ok(strict.similarity >= 0.9);
      const probe = await probeHardCutBoundary(cfg, 'videos/blue-to-red.mp4', 'videos/blue-to-red.mp4');
      assert.equal(probe.informational_only, true);
      assert.equal(probe.mode, 'hard_cut');
      assert.ok(probe.similarity >= 0 && probe.similarity <= 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
