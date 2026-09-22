const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discoverDraftRoot, prepareEditorCopy } = require('../src/services/jianyingDelivery');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jy-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'original'), drafts = path.join(root, '草稿 用户');
  fs.mkdirSync(source); fs.mkdirSync(drafts);
  fs.writeFileSync(path.join(source, 'draft_content.json'), JSON.stringify({ id: 'test-draft-1', materials: {} }));
  fs.writeFileSync(path.join(source, 'draft_meta_info.json'), JSON.stringify({ draft_id: 'test-draft-1', draft_name: '测试 : 工程', draft_fold_path: source }));
  const result = { draft_path: source, draft_id: 'test-draft-1' };
  return { root, source, drafts, result, location: { ready: true, path: drafts } };
}
test('discovers custom INI directory and keeps unavailable configured location explicit', t => {
  const { root, drafts } = fixture(t);
  const configDir = path.join(root, 'JianyingPro/User Data/Config'); fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'globalSetting'), `[General]\ncurrentCustomDraftPath=${drafts.replace(/\\/g, '\\\\')}\n`);
  const detected = discoverDraftRoot({}, { LOCALAPPDATA: root }, 'win32');
  assert.equal(detected.ready, true); assert.equal(detected.path, drafts); assert.equal(detected.source, 'jianying_settings');
  const configured = discoverDraftRoot({ config_path: path.join(root, 'config.json'), drafts_root: './missing' }, { LOCALAPPDATA: root }, 'win32');
  assert.equal(configured.ready, false); assert.equal(configured.source, 'configuration');
  assert.equal(configured.path, path.join(root, 'missing'));
  assert.equal(discoverDraftRoot({}, {}, 'linux').ready, false);
});
test('editor copy is independent; metadata targets editor directory; reuse preserves editor edits', t => {
  const f = fixture(t), originals = fs.readdirSync(f.source).map(name => [name, fs.readFileSync(path.join(f.source, name), 'utf8')]);
  const copied = prepareEditorCopy(f.result, f.location);
  assert.equal(copied.status, 'editor_copy_prepared'); assert.equal(copied.reused, false);
  assert.equal(path.dirname(copied.draft_path), f.drafts);
  const meta = JSON.parse(fs.readFileSync(path.join(copied.draft_path, 'draft_meta_info.json'), 'utf8'));
  assert.equal(meta.draft_fold_path, copied.draft_path); assert.equal(meta.draft_name, copied.project_name);
  assert.equal(meta.draft_root_path, f.drafts);
  fs.writeFileSync(path.join(copied.draft_path, 'draft_content.json'), 'editor-owned encrypted or edited bytes');
  const repeated = prepareEditorCopy(f.result, f.location);
  assert.equal(repeated.reused, true); assert.equal(repeated.draft_path, copied.draft_path);
  assert.equal(fs.readdirSync(f.drafts).length, 1);
  assert.equal(fs.readFileSync(path.join(copied.draft_path, 'draft_content.json'), 'utf8'), 'editor-owned encrypted or edited bytes');
  for (const [name, value] of originals) assert.equal(fs.readFileSync(path.join(f.source, name), 'utf8'), value);
  assert.equal(fs.existsSync(path.join(f.drafts, 'root_meta_info.json')), false);
});
test('ownership mismatch never replaces an existing editor project', t => {
  const f = fixture(t), copy = prepareEditorCopy(f.result, f.location);
  fs.unlinkSync(path.join(copy.draft_path, 'yinzi-editor-copy.json'));
  fs.writeFileSync(path.join(copy.draft_path, 'keep.txt'), 'user data');
  const again = prepareEditorCopy(f.result, f.location);
  assert.equal(again.status, 'manual_location_needed');
  assert.equal(fs.readFileSync(path.join(copy.draft_path, 'keep.txt'), 'utf8'), 'user data');
  assert.equal(fs.readdirSync(f.drafts).length, 1);
});
test('missing or invalid location preserves complete generated output and offers a concrete next step', t => {
  const f = fixture(t);
  const absent = prepareEditorCopy(f.result, { ready: false, reason: '未找到软件' });
  assert.equal(absent.status, 'manual_location_needed'); assert.equal(absent.draft_path, f.source);
  assert.match(absent.next_action, /未找到软件/);
  const notDirectory = path.join(f.root, 'file'); fs.writeFileSync(notDirectory, 'keep');
  const failed = prepareEditorCopy(f.result, { ready: true, path: notDirectory });
  assert.equal(failed.status, 'manual_location_needed'); assert.equal(fs.readFileSync(notDirectory, 'utf8'), 'keep');
  assert.ok(fs.existsSync(path.join(f.source, 'draft_content.json')));
  assert.equal(fs.readdirSync(f.root).some(s => s.startsWith('.yinzi-jianying-')), false);
});
test('modified source cannot overwrite a prior editor copy', t => {
  const f = fixture(t), first = prepareEditorCopy(f.result, f.location);
  fs.writeFileSync(path.join(f.source, 'new.txt'), 'new input');
  const result = prepareEditorCopy(f.result, f.location);
  assert.equal(result.status, 'manual_location_needed');
  assert.equal(fs.existsSync(path.join(first.draft_path, 'new.txt')), false);
});

test('incomplete editor copy is reported without replacing user files', t => {
  const f = fixture(t), first = prepareEditorCopy(f.result, f.location);
  fs.unlinkSync(path.join(first.draft_path, 'draft_content.json'));
  const again = prepareEditorCopy(f.result, f.location);
  assert.equal(again.status, 'manual_location_needed');
  assert.match(again.reason, /draft_content.json/);
  assert.equal(fs.existsSync(path.join(first.draft_path, 'draft_content.json')), false);
  assert.equal(fs.readdirSync(f.drafts).length, 1);
});

test('template marker is replaced only in the new editor copy', t => {
  const f = fixture(t), marker = path.join(f.source, 'yinzi-editor-copy.json');
  fs.writeFileSync(marker, '{"draft_id":"old-template"}');
  const copy = prepareEditorCopy(f.result, f.location);
  assert.equal(copy.status, 'editor_copy_prepared');
  assert.equal(JSON.parse(fs.readFileSync(path.join(copy.draft_path, 'yinzi-editor-copy.json'))).draft_id, f.result.draft_id);
  assert.equal(fs.readFileSync(marker, 'utf8'), '{"draft_id":"old-template"}');
});
