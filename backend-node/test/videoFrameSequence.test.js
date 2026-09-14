const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');
const { exportFrames, assembleFrames, mapPool, extraAssembleSources } = require('../src/services/videoFrameSequence');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-frame-input-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const ffmpeg = getFfmpegPath(), ffprobe = getFfprobePath();
const available = [ffmpeg, ffprobe].every(bin => spawnSync(bin, ['-version'], { windowsHide: true, timeout: 10000 }).status === 0);
const components = { 'media.ffmpeg': { executables: { ffmpeg, ffprobe } } };
function run(bin, args) {
  const p = spawnSync(bin, args, { windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 4000000 });
  assert.equal(p.status, 0, p.error?.message || p.stderr);
  return p.stdout;
}
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('a failed frame worker stops new encodes and waits for the in-flight encode before returning', async () => {
  let release, failed, settled = false;
  const entered = [];
  const pending = new Promise(resolve => { release = resolve; });
  const failure = new Promise(resolve => { failed = resolve; });
  const work = mapPool(12, 2, async index => {
    entered.push(index);
    if (index === 0) { await Promise.resolve(); failed(); throw new Error('encoder failed'); }
    await pending;
  });
  const rejection = assert.rejects(work, /encoder failed/).then(() => { settled = true; });
  await failure;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'job must not finish while an encode is still running');
  assert.deepEqual(entered, [0, 1], 'failure must prevent scheduling the remaining frames');
  release();
  await rejection;
});

test('queue inputs resolve relative to the manifest, independently of the working directory', () => {
  const dir = path.join(root, 'portable manifest');
  fs.mkdirSync(dir);
  for (const name of ['source.mp4', 'voice.wav', 'edited.png']) fs.writeFileSync(path.join(dir, name), 'fixture');
  const input = path.join(dir, 'frames.json');
  fs.writeFileSync(input, JSON.stringify({ source: { path: 'source.mp4' }, audio: { path: 'voice.wav' } }));
  const extras = extraAssembleSources('local.video.assemble-frames', { replacements: [{ index: 0, path: 'edited.png' }] }, input);
  assert.deepEqual(extras.map(x => x.path), ['source.mp4', 'voice.wav', 'edited.png'].map(x => path.join(dir, x)));
});

test('real CFR export/edit/reassemble preserves 240 frames and rejects changed inputs', { skip: !available }, async t => {
  const src = path.join(root, 'cfr source.mp4');
  run(ffmpeg, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=60:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  const input = path.join(root, 'export', 'frames.json');
  await exportFrames({ inputPath: src, outputPath: input, components });
  const original = JSON.parse(fs.readFileSync(input));
  assert.equal(original.frame_count, 240);
  const frames = path.dirname(input);
  const save = m => fs.writeFileSync(input, JSON.stringify(m));
  let sequence = 0;
  const assemble = (parameters = {}, report = () => {}) => assembleFrames({ inputPath: input, outputPath: path.join(root, 'assemble-' + sequence++, 'result.mp4'), parameters, components, report });
  await t.test('relative source/audio and explicit edited frame survive roundtrip with exact duration', async () => {
    const m = structuredClone(original);
    m.source.path = path.relative(frames, src);
    m.audio.path = path.relative(frames, m.audio.path);
    save(m);
    const edited = path.join(frames, 'edited.png');
    run(ffmpeg, ['-nostdin', '-y', '-v', 'error', '-i', path.join(frames, m.frames[20].file), '-vf', 'drawbox=x=10:y=10:w=20:h=20:c=cyan:t=fill', '-frames:v', '1', edited]);
    const result = await assemble({ replacements: [{ index: 20, path: 'edited.png', sha256: sha(edited) }] });
    assert.deepEqual(result.replaced_indexes, [20]);
    assert.equal(result.after.has_audio, true);
    const output = path.join(root, 'assemble-0', 'result.mp4');
    const probe = JSON.parse(run(ffprobe, ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets,duration', '-of', 'json', output]));
    assert.equal(Number(probe.streams[0].nb_read_packets), 240);
    assert.equal(Number(probe.streams[0].duration), 4);
  });
  save(original);
  await t.test('out-of-range edit does not silently become a no-op', async () => {
    await assert.rejects(assemble({ replacements: [{ index: 240, path: original.frames[0].file, sha256: original.frames[0].sha256 }] }), { code: 'FRAME_SEQUENCE_INPUT' });
  });
  await t.test('changed exported audio requires explicitly selecting the new voice', async () => {
    const audio = original.audio.path, bytes = fs.readFileSync(audio);
    fs.appendFileSync(audio, Buffer.from([0, 0]));
    try { await assert.rejects(assemble(), { code: 'INPUT_CHANGED' }); }
    finally { fs.writeFileSync(audio, bytes); }
  });
  await t.test('missing explicitly selected voice does not fall back to the old voice', async () => {
    await assert.rejects(assemble({ audio_path: 'missing.wav' }), { code: 'AUDIO_MISSING' });
  });
  await t.test('a frame changed after preflight cannot be registered as successful output', async () => {
    const file = path.join(frames, original.frames[0].file), bytes = fs.readFileSync(file);
    try {
      await assert.rejects(assemble({}, status => {
        if (status.stage === 'assembling') fs.appendFileSync(file, Buffer.from([0]));
      }), { code: 'INPUT_CHANGED' });
    } finally { fs.writeFileSync(file, bytes); }
  });
});