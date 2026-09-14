const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  settings, formatTimecode, parseShowinfoLine, frameMetrics, analyzeSamples,
  selectKeyframes, alignShotsWithBeats, contactLabel, clipEndSeconds, clipEndFromLastFrame,
  contentDuration, ptsSelect, executeNative,
} = require('../src/services/videoShotAnalysis');
const { createRequire } = require('node:module');

function existingDir(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return candidates.find(Boolean) || '';
}

const BACKEND = existingDir([
  process.env.YINZI_BACKEND_NODE,
  process.env.BACKEND_NODE_ROOT,
  path.resolve(__dirname, '..'),
]);
let ffmpegPathFn = null;
try { ffmpegPathFn = require(path.join(BACKEND, 'src/utils/ffmpegPath')); } catch { ffmpegPathFn = null; }
const FFMPEG = process.env.FFMPEG_PATH || ffmpegPathFn?.getFfmpegPath?.() || path.join(BACKEND, 'tools/ffmpeg/ffmpeg.exe');
const FFPROBE = process.env.FFPROBE_PATH || ffmpegPathFn?.getFfprobePath?.() || path.join(BACKEND, 'tools/ffmpeg/ffprobe.exe');
const SHARP_DIR = process.env.SHARP_DIR || path.join(BACKEND, 'node_modules/sharp');
const W_ROOT = process.env.YINZI_SHOT_FIXTURE_ROOT || '';
const AE_DIR = process.env.YINZI_AE_FIXTURE_DIR || path.join(W_ROOT, 'outputs/虹咲2-AE实测');
const COUNTER_MKV = process.env.YINZI_ORIGIN5_MKV || path.join(W_ROOT, 'work/shot-timestamp-review/two-color-origin5.mkv');
const HIGHFPS_MP4 = process.env.YINZI_HIGHFPS_MP4 || path.join(W_ROOT, 'work/shot-highfps-review/red-blue-60fps.mp4');
const EVIDENCE_DIR = process.env.SHOT_ANALYSIS_EVIDENCE_DIR || '';

function hasBin(file) {
  try { return fs.existsSync(file) && fs.statSync(file).size > 1024; } catch { return false; }
}
const hasFfmpeg = hasBin(FFMPEG) && hasBin(FFPROBE);
const hasSharp = fs.existsSync(path.join(SHARP_DIR, 'package.json'));
const sharp = hasSharp ? createRequire(path.join(SHARP_DIR, 'package.json'))('sharp') : null;
const components = () => ({
  'media.ffmpeg': { component_id: 'media.ffmpeg', directory: path.dirname(FFMPEG), executables: { ffmpeg: FFMPEG, ffprobe: FFPROBE } },
  'media.sharp': { component_id: 'media.sharp', directory: SHARP_DIR },
});

function run(bin, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      code === 0 ? resolve({ stdout, stderr }) : reject(Object.assign(new Error(stderr.slice(-1500)), { code }));
    });
  });
}

