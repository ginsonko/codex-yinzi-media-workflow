const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { analyzeEnvelope, settings, executeNative } = require('../src/services/audioBeatAnalysis');
const { execute } = require('../src/services/localMediaExecutor');
const { run, sha256 } = require('../src/services/componentRuntime');
const { getFfmpegPath, getFfprobePath, hasLocalFfmpeg } = require('../src/utils/ffmpegPath');

function wav(file, hits, duration = 4.5) {
  const rate = 16000, samples = Math.ceil(duration * rate), buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const t = i / rate; let value = 0;
    for (const hit of hits) { const dt = t - hit; if (dt >= 0 && dt < 0.08) value += Math.sin(2 * Math.PI * 90 * dt) * Math.exp(-dt * 65) * 0.7; }
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buffer);
}

test('beat suggestions do not invent a tempo for silence, steady energy or a single transient', () => {
  for (const frames of [Array(300).fill(0), Array(300).fill(0.1), [0,0,0.5,0.2,...Array(300).fill(0)]]) {
    const result = analyzeEnvelope(frames, 0.01);
    assert.equal(result.tempo_hypothesis, null);
    assert.ok(result.onsets.length <= 1);
  }
  assert.throws(() => settings({ high_hz: 100, low_hz: 300 }), { code: 'BEAT_ANALYSIS_INPUT' });
  assert.throws(() => settings({ sensitivity: NaN }), { code: 'BEAT_ANALYSIS_INPUT' });
});

test('real FFmpeg beat analysis preserves audio and finds timed drum hits without paid models', { skip: !hasLocalFfmpeg() }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-beats-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, '节拍 中文.wav'), hits = Array.from({length:8}, (_,i) => 0.25 + i * 0.5);
  wav(input, hits); const before = await sha256(input);
  const component = { component_id: 'media.ffmpeg', version: 'test-existing', reused: true, executables: { ffmpeg: getFfmpegPath(), ffprobe: getFfprobePath() } };
  const result = await execute({ module_id: 'local.audio.analyze-beats', input_path: input }, { outputDir: path.join(root,'out'), manager: { ensureComponent: async () => component } });
  const analysis = JSON.parse(fs.readFileSync(result.output_path, 'utf8'));
  assert.equal(await sha256(input), before);
  assert.equal(analysis.onsets.length, hits.length, JSON.stringify(analysis.onsets));
  for (const [i, hit] of hits.entries()) assert.ok(Math.abs(analysis.onsets[i].seconds - hit) <= 0.025, JSON.stringify(analysis.onsets));
  assert.ok(Math.abs(analysis.tempo_hypothesis.bpm - 120) < 1);
  assert.equal(analysis.tempo_hypothesis.musical_tempo_confirmed, false);
  assert.equal(result.details.quality_status, 'review_required');
  assert.ok(fs.readFileSync(path.join(root,'out','audio-timeline.svg'),'utf8').includes('<svg'));
  const silent = path.join(root, 'silent.wav'); wav(silent, [], 0.07);
  const short = path.join(root, 'short.json');
  await executeNative({ inputPath: silent, outputPath: short, components: { 'media.ffmpeg': component } });
  assert.deepEqual(JSON.parse(fs.readFileSync(short)).onsets, []);
  await assert.rejects(executeNative({ inputPath: input, outputPath: path.join(root,'limit.json'), parameters: {max_duration:1}, components: {'media.ffmpeg':component} }), {code:'BEAT_ANALYSIS_LIMIT'});
});

test('analysis times retain delayed audio relative to the video origin', { skip: !hasLocalFfmpeg() }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-delayed-beats-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const audio=path.join(root,'audio.wav'), input=path.join(root,'delayed.mkv'); wav(audio,[0.25,0.75,1.25],2);
  await run(getFfmpegPath(),['-nostdin','-y','-v','error','-f','lavfi','-i','color=c=black:s=160x96:r=24:d=3','-itsoffset','0.5','-i',audio,'-c:v','libx264','-c:a','pcm_s16le',input]);
  const output = path.join(root,'result.json');
  await executeNative({inputPath:input,outputPath:output,components:{'media.ffmpeg':{executables:{ffmpeg:getFfmpegPath(),ffprobe:getFfprobePath()}}}});
  const analysis=JSON.parse(fs.readFileSync(output));
  assert.equal(analysis.onsets.length,3);
  assert.ok(Math.abs(analysis.onsets[0].seconds-0.75)<0.025,JSON.stringify(analysis.onsets));
  assert.ok(Math.abs(analysis.onsets[2].seconds-1.75)<0.025);
});
