const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const {
  FaceTracker, greedyMatch, formatTimecode, parseShowinfoLine, iou, mapPtsToCfr,
} = require('../src/services/videoFaceTracker');

function chooseFaces(faces, p) {
  if (p.face_selection === 'all') return faces;
  if (!faces.length) return [];
  if (p.face_selection === 'index') return [faces[p.target_index]];
  return [faces.reduce((best, face) => (face.box.width * face.box.height > best.box.width * best.box.height ? face : best))];
}

test('queued tracking cache is a real source dependency and changes are detected', t => {
  const {snapshot,verify}=require('../src/services/localMediaSources');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-tracks-source-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const input=path.join(dir,'input.mp4'),tracks=path.join(dir,'tracks.json');
  fs.writeFileSync(input,'fixture');fs.writeFileSync(tracks,'{}');
  const sources=snapshot({module_id:'local.video.face-mask',input_path:input,parameters:{tracks_path:tracks}});
  assert.equal(sources.find(s=>s.role==='tracks').path,tracks);
  assert.doesNotThrow(()=>verify(sources));
  fs.writeFileSync(tracks,'{"changed":true}');
  assert.throws(()=>verify(sources),{code:'INPUT_CHANGED'});
});

const WORKSPACE = path.resolve(__dirname, '..');
const BACKEND = process.env.YINZI_BACKEND_NODE || path.resolve(__dirname, '..');
const FACE_OPS = process.env.YINZI_FACE_IMAGE_OPS || (BACKEND ? path.join(BACKEND, 'src/services/faceImageOperations.js') : '');
if (FACE_OPS && fs.existsSync(FACE_OPS) && !process.env.YINZI_FACE_IMAGE_OPS) process.env.YINZI_FACE_IMAGE_OPS = FACE_OPS;
if (BACKEND && !process.env.YINZI_BACKEND_NODE) process.env.YINZI_BACKEND_NODE = BACKEND;

const {
  parametersFor, trackFacesOperation, faceMaskOperation, executeNative,
  extraTrackSources, loadCachedTracks,
} = require('../src/services/videoFaceTracking');

let ffmpegPathFn = null;
try {
  if (BACKEND) ffmpegPathFn = require(path.join(BACKEND, 'src/utils/ffmpegPath'));
} catch { ffmpegPathFn = null; }
const FFMPEG = process.env.FFMPEG_PATH || ffmpegPathFn?.getFfmpegPath?.() || (BACKEND ? path.join(BACKEND, 'tools/ffmpeg/ffmpeg.exe') : '');
const FFPROBE = process.env.FFPROBE_PATH || ffmpegPathFn?.getFfprobePath?.() || (BACKEND ? path.join(BACKEND, 'tools/ffmpeg/ffprobe.exe') : '');
const SHARP_DIR = process.env.SHARP_DIR || (BACKEND ? path.join(BACKEND, 'node_modules/sharp') : '');
const FACE_DIR = process.env.FACE_COMPONENT_DIR || '';
const LENA = process.env.LENA_JPG || path.join(__dirname, '../fixtures/lena.jpg');
const EVIDENCE_DIR = process.env.FACE_TRACK_EVIDENCE_DIR || path.join(WORKSPACE, 'results');
const srcText = fs.readFileSync(path.join(WORKSPACE, 'src/services/videoFaceTracking.js'), 'utf8');
assert.doesNotMatch(srcText, /C:\\\\Users\\\\Administrator/);
assert.doesNotMatch(srcText, /C:\/Users\/Administrator/);
assert.doesNotMatch(srcText, /AppData\\Local\\Programs\\Python/);
assert.doesNotMatch(srcText, /python\.exe/i);

function hasBin(file) {
  try { return fs.existsSync(file) && fs.statSync(file).size > 1024; } catch { return false; }
}
const hasFfmpeg = hasBin(FFMPEG) && hasBin(FFPROBE);
const hasSharp = fs.existsSync(path.join(SHARP_DIR, 'package.json'));
const hasOrt = FACE_DIR && fs.existsSync(path.join(FACE_DIR, 'models/yunet.onnx')) && fs.existsSync(path.join(FACE_DIR, 'package.json'));
const hasFaceOps = FACE_OPS && fs.existsSync(FACE_OPS);
const canRun = hasFfmpeg && hasSharp && hasOrt && hasFaceOps && fs.existsSync(LENA);
const sharp = hasSharp ? createRequire(path.join(SHARP_DIR, 'package.json'))('sharp') : null;

function components() {
  return {
    'vision.face-detector': { component_id: 'vision.face-detector', directory: FACE_DIR },
    'media.ffmpeg': { component_id: 'media.ffmpeg', directory: path.dirname(FFMPEG), executables: { ffmpeg: FFMPEG, ffprobe: FFPROBE } },
    'media.sharp': { component_id: 'media.sharp', directory: SHARP_DIR },
  };
}

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

