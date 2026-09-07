const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync: defaultSpawnSync } = require('node:child_process');
const { normalizeDirectorDocument } = require('./productionDirector');
const { getFfmpegPath, hasLocalFfmpeg } = require('../utils/ffmpegPath');

const SCHEMA = 'yinzi.blender-director/v1';
const CAPABILITY_SCHEMA = 'yinzi.blender-capability/v1';
const SMOKE_PLAN_SCHEMA = 'yinzi.blender-smoke-plan/v1';
const RENDER_PLAN_SCHEMA = 'yinzi.blender-render-plan/v1';
const RENDER_RESULT_SCHEMA = 'yinzi.blender-render-result/v1';
const SMOKE_SCRIPT_RELATIVE = path.join('runtime', 'blender', 'smoke_scene.py').replace(/\\/g, '/');
const RENDER_SCRIPT_RELATIVE = path.join('runtime', 'blender', 'render_scene.py').replace(/\\/g, '/');
const PROBE_TIMEOUT_MS = 2500;
const MAX_OUTPUT_BYTES = 64 * 1024;
const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const PROFILES = Object.freeze({
  smoke: Object.freeze({
    id: 'smoke',
    label: 'S1 最小烟测',
    engine: 'BLENDER_EEVEE_NEXT',
    frames: [1, 2, 3],
    resolution: { width: 320, height: 180, percentage: 100 },
    fps: 24,
    samples: 8,
  }),
  professional: Object.freeze({
    id: 'professional',
    label: 'S2 专业导演台预演',
    engine: 'BLENDER_EEVEE_NEXT',
    resolution: { width: 640, height: 360, percentage: 100 },
    fps: 24,
    samples: 16,
    max_preview_frames: 24,
  }),
});

function nowIso() { return new Date().toISOString(); }

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function safeText(value, fallback = '', limit = 200) {
  const text = String(value == null ? fallback : value).trim();
  return text.slice(0, limit);
}

function storageRoot(cfg) {
  const configured = cfg?.storage?.local_path || './data/storage';
  return path.resolve(path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured));
}

function candidateExecutables(cfg, options = {}) {
  const values = [];
  if (Array.isArray(options.candidates)) {
    return [...new Set(options.candidates.map((value) => safeText(value, '', 1024)).filter(Boolean))];
  } else {
    if (options.executable) values.push(options.executable);
    if (process.env.BLENDER_PATH) values.push(process.env.BLENDER_PATH);
    if (cfg?.director?.blender?.executable) values.push(cfg.director.blender.executable);
    values.push('blender');
  }
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    for (const version of ['4.5', '4.4', '4.3', '4.2']) {
      values.push(path.join(programFiles, 'Blender Foundation', `Blender ${version}`, 'blender.exe'));
      values.push(path.join(localAppData, 'Programs', 'Blender Foundation', `Blender ${version}`, 'blender.exe'));
    }
  } else {
    values.push('/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender');
  }
  return [...new Set(values.map((value) => safeText(value, '', 1024)).filter(Boolean))];
}

function parseVersion(output) {
  const firstLine = String(output || '').split(/\r?\n/).find((line) => line.trim()) || '';
  const match = firstLine.match(/\bBlender\s+(\d+\.\d+(?:\.\d+)?)/i);
  if (!match) return { version: null, raw: safeText(firstLine, '', 240) };
  return { version: match[1], raw: safeText(firstLine, '', 240) };
}

function publicExecutable(value) {
  const raw = String(value || '');
  return {
    name: path.basename(raw) || raw,
    kind: path.isAbsolute(raw) ? 'path' : 'command',
  };
}

