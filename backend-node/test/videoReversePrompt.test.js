const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectFrames, compileManifest } = require('../src/services/videoReversePrompt');
const manifest = { schema: 'yinzi.video-reverse/v1', goal: '按原镜头替换主体', source: { duration_seconds: 5, sha256: 'original' }, frames: [{ id: 'K001', seconds: 0 }, { id: 'K002', seconds: 1.7 }, { id: 'K003', seconds: 3 }, { id: 'K004', seconds: 4.95 }] };
const parameters = () => ({ observations: [{ start: 0, end: 2, frame_ids: ['K001', 'K002'], description: '人物举手', background: '黄底文字' }, { start: 2, end: 5, frame_ids: ['K003', 'K004'], description: '人物收手闭眼', transition: '末尾切为白底' }], references: [{ type: 'image', index: 6, role: '身份设定' }, { type: 'video', index: 1, role: '原时间线' }], output_duration: 30 });
test('irregular frame timing selects actual nearest frames in chronological order without duplicates', () => {
  assert.deepEqual(selectFrames([0, .04, .12, .5, 1.7, 3], { timestamps: [1.65, .11, .1, 3] }).map(f => [f.source_frame, f.seconds]), [[2, .12], [4, 1.7], [5, 3]]);
  assert.throws(() => selectFrames([0, 1], { timestamps: [-1] }), /关键帧秒数/);
});
test('reference order and complete timing survive compilation, rather than silently relabeling identity', () => {
  const result = compileManifest(manifest, parameters());
  assert.match(result.prompt, /@图片6：身份设定/);
  assert.match(result.prompt, /保留前 5 秒原时间节奏/);
  assert.match(result.prompt, /30 秒/);
  assert.deepEqual(result.acceptance_times, [0, 1.7, 3, 4.95]);
  assert.equal(result.quality_status, 'review_required');
});
test('missing visual analysis and frames from the wrong moment cannot masquerade as a reversed prompt', () => {
  assert.throws(() => compileManifest(manifest, {}), /observations/);
  const p = parameters(); p.observations[0].frame_ids = ['K004'];
  assert.throws(() => compileManifest(manifest, p), /时间不对应/);
});
test('unknown references, duplicate attachments, overlaps and truncated prompts preserve actionable errors', () => {
  let p = parameters(); p.references[0].frame_ids = ['missing']; assert.throws(() => compileManifest(manifest, p), /不在关键帧/);
  p = parameters(); p.references.push(p.references[0]); assert.throws(() => compileManifest(manifest, p), /索引重复/);
  p = parameters(); p.observations[1].start = 1.9; assert.throws(() => compileManifest(manifest, p), /不能重叠/);
  p = parameters(); p.max_prompt_chars = 100; assert.throws(() => compileManifest(manifest, p), /不会静默截断/);
  p = parameters(); p.output_duration = 2; assert.throws(() => compileManifest(manifest, p), /输出时长短于/);
});
test('unobserved timeline remains an explicit warning and uncertainties remain in the receipt', () => {
  const p = parameters(); p.observations[1].end = 4; p.observations[1].frame_ids = ['K003']; p.observations[1].uncertainties = '手部遮挡不确定';
  const r = compileManifest(manifest, p);
  assert.match(r.warnings[0], /4–5秒/); assert.equal(r.observations[1].uncertainties, '手部遮挡不确定');
});
