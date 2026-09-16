'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const fail = (code, message) => Object.assign(new Error(message), { code });

const SUPPORTED_MODELS = new Set([
  'rife', 'rife-anime', 'rife-HD', 'rife-UHD',
  'rife-v2', 'rife-v2.3', 'rife-v2.4', 'rife-v3.0',
  'rife-v3.1', 'rife-v4', 'rife-v4.6'
]);

const VALID_MI_MODES = new Set(['mci', 'blend', 'dup']);
const VALID_MC_MODES = new Set(['aobmc', 'obmc']);
const VALID_ME_MODES = new Set(['bidir', 'bilat']);

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(fail('PROCESS_TIMEOUT', `执行超时 (${options.timeout || 30000}ms): ${executable}`));
    }, options.timeout || 30000);

    child.stdout.on('data', b => {
      stdout = (stdout + b).slice(-1024 * 1024);
      options.onOutput?.(String(b));
    });
    child.stderr.on('data', b => {
      stderr = (stderr + b).slice(-1024 * 1024);
      options.onErrorOutput?.(String(b));
    });
    child.on('error', e => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', code => {
      clearTimeout(timer);
      const allowed = options.exitCodes || [0];
      if (allowed.includes(code)) {
        resolve({ stdout, stderr, code });
      } else {
        reject(fail('COMPONENT_PROCESS_FAILED', `本地进程未完成 (${code}): ${stderr.slice(-1500)}`));
      }
    });
  });
}

async function probeMedia(ffprobe, filePath) {
  const { stdout } = await run(ffprobe, [
    '-v', 'error',
    '-show_streams',
    '-show_format',
    '-of', 'json',
    filePath
  ]);
  return JSON.parse(stdout);
}

function parseFramerate(stream) {
  const str = stream.r_frame_rate || stream.avg_frame_rate;
  if (!str || str === '0/0') return 25;
  if (str.includes('/')) {
    const [num, den] = str.split('/').map(Number);
    return den ? num / den : 25;
  }
  const val = Number(str);
  return Number.isFinite(val) && val > 0 ? val : 25;
}

