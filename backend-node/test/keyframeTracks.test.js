const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTrack, normalizeAnimation, valueAt, expression } = require('../src/services/keyframeTracks');
const { animationCanvas } = require('../src/services/videoLayerAnimation');

test('independent tracks clamp boundaries and hold changes exactly at the next key', () => {
  const frames = normalizeTrack([{ time: 0.5, value: 10, easing: 'hold' }, { time: 1, value: 30 }, { time: 2, value: 50 }]);
  assert.equal(valueAt(frames, 0), 10);
  assert.equal(valueAt(frames, 0.999), 10);
  assert.equal(valueAt(frames, 1), 30);
  assert.equal(valueAt(frames, 1.5), 40);
  assert.equal(valueAt(frames, 3), 50);
  const tracks = normalizeAnimation({ x: [{ time: 0, value: 0 }, { time: 2, value: 80 }], opacity: [{ time: 1, value: 0.5 }] }, 2);
  assert.equal(valueAt(tracks.x, 1), 40); assert.equal(valueAt(tracks.opacity, 0), 0.5);
});

test('easing has precise midpoint and endpoint values', () => {
  for (const [easing, midpoint] of [['linear', 50], ['ease-in', 25], ['ease-out', 75], ['ease-in-out', 50]]) {
    const frames = normalizeTrack([{ time: 0, value: 0, easing }, { time: 1, value: 100 }]);
    assert.equal(valueAt(frames, 0.5), midpoint); assert.equal(valueAt(frames, 1), 100);
  }
});

test('invalid tracks reject coercion, injection, duplicate times and unbounded canvases', () => {
  const invalid = [[], [{ time: 0, value: '1' }], [{ time: NaN, value: 1 }], [{ time: 0, value: Infinity }],
    [{ time: 1, value: 0 }, { time: 1, value: 1 }], [{ time: 2, value: 1 }], [{ time: 0, value: 1, easing: 'sin(t)' }]];
  for (const frames of invalid) assert.throws(() => normalizeTrack(frames, { duration: 1 }), { code: 'KEYFRAME_TRACK_INVALID' });
  assert.throws(() => normalizeAnimation({ scale_x: [{ time: 0, value: 0 }] }, 2), { code: 'KEYFRAME_TRACK_INVALID' });
  assert.throws(() => normalizeAnimation({ command: [{ time: 0, value: 1 }] }, 2), { code: 'KEYFRAME_TRACK_INVALID' });
  assert.throws(() => expression(normalizeTrack([{ time: 0, value: 1 }]), 't);movie=x'), { code: 'KEYFRAME_TRACK_INVALID' });
  assert.throws(() => animationCanvas({ width: 8000, height: 8000, animation: { rotation: [{ time: 0, value: 45 }] } }), { code: 'KEYFRAME_TRACK_INVALID' });
});
