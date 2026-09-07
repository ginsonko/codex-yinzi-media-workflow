const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getFfmpegPath, hasLocalFfmpeg } = require('../src/utils/ffmpegPath');
const { runStrictNormalizedMerge } = require('../src/services/videoMergeService');

const log = { info() {}, warn() {}, error() {} };

function run(args) {
  const result = spawnSync(getFfmpegPath(), args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
}

it('strict merge normalizes mixed dimensions/fps/audio and creates one real H.264/AAC output', {
  skip: !hasLocalFfmpeg(),
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-merge-test-'));
  try {
    const first = path.join(dir, 'first.mp4');
    const second = path.join(dir, 'second.mp4');
    const output = path.join(dir, 'final.mp4');
    run([
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=0x1e8f75:s=640x360:r=24:d=0.8',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=0.8',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', first,
    ]);
    run([
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=15:duration=0.8',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-y', second,
    ]);
    const ok = runStrictNormalizedMerge([first, second], output, { aspect_ratio: '16:9', preset: 'veryfast', crf: 24 }, log, dir);
    assert.equal(ok, true);
    assert.equal(fs.existsSync(output), true);
    assert.ok(fs.statSync(output).size > 8192);
    const inspection = spawnSync(getFfmpegPath(), ['-hide_banner', '-i', output], { encoding: 'utf8' });
    assert.match(inspection.stderr, /Video:\s*h264/i);
    assert.match(inspection.stderr, /Audio:\s*aac/i);
    assert.match(inspection.stderr, /1280x720/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