function normalizeParameters(raw = {}) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw fail('INVALID_PARAMETERS', '参数必须为对象');
  }

  const engine = raw.engine || 'auto';
  if (!['auto', 'rife', 'minterpolate'].includes(engine)) {
    throw fail('INVALID_ENGINE', `引擎仅支持 'auto', 'rife', 'minterpolate'，收到: ${engine}`);
  }

  const hasMultiplier = raw.multiplier != null;
  const hasTargetFps = raw.target_fps != null;

  if (hasMultiplier && hasTargetFps) {
    throw fail('PARAMETER_CONFLICT', '不能同时指定 multiplier 与 target_fps，请二选一');
  }

  let multiplier = null;
  let targetFps = null;

  if (hasMultiplier) {
    multiplier = Number(raw.multiplier);
    if (!Number.isFinite(multiplier) || multiplier <= 1 || multiplier > 16) {
      throw fail('INVALID_MULTIPLIER', `倍率 multiplier 须在 1.01 到 16 之间，收到: ${raw.multiplier}`);
    }
  } else if (hasTargetFps) {
    targetFps = Number(raw.target_fps);
    if (!Number.isFinite(targetFps) || targetFps < 1 || targetFps > 120) {
      throw fail('INVALID_TARGET_FPS', `目标帧率 target_fps 须在 1 到 120 之间，收到: ${raw.target_fps}`);
    }
  } else {
    // 操作内部兜底：用户未给 multiplier 也未给 target_fps 时默认 2x。
    // 不得写入 op.defaults.multiplier，否则 localMediaExecutor 的
    // { ...op.defaults, ...request.parameters } 会在仅提供 target_fps 时误报 PARAMETER_CONFLICT。
    multiplier = 2;
  }

  const rifeModel = raw.rife_model || 'rife-v4.6';
  if (!SUPPORTED_MODELS.has(rifeModel)) {
    throw fail('INVALID_RIFE_MODEL', `不支持的 RIFE 模型: ${rifeModel}`);
  }

  if (raw.gpu_id != null) {
    const gid = Number(raw.gpu_id);
    if (!Number.isInteger(gid) || gid < -1 || gid > 16) {
      throw fail('INVALID_GPU_ID', `GPU 编号须为 -1 到 16 之间的整数，收到: ${raw.gpu_id}`);
    }
  }
  const gpuId = raw.gpu_id != null ? Number(raw.gpu_id) : 0;

  const numThreads = raw.threads || '1:2:2';
  if (typeof numThreads !== 'string' || !/^\d+:\d+:\d+$/.test(numThreads)) {
    throw fail('INVALID_THREADS', `线程分配格式须为 load:proc:save (例如 '1:2:2')，收到: ${numThreads}`);
  }
  const threadParts = numThreads.split(':').map(Number);
  if (threadParts.some(n => n < 1 || n > 32)) {
    throw fail('INVALID_THREADS', `每个线程通道须在 1 到 32 之间，收到: ${numThreads}`);
  }

  if (raw.uhd != null && typeof raw.uhd !== 'boolean') {
    throw fail('INVALID_BOOLEAN', `uhd 参数须为布尔类型，收到: ${typeof raw.uhd}`);
  }
  const uhd = Boolean(raw.uhd);

  if (raw.scene_detection != null && typeof raw.scene_detection !== 'boolean') {
    throw fail('INVALID_BOOLEAN', `scene_detection 参数须为布尔类型，收到: ${typeof raw.scene_detection}`);
  }
  const sceneDetection = raw.scene_detection !== false;

  const sceneThreshold = Number(raw.scene_threshold ?? 12.0);
  if (!Number.isFinite(sceneThreshold) || sceneThreshold < 1.0 || sceneThreshold > 100.0) {
    throw fail('INVALID_SCENE_THRESHOLD', `场景切换阈值须在 1.0 到 100.0 之间，收到: ${raw.scene_threshold}`);
  }

  // FFmpeg 备用参数严格校验
  const minterpolateMiMode = raw.minterpolate_mi_mode || 'mci';
  if (!VALID_MI_MODES.has(minterpolateMiMode)) {
    throw fail('INVALID_MI_MODE', `minterpolate_mi_mode 仅支持 mci/blend/dup，收到: ${minterpolateMiMode}`);
  }

  const minterpolateMcMode = raw.minterpolate_mc_mode || 'aobmc';
  if (!VALID_MC_MODES.has(minterpolateMcMode)) {
    throw fail('INVALID_MC_MODE', `minterpolate_mc_mode 仅支持 aobmc/obmc，收到: ${minterpolateMcMode}`);
  }

  const minterpolateMeMode = raw.minterpolate_me_mode || 'bidir';
  if (!VALID_ME_MODES.has(minterpolateMeMode)) {
    throw fail('INVALID_ME_MODE', `minterpolate_me_mode 仅支持 bidir/bilat，收到: ${minterpolateMeMode}`);
  }

  return {
    engine,
    multiplier,
    targetFps,
    rifeModel,
    gpuId,
    numThreads,
    uhd,
    sceneDetection,
    sceneThreshold,
    minterpolateMiMode,
    minterpolateMcMode,
    minterpolateMeMode
  };
}

/**
 * 探测视频硬切切点时间戳 (PTS 秒数)
 */
async function detectSceneCutTimestamps(ffmpeg, inputPath, sceneThreshold) {
  const normThreshold = (Math.max(1, Math.min(100, sceneThreshold)) / 100).toFixed(4);
  const filterArg = `select='gt(scene,${normThreshold})',metadata=print:file=-`;
  const res = await run(ffmpeg, [
    '-nostdin', '-y', '-i', inputPath,
    '-vf', filterArg,
    '-f', 'null', '-'
  ], { timeout: 60000, exitCodes: [0] });

  const cutPtsTimes = [];
  const lines = (res.stderr || '').split(/\r?\n/).concat((res.stdout || '').split(/\r?\n/));
  for (const line of lines) {
    const m = line.match(/pts_time:([0-9.]+)/);
    if (m) {
      const pts = parseFloat(m[1]);
      if (Number.isFinite(pts)) cutPtsTimes.push(pts);
    }
  }
  return [...new Set(cutPtsTimes)].sort((a, b) => a - b);
}