function probeOne(executable, options = {}) {
  const spawnSync = options.spawnSync || defaultSpawnSync;
  const timeoutMs = Math.max(100, Math.min(10000, Number(options.timeoutMs) || PROBE_TIMEOUT_MS));
  const started = Date.now();
  let result;
  try {
    result = spawnSync(executable, ['--version'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      shell: false,
    }) || {};
  } catch (error) {
    return { ok: false, error_code: 'BLENDER_PROBE_EXCEPTION', error_message: error.message, elapsed_ms: Date.now() - started };
  }
  const elapsed = Date.now() - started;
  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM' || result.signal === 'SIGKILL';
  if (timedOut) return { ok: false, error_code: 'BLENDER_PROBE_TIMEOUT', error_message: 'Blender 版本探测超时', elapsed_ms: elapsed };
  if (result.error) return { ok: false, error_code: 'BLENDER_NOT_FOUND', error_message: result.error.message, elapsed_ms: elapsed };
  if (result.status !== 0) {
    return {
      ok: false,
      error_code: 'BLENDER_PROBE_FAILED',
      error_message: safeText(result.stderr || result.stdout, 'Blender 版本探测失败', 500),
      exit_code: result.status,
      elapsed_ms: elapsed,
    };
  }
  const parsed = parseVersion(result.stdout || result.stderr);
  return {
    ok: true,
    version: parsed.version,
    version_known: Boolean(parsed.version),
    raw: parsed.raw,
    exit_code: result.status,
    elapsed_ms: elapsed,
  };
}

function detectBlender(cfg, options = {}) {
  const checkedAt = (options.now || nowIso)();
  const candidates = candidateExecutables(cfg, options);
  const attempts = [];
  for (const executable of candidates) {
    const probe = probeOne(executable, options);
    attempts.push({ executable: publicExecutable(executable), ...probe });
    if (probe.ok) {
      return {
        schema: CAPABILITY_SCHEMA,
        checked_at: checkedAt,
        status: probe.version_known ? 'ready' : 'degraded',
        available: true,
        version_known: probe.version_known,
        version: probe.version,
        executable: publicExecutable(executable),
        renderers: {
          candidates: ['BLENDER_EEVEE_NEXT', 'CYCLES'],
          verified: false,
          note: '版本探测不会替代实际渲染烟测',
        },
        operations: {
          background_python: true,
          frame_render: true,
          gltf_export: 'unverified',
          video_encode: 'external_ffmpeg_or_blender_unverified',
        },
        probe: { elapsed_ms: probe.elapsed_ms, attempts: attempts.length },
        reasons: probe.version_known ? [] : ['BLENDER_VERSION_UNPARSEABLE'],
      };
    }
  }
  const last = attempts[attempts.length - 1] || null;
  return {
    schema: CAPABILITY_SCHEMA,
    checked_at: checkedAt,
    status: 'unavailable',
    available: false,
    version_known: false,
    version: null,
    executable: null,
    renderers: { candidates: ['BLENDER_EEVEE_NEXT', 'CYCLES'], verified: false },
    operations: { background_python: false, frame_render: false, gltf_export: 'unavailable', video_encode: 'unavailable' },
    probe: { elapsed_ms: attempts.reduce((sum, item) => sum + Number(item.elapsed_ms || 0), 0), attempts: attempts.length },
    reasons: [last?.error_code || 'BLENDER_NOT_FOUND'],
  };
}

function normalizeRequestKey(value) {
  const key = safeText(value, '', 128);
  if (!REQUEST_KEY.test(key) || /^sk-/i.test(key)) {
    const error = new Error('request_key 必须是 3-128 位稳定标识，且不能包含凭据');
    error.code = 'BLENDER_REQUEST_KEY_INVALID';
    throw error;
  }
  return key;
}

