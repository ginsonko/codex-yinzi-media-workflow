const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_EDGE_VOICE,
  normalizeNarrationPlan,
  validateNarrationPlan,
} = require('../src/services/productionNarrationPlan');

function sources() {
  return {
    shots: [
      { id: 11, scope_id: '1', title: '开场', content: { duration: 3, narration: '夜色降临。' } },
      { id: 12, scope_id: '2', title: '街巷', content: { duration: 5, narration: '她走进雨后的街巷。' } },
    ],
    videos: [
      { id: 21, scope_id: '1', content: { validation: { duration: 3 } } },
      { id: 22, scope_id: '2', content: { validation: { duration: 5 } } },
    ],
  };
}

describe('production narration confirmation plan', () => {
  it('uses Xiaoyi by default and binds the plan to current shot/video identities', () => {
    const { shots, videos } = sources();
    const plan = normalizeNarrationPlan({}, shots, videos);
    assert.equal(plan.voice_provider, 'edge');
    assert.equal(plan.voice_id, DEFAULT_EDGE_VOICE);
    assert.equal(plan.subtitle_mode, 'burn');
    assert.equal(plan.source_shot_artifact_ids.join(','), '11,12');
    assert.equal(plan.source_shot_video_artifact_ids.join(','), '21,22');
    assert.equal(validateNarrationPlan(plan, shots, videos).confirmation_fingerprint, plan.confirmation_fingerprint);
  });

  it('rejects a stale confirmation after narration or upstream video changes', () => {
    const { shots, videos } = sources();
    const plan = normalizeNarrationPlan({}, shots, videos);
    assert.throws(() => validateNarrationPlan({
      ...plan,
      segments: plan.segments.map((segment) => ({ ...segment, narration: `${segment.narration} 改写` })),
    }, shots, videos), /旁白设置或上游镜头已经变化/);
    assert.throws(() => validateNarrationPlan(plan, shots, [
      videos[0], { ...videos[1], id: 99 },
    ]), /旁白设置或上游镜头已经变化/);
  });

  it('turns narration off into an explicit original-audio-only plan', () => {
    const { shots, videos } = sources();
    const plan = normalizeNarrationPlan({ narration_enabled: false }, shots, videos);
    assert.equal(plan.narration_enabled, false);
    assert.equal(plan.subtitle_mode, 'off');
    assert.equal(plan.segments[0].narration, '夜色降临。');
  });
});