/**
 * 运行主引擎 RIFE (rife-ncnn-vulkan)
 * 支持多镜头自动切分与切点硬切保护（避免在无关场景间生成混合鬼影帧）
 */
async function executeRife({
  inputPath,
  outputPath,
  params,
  components,
  sourceInfo,
  workDir,
  report,
  signal
}) {
  const rifeBin = components['vision.rife']?.executables?.rife;
  if (!rifeBin || !fs.existsSync(rifeBin)) {
    throw fail('RIFE_BINARY_MISSING', '未找到 vision.rife 可执行文件');
  }
  const rifeDir = path.dirname(rifeBin);
  const ffmpeg = components['media.ffmpeg'].executables.ffmpeg;

  const inFramesDir = path.join(workDir, 'rife-in');
  const finalOutFramesDir = path.join(workDir, 'rife-out');
  fs.mkdirSync(inFramesDir, { recursive: true });
  fs.mkdirSync(finalOutFramesDir, { recursive: true });

  const inputFps = sourceInfo.fps;
  const effectiveFps = params.targetFps || (inputFps * (params.multiplier || 2));
  const effectiveMultiplier = effectiveFps / inputFps;

  report({
    stage: 'extracting_frames',
    message: `提取视频输入帧，原帧率: ${inputFps.toFixed(2)} fps, 目标: ${effectiveFps.toFixed(2)} fps (${effectiveMultiplier.toFixed(2)}x)`
  });

  // 1. 抽取全部高质量 PNG 帧
  await run(ffmpeg, [
    '-nostdin', '-y', '-v', 'error',
    '-i', inputPath,
    path.join(inFramesDir, '%08d.png')
  ], { timeout: 10 * 60 * 1000 });

  const inFiles = fs.readdirSync(inFramesDir).filter(f => f.endsWith('.png')).sort();
  if (inFiles.length < 2) {
    throw fail('INSUFFICIENT_FRAMES', `输入视频帧数不足 (${inFiles.length} 帧)，无法插帧`);
  }

  const modelPath = path.join(rifeDir, params.rifeModel);
  if (!fs.existsSync(modelPath)) {
    throw fail('RIFE_MODEL_NOT_FOUND', `RIFE 模型目录不存在: ${modelPath}`);
  }

  // 2. 场景检测与分段规划（严密保护硬切）
  let segments = [{ start: 0, end: inFiles.length }];
  let detectedCuts = [];

  if (params.sceneDetection) {
    report({
      stage: 'scene_detecting',
      message: `正在分析视频场景硬切切点 (阈值: ${params.sceneThreshold})`
    });
    try {
      const cutTimestamps = await detectSceneCutTimestamps(ffmpeg, inputPath, params.sceneThreshold);
      detectedCuts = cutTimestamps;
      if (cutTimestamps.length > 0) {
        const cutIndices = cutTimestamps
          .map(pts => Math.round(pts * inputFps))
          .filter(idx => idx > 0 && idx < inFiles.length);

        if (cutIndices.length > 0) {
          segments = [];
          let curStart = 0;
          for (const cutIdx of cutIndices) {
            if (cutIdx > curStart) {
              segments.push({ start: curStart, end: cutIdx });
              curStart = cutIdx;
            }
          }
          if (curStart < inFiles.length) {
            segments.push({ start: curStart, end: inFiles.length });
          }
        }
      }
    } catch (scErr) {
      report({
        stage: 'scene_detecting_warning',
        message: `场景切点分析未完成，继续整片插帧: ${scErr.message}`
      });
    }
  }

  const targetTotalFrames = Math.round(inFiles.length * effectiveMultiplier);

  // 分配各片段目标帧数，保证总帧数严格精准
  let allocated = 0;
  const segTargets = segments.map((seg, idx) => {
    if (idx === segments.length - 1) {
      return targetTotalFrames - allocated;
    }
    const count = Math.round((seg.end - seg.start) * effectiveMultiplier);
    allocated += count;
    return count;
  });

  report({
    stage: 'rife_interpolating',
    message: `RIFE 运动光流插帧计算中 (模型: ${params.rifeModel}, 片段数: ${segments.length}, 硬切保护: ${segments.length > 1 ? '已激活' : '未触发'})`,
    engine: 'rife-ncnn-vulkan'
  });

  let globalFrameIndex = 0;
  for (let sIdx = 0; sIdx < segments.length; sIdx++) {
    const seg = segments[sIdx];
    const segCount = seg.end - seg.start;
    const segTarget = segTargets[sIdx];

    const segInDir = path.join(workDir, `seg_${sIdx}_in`);
    const segOutDir = path.join(workDir, `seg_${sIdx}_out`);
    fs.mkdirSync(segInDir, { recursive: true });
    fs.mkdirSync(segOutDir, { recursive: true });

    for (let i = 0; i < segCount; i++) {
      const srcFile = path.join(inFramesDir, inFiles[seg.start + i]);
      const dstFile = path.join(segInDir, String(i + 1).padStart(8, '0') + '.png');
      fs.copyFileSync(srcFile, dstFile);
    }

    if (segCount === 1) {
      // 单帧片段：直接按目标倍数复制帧，不调用多帧光流
      const singleSrc = path.join(segInDir, '00000001.png');
      for (let i = 1; i <= segTarget; i++) {
        fs.copyFileSync(singleSrc, path.join(segOutDir, String(i).padStart(8, '0') + '.png'));
      }
    } else {
      const rifeArgs = [
        '-i', segInDir,
        '-o', segOutDir,
        '-m', modelPath,
        '-g', String(params.gpuId),
        '-j', params.numThreads,
        '-n', String(segTarget)
      ];
      if (params.uhd) rifeArgs.push('-u');

      await run(rifeBin, rifeArgs, {
        cwd: rifeDir,
        timeout: 20 * 60 * 1000
      });
    }

    const segOutFiles = fs.readdirSync(segOutDir).filter(f => f.endsWith('.png')).sort();
    if (segOutFiles.length === 0) {
      throw fail('RIFE_OUTPUT_EMPTY', `RIFE 片段 ${sIdx} 未生成任何插值帧`);
    }

    for (const f of segOutFiles) {
      globalFrameIndex++;
      fs.copyFileSync(
        path.join(segOutDir, f),
        path.join(finalOutFramesDir, String(globalFrameIndex).padStart(8, '0') + '.png')
      );
    }
  }

  const outFiles = fs.readdirSync(finalOutFramesDir).filter(f => f.endsWith('.png')).sort();
  if (outFiles.length === 0) {
    throw fail('RIFE_OUTPUT_EMPTY', 'RIFE 运行完成但未生成任何插值帧');
  }

  report({
    stage: 'muxing',
    message: `生成插帧视频，精确封装音轨与元数据 (总帧数: ${outFiles.length})`
  });

  // 3. 回组视频并严格保留原音轨与时长
  const muxArgs = [
    '-nostdin', '-y', '-v', 'error',
    '-framerate', String(effectiveFps),
    '-i', path.join(finalOutFramesDir, '%08d.png')
  ];

  if (sourceInfo.hasAudio) {
    muxArgs.push('-i', inputPath);
    muxArgs.push('-map', '0:v:0', '-map', '1:a:0');
    muxArgs.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '19');
    const audioStream = sourceInfo.audioStream;
    const canCopy = ['aac', 'mp3', 'alac'].includes(audioStream.codec_name);
    muxArgs.push('-c:a', canCopy ? 'copy' : 'aac');
  } else {
    muxArgs.push('-map', '0:v:0');
    muxArgs.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '19');
  }

  muxArgs.push('-t', String(sourceInfo.duration));
  muxArgs.push('-movflags', '+faststart', outputPath);

  await run(ffmpeg, muxArgs, { timeout: 10 * 60 * 1000 });

  return {
    engine_used: 'rife-ncnn-vulkan',
    rife_model: params.rifeModel,
    input_frames: inFiles.length,
    output_frames: outFiles.length,
    input_fps: inputFps,
    output_fps: effectiveFps,
    duration: sourceInfo.duration,
    scene_segments_count: segments.length,
    scene_cuts_detected: detectedCuts
  };
}

