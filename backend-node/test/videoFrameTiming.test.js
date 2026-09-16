const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');

const BACKEND = path.resolve(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-frame-regression-'));
const { after } = require('node:test');
after(() => fs.rmSync(OUT, { recursive: true, force: true }));
const {
  parseShowinfoLine, parseRate, planFrameDurations, concatEscape,
  writeConcatList, constantFrameRate, audioFilters,
  extraAssembleSources, exportSettings, assembleSettings,
  exportFrames, assembleFrames, SCHEMA_VERSION,
} = require('../src/services/videoFrameSequence');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');
const FFMPEG = process.env.FFMPEG_PATH || getFfmpegPath();
const FFPROBE = process.env.FFPROBE_PATH || getFfprobePath();
const { spawnSync } = require('node:child_process');
const hasFfmpeg = [FFMPEG, FFPROBE].every(bin => spawnSync(bin, ['-version'], { windowsHide: true, timeout: 10000 }).status === 0);
const sharp = require('sharp');
const hasSharp = true;

function components() {
  return {
    'media.ffmpeg': {
      component_id: 'media.ffmpeg',
      directory: path.dirname(FFMPEG),
      executables: { ffmpeg: FFMPEG, ffprobe: FFPROBE },
    },
  };
}

function run(bin, args, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      code === 0
        ? resolve({ stdout, stderr })
        : reject(Object.assign(new Error(stderr.slice(-2000) || stdout.slice(-2000)), { exitCode: code }));
    });
  });
}

async function probe(file) {
  return JSON.parse((await run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file])).stdout);
}

async function probePackets(file) {
  return JSON.parse((await run(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0', '-count_packets',
    '-show_entries', 'stream=nb_read_packets,duration,r_frame_rate,avg_frame_rate,time_base',
    '-show_entries', 'packet=pts_time,duration_time,size',
    '-of', 'json', file,
  ])).stdout);
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function slash(file) {
  return path.resolve(file).replaceAll('\\', '/');
}

async function pcmS16(file, { rate = 48000, channels = 1, duration = null } = {}) {
  const tmp = path.join(os.tmpdir(), `pcm-${crypto.randomBytes(6).toString('hex')}.s16le`);
  const args = ['-nostdin', '-y', '-v', 'error', '-i', file, '-vn', '-ac', String(channels), '-ar', String(rate)];
  if (duration != null) args.push('-t', String(duration));
  args.push('-f', 's16le', tmp);
  await run(FFMPEG, args);
  const buf = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  return { samples, rate };
}

function rms(samples, start, end) {
  const a = Math.max(0, start);
  const b = Math.min(samples.length, end);
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (b - a));
}

function firstLoud(samples, rate, thresh = 400, win = 480) {
  for (let i = 0; i + win < samples.length; i += win) {
    if (rms(samples, i, i + win) > thresh) return i / rate;
  }
  return null;
}

fs.mkdirSync(OUT, { recursive: true });
const evidence = { started_at: new Date().toISOString(), ffmpeg: FFMPEG, checks: [] };
function record(name, data) {
  evidence.checks.push({ name, at: new Date().toISOString(), ...data });
  fs.writeFileSync(path.join(OUT, 'independent-evidence.json'), JSON.stringify(evidence, null, 2));
}

