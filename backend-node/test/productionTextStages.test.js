const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeReview,
  normalizeResources,
  normalizeShots,
  scriptPrompts,
  resourcePrompts,
  reviewPrompts,
  storyboardPrompts,
  shotRevisionPrompts,
  shotSplitPrompts,
  shotPickupPrompts,
  shotContinuityRevisionPrompts,
  recoverShotRevisionFromApprovedRough,
} = require('../src/services/productionTextStages');

const log = { warn() {}, error() {} };

function rawShots(secondMode = 'strict_continuation') {
  return JSON.stringify({
    shots: [{
      number: 1,
      title: 'Opening confrontation',
      duration: 6,
      action: 'The heroine and the dog demon complete their standoff.',
      visual: 'Wide cyberpunk street composition.',
      video_prompt: 'Establish the complete confrontation and end on a talisman flash.',
      transition_mode: 'opening',
    }, {
      number: 2,
      title: 'Side combat beat',
      duration: 7,
      action: 'The heroine completes one binding and sword combination.',
      visual: 'Independent side-on medium camera setup.',
      video_prompt: 'Begin after the cut and complete the combination in this clip.',
      transition_mode: secondMode,
      continuous_take_id: 'take-a',
      cut_in: 'A fresh side-on composition after the flash.',
      cut_out: 'The dog demon claw fully covers the lens.',
      cut_motivation: 'The talisman flash fills the previous frame.',
    }],
  });
}

describe('production storyboard boundary contract', () => {
  it('carries shared material authority context through revise, split, and pickup prompts', () => {
    const shared = JSON.stringify({
      subjects: [{ id: 'subject-cat', target_scope: 'character-1', source_artifact_id: 180, authority: 'uploaded_asset' }],
      assets: [{ id: 'asset-cat', artifact_id: 180, role: 'primary_subject_reference', target_scope: 'character-1' }],
      shots: [{ number: 1, source: 'generate', character_ids: ['character-1'], reference_asset_ids: ['asset-cat'] }],
    });
    const revision = shotRevisionPrompts({ instruction: '保持猫娘身份', assets: [], material_context: shared });
    const split = shotSplitPrompts({ instruction: '在动作完成处拆分', assets: [], material_context: shared, current_number: 1, next_number: 1.5 });
    const pickup = shotPickupPrompts({ instruction: '补拍猫娘特写', assets: [], material_context: shared, number: 1.5 });
    const continuity = shotContinuityRevisionPrompts({ assets: [], material_context: shared, strict_first_frame_supported: false });
    for (const prompts of [revision, split, pickup, continuity]) {
      assert.match(prompts.system, /Stable asset IDs/);
      assert.match(prompts.user, /subject-cat/);
      assert.match(prompts.user, /source_artifact_id/);
      assert.match(prompts.user, /uploaded_asset/);
      assert.match(prompts.system, /never replace/);
    }
  });

  it('downgrades unsupported strict continuation to an explicit ordinary tail-frame reference', () => {
    const result = normalizeShots(rawShots(), log, 3, { strict_first_frame_supported: false });
    assert.equal(result.shots[0].transition_mode, 'opening');
    assert.equal(result.shots[1].transition_mode, 'reference_continuation');
    assert.match(result.shots[1].boundary_prompt, /普通参考图/);
    assert.equal(result.shots[1].required_fields.includes('cut_motivation'), false);
    assert.equal(result.shots[1].required_fields.includes('continuous_take_id'), false);
  });

  it('preserves strict continuation only when the selected capability allows first_frame', () => {
    const result = normalizeShots(rawShots(), log, 3, { strict_first_frame_supported: true });
    assert.equal(result.shots[1].transition_mode, 'strict_continuation');
    assert.equal(result.shots[1].continuous_take_id, 'take-a');
    assert.match(result.shots[1].boundary_prompt, /严格续拍/);
  });

  it('instructs both rough planning and sequential revision not to split a take across requests', () => {
    const rough = storyboardPrompts('A sufficiently detailed screenplay.', [], {
      target_shots: 3,
      max_total_seconds: 20,
      strict_first_frame_supported: false,
    });
    const revision = shotContinuityRevisionPrompts({ strict_first_frame_supported: false });
    assert.match(rough.system, /同一次运镜、同一个尚未完成的物理动作不得拆到两个视频请求中/);
    assert.match(rough.system, /默认使用 hard_cut/);
    assert.match(rough.system, /2\.5 由供应商固定请求 30 秒/);
    assert.match(rough.system, /2\.0.*5、10、15 秒/);
    assert.doesNotMatch(`${rough.system}\n${rough.user}`, /2到4秒/);
    assert.match(revision.system, /Never split one camera move or an unfinished physical action/);
    assert.match(revision.system, /ordinary image reference/);
  });

  it('recovers an approved rough shot as an independent hard cut without a predecessor tail frame', () => {
    const recovered = recoverShotRevisionFromApprovedRough({
      number: 3,
      title: '雨后集市',
      duration: 4,
      action: '少女在摊位前停下并看向远处。',
      visual: '雨后集市的独立中景，灯笼倒影铺在石板路上。',
      video_prompt: '少女停下，抬眼，镜头稳定结束。',
      transition_mode: 'hard_cut',
      scene_name: '雨后集市',
      cut_in: '新的集市中景，少女已站在摊位前。',
      cut_out: '少女视线稳定落向画外。',
      cut_motivation: '从前一场动作结果切到新的地点和信息。',
    }, {
      number: 2,
      cut_out: '深潭中的取物动作已经完整结束。',
    }, { strict_first_frame_supported: false, duration_min: 2 });
    assert.equal(recovered.transition_mode, 'hard_cut');
    assert.equal(recovered.duration, 4);
    assert.match(recovered.continuity_in, /叙事状态承接/);
    assert.match(recovered.boundary_prompt, /不使用上一段视频尾帧/);
    assert.doesNotMatch(recovered.boundary_prompt, /逐像素承接/);
    assert.equal(recovered.continuous_take_id, '');
  });
});

