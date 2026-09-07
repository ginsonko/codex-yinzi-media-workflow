const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveWebDist } = require('../src/app');

test('resolves the source checkout frontend when backend starts from a runtime data directory', () => {
  const expected = path.resolve(__dirname, '..', '..', 'frontweb', 'dist');
  const resolved = resolveWebDist({});
  assert.equal(resolved, expected);
});

test('prefers an explicit frontend build path when it contains index.html', () => {
  const expected = path.resolve(__dirname, '..', '..', 'frontweb', 'dist');
  const resolved = resolveWebDist({ webDistPath: expected });
  assert.ok(resolved.endsWith(path.join('frontweb', 'dist')));
});
