const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const {
  prepareYinziReferenceImage,
  YINZI_REFERENCE_IMAGE_PROFILE,
  YINZI_REFERENCE_IMAGE_MAX_LONG_EDGE,
  YINZI_REFERENCE_IMAGE_MAX_BYTES,
} = require('../src/services/yinziReferenceImage');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

describe('Yinzi local reference-image preparation', () => {
  it('creates and reuses a bounded JPEG without changing the canonical image', async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-reference-image-'));
    try {
      const source = path.join(storage, 'canonical.png');
      const width = 2048;
      const height = 1152;
      await sharp(crypto.randomBytes(width * height * 3), {
        raw: { width, height, channels: 3 },
      }).png({ compressionLevel: 0 }).toFile(source);
      const sourceHash = sha256(source);
      assert.ok(fs.statSync(source).size > YINZI_REFERENCE_IMAGE_MAX_BYTES);

      const first = await prepareYinziReferenceImage(source, { storage_root: storage });
      assert.equal(first.normalized, true);
      assert.match(first.file_path, new RegExp(`${sourceHash}-${YINZI_REFERENCE_IMAGE_PROFILE}\\.jpg$`));
      assert.ok(first.probe.bytes <= YINZI_REFERENCE_IMAGE_MAX_BYTES);
      assert.ok(Math.max(first.probe.width, first.probe.height) <= YINZI_REFERENCE_IMAGE_MAX_LONG_EDGE);
      assert.equal(first.probe.format, 'jpeg');
      assert.equal(sha256(source), sourceHash);

      const second = await prepareYinziReferenceImage(source, { storage_root: storage });
      assert.equal(second.file_path, first.file_path);
      assert.equal(second.cache_reused, true);
      assert.equal(sha256(source), sourceHash);
    } finally {
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it('reuses a valid image that is already within the transport profile', async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-reference-image-small-'));
    try {
      const source = path.join(storage, 'small.png');
      await sharp({ create: { width: 640, height: 360, channels: 3, background: '#315f73' } }).png().toFile(source);
      const prepared = await prepareYinziReferenceImage(source, { storage_root: storage });
      assert.equal(prepared.normalized, false);
      assert.equal(prepared.file_path, source);
      assert.equal(fs.existsSync(path.join(storage, '.provider-reference-cache')), false);
    } finally {
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it('fails closed on an invalid local image', async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-reference-image-invalid-'));
    try {
      const source = path.join(storage, 'invalid.png');
      fs.writeFileSync(source, Buffer.from('not an image'));
      await assert.rejects(prepareYinziReferenceImage(source, { storage_root: storage }), /image|unsupported|format/i);
      assert.equal(fs.existsSync(path.join(storage, '.provider-reference-cache')), false);
    } finally {
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });
});
