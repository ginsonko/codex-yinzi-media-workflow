const test = require('node:test');
const assert = require('node:assert/strict');
const { getOperation } = require('../src/services/localMediaOperations');
const schemas = require('../src/services/mediaExtensionSchemas.json');

const ids = [
  'local.audio.deesser', 'local.audio.anlmdn', 'local.audio.crystalizer',
  'local.audio.virtualbass', 'local.audio.afwtdn', 'local.video.atadenoise',
  'local.video.bm3d', 'local.video.cas',
];

test('professional FFmpeg extensions are registered with schemas and executable builders', () => {
  for (const id of ids) {
    const operation = getOperation(id);
    assert.ok(operation, id);
    assert.equal(operation.component_id, 'media.ffmpeg');
    assert.ok(operation.build(operation.defaults));
    if (id === 'local.audio.anlmdn') assert.equal(typeof operation.prepare, 'function');
    assert.ok(schemas[id]);
  }
});

test('professional FFmpeg extensions reject out-of-range parameters', () => {
  const cases = [
    ['local.audio.deesser', { intensity: 2 }],
    ['local.audio.anlmdn', { strength: 0 }],
    ['local.video.atadenoise', { frames: 1 }],
    ['local.video.bm3d', { block: 1 }],
    ['local.video.cas', { strength: 2 }],
  ];
  for (const [id, parameters] of cases) {
    assert.throws(() => getOperation(id).validateParameters(parameters), /参数/);
  }
  for (const group of [1, 4, 8, 16, 32, 64, 128, 256]) {
    assert.doesNotThrow(() => getOperation('local.video.bm3d').validateParameters({ group }));
  }
  for (const group of [2, 3, 5, 6, 7, 9, 10, 12]) {
    assert.throws(() => getOperation('local.video.bm3d').validateParameters({ group }), /group/);
  }
});