/**
 * 运行备用引擎 FFmpeg minterpolate (运动补偿插值/混叠模式)
 * 采用尾帧时延克隆补齐 (tpad clone) 彻底杜绝尾帧与时间戳不足导致视频少于音频的缺陷
 */
async function executeMinterpolate({
  inputPath,
  outputPath,
  params,
  components,
  sourceInfo,
  report,
  signal
}) {
  const ffmpeg = components['media.ffmpeg'].executables.ffmpeg;
  const inputFps = sourceInfo.fps;
  const effectiveFps = params.targetFps || (inputFps * (params.multiplier || 2));

  report({
    stage: 'minterpolate_executing',
    message: `FFmpeg minterpolate 运动补偿插帧计算中 (${inputFps.toFixed(2)} -> ${effectiveFps.toFixed(2)} fps)`,
    engine: 'ffmpeg-minterpolate'
  });

  // 严格参数化滤镜字符串，杜绝外部任意字符注入
  // 垫入尾帧保护运动补偿不被末尾边界截断：动态计算至少覆盖 3 个源帧且不少于 0.5s
  const padDuration = Math.max(0.5, 3 / inputFps).toFixed(3);
  const filterParts = [
    `tpad=stop_mode=clone:stop_duration=${padDuration}`
  ];

  let mint = `minterpolate=fps=${effectiveFps}:mi_mode=${params.minterpolateMiMode}`;
  if (params.minterpolateMiMode === 'mci') {
    mint += `:mc_mode=${params.minterpolateMcMode}:me_mode=${params.minterpolateMeMode}:vsbmc=1`;
  }
  if (params.sceneDetection) {
    mint += `:scd=fdiff:scd_threshold=${params.sceneThreshold}`;
  } else {
    mint += ':scd=none';
  }
  filterParts.push(mint);
  filterParts.push(`trim=duration=${sourceInfo.duration}`);
  filterParts.push('setpts=PTS-STARTPTS');

  const fullFilterStr = filterParts.join(',');

  const args = [
    '-nostdin', '-y', '-v', 'error',
    '-threads', '2', '-filter_threads', '2',
    '-i', inputPath,
    '-map', '0:v:0'
  ];

  if (sourceInfo.hasAudio) {
    args.push('-map', '0:a:0');
  }

  args.push('-vf', fullFilterStr);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '19');

  if (sourceInfo.hasAudio) {
    const audioStream = sourceInfo.audioStream;
    const canCopy = ['aac', 'mp3', 'alac'].includes(audioStream.codec_name);
    args.push('-c:a', canCopy ? 'copy' : 'aac');
  }

  args.push('-t', String(sourceInfo.duration));
  args.push('-movflags', '+faststart', outputPath);

  await run(ffmpeg, args, { timeout: 15 * 60 * 1000 });

  return {
    engine_used: 'ffmpeg-minterpolate',
    filter: fullFilterStr,
    input_fps: inputFps,
    output_fps: effectiveFps,
    duration: sourceInfo.duration
  };
}

