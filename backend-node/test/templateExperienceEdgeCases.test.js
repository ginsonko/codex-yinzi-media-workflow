const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const execution = require('../src/services/templateExecutionPlan');

function item(name, detectedType, usageRole, patch = {}) {
  return {
    file_name: name,
    relative_path: name,
    sha256: `sha-${name}`,
    detected_type: detectedType,
    usage_role: usageRole,
    confidence: 0.95,
    status: 'ready',
    ...patch,
  };
}
function image(name, role = 'character_reference', type = 'character', patch = {}) {
  return item(name, type, role, { mime_type: 'image/png', ...patch });
}
function video(name, role = 'direct_clip', shotNumber = null, patch = {}) {
  return item(name, 'video', role, {
    mime_type: 'video/mp4',
    direct_clip_candidate: role === 'direct_clip',
    ...(shotNumber == null ? {} : { shot_number: shotNumber }),
    ...patch,
  });
}
function plan(templateId, intent, items, targetShots = 3) {
  return execution.buildExecutionPlan({ template_id: templateId, user_intent: intent, items, target_shots: targetShots });
}

describe('V0.1.4 horizontal unexpected-user scenarios', () => {
  it('does not silently choose between two completed clips targeting the same shot', () => {
    const result = plan('course-clipping', '把课程原片整理成三段', [
      video('shot2-version-a.mp4', 'direct_clip', 2),
      video('shot2-version-b.mp4', 'direct_clip', 2),
    ]);
    assert.equal(result.shots[1].source, 'unresolved');
    assert.equal(result.shots[1].status, 'needs_confirmation');
    assert.equal(result.unresolved_items.filter((entry) => entry.type === 'direct_clip_shot_conflict').length, 2);
    assert.equal(result.summary.imported_clip_count, 0);
  });

  it('never promotes an action/reference video into an approved final clip', () => {
    const result = plan('dance-action', '让角色参考动作跳舞', [
      image('performer.png'),
      video('dance-guide.mp4', 'action_reference'),
    ]);
    const guide = result.assets.find((asset) => asset.file_name === 'dance-guide.mp4');
    assert.equal(guide.role, 'action_reference');
    assert.equal(guide.direct_clip_candidate, false);
    assert.equal(result.summary.imported_clip_count, 0);
  });

  it('keeps low-confidence AI assignments editable without blocking the workflow', () => {
    const result = plan('free', '使用这份素材制作一个故事', [
      image('uncertain.png', 'visual_reference', 'image', { confidence: 0.31 }),
    ]);
    assert.equal(result.unresolved_items.some((entry) => entry.type === 'low_confidence_assignment'), true);
    assert.equal(result.shots.length, 3);
    assert.equal(result.summary.requires_confirmation, true);
  });

  it('keeps explicit scene and prop classifications outside the character identity set', () => {
    const result = plan('virtual-drama', '让上传角色在上传场景中拿起上传道具', [
      image('hero.png'),
      image('room.png', 'scene_reference', 'scene'),
      image('lantern.png', 'prop_reference', 'prop'),
    ], 1);
    assert.equal(result.subjects.length, 1);
    assert.equal(result.assets.find((asset) => asset.file_name === 'room.png').target_scope_type, 'scene');
    assert.equal(result.assets.find((asset) => asset.file_name === 'lantern.png').target_scope_type, 'prop');
  });

  it('separates a presenter from a product even inside an ecommerce template', () => {
    const result = plan('ecommerce', '让上传人物介绍上传商品', [
      image('presenter.png', 'character_reference', 'person'),
      image('coffee-maker.png', 'product_reference', 'product'),
    ], 1);
    assert.deepEqual(result.subjects.map((subject) => subject.target_scope_type).sort(), ['character', 'product']);
    assert.equal(result.assets.find((asset) => asset.file_name === 'presenter.png').target_scope_id, 'character-1');
    assert.equal(result.assets.find((asset) => asset.file_name === 'coffee-maker.png').target_scope_id, 'product-1');
  });

  it('does not send every uploaded product when a shot names none of several products', () => {
    const result = plan('brand-promo', '展示上传的两个产品', [
      image('product-a.png', 'product_reference', 'product'),
      image('product-b.png', 'product_reference', 'product'),
    ], 1);
    const bound = execution.bindShotReferences({ number: 1 }, result, [
      { scope_type: 'product', scope_id: 'product-1', content: { name: '产品甲' } },
      { scope_type: 'product', scope_id: 'product-2', content: { name: '产品乙' } },
    ]);
    assert.deepEqual(bound.character_ids, []);
    assert.deepEqual(bound.reference_asset_ids, []);
  });

  it('still carries one unambiguous product authority into its generated shot', () => {
    const result = plan('brand-promo', '展示上传的唯一产品', [
      image('only-product.png', 'product_reference', 'product'),
    ], 1);
    const bound = execution.bindShotReferences({ number: 1 }, result, [
      { scope_type: 'product', scope_id: 'product-1', content: { name: '唯一产品' } },
    ]);
    assert.deepEqual(bound.character_ids, []);
    assert.deepEqual(bound.reference_asset_ids, ['product-1']);
  });

  it('ignores excluded uploads while retaining all ready materials', () => {
    const result = plan('image-to-video', '让上传图片中的角色转身', [
      image('active.png'),
      image('removed.png', 'character_reference', 'character', { status: 'excluded' }),
    ], 1);
    assert.equal(result.assets.length, 1);
    assert.equal(result.assets[0].file_name, 'active.png');
  });

  it('keeps two same-named files distinct when their content hashes differ', () => {
    const result = plan('image-to-video', '让两个上传角色互动', [
      image('same-name.png', 'character_reference', 'character', { sha256: 'hash-a' }),
      image('same-name.png', 'character_reference', 'character', { sha256: 'hash-b', relative_path: 'other/same-name.png' }),
    ], 1);
    assert.equal(new Set(result.assets.map((asset) => asset.id)).size, 2);
    assert.equal(result.subjects.length, 2);
  });

  it('bounds excessive identity candidates and leaves generation usable', () => {
    const items = Array.from({ length: 13 }, (_, index) => image(`cast-${index + 1}.png`));
    const result = plan('virtual-drama', '让上传的全部角色参与群像故事', items, 2);
    assert.equal(result.subjects.length, 8);
    assert.equal(result.assets.length, 13);
    assert.equal(result.shots.length, 2);
  });

  it('uses the open free-creation contract for an unknown future template', () => {
    const result = plan('future-template-from-server', '制作一个未知类型但可继续的项目', [], 1);
    assert.equal(result.template_id, 'future-template-from-server');
    assert.equal(result.workflow.id, 'free');
    assert.equal(result.shots[0].source, 'generate');
  });

  it('supports a long editable shot plan without a local fifteen-second ceiling', () => {
    const result = plan('novel-drama', '把长篇章节拆成三十个完整镜头', [item('chapter.md', 'text', 'source_document')], 30);
    assert.equal(result.shots.length, 30);
    assert.equal(result.summary.planned_video_actions, 30);
  });

  it('skips all video generation when every requested timeline slot has a user clip', () => {
    const result = plan('travel-memory', '直接按顺序剪辑三个已有片段', [
      video('shot1-trip.mp4', 'direct_clip', 1),
      video('shot2-trip.mp4', 'direct_clip', 2),
      video('shot3-trip.mp4', 'direct_clip', 3),
    ], 3);
    assert.equal(result.summary.imported_clip_count, 3);
    assert.equal(result.summary.planned_video_actions, 0);
    assert.equal(result.stage_policy.shot_video, 'skip_all_reused');
  });

  it('generates only the missing middle shot between two uploaded clips', () => {
    const result = plan('travel-memory', '已有首尾片段，只补中间镜头', [
      video('shot1-trip.mp4', 'direct_clip', 1),
      video('shot3-trip.mp4', 'direct_clip', 3),
    ], 3);
    assert.deepEqual(result.shots.map((shot) => shot.source), ['imported_clip', 'generate', 'imported_clip']);
    assert.equal(result.summary.planned_video_actions, 1);
  });

  it('reconstructs a conflict plan deterministically after refresh or restart', () => {
    const materials = [video('shot1-a.mp4', 'direct_clip', 1), video('shot1-b.mp4', 'direct_clip', 1)];
    const clean = (value) => JSON.parse(JSON.stringify(value, (key, entry) => key === 'created_at' ? undefined : entry));
    assert.deepEqual(clean(plan('course-clipping', '解决重复片段后继续', materials, 2)), clean(plan('course-clipping', '解决重复片段后继续', materials, 2)));
  });
});
