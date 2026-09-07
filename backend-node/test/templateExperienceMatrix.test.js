const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../src/services/templateCatalog');
const execution = require('../src/services/templateExecutionPlan');

// Fourteen real entry profiles (13 named templates plus free creation).  These
// fixtures describe user material semantics, not model answers; the matrix
// exercises the production execution-plan code used by imports and prompts.
const PROFILES = [
  { id: 'free', intent: '让上传图中的主角在雨后街道慢慢回头', primary: image('hero.png', 'primary_subject_reference', 'character') },
  { id: 'ecommerce', intent: '用上传的咖啡机和卖点资料制作三镜商品短片，不改包装和 logo', primary: image('coffee-machine.png', 'product_reference', 'product') },
  { id: 'outfit-change', intent: '保持上传人物身份，只换成上传的蓝色礼服', primary: image('person.png', 'character_reference', 'person') },
  { id: 'dance-action', intent: '让上传人物参考动作视频的节拍跳舞，但不要复制参考者身份', primary: image('dancer.png', 'character_reference', 'person') },
  { id: 'image-to-video', intent: '让上传图片中的猫娘在花园轻轻转身，保持脸、发型、服装和颜色', primary: image('catgirl.png', 'primary_subject_reference', 'character') },
  { id: 'novel-drama', intent: '把上传小说第一章改成四镜短剧，保留原作人物关系', primary: document('chapter-1.md') },
  { id: 'knowledge-explainer', intent: '根据上传报告制作知识讲解，数字和结论必须可追溯', primary: document('report.pdf') },
  { id: 'travel-memory', intent: '按日期整理旅行照片和片段，不虚构地点和人物关系', primary: image('2026-05-01-harbor.jpg', 'visual_reference', 'image') },
  { id: 'game-tutorial', intent: '按步骤文档剪辑录屏，准确展示三个操作步骤', primary: video('shot1-recording.mp4', 'direct_clip', 1) },
  { id: 'music-mv', intent: '按上传歌曲节拍制作四镜 MV，保留演出者身份', primary: audio('song.wav') },
  { id: 'brand-promo', intent: '按品牌手册和产品素材制作宣传片，不新增未经确认的承诺', primary: image('product.png', 'product_reference', 'product') },
  { id: 'course-clipping', intent: '从课程原片剪出五段重点，保留章节时间码和讲师原意', primary: video('shot1-course.mp4', 'direct_clip', 1) },
  { id: 'podcast-video', intent: '把播客音频整理成四段视频，保持嘉宾观点和说话顺序', primary: audio('podcast.wav') },
  { id: 'virtual-drama', intent: '使用上传角色和场景设定制作四镜短剧，跨镜保持一致', primary: image('character-a.png', 'character_reference', 'character') },
];

function base(name, detectedType, usageRole, patch = {}) {
  return {
    file_name: name,
    relative_path: name,
    sha256: `sha-${name}`,
    detected_type: detectedType,
    usage_role: usageRole,
    candidate_stage: detectedType === 'video' ? 'shot_video' : detectedType === 'document' ? 'script' : 'asset_images',
    confidence: 0.94,
    status: 'ready',
    evidence: { reason: '验收场景明确标注的素材语义' },
    ...patch,
  };
}
function image(name, role = 'visual_reference', type = 'image') { return base(name, type, role, { mime_type: 'image/png', identity_anchors: ['颜色与轮廓', '脸部或产品结构'] }); }
function video(name, role = 'direct_clip', shotNumber = null) { return base(name, 'video', role, { mime_type: 'video/mp4', direct_clip_candidate: true, ...(shotNumber == null ? {} : { shot_number: shotNumber }) }); }
function audio(name) { return base(name, 'audio', 'source_audio', { mime_type: 'audio/wav', candidate_stage: 'final_edit' }); }
function document(name) { return base(name, 'text', 'source_document', { mime_type: 'text/plain', candidate_stage: 'script' }); }
function semantic(plan) {
  return JSON.parse(JSON.stringify(plan, (key, value) => ['created_at', 'resolved_at'].includes(key) ? undefined : value));
}
function plan(profile, items, targetShots = 3) {
  return execution.buildExecutionPlan({ template_id: profile.id, user_intent: profile.intent, target_shots: targetShots, items });
}