/**
 * 统一主备执行器 executeNative 合同实现
 */
async function executeNative({
  inputPath,
  outputPath,
  parameters: raw = {},
  components,
  report = () => {},
  ensureComponent
}) {
  const started = Date.now();
  const params = normalizeParameters(raw);
  const ffmpegComponent = components['media.ffmpeg'];
  if (!ffmpegComponent) throw fail('FFMPEG_MISSING', '缺少必要组件 media.ffmpeg');
  const ffprobe = ffmpegComponent.executables.ffprobe;

  // 1. 技术探针源视频
  const probeData = await probeMedia(ffprobe, inputPath);
  const videoStream = probeData.streams.find(s => s.codec_type === 'video');
  if (!videoStream) throw fail('INVALID_VIDEO_INPUT', '输入文件不含视频流');
  const audioStream = probeData.streams.find(s => s.codec_type === 'audio');
  // 视频有效时长优先取实际视频流而非音频较长的 container format
  const duration = Number(videoStream.duration || probeData.format?.duration || 0);
  if (!(duration > 0)) throw fail('INVALID_DURATION', '无法探测视频有效时长');

  const fps = parseFramerate(videoStream);
  const videoStartTime = Number(videoStream.start_time || 0);
  const inputAudioDuration = audioStream ? Number(audioStream.duration || probeData.format?.duration || 0) : null;
  const inputAudioStartTime = audioStream ? Number(audioStream.start_time || 0) : null;
  const relativeAudioOffset = audioStream ? (inputAudioStartTime - videoStartTime) : 0;

  const sourceInfo = {
    fps,
    duration,
    videoStartTime,
    width: videoStream.width,
    height: videoStream.height,
    hasAudio: Boolean(audioStream),
    audioStream,
    inputAudioDuration,
    inputAudioStartTime,
    relativeAudioOffset
  };

  // RIFE's native image IO cannot use the deeply nested paths of a job store.
  // Keep each attempt isolated under the host's configurable temporary root.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-interpolate-'));

  let resultDetails;
  let fallbackReason = null;

  // 2. 决策与执行路由
  try {
    if (params.engine === 'auto' || params.engine === 'rife') {
      // 动态按需准备与调用 RIFE
      try {
        if (ensureComponent && !components['vision.rife']) {
          components['vision.rife'] = await ensureComponent('vision.rife');
        }
        if (!components['vision.rife'] || !components['vision.rife'].executables?.rife) {
          throw fail('RIFE_NOT_AVAILABLE', '组件 vision.rife 未安装且未就绪');
        }
        resultDetails = await executeRife({
          inputPath,
          outputPath,
          params,
          components,
          sourceInfo,
          workDir,
          report
        });
      } catch (rifeError) {
        if (params.engine === 'rife') {
          // 用户显式指定 RIFE，禁止静默回退，严格抛出明确异常
          throw rifeError;
        }
        // auto 模式下记录回退原因并平滑降级至备用引擎 minterpolate
        fallbackReason = `RIFE 执行未完成 (${rifeError.message})，自动回退至 FFmpeg minterpolate 备用引擎`;
        report({
          stage: 'fallback',
          message: fallbackReason,
          error: rifeError.message
        });
        resultDetails = await executeMinterpolate({
          inputPath,
          outputPath,
          params,
          components,
          sourceInfo,
          report
        });
        resultDetails.fallback_reason = fallbackReason;
      }
    } else {
      // params.engine === 'minterpolate'
      // 显式指定备用引擎时，绝不下载或调用 vision.rife
      resultDetails = await executeMinterpolate({
        inputPath,
        outputPath,
        params,
        components,
        sourceInfo,
        report
      });
    }

    // 3. 输出质量、音画对齐与完整性探针校验
    const afterProbe = await probeMedia(ffprobe, outputPath);
    const outVideo = afterProbe.streams.find(s => s.codec_type === 'video');
    const outAudio = afterProbe.streams.find(s => s.codec_type === 'audio');
    if (!outVideo) throw fail('OUTPUT_CORRUPTED', '插帧成果视频未包含有效视频流');

    const outVideoDuration = Number(outVideo.duration || afterProbe.format?.duration || 0);
    const outAudioDuration = outAudio ? Number(outAudio.duration || afterProbe.format?.duration || 0) : null;
    const outVideoFrames = Number(outVideo.nb_frames || 0);
    const outAudioFrames = outAudio ? Number(outAudio.nb_frames || 0) : null;
    const outAudioStartTime = outAudio ? Number(outAudio.start_time || 0) : null;

    // 严密核对视频与音频各自的时长与帧率
    if (Math.abs(outVideoDuration - duration) > 0.1) {
      throw fail('DURATION_MISMATCH', `视频流输出时长 (${outVideoDuration.toFixed(3)}s) 与原视频 (${duration.toFixed(3)}s) 偏离过大`);
    }

    if (sourceInfo.hasAudio) {
      if (!outAudio) throw fail('AUDIO_LOST', '原视频含有音轨但插帧成果中音频丢失');
      const outVideoStartTime = Number(outVideo.start_time || 0);
      const outRelativeAudioOffset = outAudioStartTime - outVideoStartTime;
      // 校验音频相对 video_start 的时间偏移保真度
      const startOffsetGap = Math.abs(outRelativeAudioOffset - sourceInfo.relativeAudioOffset);
      if (startOffsetGap > 0.05) {
        throw fail('AUDIO_OFFSET_MISMATCH', `音频相对偏移未保持: 预期 ${sourceInfo.relativeAudioOffset.toFixed(3)}s, 实际 ${outRelativeAudioOffset.toFixed(3)}s`);
      }
      // 校验输出音频时长：输出视频受 -t duration 截断，音频有效长度不超过 duration - max(0, relativeAudioOffset)
      const expectedAudioDuration = Math.min(
        sourceInfo.inputAudioDuration,
        Math.max(0, duration - Math.max(0, sourceInfo.relativeAudioOffset))
      );
      const audioDurationGap = Math.abs(outAudioDuration - expectedAudioDuration);
      if (audioDurationGap > 0.08) {
        throw fail('AUDIO_DURATION_MISMATCH', `音频流输出时长 (${outAudioDuration.toFixed(3)}s) 与预期 (${expectedAudioDuration.toFixed(3)}s) 偏离过大`);
      }
    }

    const outFps = parseFramerate(outVideo);

    return {
      status: 'succeeded',
      engine: resultDetails.engine_used,
      quality_status: 'review_required',
      quality_note: resultDetails.engine_used === 'rife-ncnn-vulkan'
        ? 'RIFE 深度光流插帧完成（已激活场景硬切保护）；建议检查边缘交界与极高速遮挡物体是否存在微小光流伪影。'
        : 'FFmpeg 运动估计/补偿插帧完成（已激活尾帧保护与硬切跳过）；建议检查重复块运动是否存在轻微块状压缩伪影。',
      before: {
        width: sourceInfo.width,
        height: sourceInfo.height,
        fps: sourceInfo.fps,
        duration: sourceInfo.duration,
        has_audio: sourceInfo.hasAudio
      },
      after: {
        width: outVideo.width,
        height: outVideo.height,
        fps: outFps,
        duration: outVideoDuration,
        video_duration: outVideoDuration,
        audio_duration: outAudioDuration,
        video_frames: outVideoFrames,
        audio_frames: outAudioFrames,
        audio_start_time: outAudioStartTime,
        duration_gap: outAudio ? Math.abs(outVideoDuration - outAudioDuration) : 0,
        has_audio: Boolean(outAudio)
      },
      processing_seconds: (Date.now() - started) / 1000,
      details: {
        ...resultDetails,
        video_duration: outVideoDuration,
        audio_duration: outAudioDuration,
        video_frames: outVideoFrames,
        audio_frames: outAudioFrames,
        audio_start_time: outAudioStartTime,
        duration_gap: outAudio ? Math.abs(outVideoDuration - outAudioDuration) : 0
      }
    };
  } finally {
    // 仅清理本次调用的唯一临时工作目录，绝不误删输出目录或其他并发任务
    try {
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    } catch (_) {}
  }
}

