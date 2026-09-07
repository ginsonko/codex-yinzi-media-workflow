const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discoverProgramFilesBins, isPlausibleBinaryFile } = require('../src/utils/ffmpegPath');

it('discovers versioned FFmpeg installations without hard-coding a release name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-discovery-test-'));
  try {
    const expected = path.join(root, 'ffmpeg-2026-test-build', 'bin', 'ffprobe.exe');
    fs.mkdirSync(path.dirname(expected), { recursive: true });
    fs.writeFileSync(expected, 'test');
    fs.mkdirSync(path.join(root, 'unrelated-tool', 'bin'), { recursive: true });
    assert.deepEqual(discoverProgramFilesBins('ffprobe.exe', [root]), [expected]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('does not treat a zero-byte FFmpeg placeholder as an installed binary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-placeholder-test-'));
  try {
    const placeholder = path.join(root, 'ffmpeg.exe');
    fs.writeFileSync(placeholder, '');
    assert.equal(isPlausibleBinaryFile(placeholder), false);
    fs.writeFileSync(placeholder, Buffer.alloc(1024 * 1024));
    assert.equal(isPlausibleBinaryFile(placeholder), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