describe('production creative and review defaults', () => {
  it('tells the writer to make coherent creative decisions for unspecified details', () => {
    const prompts = scriptPrompts('请你自己生成一个有趣的短片剧本', { target_shots: 3 });
    assert.match(prompts.system, /未指定/);
    assert.match(prompts.system, /主动做出/);
    assert.match(prompts.system, /不能回答“用户未指定”/);
    assert.match(prompts.user, /未指定的创作要素由你直接决定/);
  });

  it('passes series-group selected assets as authoritative context and keeps candidates advisory', () => {
    const series_context = {
      group: { id: 7, name: '星尘系列' },
      selected: [{ asset_key: 'hero-lin', asset_type: 'character', title: '林夏', version: 2, content: { hair: 'silver' } }],
      candidates: [{ asset_key: 'old-scene', asset_type: 'scene', title: '旧温室', version: 1, content: { location: 'greenhouse' }, selected: false }],
    };
    const script = scriptPrompts('续集故事', { target_shots: 2, series_context });
    const resources = require('../src/services/productionTextStages').resourcePrompts('剧本', { series_context });
    const board = storyboardPrompts('剧本', [], { target_shots: 2, series_context });
    for (const prompts of [script, resources, board]) {
      assert.match(`${prompts.system}\n${prompts.user}`, /hero-lin/);
      assert.match(`${prompts.system}\n${prompts.user}`, /old-scene/);
      assert.match(prompts.system, /不得(?:静默|把未确认候选)/);
    }
  });

  it('passes uploaded authority and stable artifact provenance into every planning prompt', () => {
    const policy = {
      target_shots: 1,
      execution_plan: {
        subjects: [{ id: 'subject-cat', name: '猫娘截图', authority: 'uploaded_asset', source_artifact_id: 42, target_scope_id: 'character-1', must_preserve_identity: true }],
        assets: [{ id: 'asset-cat', file_name: 'capture.png', role: 'primary_subject_reference', authority: 'uploaded_asset', artifact_id: 42, source_ref: { sha256: 'cat-hash' }, target_scope_id: 'character-1' }],
        shots: [{ number: 1, source: 'generate' }], unresolved_items: [],
      },
    };
    const script = scriptPrompts('让上传图片中的猫娘动起来', policy);
    const resources = resourcePrompts('剧本：猫娘在雨夜屋顶撑伞。', policy);
    const board = storyboardPrompts('剧本：猫娘在雨夜屋顶撑伞。', [], policy);
    for (const prompts of [script, resources, board]) {
      const text = `${prompts.system}\n${prompts.user}`;
      assert.match(text, /uploaded_asset/);
      assert.match(text, /cat-hash/);
      assert.match(text, /artifact_id/);
    }
    assert.match(resources.system, /不能凭空创建替代主体/);
  });

  it('moves a structurally identified scene out of characters without keyword gates', () => {
    const result = normalizeResources(JSON.stringify({
      characters: [{
        name: '猫娘',
        description: '银发猫耳少女，穿蓝色外套。',
        role: '主角',
        appearance: '银发、猫耳、蓝色外套',
      }, {
        name: '花园',
        description: '雨后温室入口，石板路通向玻璃门。',
        location: '温室入口',
        time: '雨后傍晚',
        spatial_anchors: ['玻璃门在画面右侧', '石板路从前景延伸到门口'],
      }],
      scenes: [],
      props: [],
    }), log, { requires_scene: false });
    assert.equal(result.characters.length, 1);
    assert.equal(result.scenes.length, 1);
    assert.equal(result.scenes[0].name, '花园');
    assert.equal(result.scenes[0].location, '温室入口');
  });

  it('merges one uploaded authority into one model resource without creating a duplicate', () => {
    const result = normalizeResources(JSON.stringify({
      characters: [{
        name: '猫娘', description: '棕色长发、猫耳和浅色上衣',
        role: '主角', appearance: '棕色长发、猫耳、浅色上衣',
      }], scenes: [], props: [],
    }), log, {
      requires_scene: false,
      authoritative_subjects: [{
        id: 'subject-cat', kind: 'character', name: '猫娘', source_artifact_id: 42,
        identity_anchors: ['猫耳', '棕色长发'],
      }],
    });
    assert.equal(result.characters.length, 1);
    assert.equal(result.characters[0].source_artifact_id, 42);
    assert.equal(result.characters[0].authority, 'uploaded_asset');
    assert.equal(result.characters[0].must_preserve_identity, true);
    assert.equal(result.characters[0].can_generate_replacement, false);
  });

  it('never binds one terse model resource positionally to multiple uploaded authorities', () => {
    const result = normalizeResources(JSON.stringify({
      characters: [{ name: '角色', description: '模型只返回的未绑定角色描述', role: '配角' }],
      scenes: [], props: [],
    }), log, {
      requires_scene: false,
      authoritative_subjects: [
        { id: 'subject-a', kind: 'character', name: '角色 A', source_artifact_id: 42 },
        { id: 'subject-b', kind: 'character', name: '角色 B', source_artifact_id: 43 },
      ],
    });
    const linked = result.characters.filter((item) => item.source_artifact_id);
    assert.deepEqual(linked.map((item) => item.source_artifact_id).sort((a, b) => a - b), [42, 43]);
    assert.equal(result.characters.find((item) => item.name === '角色').source_artifact_id || null, null);
  });

  it('approves low-confidence work when the reviewer found no blocking issue', () => {
    const verdict = normalizeReview(JSON.stringify({
      decision: 'approved', confidence: 0.31, severity: 'minor',
      blocking_issues: [], improvement_notes: ['对白还可以更精炼'],
      requires_human_authority: false, reason: '可进入下一阶段',
    }), log);
    assert.equal(verdict.decision, 'approved');
    assert.deepEqual(verdict.blocking_issues, []);
    assert.deepEqual(verdict.improvement_notes, ['对白还可以更精炼']);
  });

  it('does not escalate an unsupported needs_human verdict without human authority', () => {
    const autoRepair = normalizeReview(JSON.stringify({
      decision: 'needs_human', confidence: 0.4, severity: 'major',
      blocking_issues: ['缺少结尾动作'], requires_human_authority: false,
      reason: '需要补齐动作',
    }), log);
    const harmless = normalizeReview(JSON.stringify({
      decision: 'needs_human', confidence: 0.4, severity: 'minor',
      blocking_issues: [], requires_human_authority: false,
      reason: '审美不确定',
    }), log);
    assert.equal(autoRepair.decision, 'rejected');
    assert.equal(harmless.decision, 'approved');
  });

  it('keeps human escalation only when human authority is explicitly required', () => {
    const verdict = normalizeReview(JSON.stringify({
      decision: 'needs_human', confidence: 0.9, severity: 'critical',
      blocking_issues: ['需要用户授权额外预算'], requires_human_authority: true,
      reason: '预算授权缺失',
    }), log);
    assert.equal(verdict.decision, 'needs_human');
    assert.equal(verdict.requires_human_authority, true);
  });

  it('includes prior review history and forbids moving the approval bar', () => {
    const prompts = reviewPrompts({ stage: 'script', title: '剧本', content: { text: '内容' } }, {
      previous_reviews: [{ decision: 'rejected', reason: '结尾动作缺失' }],
    });
    assert.match(prompts.system, /不得移动标准/);
    assert.match(prompts.user, /结尾动作缺失/);
  });
});
