const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  inspectArtifactMedia,
  materializeArtifactMedia,
  historicalFile,
} = require('../src/services/productionReusableMedia');

const temporaryRoots = [];

function tempRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  temporaryRoots.push(root);
  return root;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function historicalArtifact(sourceRoot, sourcePath, bytes, overrides = {}) {
  const hash = sha256(bytes);
  return {
    id: 41,
    media_path: 'legacy/previews/shot-1.webm',
    mime_type: 'video/webm',
    content_hash: hash,
    content: {
      validation: {
        absolute_path: sourcePath,
        storage_root: sourceRoot,
        sha256: hash,
      },
    },
    ...overrides,
  };
}

afterEach(() => {
  while (temporaryRoots.length) {
    fs.rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

describe('production reusable media', () => {
  it('returns a current-storage file ready without copying it', async () => {
    const currentRoot = tempRoot('reusable-current');
    const relativePath = 'videos/current.mp4';
    const absolutePath = path.join(currentRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, Buffer.from('current-video'));
    const cfg = { storage: { local_path: currentRoot } };
    const artifact = {
      media_path: relativePath,
      mime_type: 'video/mp4',
      content_hash: sha256(Buffer.from('current-video')),
      content: {},
    };

    const inspected = inspectArtifactMedia(cfg, artifact);
    assert.equal(inspected.available, true);
    assert.equal(inspected.ready, true);
    assert.equal(inspected.media_url, '/static/videos/current.mp4');
    assert.equal(inspected.source_kind, 'current_storage');

    const prepared = await materializeArtifactMedia(cfg, artifact);
    assert.equal(prepared.media_path, relativePath);
    assert.equal(prepared.original_media_path, relativePath);
    assert.equal(fs.readdirSync(currentRoot).includes('reusable'), false);
  });

  it('inspects historical receipts cheaply and materializes one verified file idempotently', async () => {
    const currentRoot = tempRoot('reusable-target');
    const sourceRoot = tempRoot('reusable-source');
    const bytes = Buffer.from('verified-historical-video');
    const sourcePath = path.join(sourceRoot, 'previews', 'shot-1.webm');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, bytes);
    const artifact = historicalArtifact(sourceRoot, sourcePath, bytes);
    const cfg = { storage: { local_path: currentRoot } };

    const inspected = inspectArtifactMedia(cfg, artifact);
    assert.deepEqual(inspected, {
      available: true,
      ready: false,
      media_path: artifact.media_path,
      media_url: null,
      original_media_path: artifact.media_path,
      availability_reason: 'needs_materialization',
      source_kind: 'historical_storage',
    });

    const first = await materializeArtifactMedia(cfg, artifact);
    const second = await materializeArtifactMedia(cfg, artifact);
    assert.equal(first.media_path, second.media_path);
    assert.equal(first.sha256, sha256(bytes));
    assert.equal(first.original_media_path, artifact.media_path);
    assert.match(first.media_path, /^reusable\/[a-f0-9]{64}\/[a-f0-9]{64}\.webm$/);
    const cachedPath = path.join(currentRoot, first.media_path);
    assert.deepEqual(fs.readFileSync(cachedPath), bytes);
    assert.deepEqual(fs.readdirSync(path.dirname(cachedPath)), [path.basename(cachedPath)]);
  });

  it('rejects a historical file whose bytes do not match its receipt', async () => {
    const currentRoot = tempRoot('reusable-target');
    const sourceRoot = tempRoot('reusable-source');
    const bytes = Buffer.from('tampered-video');
    const sourcePath = path.join(sourceRoot, 'shot.mp4');
    fs.writeFileSync(sourcePath, bytes);
    const artifact = historicalArtifact(sourceRoot, sourcePath, bytes, {
      content_hash: '0'.repeat(64),
      content: { validation: { absolute_path: sourcePath, storage_root: sourceRoot, sha256: '0'.repeat(64) } },
    });

    await assert.rejects(
      materializeArtifactMedia({ storage: { local_path: currentRoot } }, artifact),
      (error) => error.code === 'REUSABLE_MEDIA_DIGEST_MISMATCH',
    );
    assert.equal(fs.existsSync(path.join(currentRoot, 'reusable')), false);
  });

  it('rejects receipts outside their recorded root and relative receipt paths', () => {
    const recordedRoot = tempRoot('reusable-recorded-root');
    const otherRoot = tempRoot('reusable-other-root');
    const bytes = Buffer.from('unrelated-file');
    const outsidePath = path.join(otherRoot, 'outside.mp4');
    fs.writeFileSync(outsidePath, bytes);

    const outside = historicalArtifact(recordedRoot, outsidePath, bytes);
    assert.deepEqual(historicalFile(outside), {
      available: false,
      reason: 'media_receipt_outside_root',
    });

    const relative = historicalArtifact(recordedRoot, outsidePath, bytes, {
      content: { validation: { absolute_path: 'outside.mp4', storage_root: recordedRoot, sha256: sha256(bytes) } },
    });
    assert.deepEqual(historicalFile(relative), {
      available: false,
      reason: 'media_receipt_path_not_absolute',
    });
  });
});