function prepareBlenderSmoke(cfg, input = {}, options = {}) {
  const requestKey = normalizeRequestKey(input.request_key || input.idempotency_key);
  if (!input.scene || typeof input.scene !== 'object' || Array.isArray(input.scene)) {
    const error = new Error('Blender smoke 准备需要 scene 场景文档');
    error.code = 'BLENDER_SCENE_REQUIRED';
    throw error;
  }
  let scene;
  try {
    scene = normalizeDirectorDocument(input.scene, input.duration, input.aspect_ratio);
  } catch (error) {
    error.code = error.code || 'BLENDER_SCENE_INVALID';
    throw error;
  }
  const profile = PROFILES.smoke;
  const sceneHash = hashJson(scene);
  const planId = hashJson({ schema: SMOKE_PLAN_SCHEMA, request_key: requestKey, scene_hash: sceneHash }).slice(0, 24);
  const relativeDir = `blender/smoke/${planId}`;
  const root = storageRoot(cfg);
  const relativeArtifacts = {
    scene: `${relativeDir}/scene.json`,
    blend: `${relativeDir}/scene.blend`,
    glb: `${relativeDir}/scene.glb`,
    frame_pattern: `${relativeDir}/frames/frame-####.png`,
    mp4: `${relativeDir}/preview.mp4`,
    manifest: `${relativeDir}/manifest.json`,
  };
  // Resolve for an internal containment check, but do not create directories
  // or write files during preparation.
  const absoluteDir = path.resolve(root, relativeDir);
  const relativeCheck = path.relative(root, absoluteDir);
  if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
    const error = new Error('Blender smoke 输出目录超出项目存储根');
    error.code = 'BLENDER_OUTPUT_PATH_INVALID';
    throw error;
  }
  const capability = detectBlender(cfg, options);
  return {
    schema: SCHEMA,
    plan_schema: SMOKE_PLAN_SCHEMA,
    plan_id: planId,
    request_key: requestKey,
    prepared_at: (options.now || nowIso)(),
    executed: false,
    status: capability.available ? 'ready_to_execute' : 'blocked',
    blocked_reason: capability.available ? null : capability.reasons[0],
    capability,
    profile,
    scene: {
      hash: sceneHash,
      version: scene.version,
      aspect_ratio: scene.aspect_ratio,
      duration_seconds: scene.timeline.duration,
      object_count: scene.objects.length,
      camera_count: scene.objects.filter((item) => item.kind === 'camera').length,
      keyframe_count: scene.timeline.keyframes.length,
    },
    command: capability.available
      ? {
        executable: capability.executable,
        flags: ['--background', '--disable-autoexec', '--python-exit-code', '2'],
        script: SMOKE_SCRIPT_RELATIVE,
        input: relativeArtifacts.scene,
        output_dir: relativeDir,
      }
      : null,
    artifacts: [
      { key: 'scene_json', relative_path: relativeArtifacts.scene, status: 'pending', authoritative: 'input_snapshot' },
      { key: 'blend', relative_path: relativeArtifacts.blend, status: 'pending', authoritative: 'editable_scene' },
      { key: 'glb', relative_path: relativeArtifacts.glb, status: 'pending', authoritative: 'browser_proxy' },
      { key: 'frames', relative_path: relativeArtifacts.frame_pattern, status: 'pending', authoritative: 'rendered_frames' },
      { key: 'mp4', relative_path: relativeArtifacts.mp4, status: 'pending', authoritative: 'encoded_preview' },
      { key: 'manifest', relative_path: relativeArtifacts.manifest, status: 'pending', authoritative: 'receipt' },
    ],
    side_effects: {
      filesystem_write: false,
      process_started: false,
      network: false,
      paid: false,
    },
    recovery: {
      idempotency_key: requestKey,
      resume_rule: '读取同一 plan_id 的 manifest；已存在的帧/工程文件只验收或续跑缺失阶段',
      retry_rule: '准备接口重复调用不会启动 Blender；执行器必须单独实现幂等锁',
    },
  };
}

function resolveBlenderExecutable(cfg, options = {}) {
  const candidates = candidateExecutables(cfg, options);
  for (const executable of candidates) {
    const probe = probeOne(executable, options);
    if (probe.ok) return executable;
  }
  return null;
}

function boundedRenderFrames(duration, fps, maxFrames, requested) {
  const max = Math.max(3, Math.min(120, Number(maxFrames) || 24));
  const total = Math.max(1, Math.round(Number(duration) * Number(fps)));
  if (Array.isArray(requested) && requested.length) {
    return [...new Set(requested.map(Number).filter((value) => Number.isInteger(value) && value >= 1 && value <= total))]
      .slice(0, max).sort((a, b) => a - b);
  }
  const count = Math.min(max, Math.max(3, total));
  if (count >= total) return Array.from({ length: total }, (_, index) => index + 1);
  return Array.from({ length: count }, (_, index) => 1 + Math.round(index * (total - 1) / (count - 1)));
}