module.exports = {
  id: 'local.video.interpolate',
  title: '视频运动补帧与帧率插值 (RIFE / minterpolate 主备)',
  kind: 'video',
  description: 'High-quality optical flow video frame interpolation using RIFE ncnn Vulkan as primary engine and FFmpeg minterpolate as robust fallback.',
  description_zh: '本地高质量视频运动补帧插值；优先官方 RIFE ncnn Vulkan 显卡光流加速，低配及无 Vulkan 环境自动无缝回退 FFmpeg 运动补偿；严密保护场景硬切、音轨与准确时长。',
  component_id: 'media.ffmpeg',
  // 注意：此处不将 vision.rife 设为固定硬依赖，使得无 GPU 或下载失败环境仍可纯走 minterpolate
  additional_components: [],
  optional_components: ['vision.rife'],
  resource_group: 'gpu',
  output_extension: 'mp4',
  source: 'https://github.com/nihui/rife-ncnn-vulkan ; https://ffmpeg.org/ffmpeg-filters.html#minterpolate',
  // multiplier / target_fps 互斥，默认 2x 只在 normalizeParameters 内部兜底。
  // 共享 executor 会合并 op.defaults，此处不得带 multiplier。
  defaults: {
    engine: 'auto',
    rife_model: 'rife-v4.6',
    gpu_id: 0,
    threads: '1:2:2',
    uhd: false,
    scene_detection: true,
    scene_threshold: 12.0,
    minterpolate_mi_mode: 'mci',
    minterpolate_mc_mode: 'aobmc',
    minterpolate_me_mode: 'bidir'
  },
  executeNative,
  normalizeParameters,
  validateParameters: normalizeParameters
};