describe('V0.1.4 template experience matrix (14 entries x 11 scenarios = 154)', () => {
  for (const profile of PROFILES) {
    const label = profile.id;

    it(`${label} / S1 minimum material produces an explainable non-blocking plan`, () => {
      const result = plan(profile, [profile.primary]);
      assert.equal(result.template_id, profile.id);
      assert.equal(result.user_intent, profile.intent);
      assert.equal(result.assets.length, 1);
      assert.ok(result.workflow.prompt_context.instruction);
      assert.equal(result.summary.planned_video_actions, result.shots.filter((shot) => shot.source === 'generate').length);
    });

    it(`${label} / S2 missing required material is advice, never a local submission gate`, () => {
      const empty = plan(profile, []);
      const missing = execution.missingInputSlots(empty);
      assert.ok(Array.isArray(missing));
      assert.equal(empty.shots.length >= 1, true);
      assert.equal(empty.summary.planned_video_actions, empty.shots.length);
      assert.equal(empty.unresolved_items.length, 0);
      for (const item of missing) assert.match(item.reason, /可继续生成|稍后补充/);
    });

    it(`${label} / S3 an explicitly numbered uploaded clip replaces only its timeline shot`, () => {
      const result = plan(profile, [profile.primary, video('shot2-ready.mp4', 'direct_clip', 2)], 3);
      assert.equal(result.shots.length, 3);
      assert.equal(result.shots[1].source, 'imported_clip');
      assert.equal(result.shots[0].source, profile.primary.detected_type === 'video' && profile.primary.shot_number === 1 ? 'imported_clip' : 'generate');
      assert.equal(result.shots[2].source, 'generate');
      assert.equal(result.summary.imported_clip_count >= 1, true);
      assert.equal(result.stage_policy.shot_video, 'generate_missing');
    });

    it(`${label} / S4 an unnumbered possible final clip remains visible for user confirmation`, () => {
      const result = plan(profile, [profile.primary, video('possibly-finished.mp4', 'direct_clip')], 3);
      const candidate = result.assets.find((asset) => asset.file_name === 'possibly-finished.mp4');
      assert.equal(candidate.direct_clip_candidate, true);
      assert.equal(candidate.requires_user_confirmation, true);
      assert.equal(result.unresolved_items.some((item) => item.asset_id === candidate.id), true);
      assert.equal(result.summary.requires_confirmation, true);
    });

    it(`${label} / S4b two uploaded clips targeting the same shot require an explicit user choice`, () => {
      const result = plan(profile, [
        profile.primary,
        video('shot2-version-a.mp4', 'direct_clip', 2),
        video('shot2-version-b.mp4', 'direct_clip', 2),
      ], 3);
      assert.equal(result.shots[1].source, 'unresolved');
      assert.equal(result.shots[1].status, 'needs_confirmation');
      assert.equal(result.stage_policy.shot_video, 'awaiting_clip_assignment');
      assert.equal(result.unresolved_items.filter((item) => item.type === 'direct_clip_shot_conflict').length, 2);
    });

    it(`${label} / S4c a reference video is never silently promoted into the final timeline`, () => {
      const result = plan(profile, [profile.primary, video('motion-guide.mp4', 'reference_video')], 2);
      const reference = result.assets.find((asset) => asset.file_name === 'motion-guide.mp4');
      assert.equal(reference.role, 'reference_video');
      assert.equal(reference.direct_clip_candidate, false);
      assert.equal(result.shots.every((shot) => shot.source !== 'imported_clip') || result.shots.filter((shot) => shot.source === 'imported_clip').every((shot) => shot.source_asset_id !== reference.id), true);
    });

    it(`${label} / S5 two uploaded characters are never silently conflated`, () => {
      const materials = [
        image('character-a.png', 'character_reference', 'character'),
        image('character-b.png', 'character_reference', 'character'),
      ];
      const result = plan({ ...profile, intent: '让上传的两个角色在同一故事中互动' }, materials, 1);
      const resources = [
        { scope_type: 'character', scope_id: 'character-1', content: { name: '角色甲' } },
        { scope_type: 'character', scope_id: 'character-2', content: { name: '角色乙' } },
      ];
      const bound = execution.bindShotReferences({ number: 1, character_ids: [], character_names: [] }, result, resources);
      assert.deepEqual(bound.character_ids, []);
      assert.deepEqual(bound.reference_asset_ids, []);
    });

    it(`${label} / S6 one exact available authority is carried into the shot reference package`, () => {
      const isProduct = ['ecommerce', 'brand-promo'].includes(profile.id);
      const subject = image(isProduct ? 'only-product.png' : 'only-character.png', isProduct ? 'product_reference' : 'character_reference', isProduct ? 'product' : 'character');
      const result = plan({ ...profile, intent: '让上传图片中的角色完成动作' }, [subject], 1);
      const expectedScope = isProduct ? 'product-1' : 'character-1';
      const resources = [{ scope_type: isProduct ? 'product' : 'character', scope_id: expectedScope, content: { name: isProduct ? '唯一商品' : '唯一角色' } }];
      const bound = execution.bindShotReferences({ number: 1, character_ids: [], character_names: [] }, result, resources);
      assert.deepEqual(bound.character_ids, isProduct ? [] : [expectedScope]);
      assert.equal(bound.reference_asset_ids.includes(expectedScope), true);
    });

    it(`${label} / S6b low-confidence AI placement stays editable and does not block the shot plan`, () => {
      const uncertain = { ...profile.primary, file_name: `uncertain-${profile.primary.file_name}`, relative_path: `uncertain-${profile.primary.file_name}`, sha256: `uncertain-${profile.id}`, confidence: 0.31 };
      const result = plan(profile, [uncertain], 1);
      assert.equal(result.unresolved_items.some((item) => item.type === 'low_confidence_assignment'), true);
      assert.equal(result.shots.length, 1);
      assert.equal(result.summary.requires_confirmation, true);
    });

    it(`${label} / S7 scene requirements and optional stages follow template semantics`, () => {
      const result = plan(profile, [profile.primary], 2);
      const expectedSceneRequired = ['novel-drama', 'virtual-drama'].includes(profile.id);
      assert.equal(result.summary.scene_required, expectedSceneRequired);
      assert.equal(result.stage_policy.scene, expectedSceneRequired ? 'generate_if_needed' : 'optional');
      assert.equal(result.workflow.skip_rules.optional_stages.includes('shot_video'), true);
      assert.equal(result.workflow.skip_rules.allow_partial_success, true);
    });

    it(`${label} / S8 refresh/restart reconstruction is deterministic and creates zero video requests`, () => {
      let videoCreates = 0;
      const first = plan(profile, [profile.primary, video('shot3-existing.mp4', 'direct_clip', 3)], 4);
      const restored = plan(profile, [profile.primary, video('shot3-existing.mp4', 'direct_clip', 3)], 4);
      assert.deepEqual(semantic(restored), semantic(first));
      assert.equal(first.reference_policy.include_roles.length > 0, true);
      assert.equal(first.workflow.reference_rules.user_controls_inclusion, true);
      assert.equal(first.workflow.reference_rules.preserve_original_files, true);
      assert.equal(videoCreates, 0);
    });
  }

  it('matrix definition contains every catalog template plus free creation exactly once', () => {
    const expected = ['free', ...catalog.listTemplates().items.map((item) => item.id)].sort();
    const actual = PROFILES.map((item) => item.id).sort();
    assert.deepEqual(actual, expected);
    assert.equal(PROFILES.length * 11, 154);
  });
});