test('unit: AE-like rounded durations must map to declared 60 fps, not 60.0006', () => {
  const frames = [];
  for (let i = 0; i < 240; i++) {
    frames.push({ pts_time: Number((i / 60).toFixed(6)), duration_time: 0.016667, time_base: '1/60000' });
  }
  const ptsSpan = 4;
  const durations = planFrameDurations(frames, { timing_strategy: 'pts', pts_span: ptsSpan, time_base: '1/60000' });
  assert.ok(Math.abs(durations.reduce((a, b) => a + b, 0) - 4) < 1e-9);
  const buggy = 1 / ((Math.min(...durations) + Math.max(...durations)) / 2);
  assert.ok(Math.abs(buggy - 60) > 0.0005, `old mean-gap fps=${buggy}`);
  const fps = constantFrameRate(durations, { r_frame_rate: '60/1' });
  assert.equal(fps, 60);
  const fallback = constantFrameRate(durations, {});
  assert.equal(fallback, 60);
  const concat = path.join(os.tmpdir(), `concat-${Date.now()}.ffconcat`);
  writeConcatList(concat, frames.map((_, i) => ({ path: `frame-${i}.png` })), durations, { repeatLast: false });
  const text = fs.readFileSync(concat, 'utf8');
  const files = text.split(/\r?\n/).filter(line => line.startsWith('file '));
  assert.equal(files.length, 240);
  fs.unlinkSync(concat);
  const parsed = parseShowinfoLine('[Parsed_showinfo_0] n: 239 pts: 239000 pts_time:3.983333 duration:1000 duration_time:0.016667');
  assert.equal(parsed.pts_time, 3.983333);
  assert.equal(parseRate('60/1'), 60);
  const delay = audioFilters(0.2, 0.05, 0.8);
  assert.equal(delay.offset, 0.25);
  assert.ok(delay.filters.some(item => item.startsWith('adelay=')));
  assert.throws(() => exportSettings({ max_frames: 0 }), { code: 'FRAME_SEQUENCE_INPUT' });
  assert.throws(() => assembleSettings({ timing_strategy: 'avg' }), { code: 'FRAME_SEQUENCE_INPUT' });
  assert.equal(concatEscape("C:/temp/it's.png"), "C:/temp/it'\\''s.png");
  assert.deepEqual(extraAssembleSources('local.video.assemble-frames', {}, ''), []);
  record('unit_cfr_fps', { old_mean_gap_fps: buggy, fixed_fps: fps, concat_files: files.length });
});

test('real ffmpeg: VFR packet durations come from PTS gaps, not avg_frame_rate, and clip concat stays on disk', {
  skip: !hasFfmpeg || !hasSharp,
}, async () => {
  const dir = fs.mkdtempSync(path.join(OUT, 'ind-vfr-'));
  const pngDir = path.join(dir, 'png');
  fs.mkdirSync(pngDir);
  const colors = ['#cc0000', '#00aa00', '#2266cc', '#dddd00', '#cc00cc', '#00cccc'];
  const durations = [0.04, 0.20, 0.04, 0.16, 0.04, 0.12];
  for (let i = 0; i < colors.length; i++) {
    await sharp({ create: { width: 160, height: 90, channels: 3, background: colors[i] } })
      .png().toFile(path.join(pngDir, `p${i}.png`));
  }
  const list = path.join(dir, 'vfr.ffconcat');
  const lines = ['ffconcat version 1.0'];
  for (let i = 0; i < colors.length; i++) {
    lines.push(`file '${slash(path.join(pngDir, `p${i}.png`))}'`);
    lines.push(`duration ${durations[i]}`);
  }
  lines.push(`file '${slash(path.join(pngDir, 'p5.png'))}'`);
  fs.writeFileSync(list, lines.join('\n') + '\n');
  const src = path.join(dir, 'vfr.mkv');
  await run(FFMPEG, [
    '-nostdin', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.6',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-fps_mode', 'passthrough', src,
  ]);
  const exportDir = path.join(OUT, 'vfr-export');
  fs.rmSync(exportDir, { recursive: true, force: true });
  const manifestPath = path.join(exportDir, 'result.json');
  const t0 = Date.now();
  await exportFrames({
    inputPath: src, outputPath: manifestPath,
    parameters: { keep_audio: true, max_frames: 40, max_duration: 2 },
    components: components(),
  });
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const ptsGaps = manifest.frames.slice(0, -1).map((f, i) => Number((manifest.frames[i + 1].pts_time - f.pts_time).toFixed(6)));
  ptsGaps.push(Number(manifest.timeline.last_duration_time));
  assert.equal(manifest.frame_count, 7);
  assert.equal(manifest.timeline.pts_span, 0.64);
  assert.equal(manifest.timeline.avg_frame_rate_guess_seconds, 0.28);
  assert.deepEqual(ptsGaps, [0.04, 0.2, 0.04, 0.16, 0.04, 0.12, 0.04]);
  const assembled = path.join(OUT, 'vfr-assembled.mp4');
  await assembleFrames({
    inputPath: manifestPath, outputPath: assembled,
    parameters: { timing_strategy: 'pts', keep_audio: true },
    components: components(),
  });
  const wall = Date.now() - t0;
  const packets = await probePackets(assembled);
  const durs = packets.packets.map(p => Number(Number(p.duration_time).toFixed(2)));
  assert.deepEqual(durs, [0.04, 0.2, 0.04, 0.16, 0.04, 0.12, 0.04]);
  const formatDur = Number((await probe(assembled)).format.duration);
  assert.ok(Math.abs(formatDur - 0.64) < 0.02, `vfr duration=${formatDur}`);
  const assembleManifest = JSON.parse(fs.readFileSync(path.join(path.dirname(assembled), 'assemble-manifest.json'), 'utf8'));
  assert.equal(assembleManifest.encode_mode, 'clip_concat_vfr');
  assert.equal(assembleManifest.video_packets, 7);
  record('vfr_packet_durations', {
    pts_gaps: ptsGaps, packet_durations: durs, format_duration: formatDur,
    avg_guess: manifest.timeline.avg_frame_rate_guess_seconds, wall_ms: wall,
    encode_mode: assembleManifest.encode_mode,
  });
});