function box(x, y, w, h, extra = {}) {
  return { box: { x, y, width: w, height: h }, landmarks: extra.landmarks, confidence: extra.confidence ?? 0.9, index: extra.index ?? 0, source: 'yunet_cpu' };
}

function meanRgb(file) {
  return sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true }).then(({ data, info }) => {
    let r = 0, g = 0, b = 0, n = info.width * info.height;
    for (let i = 0; i < data.length; i += 3) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
    return { r: r / n, g: g / n, b: b / n, width: info.width, height: info.height };
  });
}

async function extractPng(input, output, extra = []) {
  await run(FFMPEG, ['-nostdin', '-y', '-v', 'error', ...extra, '-i', input, '-frames:v', '1', output]);
}

function rmsOfRegion(data, width, box) {
  let sum = 0, n = 0;
  const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.width)), y1 = Math.min(data.length / (width * 4), Math.ceil(box.y + box.height));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      sum += data[i] + data[i + 1] + data[i + 2];
      n++;
    }
  }
  return n ? sum / n : 0;
}

function trackerParams(extra = {}) {
  return {
    face_selection: 'all', hold_seconds: 0.15, predict_motion: false, predict_max_seconds: 0.4,
    match_min_score: 0.25, match_iou: 0.1, match_center_ratio: 1, ...extra,
  };
}

test('parameters stay bounded and tracker IDs do not swap on crossing faces', () => {
  assert.equal(formatTimecode(1.25), '00:00:01.250');
  const parsed = parseShowinfoLine('[Parsed_showinfo_2] n: 3 pts: 7680 pts_time:5.125 duration:512 duration_time:0.0416667');
  assert.equal(parsed.pts_time, 5.125);
  if (FACE_OPS && fs.existsSync(FACE_OPS)) {
    assert.throws(() => parametersFor({ hold_seconds: -1 }), { code: 'INVALID_PARAMETERS' });
    assert.throws(() => parametersFor({ max_frames: 3.5 }), { code: 'INVALID_PARAMETERS' });
    assert.throws(() => parametersFor({ analysis_width: 33 }), { code: 'INVALID_PARAMETERS' });
    assert.throws(() => parametersFor({ detection_size: 320 }), { code: 'INVALID_PARAMETERS' });
  }
  const p = trackerParams({ face_selection: 'all' });
  const left = box(10, 10, 40, 50, { index: 0 });
  const right = box(200, 10, 40, 50, { index: 1 });
  const tracker = new FaceTracker(p, 320, 180, chooseFaces);
  tracker.step({ seconds: 0, detections: [left, right], shotCut: false });
  const pathLeft = [10, 50, 90, 130, 170, 200];
  const pathRight = [200, 160, 120, 80, 40, 10];
  let later;
  for (let i = 1; i < pathLeft.length; i++) {
    later = tracker.step({
      seconds: i * 0.04,
      detections: [box(pathLeft[i], 10, 40, 50, { index: 0 }), box(pathRight[i], 10, 40, 50, { index: 1 })],
      shotCut: false,
    });
  }
  const ids = later.tracks.map(t => t.target_id).sort();
  assert.deepEqual(ids, ['T001', 'T002']);
  const t1 = later.tracks.find(t => t.target_id === 'T001');
  const t2 = later.tracks.find(t => t.target_id === 'T002');
  assert.ok(t1.box.x > 150, JSON.stringify(t1.box));
  assert.ok(t2.box.x < 50, JSON.stringify(t2.box));
});

test('largest selection never steals ID; hold freezes last box; shot cut resets', () => {
  const p = trackerParams({ face_selection: 'largest', hold_seconds: 0.15, predict_motion: false, scene_threshold: 0.2, min_shot_seconds: 0.04 });
  const tracker = new FaceTracker(p, 320, 180, chooseFaces);
  const first = tracker.step({ seconds: 0, detections: [box(10, 10, 80, 90, { index: 0 }), box(200, 20, 30, 30, { index: 1 })], shotCut: false });
  assert.equal(first.tracks.length, 1);
  assert.equal(first.tracks[0].target_id, 'T001');
  assert.ok(first.tracks[0].box.width > 50);
  const held = tracker.step({ seconds: 0.08, detections: [box(200, 20, 90, 90, { index: 0 })], shotCut: false });
  const live = held.tracks.find(t => t.target_id === 'T001');
  assert.equal(live.state, 'held');
  assert.equal(Math.round(live.box.x), 10);
  assert.equal(held.tracks.filter(t => t.state !== 'lost').length, 1);
  const lost = tracker.step({ seconds: 0.4, detections: [box(200, 20, 90, 90, { index: 0 })], shotCut: false });
  assert.equal(lost.tracks.find(t => t.target_id === 'T001'), undefined);
  assert.equal(lost.tracks.length, 0);
  const cut = tracker.step({ seconds: 0.6, detections: [box(200, 20, 90, 90, { index: 0 })], shotCut: true, scene_score: 0.8, source_seconds: 0.6 });
  assert.equal(cut.shot_index, 1);
  assert.equal(cut.tracks[0].target_id, 'T002');
  const summaries = tracker.finish(0.7);
  assert.ok(tracker.cuts.length >= 1);
  assert.equal(tracker.cuts[0].lost_reason || 'shot_cut', 'shot_cut');
  assert.ok(summaries.some(t => t.lost_reason === 'hold_timeout' || t.lost_reason === 'eof'));
  assert.ok(summaries.some(t => t.target_id === 'T002'));
});