function prepareBlenderRender(cfg, input = {}, options = {}) {
  const requestKey = normalizeRequestKey(input.request_key || input.idempotency_key);
  if (!input.scene || typeof input.scene !== 'object' || Array.isArray(input.scene)) {
    const error = new Error('Blender render 准备需要 scene 场景文档');
    error.code = 'BLENDER_SCENE_REQUIRED';
    throw error;
  }
  let scene;
  try { scene = normalizeDirectorDocument(input.scene, input.duration, input.aspect_ratio); }
  catch (error) { error.code = error.code || 'BLENDER_SCENE_INVALID'; throw error; }
  const profile = { ...PROFILES.professional };
  const requestedWidth = Number(input.width || options.width);
  const requestedHeight = Number(input.height || options.height);
  profile.resolution = {
    width: Number.isFinite(requestedWidth) ? Math.max(160, Math.min(1280, Math.round(requestedWidth))) : profile.resolution.width,
    height: Number.isFinite(requestedHeight) ? Math.max(90, Math.min(720, Math.round(requestedHeight))) : profile.resolution.height,
    percentage: 100,
  };
  const duration = scene.timeline.duration;
  const frames = boundedRenderFrames(duration, profile.fps, input.max_preview_frames || profile.max_preview_frames, input.frames);
  const sceneHash = hashJson(scene);
  const planId = hashJson({ schema: RENDER_PLAN_SCHEMA, request_key: requestKey, scene_hash: sceneHash, profile: { ...profile, frames } }).slice(0, 24);
  const relativeDir = `blender/render/${planId}`;
  const root = storageRoot(cfg);
  const absoluteDir = path.resolve(root, relativeDir);
  const relativeCheck = path.relative(root, absoluteDir);
  if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
    const error = new Error('Blender render 输出目录超出项目存储根');
    error.code = 'BLENDER_OUTPUT_PATH_INVALID';
    throw error;
  }
  const capability = detectBlender(cfg, options);
  const relativeArtifacts = {
    scene: `${relativeDir}/scene.json`,
    blend: `${relativeDir}/scene.blend`,
    glb: `${relativeDir}/scene.glb`,
    frame_pattern: `${relativeDir}/frames/frame-####.png`,
    mp4: `${relativeDir}/preview.mp4`,
    manifest: `${relativeDir}/manifest.json`,
  };
  return {
    schema: RENDER_PLAN_SCHEMA,
    plan_id: planId,
    request_key: requestKey,
    prepared_at: (options.now || nowIso)(),
    executed: false,
    status: capability.available ? 'ready_to_execute' : 'blocked',
    blocked_reason: capability.available ? null : capability.reasons[0],
    capability,
    profile: { ...profile, frames },
    scene: {
      hash: sceneHash,
      document: scene,
      version: scene.version,
      aspect_ratio: scene.aspect_ratio,
      duration_seconds: duration,
      object_count: scene.objects.length,
      camera_count: scene.objects.filter((item) => item.kind === 'camera').length,
      keyframe_count: scene.timeline.keyframes.length,
    },
    command: capability.available ? {
      executable: capability.executable,
      flags: ['--background', '--disable-autoexec', '--python-exit-code', '2'],
      script: RENDER_SCRIPT_RELATIVE,
      input: relativeArtifacts.scene,
      output_dir: relativeDir,
    } : null,
    artifacts: [
      { key: 'scene_json', relative_path: relativeArtifacts.scene, status: 'pending', authoritative: 'input_snapshot' },
      { key: 'blend', relative_path: relativeArtifacts.blend, status: 'pending', authoritative: 'editable_scene' },
      { key: 'glb', relative_path: relativeArtifacts.glb, status: 'pending', authoritative: 'browser_proxy' },
      { key: 'frames', relative_path: relativeArtifacts.frame_pattern, status: 'pending', authoritative: 'rendered_frames' },
      { key: 'mp4', relative_path: relativeArtifacts.mp4, status: 'pending', authoritative: 'encoded_preview' },
      { key: 'manifest', relative_path: relativeArtifacts.manifest, status: 'pending', authoritative: 'receipt' },
    ],
    side_effects: { filesystem_write: false, process_started: false, network: false, paid: false },
    recovery: {
      idempotency_key: requestKey,
      resume_rule: '读取同一 plan_id 的 manifest；保留已完成帧、blend 和 GLB，只补缺失阶段',
      retry_rule: '同一 request_key + scene_hash 复用 plan_id，不重复执行已经完成的阶段',
    },
  };
}

