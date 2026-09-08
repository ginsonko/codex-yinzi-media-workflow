const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalog = require('../src/services/orchestrationModuleCatalog');

test('registered modules hot-load, survive reload, and cannot replace builtins or escape the registry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-modules-'));
  const previous = process.env.YINZI_WORKFLOW_MODULE_DIR;
  process.env.YINZI_WORKFLOW_MODULE_DIR = dir;
  try {
    catalog.registerModule({ module_id: 'image.poster-overlay', title: '海报排版', description: '保留原图，叠加准确文字', inputs: ['image'], outputs: ['image'], example: '纠正版本号' });
    assert.equal(catalog.listModules({ q: '海报' }).items[0].module_id, 'image.poster-overlay');
    delete require.cache[require.resolve('../src/services/orchestrationModuleCatalog')];
    assert.equal(require('../src/services/orchestrationModuleCatalog').getModule('image.poster-overlay').title, '海报排版');
    assert.throws(() => catalog.registerModule({ module_id: '../escape' }));
    assert.throws(() => catalog.registerModule({ module_id: 'image.generate' }));
    fs.writeFileSync(path.join(dir, 'broken.json'), '{bad');
    assert.ok(catalog.listModules().items.some(item => item.module_id === 'image.generate'));
    assert.ok(catalog.listModules().items.some(item => item.module_id === 'image.poster-overlay'));
  } finally {
    if (previous === undefined) delete process.env.YINZI_WORKFLOW_MODULE_DIR;
    else process.env.YINZI_WORKFLOW_MODULE_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('catalog exposes local-first character, animation, beauty and fast batch choices', () => {
  const ids = catalog.listModules().items.map((item) => item.module_id);
  for (const id of [
    'video.character-replace-local',
    'video.identity-repair-local',
    'video.to-animation-local',
    'video.beauty-local',
    'image.batch-generate-fast',
  ]) assert.ok(ids.includes(id), `missing ${id}`);
  assert.equal(catalog.getModule('video.character-replace-local').side_effects.paid, false);
});
