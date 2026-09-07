const test = require('node:test');
const assert = require('node:assert/strict');
const {
  semanticProgressSignature,
  idleBackoffDelay,
} = require('../src/services/productionProgress');

test('semantic production signatures ignore bookkeeping versions but detect real workflow changes', () => {
  const base = {
    run: {
      id: 'run-1', status: 'running', current_stage: 'asset_images',
      current_scope_type: 'character', current_scope_id: '1', version: 10,
      updated_at: 'one', runtime: {},
    },
    artifacts: [{ id: 1, stage: 'asset_images', scope_type: 'character', scope_id: '1', revision: 1, status: 'rejected' }],
    actions: [{ id: 2, stage: 'asset_images', scope_type: 'character', scope_id: '1', kind: 'image_generate', attempt: 1, status: 'completed' }],
  };
  const bookkeepingOnly = JSON.parse(JSON.stringify(base));
  bookkeepingOnly.run.version = 99;
  bookkeepingOnly.run.updated_at = 'two';
  assert.equal(semanticProgressSignature(base), semanticProgressSignature(bookkeepingOnly));

  const changed = JSON.parse(JSON.stringify(base));
  changed.actions[0].status = 'waiting';
  assert.notEqual(semanticProgressSignature(base), semanticProgressSignature(changed));
});

test('semantic idle delay uses bounded exponential backoff', () => {
  assert.equal(idleBackoffDelay(1), 3500);
  assert.equal(idleBackoffDelay(2), 7000);
  assert.equal(idleBackoffDelay(9), 30000);
});
