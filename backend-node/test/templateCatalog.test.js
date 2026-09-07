const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../src/services/templateCatalog');

test('template catalog exposes all V0.1.4 templates with stable slots', () => {
  const result = catalog.listTemplates();
  assert.equal(result.total, 13);
  assert.ok(result.items.every((item) => item.id && item.version === 1 && item.slots.length > 0));
  assert.equal(catalog.getTemplate('novel-drama').prompt_key, 'template.novel-drama.v1');
  assert.equal(catalog.getTemplate('image-to-video').workflow.requires_scene, false);
  assert.equal(catalog.getTemplate('novel-drama').workflow.requires_scene, true);
  assert.equal(catalog.getTemplate('does-not-exist'), null);
});

test('template catalog search is bounded and case insensitive', () => {
  const result = catalog.listTemplates({ q: 'MV' });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].id, 'music-mv');
});
