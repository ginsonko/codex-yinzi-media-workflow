const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const bridge = require('../src/services/jianyingDraft');
const { operations } = require('../src/services/localJianyingOperation');
const put = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const temporary = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-jianying-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };

test('nested template, subtitle and replacement dependencies resolve against their own roots', t => {
  const root = temporary(t), template = path.join(root, 'template'); fs.mkdirSync(template);
  for (const file of ['clip.mp4', 'new.mp4', 'caption.srt']) fs.writeFileSync(path.join(root, file), 'nonempty fixture');
  fs.writeFileSync(path.join(template, 'inside.png'), 'fixture');
  put(path.join(template, 'draft_content.json'), { canvas_config: {}, tracks: [], materials: {
    videos: [{ path: '../clip.mp4' }], stickers: [{ path: 'inside.png' }]
  } });
  const job = path.join(root, 'job.json');
  put(job, { clips: [{ path: 'clip.mp4' }], subtitles: [{ path: 'caption.srt' }], template: {
    path: 'template/draft_content.json', media_replacements: [{ path: 'new.mp4', name: 'clip.mp4' }]
  } });
  const sources = bridge.sourcesForJob(job);
  assert.deepEqual(new Set(sources.map(s => s.path)), new Set(['clip.mp4', 'new.mp4', 'caption.srt', 'template/inside.png', 'template/draft_content.json'].map(f => path.join(root, f))));
  assert.ok(sources.every(s => path.isAbsolute(s.path)));
  const first = bridge.snapshot(job);
  fs.writeFileSync(path.join(root, 'clip.mp4'), 'changed fixture');
  const second = bridge.snapshot(job);
  assert.notEqual(first.find(s => s.path.endsWith('clip.mp4')).sha256, second.find(s => s.path.endsWith('clip.mp4')).sha256);
});

test('encrypted templates and unresolved nested resources fail before any output is created', t => {
  const root = temporary(t), template = path.join(root, 'template'); fs.mkdirSync(template);
  const file = path.join(template, 'draft_content.json'), job = path.join(root, 'job.json');
  put(job, { template: { path: 'template' } });
  fs.writeFileSync(file, Buffer.from([0xff, 0x03, 0x00, 0xaa]));
  assert.throws(() => bridge.sourcesForJob(job), { code: 'JIANYING_INVALID_JSON' });
  put(file, { canvas_config: {}, tracks: [], materials: { videos: [{ path: '../missing.mp4' }] } });
  assert.throws(() => bridge.sourcesForJob(job), { code: 'JIANYING_TEMPLATE_RESOURCE_MISSING' });
  assert.equal(fs.existsSync(path.join(root, 'jianying-drafts')), false);
});

test('remote media inputs are never downloaded by the draft builder', t => {
  const root = temporary(t), job = path.join(root, 'job.json');
  put(job, { clips: [{ path: 'https://example.invalid/media.mp4' }] });
  assert.throws(() => bridge.sourcesForJob(job), { code: 'JIANYING_LOCAL_PATH_REQUIRED' });
});

test('optional operations describe engineering results, not render success', () => {
  assert.deepEqual(operations.map(o => o.id), ['local.jianying.inspect', 'local.jianying.draft']);
  assert.ok(operations.every(o => o.kind === 'document' && o.component_id === null));
  assert.deepEqual(operations[1].outputs, ['editable_draft', 'execution_receipt']);
  assert.equal(operations[1].side_effects.network, false);
});