test('real ffmpeg: non-zero audio offset and mid-clip silence survive as samples, not container start_time', {
  skip: !hasFfmpeg || !hasSharp,
}, async () => {
  const dir = fs.mkdtempSync(path.join(OUT, 'ind-audio-'));
  const raw = path.join(dir, 'raw.mp4');
  await run(FFMPEG, [
    '-nostdin', '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=orange:s=160x90:d=1.6:r=20',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=1.6',
    '-filter_complex', "[1:a]volume=0:enable='between(t,0.70,1.10)'[a]",
    '-map', '0:v:0', '-map', '[a]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', raw,
  ]);
  const src = path.join(dir, 'offset.mkv');
  await run(FFMPEG, [
    '-nostdin', '-y', '-v', 'error', '-i', raw,
    '-itsoffset', '0.20', '-i', raw,
    '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', src,
  ]);
  const srcProbe = await probe(src);
  const offset = Number(srcProbe.streams.find(s => s.codec_type === 'audio').start_time)
    - Number(srcProbe.streams.find(s => s.codec_type === 'video').start_time);
  assert.ok(Math.abs(offset - 0.2) < 0.05, `source offset=${offset}`);

  const exportDir = path.join(OUT, 'offset-export');
  fs.rmSync(exportDir, { recursive: true, force: true });
  const manifestPath = path.join(exportDir, 'result.json');
  await exportFrames({
    inputPath: src, outputPath: manifestPath,
    parameters: { keep_audio: true, max_frames: 80, max_duration: 4 },
    components: components(),
  });
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.ok(Math.abs(manifest.audio.relative_offset_seconds - 0.2) < 0.04, JSON.stringify(manifest.audio));

  const extracted = path.join(exportDir, manifest.audio.file);
  const extractedPcm = await pcmS16(extracted, { duration: 1.6 });
  const extractedLoud = firstLoud(extractedPcm.samples, extractedPcm.rate);
  const extractedLead = rms(extractedPcm.samples, 0, Math.floor(0.10 * extractedPcm.rate));
  const extractedMid = rms(extractedPcm.samples, Math.floor(0.85 * extractedPcm.rate), Math.floor(1.00 * extractedPcm.rate));
  assert.ok(extractedLoud != null && extractedLoud < 0.05, `extracted first_loud=${extractedLoud}`);
  assert.ok(extractedLead > 800, `extracted should start with tone, rms=${extractedLead}`);
  assert.ok(extractedMid < extractedLead * 0.2, `extracted mid-silence rms=${extractedMid}`);

  const assembled = path.join(OUT, 'offset-assembled.mp4');
  await assembleFrames({
    inputPath: manifestPath, outputPath: assembled,
    parameters: { timing_strategy: 'pts', keep_audio: true, audio_offset_seconds: 0.05 },
    components: components(),
  });
  const after = await probe(assembled);
  const audioStart = Number(after.streams.find(s => s.codec_type === 'audio').start_time || 0);
  assert.equal(audioStart, 0);
  const pcm = await pcmS16(assembled, { duration: 1.6 });
  const loud = firstLoud(pcm.samples, pcm.rate);
  const lead = rms(pcm.samples, 0, Math.floor(0.18 * pcm.rate));
  const tone = rms(pcm.samples, Math.floor(0.40 * pcm.rate), Math.floor(0.55 * pcm.rate));
  const mid = rms(pcm.samples, Math.floor(1.05 * pcm.rate), Math.floor(1.20 * pcm.rate));
  const afterMid = rms(pcm.samples, Math.floor(1.42 * pcm.rate), Math.floor(1.55 * pcm.rate));
  assert.ok(lead < 80, `leading rms=${lead}`);
  assert.ok(tone > 800, `tone rms=${tone}`);
  assert.ok(mid < tone * 0.2, `mid-silence rms=${mid} vs tone=${tone}`);
  assert.ok(afterMid > 800, `post-silence rms=${afterMid}`);
  assert.ok(loud != null && loud >= 0.20 && loud <= 0.32, `first_loud=${loud}`);
  record('audio_offset_pcm', {
    manifest_offset: manifest.audio.relative_offset_seconds,
    extra: 0.05,
    container_audio_start: audioStart,
    extracted_first_loud: extractedLoud,
    extracted_lead_rms: extractedLead,
    extracted_mid_rms: extractedMid,
    first_loud: loud,
    leading_rms: lead,
    tone_rms: tone,
    mid_silence_rms: mid,
    post_silence_rms: afterMid,
  });
});

