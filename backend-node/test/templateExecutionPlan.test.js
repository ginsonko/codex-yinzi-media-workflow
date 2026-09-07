const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildExecutionPlan,
  resolveArtifactBindings,
  getWorkflowSpec,
  materialContext,
  bindShotReferences,
  missingInputSlots,
} = require('../src/services/templateExecutionPlan');

test('uploaded subject image becomes an immutable authority for image-to-video', () => {
  const plan = buildExecutionPlan({
    template_id: 'image-to-video',
    user_intent: '让图片中的猫娘在雨夜屋顶撑伞，形成一个动画故事',
    target_shots: 3,
    items: [{
      file_name: 'catgirl.png', relative_path: 'catgirl.png', sha256: 'cat-hash',
      detected_type: 'image', candidate_stage: 'asset_images', status: 'ready',
      confidence: 0.96, evidence: '图中角色为猫娘',
    }],
  });
  assert.equal(plan.subjects.length, 1);
  assert.equal(plan.subjects[0].authority, 'uploaded_asset');
  assert.equal(plan.subjects[0].must_preserve_identity, true);
  assert.equal(plan.subjects[0].can_generate_replacement, false);
  assert.equal(plan.stage_policy.scene, 'optional');
  assert.equal(plan.summary.generated_shot_count, 3);
});

test('explicit shot videos occupy timeline slots and leave only missing shots to generate', () => {
  const plan = buildExecutionPlan({
    template_id: 'travel-memory',
    user_intent: '补齐中间缺失镜头并剪成完整短片',
    target_shots: 3,
    items: [
      { file_name: 'shot-01.mp4', relative_path: 'shot-01.mp4', sha256: 'v1', detected_type: 'video', candidate_stage: 'shot_video', direct_clip_candidate: true, status: 'ready' },
      { file_name: 'shot-03.mp4', relative_path: 'shot-03.mp4', sha256: 'v3', detected_type: 'video', candidate_stage: 'shot_video', direct_clip_candidate: true, status: 'ready' },
    ],
  });
  assert.deepEqual(plan.shots.map((shot) => shot.source), ['imported_clip', 'generate', 'imported_clip']);
  assert.equal(plan.summary.imported_clip_count, 2);
  assert.equal(plan.summary.generated_shot_count, 1);
  assert.equal(plan.unresolved_items.length, 0);
});

test('ambiguous videos remain visible for confirmation instead of being silently assigned', () => {
  const plan = buildExecutionPlan({
    template_id: 'image-to-video',
    user_intent: '把素材整理成一个短片',
    target_shots: 2,
    items: [{ file_name: 'finished.mp4', relative_path: 'finished.mp4', sha256: 'ambiguous', detected_type: 'video', candidate_stage: 'shot_video', direct_clip_candidate: true, status: 'ready' }],
  });
  assert.equal(plan.assets[0].requires_user_confirmation, true);
  assert.equal(plan.unresolved_items[0].type, 'direct_clip_shot_assignment');
  assert.deepEqual(plan.shots.map((shot) => shot.source), ['generate', 'generate']);
});

test('artifact bindings resolve by hash and keep source references intact', () => {
  const plan = buildExecutionPlan({
    template_id: 'image-to-video', user_intent: '让上传图片中的角色动起来', target_shots: 1,
    items: [{ file_name: 'subject.png', relative_path: 'subject.png', sha256: 'subject-hash', detected_type: 'image', status: 'ready' }],
  });
  const resolved = resolveArtifactBindings(plan, { 'subject-hash': 77 });
  assert.equal(resolved.subjects[0].source_artifact_id, 77);
  assert.equal(resolved.assets[0].artifact_id, 77);
  assert.equal(resolved.assets[0].source_ref.sha256, 'subject-hash');
});

test('scene requirement is explicit per template', () => {
  assert.equal(getWorkflowSpec('image-to-video').requires_scene, false);
  assert.equal(getWorkflowSpec('novel-drama').requires_scene, true);
});

test('user subject intent upgrades a provisional visual reference and assigns a stable resource scope', () => {
  const plan = buildExecutionPlan({
    template_id: 'image-to-video',
    user_intent: '让上传图片中的猫娘动起来',
    items: [{ file_name: 'screenshot.png', relative_path: 'screenshot.png', sha256: 'screen-hash', detected_type: 'image', usage_role: 'visual_reference', candidate_stage: 'asset_images', status: 'ready' }],
  });
  assert.equal(plan.assets[0].role, 'primary_subject_reference');
  assert.equal(plan.assets[0].target_scope_type, 'character');
  assert.equal(plan.assets[0].target_scope_id, 'character-1');
  assert.equal(plan.subjects[0].target_scope_id, 'character-1');
  assert.match(materialContext(plan), /screen-hash/);
  assert.match(materialContext(plan), /uploaded_asset/);
});

