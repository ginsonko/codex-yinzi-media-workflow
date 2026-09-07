const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const uploadService = require('../src/services/uploadService');

const log = { info() {}, warn() {}, error() {} };

test('content-addressed uploads reuse the same physical file and return a receipt', () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-upload-'));
  try {
    const buffer = Buffer.from('same-media-content');
    const expectedHash = createHash('sha256').update(buffer).digest('hex');
    const first = uploadService.uploadFile(storage, '', log, buffer, 'first.png', 'image/png', 'references');
    const second = uploadService.uploadFile(storage, '', log, buffer, 'second.png', 'image/png', 'references');
    assert.equal(first.sha256, expectedHash);
    assert.equal(first.deduplicated, false);
    assert.equal(second.sha256, expectedHash);
    assert.equal(second.deduplicated, true);
    assert.equal(second.local_path, first.local_path);
    assert.equal(fs.readFileSync(path.join(storage, first.local_path)).toString(), 'same-media-content');
    assert.equal(fs.readdirSync(path.join(storage, 'references')).filter((name) => !name.endsWith('.tmp')).length, 1);
  } finally {
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('different upload contents receive different content-addressed paths', () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-upload-'));
  try {
    const first = uploadService.uploadFile(storage, '', log, Buffer.from('one'), 'clip.mp4', 'video/mp4', 'references');
    const second = uploadService.uploadFile(storage, '', log, Buffer.from('two'), 'clip.mp4', 'video/mp4', 'references');
    assert.notEqual(first.sha256, second.sha256);
    assert.notEqual(first.local_path, second.local_path);
    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, false);
  } finally {
    fs.rmSync(storage, { recursive: true, force: true });
  }
});
