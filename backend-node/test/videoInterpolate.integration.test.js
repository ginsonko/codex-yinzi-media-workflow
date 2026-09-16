const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { execute } = require('../src/services/localMediaExecutor');
const { getOperation, contracts } = require('../src/services/localMediaOperations');
const { registry, run } = require('../src/services/componentRuntime');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');

const bins = { ffmpeg: getFfmpegPath(), ffprobe: getFfprobePath() };
const hasFfmpeg = Object.values(bins).every(bin =>
  spawnSync(bin, ['-version'], { windowsHide: true, timeout: 10000 }).status === 0);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-interpolation-'));
const source = path.join(root, 'motion.mp4');
const moduleId = 'local.video.interpolate';
const rifeBin = process.env.RIFE_BIN;
before(async () => {
  if (!hasFfmpeg) return;
  await run(bins.ffmpeg, ['-nostdin', '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=128x96:r=10:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', source]);
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

function manager({ installError = null } = {}) {
  const calls = [];
  return {
    calls,
    async ensureComponent(id) {
      calls.push(id);
      if (id === 'media.ffmpeg') return { component_id: id, version: 'fixture', reused: true, executables: bins };
      assert.equal(id, 'vision.rife');
      if (installError) throw Object.assign(new Error(installError), { code: 'COMPONENT_INSTALL_FAILED' });
      assert.ok(rifeBin && fs.existsSync(rifeBin), 'Set RIFE_BIN for a real RIFE run');
      return { component_id: id, version: '20221029', reused: true, executables: { rife: rifeBin } };
    },
    async withResource(_group, perform) { return perform(); },
  };
}

async function processVideo(name, parameters, componentManager = manager()) {
  return execute({ module_id: moduleId, input_path: source, parameters },
    { manager: componentManager, outputDir: path.join(root, name) });
}

test('formal registry exposes optional RIFE and mutually exclusive rate fields without defaults', () => {
  const op = getOperation(moduleId);
  const schema = contracts().find(item => item.module_id === moduleId).parameter_schema;
  assert.equal(op.defaults.multiplier, undefined);
  assert.equal(op.defaults.target_fps, undefined);
  assert.equal(schema.properties.multiplier.default, undefined);
  assert.equal(schema.properties.target_fps.default, undefined);
  assert.equal(op.normalizeParameters({ ...op.defaults }).multiplier, 2);
  assert.deepEqual(op.additional_components, []);
  assert.deepEqual(op.optional_components, ['vision.rife']);
  assert.equal(registry().filter(item => item.component_id === 'vision.rife').length, 1);
});

test('target FPS alone works through the formal executor and retains sound', { skip: !hasFfmpeg }, async () => {
  const components = manager();
  const receipt = await processVideo('target', { engine: 'minterpolate', target_fps: 24 }, components);
  assert.equal(receipt.details.after.fps, 24);
  assert.equal(receipt.details.after.video_frames, 48);
  assert.equal(receipt.details.after.has_audio, true);
  assert.equal(receipt.parameters.multiplier, undefined);
  assert.deepEqual(components.calls, ['media.ffmpeg']);
  await run(bins.ffmpeg, ['-v', 'error', '-i', receipt.output_path, '-f', 'null', '-']);
});

test('omitted rate produces exactly two times the source frames', { skip: !hasFfmpeg }, async () => {
  const receipt = await processVideo('default', { engine: 'minterpolate' });
  assert.equal(receipt.details.after.fps, 20);
  assert.equal(receipt.details.after.video_frames, 40);
  assert.equal(receipt.details.after.duration, 2);
});

test('explicit conflicting rates fail before any component installation', { skip: !hasFfmpeg }, async () => {
  const components = manager();
  await assert.rejects(processVideo('conflict', { multiplier: 2, target_fps: 24 }, components), { code: 'PARAMETER_CONFLICT' });
  assert.deepEqual(components.calls, []);
});

test('auto preserves the real installation failure and uses FFmpeg', { skip: !hasFfmpeg }, async () => {
  const components = manager({ installError: 'fixture offline' });
  const receipt = await processVideo('fallback', { engine: 'auto', multiplier: 2 }, components);
  assert.equal(receipt.details.engine, 'ffmpeg-minterpolate');
  assert.match(receipt.details.details.fallback_reason, /fixture offline/);
  assert.deepEqual(components.calls, ['media.ffmpeg', 'vision.rife']);
});

test('explicit RIFE preserves an installation failure instead of changing engine', { skip: !hasFfmpeg }, async () => {
  const components = manager({ installError: 'fixture explicit failure' });
  await assert.rejects(processVideo('rife-failure', { engine: 'rife' }, components), { code: 'COMPONENT_INSTALL_FAILED' });
  assert.equal(fs.existsSync(path.join(root, 'rife-failure', 'result.mp4')), false);
});

test('scene detection can be disabled and low FPS retains the full tail', { skip: !hasFfmpeg }, async () => {
  const low = path.join(root, 'low.mp4');
  await run(bins.ffmpeg, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=s=128x96:r=2:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', low]);
  const receipt = await execute({ module_id: moduleId, input_path: low,
    parameters: { engine: 'minterpolate', target_fps: 12, scene_detection: false } },
  { manager: manager(), outputDir: path.join(root, 'low-result') });
  assert.equal(receipt.details.after.video_frames, 36);
  assert.equal(receipt.details.after.duration, 3);
  assert.match(receipt.details.details.filter, /scd=none/);
  assert.match(receipt.details.details.filter, /stop_duration=1.500/);
});

test('real RIFE through formal executor retains duration, frame count and audio',
  { skip: !hasFfmpeg || !rifeBin }, async () => {
    const receipt = await processVideo('real-rife', { engine: 'rife', multiplier: 2 });
    assert.equal(receipt.details.engine, 'rife-ncnn-vulkan');
    assert.equal(receipt.details.after.video_frames, 40);
    assert.equal(receipt.details.after.duration, 2);
    assert.equal(receipt.details.after.has_audio, true);
    await run(bins.ffmpeg, ['-v', 'error', '-i', receipt.output_path, '-f', 'null', '-']);
  });

test('RIFE intermediates remain usable when the job directory would push frame paths past MAX_PATH',
  { skip: !hasFfmpeg || !rifeBin || process.platform !== 'win32' }, async () => {
    let outputDir = root;
    while (outputDir.length < 208) outputDir = path.join(outputDir, 'long-job-segment');
    const receipt = await execute({ module_id: moduleId, input_path: source,
      parameters: { engine: 'rife', target_fps: 20 } }, { manager: manager(), outputDir });
    assert.equal(receipt.details.after.video_frames, 40);
    assert.equal(receipt.details.after.has_audio, true);
  });