function bmp(file) {
  const b = Buffer.alloc(70); b.write('BM'); b.writeUInt32LE(70, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14);
  b.writeInt32LE(2, 18); b.writeInt32LE(2, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(16, 34);
  b.fill(127, 54); fs.writeFileSync(file, b);
}
function wav(file) {
  const dataLength = 8000 * 4 * 2, b = Buffer.alloc(44 + dataLength);
  b.write('RIFF'); b.writeUInt32LE(36 + dataLength, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(dataLength, 40); fs.writeFileSync(file, b);
}

const realEnabled = !!(process.env.YINZI_JIANYING_TEST_PYTHON && process.env.YINZI_JIANYING_TEST_MEDIA);
test('receipt disk failure recovers the same editor copy and editor-copy templates can be reused', { skip: !realEnabled, timeout: 180000 }, async t => {
  const root = temporary(t), drafts = path.join(root, 'editor'); fs.mkdirSync(drafts);
  const job = path.join(root, 'job.json'), output = path.join(root, 'result.json'), configPath = path.join(root, 'config.json');
  put(configPath, { python: process.env.YINZI_JIANYING_TEST_PYTHON, drafts_root: drafts });
  put(job, { name: 'Recovery', clips: [{ path: process.env.YINZI_JIANYING_TEST_MEDIA, duration: 1 }] });
  const options = { configPath, prepareEditor: true }, originalWrite = fs.writeFileSync;
  let fault = 'initial';
  const mocked = t.mock.method(fs, 'writeFileSync', function (file, data, ...args) {
    if (typeof file === 'string' && file.startsWith(output + '.') && file.endsWith('.tmp')) {
      const value = JSON.parse(data);
      if (fault === 'initial' || (fault === 'delivery' && value.editor_delivery)) {
        fault = null;
        originalWrite.call(fs, file, '{'); // A partial disk write must not corrupt the receipt.
        throw Object.assign(new Error('injected disk full'), { code: 'ENOSPC' });
      }
    }
    return originalWrite.call(fs, file, data, ...args);
  });
  await assert.rejects(bridge.execute(job, output, options), { code: 'ENOSPC' });
  assert.equal(fs.existsSync(output), false); assert.equal(fs.readdirSync(drafts).length, 0);
  fault = 'delivery';
  await assert.rejects(bridge.execute(job, output, options), { code: 'ENOSPC' });
  const saved = JSON.parse(fs.readFileSync(output));
  assert.equal(saved.stage, 'draft_ready'); assert.equal(saved.editor_delivery, undefined);
  assert.equal(fs.readdirSync(drafts).length, 1);
  mocked.mock.restore();
  const recovered = await bridge.execute(job, output, options);
  assert.equal(recovered.draft_id, saved.draft_id); assert.equal(recovered.editor_delivery.reused, true);
  assert.equal(fs.readdirSync(drafts).length, 1);
  assert.equal(fs.readdirSync(root).some(name => name.endsWith('.tmp') || name.endsWith('.lock')), false);
  const template = recovered.editor_delivery.draft_path, before = fs.readFileSync(path.join(template, 'yinzi-editor-copy.json'));
  const templateJob = path.join(root, 'template.json'); put(templateJob, { name: 'Reused template', template: { path: template } });
  const next = await bridge.execute(templateJob, path.join(root, 'next.json'), options);
  assert.equal(next.editor_delivery.status, 'editor_copy_prepared'); assert.notEqual(next.draft_id, saved.draft_id);
  assert.deepEqual(fs.readFileSync(path.join(template, 'yinzi-editor-copy.json')), before);
});
test('real pinned builder: media, SRT, presets, templates, input integrity and conflict recovery', { skip: !realEnabled, timeout: 180000 }, async t => {
  const root = temporary(t), python = process.env.YINZI_JIANYING_TEST_PYTHON;
  fs.copyFileSync(process.env.YINZI_JIANYING_TEST_MEDIA, path.join(root, 'source.mp4'));
  fs.copyFileSync(process.env.YINZI_JIANYING_TEST_MEDIA, path.join(root, 'replacement.mp4'));
  bmp(path.join(root, 'photo.bmp')); wav(path.join(root, 'sound.wav'));
  fs.writeFileSync(path.join(root, 'captions.srt'), '1\n00:00:00,000 --> 00:00:01,200\n第一句字幕\n\n2\n00:00:01,500 --> 00:00:02,800\nSecond caption\n');
  const inspection = await bridge.inspect({ python, preset_type: 'filter', query: '冷蓝', limit: 2 });
  assert.equal(inspection.stage, 'environment_inspected'); assert.equal(inspection.dependency.ready, true);
  assert.equal(inspection.presets.availability, 'reference_only_editor_unverified');
  assert.ok(inspection.presets.items.some(item => item.name === '冷蓝'));
  const job = path.join(root, 'job.json'), output = path.join(root, 'result.json');
  put(job, { name: 'Real draft 中文', width: 1280, height: 720, fps: 30,
    clips: [
      { path: 'source.mp4', start: 0, duration: 1.5, filters: [{ name: '冷蓝', intensity: 25 }], transition: { name: '叠化', duration: .3 }, keyframes: [{ property: 'uniform_scale', time: 0, value: 1 }, { property: 'uniform_scale', time: 1.5, value: 1.05 }] },
      { path: 'photo.bmp', kind: 'image', start: 1.5, duration: 1.5 },
      { path: 'sound.wav', kind: 'audio', duration: 3, volume: .5, fade: { in: .1, out: .2 }, keyframes: [{ property: 'volume', time: 0, value: .2 }, { property: 'volume', time: 1, value: .5 }] }
    ], texts: [{ text: '测试 TITLE', track: 'titles', start: .1, duration: 2.5, style: { bold: true, color: [1, .8, .2] }, border: { width: 20 }, animation: { kind: 'intro', name: '弹入', duration: .25 } }],
    subtitles: [{ path: 'captions.srt', track: 'captions' }] });
  const first = await bridge.execute(job, output, { python });
  assert.equal(first.stage, 'draft_ready'); assert.equal(first.export_verified, false); assert.equal(first.duration_seconds, 3);
  assert.equal(first.tracks, 4); assert.equal(first.segments, 6); assert.ok(first.resources.some(r => r.name === '冷蓝'));
  const data = JSON.parse(fs.readFileSync(first.draft_content_path, 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(first.draft_path, 'draft_meta_info.json'), 'utf8'));
  assert.equal(data.id, meta.draft_id); assert.equal(meta.draft_name, 'Real draft 中文');
  assert.ok(data.materials.transitions.length); assert.ok(data.materials.material_animations.length);
  const again = await bridge.execute(job, output, { python }); assert.equal(again.reused, true); assert.equal(again.draft_id, first.draft_id);
  const templateJob = path.join(root, 'template-job.json');
  put(templateJob, { name: 'Template duplicate', template: { path: first.draft_path,
    text_replacements: [{ track: 'titles', index: 0, text: '替换成功 / REPLACED' }],
    media_replacements: [{ name: 'source.mp4', path: 'replacement.mp4', kind: 'video' }] } });
  const second = await bridge.execute(templateJob, path.join(root, 'template-result.json'), { python });
  assert.notEqual(second.draft_id, first.draft_id); assert.equal(second.duration_seconds, first.duration_seconds);
  const replaced = JSON.parse(fs.readFileSync(second.draft_content_path, 'utf8'));
  assert.ok(replaced.materials.texts.some(item => item.content.includes('REPLACED')));
  assert.ok(replaced.materials.videos.some(item => item.path.endsWith('replacement.mp4')));
  assert.equal(JSON.parse(fs.readFileSync(first.draft_content_path, 'utf8')).materials.texts.some(item => item.content.includes('REPLACED')), false);
  fs.appendFileSync(path.join(root, 'captions.srt'), '\n');
  await assert.rejects(bridge.execute(job, output, { python }), { code: 'JIANYING_OUTPUT_CONFLICT' });
  fs.writeFileSync(path.join(root, 'captions.srt'), '1\n00:00:00,000 --> 00:00:01,200\n第一句字幕\n\n2\n00:00:01,500 --> 00:00:02,800\nSecond caption\n');
  fs.appendFileSync(first.draft_content_path, '\n');
  await assert.rejects(bridge.execute(job, output, { python }), { code: 'JIANYING_OUTPUT_CHANGED' });
  const invalid = path.join(root, 'invalid.json'), invalidOutput = path.join(root, 'invalid-result.json');
  put(invalid, { clips: [{ path: 'source.mp4', duration: 1, filters: [{ name: 'not-a-real-filter' }] }] });
  await assert.rejects(bridge.execute(invalid, invalidOutput, { python }), { code: 'JIANYING_UNKNOWN_PRESET' });
  assert.equal(fs.existsSync(invalidOutput), false); assert.equal(fs.existsSync(invalidOutput + '.jianying.lock'), false);
  put(invalid, { clips: [{ path: 'source.mp4', duration: 1, keyframes: [{ property: 'uniform_scale', time: 5, value: 1 }] }] });
  await assert.rejects(bridge.execute(invalid, invalidOutput, { python }), { code: 'JIANYING_KEYFRAME_RANGE' });
  assert.equal(fs.existsSync(invalidOutput), false);
  const speedJob = path.join(root, 'speed.json');
  put(speedJob, { clips: [{ path: 'source.mp4', start: .5, source_start: .25, duration: 1, speed: 2 }] });
  const fast = await bridge.execute(speedJob, path.join(root, 'speed-result.json'), { python });
  const fastContent = JSON.parse(fs.readFileSync(fast.draft_content_path, 'utf8'));
  const fastSegment = fastContent.tracks[0].segments[0];
  assert.deepEqual(fastSegment.target_timerange, { start: 500000, duration: 1000000 });
  assert.deepEqual(fastSegment.source_timerange, { start: 250000, duration: 2000000 });
  const setup = path.resolve(__dirname, '../scripts/setup-jianying.py');
  const inspectRoot = path.join(root, 'not-created'), inspectConfig = path.join(inspectRoot, 'config.json');
  const inspected = JSON.parse(execFileSync(python, [setup, '--root', inspectRoot, '--config', inspectConfig], { encoding: 'utf8' }));
  assert.equal(inspected.status, 'inspected'); assert.equal(fs.existsSync(inspectRoot), false);
  const adoptedConfig = path.join(root, 'adopted.json'); put(adoptedConfig, { note: 'keep-user-preference' });
  const adopted = JSON.parse(execFileSync(python, [setup, '--adopt', '--python', python, '--root', inspectRoot, '--config', adoptedConfig], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } }));
  assert.equal(adopted.mode, 'adopt'); assert.equal(fs.existsSync(inspectRoot), false);
  assert.equal(JSON.parse(fs.readFileSync(adoptedConfig, 'utf8')).note, 'keep-user-preference');
  assert.ok(fs.readdirSync(root).some(f => f.startsWith('adopted.json.before-')));
  const conflictConfig = path.join(root, 'concurrent.json'); put(conflictConfig, { before: true });
  const simulateConflict = `import importlib.util,json,pathlib,sys\ns=importlib.util.spec_from_file_location('setup',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)\ncfg=pathlib.Path(sys.argv[2]); target=sys.argv[1]\ndef probe(p):\n cfg.write_text(json.dumps({'concurrent_user_edit':True})); return {'ready':True}\nm.probe=probe; sys.argv=[target,'--adopt','--python',sys.executable,'--config',str(cfg)]\ntry: m.main()\nexcept RuntimeError as e:\n assert 'changed during setup' in str(e); print('config-conflict-preserved')\nelse: raise AssertionError('concurrent config edit overwritten')`;
  const preserved = execFileSync(python, ['-c', simulateConflict, setup, conflictConfig], { encoding: 'utf8' });
  assert.ok(preserved.includes('config-conflict-preserved'));
  assert.equal(JSON.parse(fs.readFileSync(conflictConfig, 'utf8')).concurrent_user_edit, true);
});
