const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const service = require('../src/services/privacyDerivationService');

test('privacy derivation is reversible, density bounded, and preserves original', async () => {
  const db = new Database(':memory:'); runMigrationsAndEnsure(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-root-')); const source = path.join(root, 'face.png');
  await sharp({ create: { width: 160, height: 120, channels: 3, background: { r: 220, g: 180, b: 160 } } }).png().toFile(source);
  const original = fs.readFileSync(source); const result = await service.derive(db, { storage: { local_path: root } }, { source_media_path: 'face.png', density: 9, seed: 42 });
  assert.equal(result.density, 0.6); assert.equal(result.reversible, true); assert.equal(fs.readFileSync(source).equals(original), true); assert.ok(fs.existsSync(path.join(root, result.derived_media_path)));
  assert.equal(service.list(db).length, 1); const removed = service.remove(db, { storage: { local_path: root } }, result.id); assert.equal(removed.source_preserved, true); assert.equal(service.list(db).length, 0);
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test('face_grid mode creates nine independent detail cells and keeps source unchanged', async () => {
  const db = new Database(':memory:'); runMigrationsAndEnsure(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-grid-')); const source = path.join(root, 'face.png');
  await sharp({ create: { width: 300, height: 240, channels: 3, background: { r: 80, g: 120, b: 180 } } }).png().toFile(source);
  const original = fs.readFileSync(source); const result = await service.derive(db, { storage: { local_path: root } }, { source_media_path: 'face.png', mode: 'face_grid', face_region: { x: 0.1, y: 0.1, width: 0.8, height: 0.7, source: 'test_detector' }, seed: 7 });
  assert.equal(result.mode, 'face_grid'); assert.equal(result.grid.rows, 3); assert.equal(result.grid.columns, 3); assert.equal(result.grid.cells.length, 9); assert.equal(result.grid.reconstructed, false);
  assert.equal(fs.readFileSync(source).equals(original), true); assert.ok(fs.statSync(path.join(root, result.derived_media_path)).size > 0);
  const metadata = await sharp(path.join(root, result.derived_media_path)).metadata(); assert.ok(metadata.width > 0 && metadata.height > 0);
  const listed = service.list(db)[0]; assert.equal(listed.mode, 'face_grid'); assert.equal(listed.grid.cells.length, 9);
  const removed = service.remove(db, { storage: { local_path: root } }, result.id); assert.equal(removed.source_preserved, true); assert.equal(fs.existsSync(source), true);
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});