test('predicted boxes are separate from detections and bounded', () => {
  const p = trackerParams({ face_selection: 'all', hold_seconds: 0.04, predict_motion: true, predict_max_seconds: 0.2 });
  const tracker = new FaceTracker(p, 320, 180, chooseFaces);
  tracker.step({ seconds: 0, detections: [box(10, 10, 40, 40)], shotCut: false });
  tracker.step({ seconds: 0.04, detections: [box(30, 10, 40, 40)], shotCut: false });
  const pred = tracker.step({ seconds: 0.12, detections: [], shotCut: false });
  assert.equal(pred.detections.length, 0);
  assert.equal(pred.tracks[0].state, 'predicted');
  assert.ok(pred.tracks[0].predicted_box);
  assert.ok(pred.tracks[0].predicted_box.x > 30);
  assert.ok(pred.tracks[0].box.x < 80);
  const assigned = greedyMatch(
    [{ last_detected_box: { x: 0, y: 0, width: 10, height: 10 }, last_detected_landmarks: null }],
    [box(200, 200, 10, 10)],
    320, 180, p,
  );
  assert.equal(assigned.length, 0);
  assert.ok(iou({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 0, width: 10, height: 10 }) > 0.3);
});

test('operations export native contracts without python paths', () => {
  assert.equal(trackFacesOperation.id, 'local.video.track-faces');
  assert.equal(faceMaskOperation.id, 'local.video.face-mask');
  assert.equal(trackFacesOperation.component_id, 'vision.face-detector');
  assert.ok(trackFacesOperation.executeNative);
  assert.ok(faceMaskOperation.executeNative);
  const src = fs.readFileSync(path.join(WORKSPACE, 'src/services/videoFaceTracking.js'), 'utf8');
  assert.match(src, /copyts/);
  assert.match(src, /fps_mode/);
  assert.match(src, /passthrough/);
  assert.match(src, /adelay/);
  assert.match(src, /pts_mapped_cfr/);
  assert.doesNotMatch(src, /AppData\\Local\\Programs\\Python/);
  assert.doesNotMatch(src, /python\.exe/i);
  assert.doesNotMatch(src, /setpts=PTS-STARTPTS,fps=/);
  assert.doesNotMatch(src, /C:\/Users\/Administrator/);
});