test('informational missing slots do not report a supplied subject image as missing', () => {
  const plan = buildExecutionPlan({
    template_id: 'image-to-video',
    user_intent: '让上传图片中的猫娘动起来',
    target_shots: 1,
    items: [{
      file_name: 'catgirl.png', relative_path: 'catgirl.png', sha256: 'cat-hash',
      detected_type: 'image', usage_role: 'primary_subject_reference',
      candidate_stage: 'asset_images', status: 'ready',
    }],
  });
  assert.deepEqual(missingInputSlots(plan), []);
});

test('informational missing slots explain only genuinely absent required inputs', () => {
  const plan = buildExecutionPlan({
    template_id: 'image-to-video',
    user_intent: '制作一个角色动画',
    target_shots: 1,
    items: [],
  });
  const missing = missingInputSlots(plan);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].slot_id, 'subject');
  assert.match(missing[0].reason, /继续生成或稍后补充/);
});

test('keeps explicitly classified scene and prop images out of character subjects', () => {
  const plan = buildExecutionPlan({
    template_id: 'image-to-video',
    user_intent: '让上传图片中的猫娘在花园里走到桌边',
    items: [
      { file_name: 'cat.png', relative_path: 'cat.png', sha256: 'cat', detected_type: 'character', usage_role: 'character_reference', candidate_stage: 'asset_images', status: 'ready' },
      { file_name: 'garden.png', relative_path: 'garden.png', sha256: 'garden', detected_type: 'scene', usage_role: 'scene_reference', candidate_stage: 'asset_images', status: 'ready' },
      { file_name: 'table.png', relative_path: 'table.png', sha256: 'table', detected_type: 'prop', usage_role: 'prop_reference', candidate_stage: 'asset_images', status: 'ready' },
    ],
  });
  assert.equal(plan.subjects.length, 1);
  assert.equal(plan.assets.find((item) => item.file_name === 'garden.png').target_scope_type, 'scene');
  assert.equal(plan.assets.find((item) => item.file_name === 'table.png').target_scope_type, 'prop');
});

test('binds a single storyboard character by its unique stable scope when the model omits the id', () => {
  const plan = buildExecutionPlan({
    template_id: 'image-to-video',
    user_intent: '让上传图片中的猫娘在花园里走到桌边',
    target_shots: 1,
    items: [
      { file_name: 'cat.png', relative_path: 'cat.png', sha256: 'cat', detected_type: 'character', usage_role: 'character_reference', candidate_stage: 'asset_images', status: 'ready' },
      { file_name: 'garden.png', relative_path: 'garden.png', sha256: 'garden', detected_type: 'scene', usage_role: 'scene_reference', candidate_stage: 'asset_images', status: 'ready' },
      { file_name: 'table.png', relative_path: 'table.png', sha256: 'table', detected_type: 'prop', usage_role: 'prop_reference', candidate_stage: 'asset_images', status: 'ready' },
    ],
  });
  const bound = bindShotReferences({
    number: 1,
    character_names: ['猫.png'],
    scene_name: 'garden.png',
    prop_names: ['table.png'],
  }, plan, [
    { scope_type: 'character', scope_id: 'character-1', content: { name: 'cat.png' } },
    { scope_type: 'scene', scope_id: 'scene-1', content: { name: 'garden.png' } },
    { scope_type: 'prop', scope_id: 'prop-1', content: { name: 'table.png' } },
  ]);
  assert.deepEqual(bound.character_ids, ['character-1']);
  assert.equal(bound.scene_id, 'scene-1');
  assert.deepEqual(bound.prop_ids, ['prop-1']);
  assert.deepEqual(bound.reference_asset_ids, ['character-1', 'scene-1', 'prop-1']);
});

test('does not choose the first character when multiple uploaded characters have no explicit reference', () => {
  const plan = buildExecutionPlan({
    template_id: 'image-to-video',
    user_intent: '让两位角色一起走过街道',
    target_shots: 1,
    items: [
      { file_name: 'hero-a.png', relative_path: 'hero-a.png', sha256: 'hero-a', detected_type: 'character', usage_role: 'character_reference', candidate_stage: 'asset_images', status: 'ready' },
      { file_name: 'hero-b.png', relative_path: 'hero-b.png', sha256: 'hero-b', detected_type: 'character', usage_role: 'character_reference', candidate_stage: 'asset_images', status: 'ready' },
    ],
  });
  const bound = bindShotReferences({ number: 1 }, plan, [
    { scope_type: 'character', scope_id: 'character-1', content: { name: 'hero-a.png' } },
    { scope_type: 'character', scope_id: 'character-2', content: { name: 'hero-b.png' } },
  ]);
  assert.deepEqual(bound.character_ids, []);
  assert.deepEqual(bound.reference_asset_ids, []);
});
