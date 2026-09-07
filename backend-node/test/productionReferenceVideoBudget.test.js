const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  planReferenceVideoBudget,
  REFERENCE_VIDEO_BUDGET_PROFILE,
  MIN_CONTINUITY_TAIL_SECONDS,
} = require('../src/services/productionReferenceVideoBudget');

describe('production reference-video duration budget', () => {
  it('leaves an under-limit bundle untouched', () => {
    const result = planReferenceVideoBudget([
      { path: 'previous.mp4', source: 'continuity_in', source_duration_seconds: 4 },
      { path: 'director.mp4', source: 'director', source_duration_seconds: 9 },
    ], { max_total_seconds: 15 });
    assert.equal(result.receipt.enforced, true);
    assert.equal(result.receipt.trimmed, false);
    assert.deepEqual(result.videos.map((item) => item.transport.mode), ['full', 'full']);
    assert.equal(result.receipt.transport_total_seconds, 13);
  });

  it('keeps the director preview full and retains the predecessor tail within the safe target', () => {
    const result = planReferenceVideoBudget([
      { path: 'previous.mp4', source: 'continuity_in', source_duration_seconds: 6.08 },
      { path: 'director.mp4', source: 'director', source_duration_seconds: 9.935 },
    ], { max_total_seconds: 15 });
    const continuity = result.videos[0].transport;
    const director = result.videos[1].transport;
    assert.equal(result.receipt.profile, REFERENCE_VIDEO_BUDGET_PROFILE);
    assert.equal(result.receipt.trimmed, true);
    assert.equal(continuity.mode, 'tail_excerpt');
    assert.ok(continuity.start_seconds > 1);
    assert.ok(continuity.duration_seconds > MIN_CONTINUITY_TAIL_SECONDS);
    assert.equal(director.mode, 'full');
    assert.equal(director.duration_seconds, 9.935);
    assert.ok(result.receipt.transport_total_seconds <= result.receipt.target_total_seconds);
  });

  it('does not silently clip arbitrary videos when continuity cannot absorb the overage', () => {
    assert.throws(() => planReferenceVideoBudget([
      { path: 'user-a.mp4', source: 'user', source_duration_seconds: 12 },
      { path: 'director.mp4', source: 'director', source_duration_seconds: 5 },
    ], { max_total_seconds: 15 }), (error) => error.code === 'REFERENCE_VIDEO_DURATION_BUDGET_UNSATISFIABLE');
  });

  it('records an unverified receipt when a duration is unavailable', () => {
    const result = planReferenceVideoBudget([
      { path: 'remote.mp4', source: 'continuity_in', source_duration_seconds: null },
      { path: 'director.mp4', source: 'director', source_duration_seconds: 10 },
    ], { max_total_seconds: 15 });
    assert.equal(result.receipt.enforced, false);
    assert.equal(result.receipt.reason, 'unknown_source_duration');
    assert.deepEqual(result.videos.map((item) => item.transport.mode), ['unverified_full', 'unverified_full']);
  });
});