test('PTS-mapped CFR holds duration and cut; cache requires hash/PTS/tracking; tracks_path is extra source', () => {
  const frames = [];
  for (let i = 0; i < 5; i++) frames.push({ n: i, pts: i * 6, pts_time: i * 0.1, duration_time: 0.1 });
  for (let i = 0; i < 15; i++) frames.push({ n: 5 + i, pts: 30 + i * 2, pts_time: 0.5 + i / 30, duration_time: 1 / 30 });
  const mapped = mapPtsToCfr(frames, { origin: 0, fps: 60, endTime: 0.984 });
  assert.equal(mapped.frame_count, Math.round(0.984 * 60));
  assert.ok(Math.abs(mapped.end - 0.983333) < 0.02, JSON.stringify(mapped.end));
  const beforeCut = mapped.mapping.find(item => Math.abs(item.t - 0.4) < 1e-6);
  const atCut = mapped.mapping.find(item => Math.abs(item.t - 0.5) < 1e-6);
  assert.ok(beforeCut && atCut, 'missing 0.4/0.5s slots');
  assert.equal(beforeCut.source_index, 4);
  assert.equal(atCut.source_index, 5);
  assert.ok(frames[atCut.source_index].pts_time <= 0.5 + 1e-9);

  const extras = extraTrackSources('local.video.face-mask', { tracks_path: path.join(os.tmpdir(), 'tracks.json') });
  assert.equal(extras.length, 1);
  assert.equal(extras[0].role, 'tracks');
  assert.equal(extraTrackSources('local.image.face-mask', { tracks_path: 'x.json' }).length, 0);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-vface-cache-'));
  const cacheFile = path.join(tmp, 'tracks.json');
  const p = FACE_OPS && fs.existsSync(FACE_OPS)
    ? parametersFor({ face_selection: 'largest' })
    : trackerParams({
      face_selection: 'largest', detection_size: 640, score_threshold: 0.6, nms_threshold: 0.3,
      top_k: 500, max_faces: 100, target_index: 0, force_user_rect: false,
      analysis_width: 160, analysis_height: 90,
    });
  fs.writeFileSync(cacheFile, JSON.stringify({
    schema: 'yinzi.video-face-tracking/v1',
    source: { width: 160, height: 90 },
    frames: [{ n: 0, pts: 0, pts_time: 0 }],
  }));
  assert.throws(() => loadCachedTracks({ ...p, tracks_path: cacheFile }, 'abc', 160, 90), { code: 'FACE_TRACK_CACHE' });
  fs.writeFileSync(cacheFile, JSON.stringify({
    schema: 'yinzi.video-face-tracking/v1',
    source: { sha256: 'abc', width: 160, height: 90 },
    parameters: { tracking: { face_selection: 'all' } },
    frames: [{ n: 0, pts: 0, pts_time: 0 }],
  }));
  assert.throws(() => loadCachedTracks({ ...p, tracks_path: cacheFile }, 'abc', 160, 90), { code: 'FACE_TRACK_CACHE' });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('synthetic Lena motion, two-face, no-face, cut, origin, 60fps, limits, cache, audio', { skip: !canRun, timeout: 300000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-vface-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const evidence = path.join(EVIDENCE_DIR, 'cpu-run');
  fs.mkdirSync(evidence, { recursive: true });
  const notes = {
    fixture_boundary: 'OpenCV lena.jpg composited with FFmpeg overlay. Synthetic moving engineering stills, not a real-person motion clip, not promotional.',
    lena_source: JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'fixtures/lena-source.json'), 'utf8')).source,
  };

  const moving = path.join(root, 'moving-lena.mp4');
  await run(FFMPEG, [
    '-nostdin', '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x2a6f97:s=640x360:r=24:d=1.0',
    '-i', LENA,
    '-filter_complex', "[1:v]scale=160:160[face];[0:v][face]overlay=x='40+t*280':y='40+t*40'",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', moving,
  ]);
  const moveJson = path.join(evidence, 'moving-track.json');
  const moveResult = await executeNative({
    inputPath: moving, outputPath: moveJson, parameters: { face_selection: 'largest', mask_mode: 'pixelate', max_duration: 8, max_frames: 80 },
    components: components(),
  }, 'track');
  const moveDoc = JSON.parse(fs.readFileSync(moveJson, 'utf8'));
  assert.equal(moveDoc.schema, 'yinzi.video-face-tracking/v1');
  assert.equal(moveDoc.onnx_sessions_created, 1);
  assert.equal(moveDoc.onnx_session_runs, moveDoc.sample.frames_analyzed);
  assert.ok(moveDoc.tracks.length >= 1);
  const detectedFrames = moveDoc.frames.filter(f => f.tracks.some(tr => tr.state === 'detected'));
  assert.ok(detectedFrames.length >= 8, `detected=${detectedFrames.length}`);
  const firstBox = detectedFrames[0].tracks.find(tr => tr.state === 'detected').box;
  const lastBox = detectedFrames.at(-1).tracks.find(tr => tr.state === 'detected').box;
  assert.ok(lastBox.x - firstBox.x > 80, JSON.stringify({ firstBox, lastBox }));
  assert.equal(new Set(detectedFrames.map(f => f.tracks.find(tr => tr.state === 'detected').target_id)).size, 1);
  assert.equal(moveDoc.source.has_audio, false);
  assert.equal(moveResult.onnx_sessions_created, 1);

  const moveMask = path.join(evidence, 'moving-mask.mp4');
  const maskResult = await executeNative({
    inputPath: moving, outputPath: moveMask, parameters: { face_selection: 'largest', mask_mode: 'pixelate', tracks_path: moveJson, max_duration: 8, max_frames: 80 },
    components: components(),
  }, 'mask');
  assert.equal(maskResult.cache_reused, true);
  assert.equal(maskResult.onnx_sessions_created, 0);
  assert.equal(maskResult.before.width, 640);
  assert.equal(maskResult.before.height, 360);
  const cachedDoc = JSON.parse(fs.readFileSync(path.join(evidence, 'moving-mask-faces.json'), 'utf8'));
  assert.equal(cachedDoc.cache_reused, true);
  const midN = detectedFrames[Math.floor(detectedFrames.length / 2)];
  const srcPng = path.join(evidence, 'moving-src.png');
  const outPng = path.join(evidence, 'moving-out.png');
  await extractPng(moving, srcPng, ['-ss', String(midN.seconds)]);
  await extractPng(moveMask, outPng, ['-ss', String(midN.seconds)]);
  const srcRaw = await sharp(srcPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const outRaw = await sharp(outPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(srcRaw.info.width, 640);
  assert.equal(outRaw.info.width, 640);
  const boxAt = midN.tracks.find(tr => tr.state === 'detected').box;
  let outsideSame = 0, outsideTotal = 0, insideDiff = 0, insideTotal = 0;
  for (let y = 0; y < 360; y++) {
    for (let x = 0; x < 640; x++) {
      const i = (y * 640 + x) * 4;
      const inBox = x >= boxAt.x && x <= boxAt.x + boxAt.width && y >= boxAt.y && y <= boxAt.y + boxAt.height;
      const diff = Math.abs(srcRaw.data[i] - outRaw.data[i]) + Math.abs(srcRaw.data[i + 1] - outRaw.data[i + 1]) + Math.abs(srcRaw.data[i + 2] - outRaw.data[i + 2]);
      if (inBox) { insideTotal++; if (diff > 30) insideDiff++; }
      else { outsideTotal++; if (diff < 8) outsideSame++; }
    }
  }
  assert.ok(insideDiff / insideTotal > 0.2, `inside changed ${insideDiff}/${insideTotal}`);
  assert.ok(outsideSame / outsideTotal > 0.9, `outside same ${outsideSame}/${outsideTotal}`);

  const two = path.join(root, 'two-face.mp4');
  await run(FFMPEG, [
    '-nostdin', '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x224466:s=640x360:r=24:d=1.2',
    '-i', LENA, '-i', LENA,
    '-filter_complex', [
      '[1:v]scale=180:180[left]',
      '[2:v]scale=110:110[right]',
      "[0:v][left]overlay=x='20':y=40:enable='lt(t,0.85)'[tmp]",
      "[tmp][right]overlay=x='430':y=160:enable='gte(t,0.25)'",
    ].join(';'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', two,
  ]);
  const twoAll = path.join(evidence, 'two-all.json');
  await executeNative({
    inputPath: two, outputPath: twoAll, parameters: { face_selection: 'all', max_duration: 8, max_frames: 80 },
    components: components(),
  }, 'track');
  const twoDoc = JSON.parse(fs.readFileSync(twoAll, 'utf8'));
  const idsOverTime = twoDoc.frames.map(f => f.tracks.filter(tr => tr.state === 'detected').map(tr => ({ id: tr.target_id, x: tr.box.x })));
  const bothPresent = twoDoc.frames.filter(f => f.tracks.filter(tr => tr.state === 'detected').length >= 2);
  assert.ok(bothPresent.length >= 3, JSON.stringify(idsOverTime.filter(x => x.length)));
  for (const frame of bothPresent) {
    const left = frame.tracks.find(tr => tr.state === 'detected' && tr.box.x < 200);
    const right = frame.tracks.find(tr => tr.state === 'detected' && tr.box.x > 350);
    assert.ok(left && right, JSON.stringify(frame.tracks));
    assert.notEqual(left.target_id, right.target_id);
  }
  const leftId = bothPresent[0].tracks.find(tr => tr.box.x < 200).target_id;
  const rightId = bothPresent[0].tracks.find(tr => tr.box.x > 350).target_id;
  for (const frame of bothPresent) {
    assert.equal(frame.tracks.find(tr => tr.box.x < 200).target_id, leftId);
    assert.equal(frame.tracks.find(tr => tr.box.x > 350).target_id, rightId);
  }
  const twoLargest = path.join(evidence, 'two-largest.json');
  await executeNative({
    inputPath: two, outputPath: twoLargest, parameters: { face_selection: 'largest', max_duration: 8, max_frames: 80 },
    components: components(),
  }, 'track');
  const largestDoc = JSON.parse(fs.readFileSync(twoLargest, 'utf8'));
  const largestLive = largestDoc.frames.flatMap(f => f.tracks.filter(tr => tr.state === 'detected'));
  assert.ok(largestLive.every(tr => tr.box.x < 250), JSON.stringify(largestLive.slice(0, 5)));
  assert.equal(new Set(largestLive.map(tr => tr.target_id)).size, 1);

  const none = path.join(root, 'no-face.mp4');
  await run(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x55aa33:s=320x180:r=24:d=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', none]);
  const noneJson = path.join(evidence, 'no-face.json');
  const noneResult = await executeNative({
    inputPath: none, outputPath: noneJson, parameters: { max_duration: 8, max_frames: 40 }, components: components(),
  }, 'track');
  const noneDoc = JSON.parse(fs.readFileSync(noneJson, 'utf8'));
  assert.ok(noneDoc.frames.every(f => f.detections.length === 0));
  assert.equal(noneResult.quality_status, 'unchanged');

  const cut = path.join(root, 'cut.mp4');
  await run(FFMPEG, [
    '-nostdin', '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x113355:s=640x360:r=24:d=0.6',
    '-f', 'lavfi', '-i', 'color=c=0xcc7733:s=640x360:r=24:d=0.6',
    '-i', LENA, '-i', LENA,
    '-filter_complex', [
      '[2:v]scale=150:150[a]', '[3:v]scale=150:150[b]',
      '[0:v][a]overlay=40:80[left]', '[1:v][b]overlay=420:80[right]',
      '[left][right]concat=n=2:v=1:a=0',
    ].join(';'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', cut,
  ]);
  const cutJson = path.join(evidence, 'cut.json');
  await executeNative({
    inputPath: cut, outputPath: cutJson, parameters: { face_selection: 'largest', scene_threshold: 0.2, min_shot_seconds: 0.15, max_duration: 8, max_frames: 80 },
    components: components(),
  }, 'track');
  const cutDoc = JSON.parse(fs.readFileSync(cutJson, 'utf8'));
  assert.ok(cutDoc.cuts.length >= 1, JSON.stringify(cutDoc.cuts));
  assert.ok(Math.abs(cutDoc.cuts[0].seconds - 0.6) <= 0.12, JSON.stringify(cutDoc.cuts));
  const idsByShot = {};
  for (const frame of cutDoc.frames) {
    for (const tr of frame.tracks.filter(x => x.state === 'detected')) {
      idsByShot[frame.shot_index] ??= new Set();
      idsByShot[frame.shot_index].add(tr.target_id);
    }
  }
  assert.ok(idsByShot[0] && idsByShot[1]);
  const overlap = [...idsByShot[0]].filter(id => idsByShot[1].has(id));
  assert.equal(overlap.length, 0, JSON.stringify({ idsByShot: Object.fromEntries(Object.entries(idsByShot).map(([k, v]) => [k, [...v]])) }));

  const origin = path.join(root, 'origin5.mkv');
  await run(FFMPEG, [
    '-nostdin', '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x2a6f97:s=640x360:r=24:d=0.8',
    '-i', LENA,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.8',
    '-filter_complex', "[1:v]scale=150:150[face];[0:v][face]overlay=80:60",
    '-output_ts_offset', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', origin,
  ]);
  const originJson = path.join(evidence, 'origin5.json');
  const originMask = path.join(evidence, 'origin5-mask.mp4');
  await executeNative({
    inputPath: origin, outputPath: originJson, parameters: { face_selection: 'largest', max_duration: 8, max_frames: 40 },
    components: components(),
  }, 'track');
  const originDoc = JSON.parse(fs.readFileSync(originJson, 'utf8'));
  assert.ok(Math.abs(originDoc.source_timeline_origin - 5) <= 0.05, JSON.stringify(originDoc.source));
  assert.ok(originDoc.frames[0].pts_time >= 4.9);
  assert.ok(Math.abs(originDoc.frames[0].seconds) <= 0.05);
  const originMaskResult = await executeNative({
    inputPath: origin, outputPath: originMask, parameters: { face_selection: 'largest', mask_mode: 'eyes', tracks_path: originJson, max_duration: 8, max_frames: 40 },
    components: components(),
  }, 'mask');
  assert.equal(originMaskResult.before.has_audio, true);
  const originProbe = JSON.parse((await run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', originMask])).stdout);
  assert.ok(originProbe.streams.some(s => s.codec_type === 'audio'));
  assert.equal(Number(originProbe.streams.find(s => s.codec_type === 'video').width), 640);

  const delayed2 = path.join(root, 'delayed-audio2.mkv');
  await run(FFMPEG, [
    '-nostdin', '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x334455:s=320x180:r=24:d=1.0',
    '-i', LENA,
    '-itsoffset', '0.4', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1.0',
    '-filter_complex', '[1:v]scale=120:120[face];[0:v][face]overlay=40:20[v]',
    '-map', '[v]', '-map', '2:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', delayed2,
  ]);
  const delayMask = path.join(evidence, 'delayed-mask.mp4');
  const delayResult = await executeNative({
    inputPath: delayed2, outputPath: delayMask, parameters: { face_selection: 'largest', mask_mode: 'blur', max_duration: 8, max_frames: 40 },
    components: components(),
  }, 'mask');
  assert.ok(delayResult.before.audio_offset_seconds > 0.3, JSON.stringify(delayResult.before));
  const earlyWav = path.join(root, 'early.wav'), lateWav = path.join(root, 'late.wav');
  await run(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-i', delayMask, '-t', '0.12', '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', earlyWav]);
  await run(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-ss', '0.55', '-i', delayMask, '-t', '0.2', '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', lateWav]);
  const rms = buf => {
    let s = 0, n = 0;
    for (let i = 44; i + 1 < buf.length; i += 2) { const v = buf.readInt16LE(i); s += v * v; n++; }
    return Math.sqrt(s / Math.max(1, n));
  };
  const earlyRms = rms(fs.readFileSync(earlyWav)), lateRms = rms(fs.readFileSync(lateWav));
  assert.ok(lateRms > earlyRms, `out early=${earlyRms} late=${lateRms}`);
  const delayProbe = JSON.parse((await run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', delayMask])).stdout);
  const delayAudio = delayProbe.streams.find(s => s.codec_type === 'audio');
  const delayVideo = delayProbe.streams.find(s => s.codec_type === 'video');
  assert.ok(delayAudio, 'masked output dropped audio');
  assert.ok(Math.abs(Number(delayVideo.duration) - 1) <= 0.08, JSON.stringify({ v: delayVideo.duration, a: delayAudio.duration }));
  notes.audio_offset = delayResult.before.audio_offset_seconds;
  notes.audio_rms = { earlyRms, lateRms, output_video_duration: delayVideo.duration, output_audio_duration: delayAudio.duration };

  const hi = path.join(root, '60fps.mp4');
  await run(FFMPEG, [
    '-nostdin', '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x226688:s=320x180:r=60:d=0.4',
    '-i', LENA,
    '-filter_complex', '[1:v]scale=100:100[face];[0:v][face]overlay=30:20',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', hi,
  ]);
  const hiJson = path.join(evidence, '60fps.json');
  await executeNative({
    inputPath: hi, outputPath: hiJson, parameters: { max_duration: 8, max_frames: 80 }, components: components(),
  }, 'track');
  const hiDoc = JSON.parse(fs.readFileSync(hiJson, 'utf8'));
  assert.ok(hiDoc.sample.frames_analyzed >= 20, hiDoc.sample.frames_analyzed);
  assert.ok(Math.abs((hiDoc.frames[1].seconds - hiDoc.frames[0].seconds) - 1 / 60) < 0.01);

  const odd = path.join(root, 'odd.mp4');
  await run(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=321x181:r=24:d=0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-an', odd]).catch(() => {});
  if (fs.existsSync(odd) && fs.statSync(odd).size > 1000) {
    await assert.rejects(executeNative({
      inputPath: odd, outputPath: path.join(root, 'odd.json'), components: components(),
    }, 'track'), { code: 'FACE_TRACK_GEOMETRY' });
  }
  await assert.rejects(executeNative({
    inputPath: none, outputPath: path.join(root, 'limit.json'), parameters: { max_duration: 0.2 }, components: components(),
  }, 'track'), { code: 'FACE_TRACK_LIMIT' });
  const broken = path.join(root, 'broken.bin');
  fs.writeFileSync(broken, 'not a video');
  await assert.rejects(executeNative({
    inputPath: broken, outputPath: path.join(root, 'broken.json'), components: components(),
  }, 'track'));
  await assert.rejects(executeNative({
    inputPath: moving, outputPath: moving, components: components(),
  }, 'track'), { code: 'FACE_OUTPUT_OVERWRITES_INPUT' });

  const eyesMask = path.join(evidence, 'eyes-mask.mp4');
  await executeNative({
    inputPath: moving, outputPath: eyesMask, parameters: { face_selection: 'largest', mask_mode: 'eyes', tracks_path: moveJson, max_duration: 8, max_frames: 80 },
    components: components(),
  }, 'mask');
  const eyesPng = path.join(evidence, 'eyes-out.png');
  await extractPng(eyesMask, eyesPng, ['-ss', String(midN.seconds)]);
  notes.moving = { firstBox, lastBox, midBox: boxAt, insideChanged: insideDiff / insideTotal, outsideSame: outsideSame / outsideTotal };
  notes.two_face = { leftId, rightId, bothPresent: bothPresent.length };
  notes.cut = cutDoc.cuts;
  notes.origin = originDoc.source;
  notes.audio_offset = delayResult.before.audio_offset_seconds;
  notes.highfps = { frames: hiDoc.sample.frames_analyzed, step: hiDoc.frames[1].seconds - hiDoc.frames[0].seconds };

  const vfr = path.join(root, 'vfr-red-blue.mkv');
  await run(FFMPEG, [
    '-nostdin', '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=red:s=160x90:r=60:d=0.5',
    '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=60:d=0.5',
    '-filter_complex', "[0:v][1:v]concat=n=2:v=1:a=0,select='if(lt(n,30),not(mod(n,6)),not(mod(n,2)))'[v]",
    '-map', '[v]', '-fps_mode', 'passthrough', '-c:v', 'libx264', '-bf', '0', vfr,
  ]);
  const vfrMask = path.join(evidence, 'vfr-mask.mp4');
  const vfrResult = await executeNative({
    inputPath: vfr, outputPath: vfrMask, parameters: { mask_mode: 'eyes', max_duration: 8, max_frames: 80, output_fps: 60 },
    components: components(),
  }, 'mask');
  const vfrProbe = JSON.parse((await run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-count_frames', '-of', 'json', vfrMask])).stdout);
  const vfrSrc = JSON.parse((await run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', vfr])).stdout);
  const vfrOutDur = Number(vfrProbe.streams.find(s => s.codec_type === 'video').duration || vfrProbe.format.duration);
  const vfrSrcVideo = vfrSrc.streams.find(s => s.codec_type === 'video');
  const vfrSrcNb = Number(vfrSrcVideo.nb_frames);
  const vfrSrcVideoDur = Number(vfrSrcVideo.duration);
  assert.ok(vfrOutDur > 0.9 && vfrOutDur < 1.05, JSON.stringify({ vfrOutDur, vfrSrcVideoDur, after: vfrResult.after }));
  assert.ok(vfrOutDur > 0.9, 'must not encode 20 VFR frames as 20/60=0.333s');
  if (vfrSrcNb > 0) assert.ok(vfrSrcNb <= 24, `unexpected dense VFR source frames=${vfrSrcNb}`);
  if (Number.isFinite(vfrSrcVideoDur) && vfrSrcVideoDur < 1.2) {
    assert.ok(Math.abs(vfrOutDur - vfrSrcVideoDur) < 0.08, JSON.stringify({ vfrOutDur, vfrSrcVideoDur }));
  }
  const vfrVideo = vfrProbe.streams.find(s => s.codec_type === 'video');
  assert.ok(Number(vfrVideo.nb_read_frames || vfrVideo.nb_frames) >= 50, JSON.stringify(vfrVideo));
  const vfrBefore = path.join(evidence, 'vfr-0.4.png');
  const vfrAfter = path.join(evidence, 'vfr-0.55.png');
  await extractPng(vfrMask, vfrBefore, ['-ss', '0.40']);
  await extractPng(vfrMask, vfrAfter, ['-ss', '0.55']);
  const beforeMean = await meanRgb(vfrBefore);
  const afterMean = await meanRgb(vfrAfter);
  assert.ok(beforeMean.r > beforeMean.b + 30, JSON.stringify(beforeMean));
  assert.ok(afterMean.b > afterMean.r + 30, JSON.stringify(afterMean));
  const vfrAudioSrc = path.join(root, 'vfr-red-blue-audio.mkv');
  await run(FFMPEG, [
    '-nostdin', '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=red:s=160x90:r=60:d=0.5',
    '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=60:d=0.5',
    '-itsoffset', '0.4', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=0.6',
    '-filter_complex', "[0:v][1:v]concat=n=2:v=1:a=0,select='if(lt(n,30),not(mod(n,6)),not(mod(n,2)))'[v]",
    '-map', '[v]', '-map', '2:a:0', '-fps_mode', 'passthrough', '-c:v', 'libx264', '-bf', '0', '-c:a', 'aac',
    '-shortest', vfrAudioSrc,
  ]);
  const vfrAudioMask = path.join(evidence, 'vfr-audio-mask.mp4');
  const vfrAudioResult = await executeNative({
    inputPath: vfrAudioSrc, outputPath: vfrAudioMask, parameters: { mask_mode: 'eyes', max_duration: 8, max_frames: 80, output_fps: 60 },
    components: components(),
  }, 'mask');
  const vfrAudioProbe = JSON.parse((await run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', vfrAudioMask])).stdout);
  const vfrAudioVideo = vfrAudioProbe.streams.find(s => s.codec_type === 'video');
  const vfrAudioTrack = vfrAudioProbe.streams.find(s => s.codec_type === 'audio');
  assert.ok(vfrAudioTrack, 'VFR+audio mask dropped audio');
  const vfrAudioDur = Number(vfrAudioVideo.duration || vfrAudioProbe.format.duration);
  assert.ok(vfrAudioDur > 0.9 && vfrAudioDur < 1.08, JSON.stringify({ vfrAudioDur, after: vfrAudioResult.after }));
  const vfrEarly = path.join(root, 'vfr-early.wav'), vfrLate = path.join(root, 'vfr-late.wav');
  await run(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-i', vfrAudioMask, '-t', '0.12', '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', vfrEarly]);
  await run(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-ss', '0.55', '-i', vfrAudioMask, '-t', '0.2', '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', vfrLate]);
  const vfrEarlyRms = rms(fs.readFileSync(vfrEarly)), vfrLateRms = rms(fs.readFileSync(vfrLate));
  assert.ok(vfrLateRms > vfrEarlyRms, `vfr audio early=${vfrEarlyRms} late=${vfrLateRms}`);
  notes.vfr = {
    source_video_duration: vfrSrcVideoDur, output_duration: vfrOutDur, output_frames: vfrResult.after.output_frames,
    output_fps: vfrResult.after.output_fps, beforeMean, afterMean,
    audio: { early: vfrEarlyRms, late: vfrLateRms, output_duration: vfrAudioDur, offset: vfrAudioResult.before.audio_offset_seconds },
  };
  fs.copyFileSync(vfrBefore, path.join(EVIDENCE_DIR, 'vfr-0.4.png'));
  fs.copyFileSync(vfrAfter, path.join(EVIDENCE_DIR, 'vfr-0.55.png'));

  fs.writeFileSync(path.join(evidence, 'run-notes.json'), JSON.stringify(notes, null, 2));
  fs.copyFileSync(path.join(evidence, 'moving-src.png'), path.join(EVIDENCE_DIR, 'moving-src.png'));
  fs.copyFileSync(path.join(evidence, 'moving-out.png'), path.join(EVIDENCE_DIR, 'moving-out.png'));
  fs.copyFileSync(eyesPng, path.join(EVIDENCE_DIR, 'eyes-out.png'));
});