function runBlenderRender(cfg, input = {}, options = {}) {
  const plan = prepareBlenderRender(cfg, input, options);
  if (plan.status === 'blocked') return plan;
  const root = storageRoot(cfg);
  const absoluteDir = path.resolve(root, `blender/render/${plan.plan_id}`);
  const manifestPath = path.join(absoluteDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (existing.video?.status === 'succeeded' || options.encodeVideo === false) {
        return { ...plan, ...existing, plan_id: plan.plan_id, request_key: plan.request_key, executed: true, reused: true, side_effects: { filesystem_write: false, process_started: false, network: false, paid: false } };
      }
      const recoveredVideo = encodeReferenceVideo(absoluteDir, existing.blender?.frames || existing.frames || [], plan.profile.fps, options);
      const recovered = { ...existing, video: recoveredVideo, executed: true, reused: true };
      fsModuleWriteManifest(manifestPath, recovered);
      return { ...plan, ...recovered, plan_id: plan.plan_id, request_key: plan.request_key, executed: true, reused: true, side_effects: { filesystem_write: recoveredVideo.status === 'succeeded', process_started: false, network: false, paid: false } };
    } catch (_) { /* incomplete manifest is repaired below */ }
  }
  const fsModule = options.fs || fs;
  fsModule.mkdirSync(path.join(absoluteDir, 'frames'), { recursive: true });
  const scenePath = path.join(absoluteDir, 'scene.json');
  fsModule.writeFileSync(scenePath, JSON.stringify(plan.scene.document, null, 2), 'utf8');
  const executable = options.executable || resolveBlenderExecutable(cfg, options);
  if (!executable) return { ...plan, status: 'blocked', blocked_reason: 'BLENDER_NOT_FOUND' };
  const spawn = options.spawnSync || defaultSpawnSync;
  const scriptPath = [
    path.resolve(process.cwd(), RENDER_SCRIPT_RELATIVE),
    path.resolve(__dirname, '../../../', RENDER_SCRIPT_RELATIVE),
    path.resolve(__dirname, '../../', RENDER_SCRIPT_RELATIVE),
  ].find((candidate) => fs.existsSync(candidate)) || path.resolve(process.cwd(), RENDER_SCRIPT_RELATIVE);
  const args = [
    '--background', '--disable-autoexec', '--python-exit-code', '2',
    '--python', scriptPath, '--',
    '--output', absoluteDir, '--input', scenePath,
    '--engine', plan.profile.engine,
    '--frames', plan.profile.frames.join(','),
    '--width', String(plan.profile.resolution.width), '--height', String(plan.profile.resolution.height),
    '--fps', String(plan.profile.fps),
  ];
  let result;
  try {
    result = spawn(executable, args, {
      encoding: 'utf8', timeout: Math.max(10000, Math.min(600000, Number(options.timeoutMs) || 300000)),
      maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, shell: false,
    }) || {};
  } catch (error) {
    result = { status: null, error };
  }
  const blenderError = result.error?.code === 'ETIMEDOUT'
    ? 'BLENDER_RENDER_TIMEOUT'
    : result.error ? 'BLENDER_RENDER_EXCEPTION' : null;
  let manifest = null;
  try { manifest = JSON.parse(fsModule.readFileSync(manifestPath, 'utf8')); } catch (_) { /* partial render */ }
  const video = options.encodeVideo === false
    ? { status: 'skipped', reason: 'disabled_for_caller' }
    : encodeReferenceVideo(absoluteDir, manifest?.frames || [], plan.profile.fps, options);
  const status = manifest?.status || (result.status === 0 ? 'partial' : 'failed');
  const payload = {
    ...plan,
    schema: RENDER_RESULT_SCHEMA,
    executed: true,
    reused: false,
    status: blenderError || (result.status !== 0 ? 'failed' : status),
    error_code: blenderError || (result.status !== 0 ? 'BLENDER_RENDER_FAILED' : null),
    error_message: blenderError ? 'Blender 渲染超时或进程异常' : (result.status !== 0 ? String(result.stderr || result.stdout || 'Blender 渲染失败').slice(0, 500) : null),
    exit_code: result.status,
    blender: manifest,
    video,
    side_effects: { filesystem_write: true, process_started: true, network: false, paid: false },
  };
  if (manifest?.status === 'succeeded') {
    payload.capability = {
      ...payload.capability,
      renderers: { ...payload.capability.renderers, verified: true, verified_engine: manifest.engine || null },
      operations: { ...payload.capability.operations, gltf_export: manifest.glb ? 'verified' : 'unavailable', video_encode: video.status === 'succeeded' ? 'verified_ffmpeg' : video.status },
    };
  }
  try { fsModule.writeFileSync(manifestPath, JSON.stringify(payload, null, 2), 'utf8'); } catch (_) { /* preserve original error */ }
  return payload;
}

