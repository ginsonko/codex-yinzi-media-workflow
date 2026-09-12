const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectLocalAssets } = require('../src/utils/localAssetPreflight');

test('remote references are deferred without network or local file checks', (t) => {
  t.mock.method(fs, 'statSync', () => { throw Error('must not inspect remote reference'); });
  const result = inspectLocalAssets({ reference_media: [
    'file_id:file_saved', 'https://media.example/clip.mp4', 'data:image/png;base64,AAAA',
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.checked_local, 0);
  assert.equal(result.deferred, 3);
  for (const item of result.checks) {
    assert.equal(item.readable, null);
    assert.equal(item.exists, null);
    assert.equal(item.verification, 'deferred');
  }
  assert.equal(fs.statSync.mock.callCount(), 0);
  assert.equal(JSON.stringify(result).includes('base64'), false);
});

test('mixed references still detect missing local files and directories', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '素材.txt');
  fs.writeFileSync(file, 'readable');
  const result = inspectLocalAssets({ reference_media: [
    file, file, path.join(root, 'missing.mp4'), root, 'file_id:file_saved',
  ] });
  assert.equal(result.checked, 4);
  assert.equal(result.checked_local, 3);
  assert.equal(result.deferred, 1);
  assert.equal(result.ok, false);
  assert.equal(result.checks[0].readable, true);
  assert.equal(result.checks[1].exists, false);
  assert.equal(result.checks[2].is_file, false);
  assert.equal(result.checks[2].ok, false);
});

test('a readable file on another Windows drive is usable', (t) => {
  t.mock.method(fs, 'statSync', () => ({ isFile: () => true }));
  t.mock.method(fs, 'accessSync', () => {});
  const currentDrive = path.parse(process.cwd()).root[0]?.toUpperCase();
  const otherDrive = currentDrive === 'Z' ? 'Y' : 'Z';
  const result = inspectLocalAssets({ local_paths: [`${otherDrive}:\\media\\source.mp4`] });
  assert.equal(result.ok, true);
  assert.equal(result.checks[0].readable, true);
});

test('permission denied remains a failed local check', (t) => {
  t.mock.method(fs, 'statSync', () => ({ isFile: () => true }));
  t.mock.method(fs, 'accessSync', () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); });
  const result = inspectLocalAssets({ local_paths: ['private.mp4'] });
  assert.equal(result.ok, false);
  assert.equal(result.checks[0].exists, true);
  assert.equal(result.checks[0].readable, false);
});