test('real ffmpeg: non-zero video origin is recorded from PTS, not guessed from avg_frame_rate', {
  skip: !hasFfmpeg || !hasSharp,
}, async () => {
  const dir = fs.mkdtempSync(path.join(OUT, 'ind-origin-'));
  const raw = path.join(dir, 'raw.mp4');
  await run(FFMPEG, [
    '-nostdin', '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=green:s=160x90:d=0.4:r=10',
    '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=0.4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', raw,
  ]);
  const src = path.join(dir, 'origin.mkv');
  await run(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-itsoffset', '1.25', '-i', raw, '-c', 'copy', src]);
  const exportDir = path.join(OUT, 'origin-export');
  fs.rmSync(exportDir, { recursive: true, force: true });
  const manifestPath = path.join(exportDir, 'result.json');
  await exportFrames({
    inputPath: src, outputPath: manifestPath,
    parameters: { keep_audio: true, max_frames: 20, max_duration: 3 },
    components: components(),
  });
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.ok(Math.abs(manifest.timeline.origin - 1.25) < 0.02, JSON.stringify(manifest.timeline));
  assert.ok(Math.abs(manifest.timeline.first_pts_time - 1.25) < 0.02);
  assert.ok(Math.abs(manifest.timeline.pts_span - 0.4) < 0.06);
  assert.ok(Math.abs(manifest.timeline.content_duration - 0.4) < 0.06);
  const assembled = path.join(OUT, 'origin-assembled.mp4');
  await assembleFrames({
    inputPath: manifestPath, outputPath: assembled,
    parameters: { timing_strategy: 'pts', keep_audio: true },
    components: components(),
  });
  const after = await probe(assembled);
  const duration = Number(after.format.duration);
  assert.ok(Math.abs(duration - manifest.timeline.pts_span) < 0.08, `origin assembled duration=${duration}`);
  record('nonzero_origin', {
    origin: manifest.timeline.origin,
    first_pts_time: manifest.timeline.first_pts_time,
    pts_span: manifest.timeline.pts_span,
    assembled_duration: duration,
    frames: manifest.frame_count,
  });
});

test('real ffmpeg: corrupted manifest, path escape, missing frame, index gap fail with codes', {
  skip: !hasFfmpeg || !hasSharp,
}, async () => {
  const dir = fs.mkdtempSync(path.join(OUT, 'ind-bad-'));
  const src = path.join(dir, 'src.mp4');
  await run(FFMPEG, [
    '-nostdin', '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=0.3:r=10',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src,
  ]);
  const exportDir = path.join(OUT, 'guard-export');
  fs.rmSync(exportDir, { recursive: true, force: true });
  const manifestPath = path.join(exportDir, 'result.json');
  await exportFrames({
    inputPath: src, outputPath: manifestPath,
    parameters: { keep_audio: false, max_frames: 12, max_duration: 2 },
    components: components(),
  });
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const garbage = path.join(dir, 'garbage.json');
  fs.writeFileSync(garbage, '{not json');
  await assert.rejects(() => assembleFrames({
    inputPath: garbage, outputPath: path.join(dir, 'g.mp4'),
    parameters: { keep_audio: false }, components: components(),
  }), { code: 'MANIFEST_INVALID' });

  const schema = path.join(dir, 'schema.json');
  fs.writeFileSync(schema, JSON.stringify({ ...manifest, schema: 'nope' }));
  await assert.rejects(() => assembleFrames({
    inputPath: schema, outputPath: path.join(dir, 's.mp4'),
    parameters: { keep_audio: false }, components: components(),
  }), { code: 'MANIFEST_INVALID' });

  const gap = JSON.parse(JSON.stringify(manifest));
  gap.frames = gap.frames.filter(f => f.index !== 1);
  const gapPath = path.join(dir, 'gap.json');
  fs.writeFileSync(gapPath, JSON.stringify(gap));
  await assert.rejects(() => assembleFrames({
    inputPath: gapPath, outputPath: path.join(dir, 'gap.mp4'),
    parameters: { keep_audio: false }, components: components(),
  }), { code: 'FRAME_INDEX_GAP' });

  const missingFile = path.join(exportDir, manifest.frames[0].file);
  const backup = path.join(dir, 'frame0.png');
  fs.copyFileSync(missingFile, backup);
  fs.unlinkSync(missingFile);
  await assert.rejects(() => assembleFrames({
    inputPath: manifestPath, outputPath: path.join(dir, 'miss.mp4'),
    parameters: { keep_audio: false }, components: components(),
  }), { code: 'FRAME_MISSING' });
  fs.copyFileSync(backup, missingFile);

  const outside = path.join(dir, 'outside.png');
  fs.copyFileSync(backup, outside);
  const escaped = JSON.parse(JSON.stringify(manifest));
  escaped.frames[0].file = path.relative(exportDir, outside).replaceAll('\\', '/');
  const escapedPath = path.join(exportDir, 'escaped.json');
  fs.writeFileSync(escapedPath, JSON.stringify(escaped));
  await assert.rejects(() => assembleFrames({
    inputPath: escapedPath, outputPath: path.join(dir, 'esc.mp4'),
    parameters: { keep_audio: false }, components: components(),
  }), err => err.code === 'PATH_ESCAPE' || err.code === 'SYMLINK_ESCAPE' || err.code === 'FRAME_HASH_UNAUTHORIZED');

  record('manifest_guards', {
    codes: ['MANIFEST_INVALID', 'FRAME_INDEX_GAP', 'FRAME_MISSING', 'PATH_ESCAPE'],
    escaped_file: escaped.frames[0].file,
  });
});