function fsModuleWriteManifest(manifestPath, value) {
  try { fs.writeFileSync(manifestPath, JSON.stringify(value, null, 2), 'utf8'); } catch (_) { /* best-effort recovery receipt */ }
}

function encodeReferenceVideo(outputDir, framePaths, fps, options = {}) {
  if (!Array.isArray(framePaths) || !framePaths.length) return { status: 'skipped', reason: 'no_rendered_frames' };
  const ffmpeg = options.ffmpegPath || getFfmpegPath();
  if (!options.ffmpegPath && !hasLocalFfmpeg()) return { status: 'unavailable', reason: 'ffmpeg_unavailable' };
  const fsModule = options.fs || fs;
  const absoluteFrames = framePaths.map((item) => path.resolve(outputDir, String(item))).filter((item) => {
    const relative = path.relative(outputDir, item);
    return !relative.startsWith('..') && !path.isAbsolute(relative) && fsModule.existsSync(item);
  });
  if (!absoluteFrames.length) return { status: 'skipped', reason: 'rendered_frames_missing' };
  const listPath = path.join(outputDir, 'frames.concat.txt');
  const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
  fsModule.writeFileSync(listPath, absoluteFrames.map((item) => `file ${quote(item)}`).join('\n') + '\n', 'utf8');
  const outputPath = path.join(outputDir, 'preview.mp4');
  const spawn = options.spawnSync || defaultSpawnSync;
  let result;
  try {
    result = spawn(ffmpeg, [
      '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-vf', `fps=${Math.max(1, Math.min(24, Number(fps) || 12))}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outputPath,
    ], { encoding: 'utf8', timeout: Math.max(10000, Math.min(300000, Number(options.videoTimeoutMs) || 120000)), maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, shell: false }) || {};
  } catch (error) { result = { status: null, error }; }
  try { fsModule.unlinkSync(listPath); } catch (_) { /* keep list for recovery if deletion is unavailable */ }
  if (result.status === 0 && fsModule.existsSync(outputPath)) {
    return { status: 'succeeded', relative_path: path.relative(outputDir, outputPath).replace(/\\/g, '/'), frame_count: absoluteFrames.length, fps: Math.max(1, Math.min(24, Number(fps) || 12)) };
  }
  return { status: result.error?.code === 'ETIMEDOUT' ? 'failed' : 'failed', reason: String(result.stderr || result.stdout || result.error?.message || 'ffmpeg_failed').slice(0, 500) };
}

module.exports = {
  SCHEMA,
  CAPABILITY_SCHEMA,
  SMOKE_PLAN_SCHEMA,
  RENDER_PLAN_SCHEMA,
  RENDER_RESULT_SCHEMA,
  SMOKE_SCRIPT_RELATIVE,
  RENDER_SCRIPT_RELATIVE,
  PROFILES,
  canonicalize,
  hashJson,
  candidateExecutables,
  parseVersion,
  probeOne,
  detectBlender,
  normalizeRequestKey,
  prepareBlenderSmoke,
  resolveBlenderExecutable,
  boundedRenderFrames,
  prepareBlenderRender,
  runBlenderRender,
  encodeReferenceVideo,
};
