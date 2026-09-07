const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const execution = require('../src/services/templateExecutionPlan');

function item(name, type, role, patch = {}) {
  return { file_name: name, relative_path: name, sha256: `sha-${name}`, detected_type: type, usage_role: role, confidence: 0.95, status: 'ready', ...patch };
}
function image(name, role = 'character_reference', type = 'character', patch = {}) { return item(name, type, role, { mime_type: 'image/png', ...patch }); }
function video(name, role = 'direct_clip', shotNumber = null, patch = {}) { return item(name, 'video', role, { mime_type: 'video/mp4', direct_clip_candidate: role === 'direct_clip', ...(shotNumber == null ? {} : { shot_number: shotNumber }), ...patch }); }
function make(templateId, intent, items = [], targetShots = 3) { return execution.buildExecutionPlan({ template_id: templateId, user_intent: intent, items, target_shots: targetShots }); }

describe('V0.1.4 horizontal recovery and intent scenarios (24)', () => {
  it('H01 empty input remains usable', () => assert.equal(make('free', '').shots.length, 3));
  it('H02 unknown future template uses free semantics', () => assert.equal(make('future-v014', '继续制作').workflow.id, 'free'));
  it('H03 Chinese relative paths remain stable', () => assert.equal(make('image-to-video', '使用素材', [image('角色/猫娘.png')]).assets[0].source_ref.relative_path, '角色/猫娘.png'));
  it('H04 same-name different hashes stay separate', () => assert.equal(make('image-to-video', '两个角色', [image('a.png', 'character_reference', 'character', { sha256: 'a' }), image('a.png', 'character_reference', 'character', { sha256: 'b', relative_path: '二/a.png' })], 1).subjects.length, 2));
  it('H05 excluded upload is omitted', () => assert.equal(make('image-to-video', '使用有效图', [image('removed.png', 'character_reference', 'character', { status: 'excluded' })]).assets.length, 0));
  it('H06 low confidence remains editable', () => assert.equal(make('image-to-video', '使用图', [image('uncertain.png', 'visual_reference', 'image', { confidence: 0.2 })]).summary.requires_confirmation, true));
  it('H07 two clips on one shot never auto-select', () => assert.equal(make('course-clipping', '整理片段', [video('a.mp4', 'direct_clip', 2), video('b.mp4', 'direct_clip', 2)]).shots[1].source, 'unresolved'));
  it('H08 action video never enters timeline', () => assert.equal(make('dance-action', '参考动作', [video('dance.mp4', 'action_reference')]).summary.imported_clip_count, 0));
  it('H09 reference video never enters timeline', () => assert.equal(make('image-to-video', '参考画面', [video('ref.mp4', 'reference_video')]).summary.imported_clip_count, 0));
  it('H10 numbered direct clip occupies only its shot', () => assert.equal(make('travel-memory', '剪辑已有片段', [video('shot2.mp4', 'direct_clip', 2)]).shots[1].source, 'imported_clip'));
  it('H11 unnumbered direct clip is visible confirmation', () => assert.equal(make('travel-memory', '判断片段', [video('maybe.mp4', 'direct_clip')]).summary.requires_confirmation, true));
  it('H12 all timeline slots can be imported', () => assert.equal(make('course-clipping', '只剪已有片段', [video('1.mp4', 'direct_clip', 1), video('2.mp4', 'direct_clip', 2), video('3.mp4', 'direct_clip', 3)]).summary.planned_video_actions, 0));
  it('H13 missing middle slot stays generated', () => assert.equal(make('course-clipping', '补中间镜头', [video('1.mp4', 'direct_clip', 1), video('3.mp4', 'direct_clip', 3)]).shots[1].source, 'generate'));
  it('H14 free template does not require a scene', () => assert.equal(make('free', '角色走路').summary.scene_required, false));
  it('H15 scene-required template reports missing scene as advice', () => assert.equal(make('virtual-drama', '角色演戏').stage_policy.scene, 'generate_if_needed'));
  it('H16 supplied scene is bound to scene scope', () => assert.equal(make('virtual-drama', '角色在房间里', [image('hero.png'), image('room.png', 'scene_reference', 'scene')]).assets.find((x) => x.file_name === 'room.png').target_scope_type, 'scene'));
  it('H17 long plan accepts thirty shots', () => assert.equal(make('novel-drama', '拆成三十镜', [item('chapter.md', 'text', 'source_document')], 30).shots.length, 30));
  it('H18 multiple roles are not conflated', () => assert.equal(make('virtual-drama', '两个角色互动', [image('a.png'), image('b.png')], 1).subjects.length, 2));
  it('H19 presenter and product retain separate scopes', () => { const p = make('ecommerce', '人物介绍商品', [image('person.png', 'character_reference', 'person'), image('product.png', 'product_reference', 'product')], 1); assert.deepEqual(p.subjects.map((x) => x.target_scope_type).sort(), ['character', 'product']); });
  it('H20 products are not treated as characters', () => { const p = make('brand-promo', '展示商品', [image('product.png', 'product_reference', 'product')], 1); assert.equal(p.subjects[0].target_scope_type, 'product'); });
  it('H21 audio remains final-edit material', () => assert.equal(make('music-mv', '使用音乐', [item('song.wav', 'audio', 'source_audio', { mime_type: 'audio/wav', candidate_stage: 'final_edit' })]).assets[0].candidate_stage, 'final_edit'));
  it('H22 documents remain script material', () => assert.equal(make('novel-drama', '使用小说', [item('story.md', 'text', 'source_document', { candidate_stage: 'script' })]).assets[0].candidate_stage, 'script'));
  it('H23 repeated planning is deterministic', () => { const a = make('image-to-video', '保持角色一致', [image('hero.png')], 2); const b = make('image-to-video', '保持角色一致', [image('hero.png')], 2); assert.deepEqual(a.shots.map((x) => x.source), b.shots.map((x) => x.source)); });
  it('H24 one-shot user setting is honored', () => assert.equal(make('image-to-video', '只做一个镜头', [image('hero.png')], 1).shots.length, 1));
});