async function colorClip(file, color, fps, duration, extra = []) {
  await run(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:r=${fps}:d=${duration}`, ...extra, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', file]);
}

async function concatClips(files, output) {
  const list = output + '.txt';
  fs.writeFileSync(list, files.map(f => `file '${f.replaceAll('\\', '/')}'`).join('\n'));
  await run(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', output]);
}

function sample(seconds, extra = {}) {
  return { seconds, source_seconds: seconds + (extra.origin || 0), luma: extra.luma ?? 0.5, motion: extra.motion ?? 0.2, score: extra.score ?? 0, ...extra };
}

test('settings and timecode stay bounded and reject invented fps math', () => {
  assert.equal(formatTimecode(0), '00:00:00.000');
  assert.equal(formatTimecode(3661.25), '01:01:01.250');
  assert.equal(formatTimecode(-1.5), '-00:00:01.500');
  assert.throws(() => settings({ sample_fps: -1 }), { code: 'SHOT_ANALYSIS_INPUT' });
  assert.throws(() => settings({ analysis_width: 33 }), { code: 'SHOT_ANALYSIS_INPUT' });
  assert.throws(() => settings({ max_frames: 3.5 }), { code: 'SHOT_ANALYSIS_INPUT' });
  const parsed = parseShowinfoLine('[showinfo@clipend] n:   4 pts:   2048 pts_time:0.166667 duration:512 duration_time:0.0416667');
  assert.equal(parsed.n, 4);
  assert.equal(parsed.pts, 2048);
  assert.equal(parsed.pts_time, 0.166667);
  assert.equal(parsed.duration, 512);
  assert.equal(parsed.duration_time, 0.0416667);
  const label = contactLabel({ id: 'K007', timecode: '00:00:03.867', roles: ['shot_start', 'shot_peak_motion', 'tail'] });
  assert.equal(label.line1, 'K007 00:00:03.867');
  assert.equal(label.line2, 'start+peak+tail');
});

test('pts pairing uses showinfo times, not frame-index divided by fps', () => {
  const { zipSamplesWithPts } = require('../src/services/videoShotAnalysis');
  const p = settings();
  const metrics = [{ luma: 0.1, luma_std: 0, motion: 0, score: 0 }, { luma: 0.2, luma_std: 0, motion: 0.4, score: 0.5 }];
  const pts = [{ pts_time: 1.5, pts: 1500, duration_time: 0.041666 }, { pts_time: 1.541666, pts: 1541, duration_time: 0.041666 }];
  const samples = zipSamplesWithPts(metrics, pts, 1.5, p);
  assert.equal(samples[0].seconds, 0);
  assert.equal(samples[0].source_seconds, 1.5);
  assert.equal(samples[0].source_pts, 1500);
  assert.equal(samples[1].seconds, 0.041666);
  assert.equal(samples[1].source_pts, 1541);
  assert.throws(() => zipSamplesWithPts(metrics, pts.slice(0, 1), 0, p), { code: 'SHOT_ANALYSIS_DECODE' });
});

test('pixel metrics distinguish a hard cut from a still frame without calling it a highlight', () => {
  const red = Buffer.alloc(6, 0); red[0] = 255; red[3] = 255;
  const blue = Buffer.alloc(6, 0); blue[2] = 255; blue[5] = 255;
  const same = frameMetrics(red, 2, 1, red, { luma: 0.2126, hist: new Float64Array(16) });
  const cut = frameMetrics(blue, 2, 1, red, { luma: 0.2126, hist: new Float64Array(16) });
  assert.ok(same.motion < 0.02);
  assert.ok(cut.motion > 0.3);
  assert.ok(cut.score > same.score);
});

test('analyzeSamples finds multiple hard cuts, a single shot, black and freeze intervals', () => {
  const p = settings({ scene_threshold: 0.2, min_shot_seconds: 0.2, min_black_seconds: 0.2, min_freeze_seconds: 0.3, freeze_motion: 0.02, black_luma: 0.08 });
  const noCut = Array.from({ length: 10 }, (_, i) => sample(i * 0.1, { luma: 0.4, motion: 0.2, score: 0.01 }));
  const single = analyzeSamples(noCut, p);
  assert.equal(single.shots.length, 1);
  assert.equal(single.cuts.length, 0);
  assert.equal(single.shots[0].start, 0);
  assert.equal(single.shots[0].end, 0.9);

  const hard = [];
  for (let s = 0; s < 3; s++) {
    for (let i = 0; i < 10; i++) {
      const seconds = s + i * 0.1;
      hard.push(sample(seconds, { luma: 0.3 + s * 0.2, motion: i && 0.01 || (s ? 0.4 : 0), score: i === 0 && s ? 0.6 : 0.01 }));
    }
  }
  const multi = analyzeSamples(hard, p);
  assert.equal(multi.shots.length, 3);
  assert.deepEqual(multi.cuts.map(c => c.seconds), [1, 2]);
  assert.equal(multi.shots[0].start_timecode, '00:00:00.000');
  assert.equal(multi.shots[0].end, 1);
  assert.equal(multi.shots[1].start, 1);
  assert.equal(multi.shots[2].end, 2.9);

  const mixed = [];
  for (let i = 0; i < 20; i++) mixed.push(sample(i * 0.1, { luma: i >= 6 && i <= 12 ? 0.02 : 0.5, motion: i >= 14 ? 0.001 : 0.2, score: 0.01 }));
  const flagged = analyzeSamples(mixed, p);
  assert.equal(flagged.shots.length, 1);
  assert.equal(flagged.black_intervals.length, 1);
  assert.ok(flagged.black_intervals[0].start <= 0.6);
  assert.ok(flagged.black_intervals[0].end >= 1.2);
  assert.equal(flagged.freeze_intervals.length, 1);
  assert.ok(flagged.freeze_intervals[0].start >= 1.3);
  const keys = selectKeyframes(hard, multi, p);
  assert.ok(keys.some(k => k.roles.includes('head')));
  assert.ok(keys.some(k => k.roles.includes('tail')));
  assert.ok(keys.length <= p.max_keyframes);
});

test('beat alignment only joins nearby times and never auto-cuts', () => {
  const shots = [{ id: 'S001', start: 1, end: 2, start_timecode: '00:00:01.000' }];
  const aligned = alignShotsWithBeats(shots, [
    { seconds: 1.04, strength: 0.8, threshold: 0.12 },
    { seconds: 3.5, strength: 0.2, threshold: 0.12 },
  ]);
  assert.equal(aligned[0].auto_cut, false);
  assert.equal(aligned[0].nearby_onset_count, 1);
  assert.equal(aligned[0].nearest_onset_to_start.seconds, 1.04);
  assert.equal(aligned[0].nearest_onset_to_start.strength, 0.8);
  assert.match(aligned[0].note, /不按节拍自动切开/);
  assert.equal(ptsSelect(-400), "'eq(pts,-400)'");
  assert.equal(ptsSelect(7680), "'eq(pts,7680)'");
  assert.throws(() => ptsSelect(0.5), { code: 'SHOT_ANALYSIS_TIME' });
  assert.equal(clipEndSeconds([{ seconds: 0.983333, source_seconds: 0.983333 }], 0.983333, 0, { pts_time: 0.983333, duration_time: 1 / 60 }), 1);
  assert.equal(clipEndSeconds([{ seconds: 0.983333, source_seconds: 0.983333 }], 1, 0), 1);
  assert.equal(clipEndSeconds([{ seconds: 0.875, source_seconds: 0.875 }], 1, 0, { pts_time: 0.875, duration_time: 0.125 }), 1);
  assert.equal(clipEndFromLastFrame({ pts_time: -0.041667, duration_time: 0.041667 }, -0.4), 0.4);
  assert.equal(contentDuration({}, { duration: 6 }, 5), 1);
  assert.equal(contentDuration({ duration: 0.983333 }, { duration: 0.983333 }, 0, { pts_time: 0.983333, duration_time: 1 / 60 }), 1);
  assert.equal(contentDuration({ duration: 4 }, { duration: 4 }, 0), 4);
});

test('last shot covers clip duration, not only the last sampled frame', () => {
  const p = settings({ scene_threshold: 0.9, min_shot_seconds: 0.2 });
  const samples = Array.from({ length: 8 }, (_, i) => sample(i * 0.125, { luma: 0.4, motion: 0.2, score: 0.01 }));
  const result = analyzeSamples(samples, p, 0, 1);
  assert.equal(result.shots.length, 1);
  assert.equal(result.shots[0].last_sample_seconds, 0.875);
  assert.equal(result.shots[0].end, 1);
  assert.equal(result.shots[0].end_basis, 'last_frame_pts_duration');
});

test('real FFmpeg hard cuts match wall-clock at 24fps and 30fps', { skip: !(hasFfmpeg && hasSharp) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-shots-rate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const fps of [24, 30]) {
    const clips = [];
    for (const [i, color] of ['red', 'green', 'blue'].entries()) {
      const file = path.join(root, `${fps}-${color}.mp4`);
      await colorClip(file, color, fps, 1);
      clips.push(file);
    }
    const input = path.join(root, `${fps}-cuts.mp4`);
    await concatClips(clips, input);
    const output = path.join(root, `${fps}.json`);
    const result = await executeNative({
      inputPath: input, outputPath: output, parameters: { sample_fps: 12, min_shot_seconds: 0.15, scene_threshold: 0.18, max_keyframes: 8 },
      components: components(),
    });
    const doc = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(doc.quality_status, 'review_required');
    assert.equal(doc.source.has_audio, false);
    assert.equal(doc.shots.length, 3, JSON.stringify(doc.cuts));
    assert.equal(doc.cuts.length, 2);
    assert.ok(Math.abs(doc.cuts[0].seconds - 1) <= 0.12, JSON.stringify(doc.cuts));
    assert.ok(Math.abs(doc.cuts[1].seconds - 2) <= 0.12, JSON.stringify(doc.cuts));
    assert.equal(doc.shots[0].start, doc.sample.first_seconds);
    assert.ok(doc.keyframes.some(k => k.roles.includes('head')));
    assert.ok(doc.keyframes.some(k => k.roles.includes('tail')));
    assert.ok(fs.existsSync(path.join(root, doc.contact_sheet.file)));
    assert.equal(result.after.shot_count, 3);
    assert.ok(!JSON.stringify(doc).includes('highlight_score'));
  }
});

test('no-cut, black interval, freeze, no-audio and bounded limits', { skip: !(hasFfmpeg && hasSharp) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-shots-edge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const still = path.join(root, 'still.mp4');
  await colorClip(still, '0x336699', 24, 1.2);
  const stillDoc = JSON.parse(fs.readFileSync((await executeNative({
    inputPath: still, outputPath: path.join(root, 'still.json'), parameters: { sample_fps: 10 }, components: components(),
  }), path.join(root, 'still.json')), 'utf8'));
  assert.equal(stillDoc.shots.length, 1);
  assert.equal(stillDoc.cuts.length, 0);
  assert.equal(stillDoc.source.has_audio, false);

  const red = path.join(root, 'red.mp4'), black = path.join(root, 'black.mp4'), blue = path.join(root, 'blue.mp4');
  await colorClip(red, 'red', 24, 0.6);
  await colorClip(black, 'black', 24, 0.7);
  await colorClip(blue, 'blue', 24, 0.6);
  const withBlack = path.join(root, 'black-insert.mp4');
  await concatClips([red, black, blue], withBlack);
  const blackDoc = JSON.parse(fs.readFileSync((await executeNative({
    inputPath: withBlack, outputPath: path.join(root, 'black.json'),
    parameters: { sample_fps: 12, black_luma: 0.12, min_black_seconds: 0.2, scene_threshold: 0.18 },
    components: components(),
  }), path.join(root, 'black.json')), 'utf8'));
  assert.ok(blackDoc.black_intervals.length >= 1, JSON.stringify(blackDoc.black_intervals));
  assert.ok(blackDoc.black_intervals[0].duration >= 0.2);
  assert.ok(blackDoc.black_intervals[0].start >= 0.4 && blackDoc.black_intervals[0].start <= 0.8, JSON.stringify(blackDoc.black_intervals));

  const move = path.join(root, 'move.mp4');
  await run(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=24:d=0.7', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', move]);
  const frozen = path.join(root, 'freeze.mp4');
  await concatClips([move, still], frozen);
  const freezeDoc = JSON.parse(fs.readFileSync((await executeNative({
    inputPath: frozen, outputPath: path.join(root, 'freeze.json'),
    parameters: { sample_fps: 12, freeze_motion: 0.02, min_freeze_seconds: 0.35 },
    components: components(),
  }), path.join(root, 'freeze.json')), 'utf8'));
  assert.ok(freezeDoc.freeze_intervals.length >= 1, JSON.stringify(freezeDoc.freeze_intervals));
  assert.ok(
    freezeDoc.freeze_intervals.some(item => item.start >= 0.55 && item.duration >= 0.35),
    JSON.stringify(freezeDoc.freeze_intervals),
  );

  await assert.rejects(executeNative({
    inputPath: still, outputPath: path.join(root, 'limit-d.json'), parameters: { max_duration: 0.4 }, components: components(),
  }), { code: 'SHOT_ANALYSIS_LIMIT' });
  await assert.rejects(executeNative({
    inputPath: still, outputPath: path.join(root, 'limit-f.json'), parameters: { sample_fps: 0, max_frames: 8 }, components: components(),
  }), { code: 'SHOT_ANALYSIS_LIMIT' });
});

test('VFR concat, delayed audio origin and unreadable files fail with codes', { skip: !(hasFfmpeg && hasSharp) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-shots-time-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, 'a24.mp4'), b = path.join(root, 'b12.mp4'), vfr = path.join(root, 'vfr.mp4');
  await colorClip(a, 'yellow', 24, 0.5);
  await colorClip(b, 'purple', 12, 0.5);
  await concatClips([a, b], vfr);
  const vfrDoc = JSON.parse(fs.readFileSync((await executeNative({
    inputPath: vfr, outputPath: path.join(root, 'vfr.json'), parameters: { sample_fps: 10, scene_threshold: 0.18, min_shot_seconds: 0.12 },
    components: components(),
  }), path.join(root, 'vfr.json')), 'utf8'));
  assert.ok(vfrDoc.shots.length >= 1);
  assert.equal(vfrDoc.sample.first_seconds, 0);
  assert.ok(vfrDoc.cuts.length >= 1, JSON.stringify(vfrDoc.cuts));
  assert.ok(Math.abs(vfrDoc.cuts[0].seconds - 0.5) <= 0.15, JSON.stringify(vfrDoc.cuts));

  const wav = path.join(root, 'tone.wav');
  await run(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', wav]);
  const delayed = path.join(root, 'delayed.mkv');
  await run(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=160x90:r=24:d=2', '-itsoffset', '0.5', '-i', wav, '-c:v', 'libx264', '-c:a', 'pcm_s16le', delayed]);
  const delayedDoc = JSON.parse(fs.readFileSync((await executeNative({
    inputPath: delayed, outputPath: path.join(root, 'delayed.json'), parameters: { sample_fps: 8 }, components: components(),
  }), path.join(root, 'delayed.json')), 'utf8'));
  assert.equal(delayedDoc.source.has_audio, true);
  assert.equal(delayedDoc.shots[0].start, delayedDoc.sample.first_seconds);
  assert.ok(Number.isFinite(delayedDoc.source_timeline_origin));

  const empty = path.join(root, 'empty.bin'); fs.writeFileSync(empty, '');
  await assert.rejects(executeNative({ inputPath: empty, outputPath: path.join(root, 'empty.json'), components: components() }));
  await assert.rejects(executeNative({ inputPath: wav, outputPath: path.join(root, 'audio-only.json'), components: components() }), { code: 'SHOT_ANALYSIS_NO_VIDEO' });
});

async function meanRgb(file) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let r = 0, g = 0, b = 0, n = info.width * info.height;
  for (let i = 0; i < data.length; i += 3) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
  return { r: r / n, g: g / n, b: b / n };
}

function dominant(rgb) {
  if (rgb.r > rgb.g + 40 && rgb.r > rgb.b + 40) return 'red';
  if (rgb.g > rgb.r + 40 && rgb.g > rgb.b + 40) return 'green';
  if (rgb.b > rgb.r + 40 && rgb.b > rgb.g + 40) return 'blue';
  return `mixed:${Math.round(rgb.r)},${Math.round(rgb.g)},${Math.round(rgb.b)}`;
}

test('keyframe PNGs match source pts on positive offset and VFR color cuts; select keeps negative pts', { skip: !(hasFfmpeg && hasSharp) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-shots-pts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidence = path.join(root, 'pts-pixel-verification');
  fs.mkdirSync(evidence, { recursive: true });

  const red = path.join(root, 'red.mp4'), green = path.join(root, 'green.mp4'), blue = path.join(root, 'blue.mp4');
  await colorClip(red, 'red', 24, 0.5);
  await colorClip(green, 'green', 12, 0.5);
  await colorClip(blue, 'blue', 24, 0.5);
  const vfr = path.join(root, 'vfr-color.mp4');
  await concatClips([red, green, blue], vfr);
  const vfrOut = path.join(root, 'vfr-color.json');
  await executeNative({ inputPath: vfr, outputPath: vfrOut, parameters: { sample_fps: 8, scene_threshold: 0.18, min_shot_seconds: 0.12, max_keyframes: 8 }, components: components() });
  const vfrDoc = JSON.parse(fs.readFileSync(vfrOut, 'utf8'));
  assert.ok(vfrDoc.shots.at(-1).end >= 1.4, JSON.stringify(vfrDoc.shots.at(-1)));
  const expected = [[0, 'red'], [0.5, 'green'], [1.0, 'blue']];
  const vfrPixels = [];
  for (const [seconds, color] of expected) {
    const frame = vfrDoc.keyframes.find(k => Math.abs(k.seconds - seconds) <= 0.12)
      || vfrDoc.keyframes.find(k => k.roles.includes(seconds === 0 ? 'head' : seconds > 0.9 ? 'tail' : 'shot_start'));
    assert.ok(frame, `missing keyframe near ${seconds}`);
    const rgb = await meanRgb(path.join(root, frame.file));
    assert.equal(dominant(rgb), color, `${frame.id} ${frame.timecode} ${JSON.stringify(rgb)}`);
    vfrPixels.push({ id: frame.id, seconds: frame.seconds, source_seconds: frame.source_seconds, source_pts: frame.source_pts, color: dominant(rgb) });
  }

  const pos = path.join(root, 'positive-start.mkv');
  await run(FFMPEG, [
    '-nostdin', '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=24:d=0.5',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=24:d=0.5',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
    '-output_ts_offset', '1.25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', pos,
  ]);
  const posOut = path.join(root, 'positive.json');
  await executeNative({ inputPath: pos, outputPath: posOut, parameters: { sample_fps: 8, scene_threshold: 0.18, min_shot_seconds: 0.12, max_keyframes: 6 }, components: components() });
  const posDoc = JSON.parse(fs.readFileSync(posOut, 'utf8'));
  assert.ok(Math.abs(posDoc.source_timeline_origin - 1.25) <= 0.05, JSON.stringify(posDoc.source));
  assert.ok(posDoc.keyframes[0].source_seconds >= 1.2, JSON.stringify(posDoc.keyframes[0]));
  assert.ok(posDoc.shots.at(-1).end >= 0.95, JSON.stringify(posDoc.shots.at(-1)));
  const posPixels = [];
  for (const frame of posDoc.keyframes) {
    const rgb = await meanRgb(path.join(root, frame.file));
    const color = dominant(rgb);
    const expect = frame.seconds < 0.45 ? 'red' : 'blue';
    assert.equal(color, expect, `${frame.id} rel=${frame.seconds} src=${frame.source_seconds} ${JSON.stringify(rgb)}`);
    posPixels.push({ id: frame.id, seconds: frame.seconds, source_seconds: frame.source_seconds, source_pts: frame.source_pts, color });
  }

  const naive = path.join(root, 'naive-ss.png');
  await run(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-i', pos, '-ss', String(posDoc.keyframes[0].source_seconds), '-frames:v', '1', naive]).catch(() => {});
  const naiveExists = fs.existsSync(naive) && fs.statSync(naive).size > 0;
  const naiveColor = naiveExists ? dominant(await meanRgb(naive)) : 'missing';
  assert.equal(ptsSelect(-400), "'eq(pts,-400)'");
  const extractSource = fs.readFileSync(path.join(__dirname, '../src/services/videoShotAnalysis.js'), 'utf8');
  assert.match(extractSource, /select=\$\{ptsSelect\(frame\.source_pts\)\}/);
  assert.doesNotMatch(extractSource, /gte\(t,\$\{start\}\)/);
  assert.doesNotMatch(extractSource, /source_seconds\s*-\s*0\.02/);
  assert.doesNotMatch(extractSource, /slack = 0\.02/);
  assert.doesNotMatch(extractSource, /Math\.max\(0,\s*frame\.source_seconds\)/);
  assert.doesNotMatch(extractSource, /t - Math\.abs\(slack\)/);
  assert.doesNotMatch(extractSource, /<= 0\.08/);

  fs.writeFileSync(path.join(evidence, 'pts-pixel-verification.json'), JSON.stringify({
    vfr: { origin: vfrDoc.source_timeline_origin, last_shot: vfrDoc.shots.at(-1), pixels: vfrPixels },
    positive: { origin: posDoc.source_timeline_origin, last_shot: posDoc.shots.at(-1), pixels: posPixels, naive_input_ss_without_copyts: naiveColor },
    negative_pts: { select: ptsSelect(-400), clamp_removed: true, container_note: 'mp4/mkv/nut/ts 在本机将负 PTS 钳到 0；提取改用 eq(pts,source_pts)，不再 20ms 提前 gte(t)。' },
  }, null, 2));
});

test('start=5s 1s red/blue counterexample covers clip end=1 and matching keyframe pixels', { skip: !(hasFfmpeg && hasSharp) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-shots-origin5-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = fs.existsSync(COUNTER_MKV) ? COUNTER_MKV : path.join(root, 'two-color-origin5.mkv');
  if (!fs.existsSync(input)) {
    await run(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=160x90:r=12:d=0.5', '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=12:d=0.5', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-bf', '0', '-output_ts_offset', '5', input]);
  }
  const before = fs.statSync(input);
  const output = path.join(root, 'result.json');
  await executeNative({
    inputPath: input, outputPath: output,
    parameters: { sample_fps: 0, max_keyframes: 12, scene_threshold: 0.1, min_shot_seconds: 0.1 },
    components: components(),
  });
  const after = fs.statSync(input);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  const doc = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.ok(Math.abs(doc.source.start_time - 5) <= 0.002, JSON.stringify(doc.source));
  assert.ok(Math.abs(doc.source.duration_seconds - 1) <= 0.02, JSON.stringify(doc.source));
  assert.ok(Math.abs(doc.shots.at(-1).end - 1) <= 0.02, JSON.stringify(doc.shots.at(-1)));
  assert.ok(doc.keyframes.length >= 2);
  for (const frame of doc.keyframes) {
    const rgb = await meanRgb(path.join(root, frame.file));
    const expect = frame.seconds < 0.499 ? 'red' : 'blue';
    assert.equal(dominant(rgb), expect, `${frame.id} rel=${frame.seconds} src=${frame.source_seconds} ${JSON.stringify(rgb)}`);
  }
  fs.writeFileSync(path.join(root, 'origin5-counterexample.json'), JSON.stringify({
    input, origin: doc.source_timeline_origin, duration: doc.source.duration_seconds,
    container_duration: doc.source.container_duration_seconds, last_shot: doc.shots.at(-1),
    keyframes: doc.keyframes.map(k => ({ id: k.id, seconds: k.seconds, source_seconds: k.source_seconds, source_pts: k.source_pts, file: k.file })),
  }, null, 2));
});

test('accepted AE clip is analyzed read-only into contact sheet and compact JSON', { skip: !(hasFfmpeg && hasSharp && fs.existsSync(path.join(AE_DIR, 'AE动效展示-4秒.mp4'))) }, async t => {
  const input = path.join(AE_DIR, 'AE动效展示-4秒.mp4');
  assert.ok(fs.existsSync(input), input);
  const before = fs.statSync(input);
  const outDir = EVIDENCE_DIR ? path.join(EVIDENCE_DIR, '虹咲2-AE动效展示-4秒') : fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-shots-ae-'));
  t.after(() => { if (!EVIDENCE_DIR) fs.rmSync(outDir, { recursive: true, force: true }); });
  fs.mkdirSync(outDir, { recursive: true });
  const output = path.join(outDir, 'result.json');
  const result = await executeNative({
    inputPath: input,
    outputPath: output,
    parameters: { sample_fps: 8, max_keyframes: 12, thumbnail_width: 160, contact_columns: 4, scene_threshold: 0.16 },
    components: components(),
  });
  const after = fs.statSync(input);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  const doc = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(doc.schema, 'yinzi.video-shot-analysis/v1');
  assert.equal(doc.quality_status, 'review_required');
  assert.ok(doc.shots.length >= 1);
  assert.ok(fs.existsSync(path.join(outDir, 'contact-sheet.png')));
  for (const frame of doc.keyframes) {
    assert.ok(fs.existsSync(path.join(outDir, frame.file)), frame.file);
    assert.match(frame.timecode, /^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  }
  assert.equal(result.quality_status, 'review_required');
  fs.writeFileSync(path.join(outDir, 'analysis-summary.json'), JSON.stringify({
    input, shots: doc.shots.length, cuts: doc.cuts.length, black: doc.black_intervals.length,
    freeze: doc.freeze_intervals.length, has_audio: doc.source.has_audio,
    first: doc.sample.first_seconds, last: doc.sample.last_seconds,
    keyframes: doc.keyframes.map(k => ({ id: k.id, timecode: k.timecode, roles: k.roles, file: k.file })),
  }, null, 2));
});

test('60fps red/blue cut at 0.5s extracts blue by integer PTS and clip end is 1 not last-sample 0.983333', { skip: !(hasFfmpeg && hasSharp) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-shots-60fps-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = fs.existsSync(HIGHFPS_MP4) ? HIGHFPS_MP4 : path.join(root, 'red-blue-60fps.mp4');
  if (!fs.existsSync(input)) {
    await run(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=160x90:r=60:d=0.5', '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=60:d=0.5', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-bf', '0', input]);
  }
  const before = fs.statSync(input);
  const output = path.join(root, 'result.json');
  await executeNative({
    inputPath: input, outputPath: output,
    parameters: { sample_fps: 0, max_keyframes: 12, scene_threshold: 0.1, min_shot_seconds: 0.1 },
    components: components(),
  });
  const after = fs.statSync(input);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  const doc = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.ok(Math.abs(doc.shots.at(-1).end - 1) <= 0.002, JSON.stringify(doc.shots.at(-1)));
  assert.equal(doc.shots.at(-1).end_basis, 'last_frame_pts_duration');
  assert.ok(Number.isInteger(doc.keyframes.find(k => Math.abs(k.seconds - 0.5) <= 0.002)?.source_pts), JSON.stringify(doc.keyframes));
  for (const frame of doc.keyframes) {
    assert.equal(typeof frame.source_pts, 'number');
    assert.ok(Number.isInteger(frame.source_pts), JSON.stringify(frame));
    const rgb = await meanRgb(path.join(root, frame.file));
    const expect = frame.seconds < 0.499 ? 'red' : 'blue';
    assert.equal(dominant(rgb), expect, `${frame.id} rel=${frame.seconds} pts=${frame.source_pts} ${JSON.stringify(rgb)}`);
  }
  const cut = doc.keyframes.find(k => Math.abs(k.seconds - 0.5) <= 0.002);
  assert.ok(cut, JSON.stringify(doc.keyframes));
  assert.equal(dominant(await meanRgb(path.join(root, cut.file))), 'blue');

  const lowOut = path.join(root, 'low-sample.json');
  await executeNative({
    inputPath: input, outputPath: lowOut,
    parameters: { sample_fps: 2, max_keyframes: 8, scene_threshold: 0.1, min_shot_seconds: 0.1 },
    components: components(),
  });
  const lowDoc = JSON.parse(fs.readFileSync(lowOut, 'utf8'));
  assert.ok(Math.abs(lowDoc.shots.at(-1).end - 1) <= 0.002, JSON.stringify(lowDoc.shots.at(-1)));
  assert.ok(lowDoc.sample.last_seconds < 0.99, JSON.stringify(lowDoc.sample));
  await assert.rejects(executeNative({
    inputPath: input, outputPath: path.join(root, 'limit-d.json'), parameters: { max_duration: 0.4 }, components: components(),
  }), { code: 'SHOT_ANALYSIS_LIMIT' });
});

test('negative source_pts stay unclamped in select expressions and last-frame duration still covers clip end', () => {
  assert.equal(ptsSelect(-512), "'eq(pts,-512)'");
  assert.doesNotMatch(ptsSelect(-512), /Math\.max/);
  const samples = [{ seconds: 0.958333, source_seconds: 0.558333, source_pts: -512 }];
  const last = { pts: 47104, pts_time: 0.558333, duration_time: 0.041667 };
  assert.equal(clipEndSeconds(samples, 0, -0.4, last), 1);
});