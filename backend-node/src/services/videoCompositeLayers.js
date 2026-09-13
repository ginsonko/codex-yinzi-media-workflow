const fs = require('node:fs');
const path = require('node:path');
const { run, sha256 } = require('./componentRuntime');
const { streamDuration } = require('./mediaStreamTiming');
const { filterGraphArgs } = require('./mediaFilterGraph');

const fail = (message, code = 'COMPOSITE_LAYERS_INVALID_INPUT') =>
  Object.assign(new Error(message), { code });

function number(value, name, min, max, integer = false) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw fail(`${name} 应在 ${min} 到 ${max} 之间${integer ? ' (整数)' : ''}`);
  }
  return n;
}

const RESOURCE_LIMITS = {
  MAX_SOURCES: 64,
  MAX_LAYERS: 64,
  MIN_DIMENSION: 16,
  MAX_DIMENSION: 4096,
  MAX_DURATION: 3600,
  MIN_FPS: 1,
  MAX_FPS: 120
};

const FIT_MODES = ['contain', 'cover', 'fill'];
const MASK_MODES = ['luminance', 'alpha'];
const AUDIO_MODES = ['source', 'none'];

function validateSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw fail('sources 必须为非空素材数组');
  }
  if (sources.length > RESOURCE_LIMITS.MAX_SOURCES) {
    throw fail(`sources 数量超过系统资源上限 (${RESOURCE_LIMITS.MAX_SOURCES})`);
  }
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (!s || typeof s !== 'object') {
      throw fail(`第 ${i} 项素材配置无效`);
    }
    if (typeof s.path !== 'string' || !s.path.trim()) {
      throw fail(`第 ${i} 项素材缺少有效的 path 属性`);
    }
  }
}

/**
 * Validates layer parameters against probed source media.
 */
function validateAndPlanLayers(layers, probedSources, baseDuration) {
  if (!Array.isArray(layers)) {
    throw fail('layers 必须为数组');
  }
  if (layers.length > RESOURCE_LIMITS.MAX_LAYERS) {
    throw fail(`layers 数量超过系统资源上限 (${RESOURCE_LIMITS.MAX_LAYERS})`);
  }

  const planned = [];

  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    if (!l || typeof l !== 'object') {
      throw fail(`第 ${i} 个图层配置无效`);
    }

    const sourceIdx = Number(l.source);
    if (!Number.isInteger(sourceIdx) || sourceIdx < 0 || sourceIdx >= probedSources.length) {
      throw fail(`第 ${i} 个图层 source 索引 (${l.source}) 超出素材范围 [0, ${probedSources.length - 1}]`);
    }

    const src = probedSources[sourceIdx];
    const isImage = src.is_image;

    // Time window within base video: start & end
    const start = number(l.start ?? 0, `图层 [${i}] start`, 0, baseDuration);
    const end = number(l.end ?? baseDuration, `图层 [${i}] end`, start, baseDuration);
    const layerDuration = end - start;
    if (layerDuration <= 0) throw fail(`图层 [${i}] 结束时间必须晚于开始时间`);

    // Source offset (source_in)
    let sourceIn = 0;
    if (!isImage) {
      sourceIn = number(l.source_in ?? 0, `图层 [${i}] source_in`, 0, src.duration);
      if (sourceIn >= src.duration) {
        throw fail(`图层 [${i}] source_in (${sourceIn}s) 不能大于或等于素材自身时长 (${src.duration}s)`);
      }
    }

    // Coordinates x, y (can be negative for clipping)
    const x = number(l.x ?? 0, `图层 [${i}] x`, -20000, 20000, true);
    const y = number(l.y ?? 0, `图层 [${i}] y`, -20000, 20000, true);

    // Dimensions width, height
    // If not specified, default to source dimensions
    const defaultWidth = l.height != null && l.width == null
      ? Math.max(2, Math.round(Number(l.height) * (src.video.width / src.video.height)))
      : src.video.width;
    const defaultHeight = l.width != null && l.height == null
      ? Math.max(2, Math.round(Number(l.width) * (src.video.height / src.video.width)))
      : src.video.height;

    const width = number(l.width ?? defaultWidth, `图层 [${i}] width`, 2, 8192, true);
    const height = number(l.height ?? defaultHeight, `图层 [${i}] height`, 2, 8192, true);

    const fit = l.fit ?? 'contain';
    if (!FIT_MODES.includes(fit)) {
      throw fail(`图层 [${i}] fit 模式不受支持: ${fit}，必须为 ${FIT_MODES.join('/')}`);
    }

    const opacity = number(l.opacity ?? 1, `图层 [${i}] opacity`, 0, 1);

    // Mask config
    let maskSourceIdx = null;
    let maskMode = l.mask_mode ?? 'luminance';
    let maskInvert = Boolean(l.mask_invert);

    if (!MASK_MODES.includes(maskMode)) {
      throw fail(`图层 [${i}] mask_mode 不受支持: ${maskMode}，必须为 ${MASK_MODES.join('/')}`);
    }

    if (l.mask_source != null) {
      maskSourceIdx = Number(l.mask_source);
      if (!Number.isInteger(maskSourceIdx) || maskSourceIdx < 0 || maskSourceIdx >= probedSources.length) {
        throw fail(`图层 [${i}] mask_source 索引 (${l.mask_source}) 超出素材范围 [0, ${probedSources.length - 1}]`);
      }
    }

    const sourceEnd = isImage ? end : Math.min(end, start + src.duration - sourceIn);
    const mask = maskSourceIdx == null ? null : probedSources[maskSourceIdx];
    if (mask && !mask.is_image && sourceIn >= mask.duration) throw fail(`图层 [${i}] 蒙版在该入点已结束`);
    const effectiveEnd = mask && !mask.is_image ? Math.min(sourceEnd, start + mask.duration - sourceIn) : sourceEnd;
    planned.push({
      index: i,
      source: sourceIdx,
      is_image: isImage,
      start,
      end: effectiveEnd,
      requested_end: end,
      duration: effectiveEnd - start,
      source_in: sourceIn,
      x,
      y,
      width,
      height,
      fit,
      opacity,
      mask_source: maskSourceIdx,
      mask_mode: maskMode,
      mask_invert: maskInvert
    });
  }

  return planned;
}

/**
 * Builds FFmpeg scale filter according to fit mode, ensuring clean rgba output.
 */
function buildScaleFilter(inputLabel, outputLabel, targetW, targetH, fit) {
  // RGBA layers may have odd dimensions; only the final H.264 canvas is even.
  const w = targetW;
  const h = targetH;

  if (fit === 'fill') {
    return `${inputLabel}scale=${w}:${h},setsar=1,format=rgba${outputLabel}`;
  }
  if (fit === 'contain') {
    // scale down/up preserving aspect ratio, pad to exact w:h with transparent background (color=0x00000000)
    return `${inputLabel}format=rgba,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setsar=1,format=rgba${outputLabel}`;
  }
  if (fit === 'cover') {
    // scale to cover then crop center to exact w:h
    return `${inputLabel}scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,format=rgba${outputLabel}`;
  }
  return `${inputLabel}scale=${w}:${h},setsar=1,format=rgba${outputLabel}`;
}

async function executeNative({
  inputPath,
  outputPath,
  parameters: p = {},
  components,
  report = () => {},
  sources = [],
  integrityManaged = false
}) {
  const runner = components?.runner || run;
  const sha256Fn = components?.sha256 || sha256;

  if (typeof runner !== 'function') {
    throw fail('缺少可用的命令执行器 componentRuntime.run');
  }
  if (typeof sha256Fn !== 'function') {
    throw fail('缺少可用的哈希校验器 componentRuntime.sha256');
  }

  const ffmpegBin = components?.['media.ffmpeg']?.executables?.ffmpeg || 'ffmpeg';
  const ffprobeBin = components?.['media.ffmpeg']?.executables?.ffprobe || 'ffprobe';

  // Build effective sources list
  // inputPath selects the base from sources; otherwise use the first source.
  let effectiveSources = [];
  if (Array.isArray(sources) && sources.length > 0) {
    effectiveSources = sources;
  } else if (inputPath) {
    effectiveSources = [{ path: inputPath, role: 'primary' }];
  } else {
    throw fail('缺少输入源文件列表 sources 或 inputPath');
  }

  validateSources(effectiveSources);

  // Probe all sources
  report({ stage: 'probing', message: `正在分析 ${effectiveSources.length} 个素材源文件` });

  const initialHashes = [];
  const probedSources = [];

  const probe = async (filePath) => {
    const res = await runner(ffprobeBin, [
      '-v', 'error',
      '-show_format',
      '-show_streams',
      '-of', 'json',
      filePath
    ]);
    return JSON.parse(res.stdout);
  };

  for (let i = 0; i < effectiveSources.length; i++) {
    const s = effectiveSources[i];
    const resolvedPath = path.resolve(s.path);
    const samePath = process.platform === 'win32'
      ? resolvedPath.toLowerCase() === path.resolve(outputPath).toLowerCase()
      : resolvedPath === path.resolve(outputPath);
    if (samePath) throw fail('输出路径必须与所有原始素材不同');
    if (!fs.existsSync(resolvedPath)) {
      throw fail(`素材源 [${i}] 文件不存在: ${s.path}`);
    }

    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile() || stat.size === 0) {
      throw fail(`素材源 [${i}] 不是可读取的非空文件: ${s.path}`);
    }

    if (s.identity) {
      const exp = s.identity;
      if (
        (exp.size != null && stat.size !== exp.size) ||
        (exp.mtime_ms != null && stat.mtimeMs !== exp.mtime_ms) ||
        (exp.ctime_ms != null && stat.ctimeMs !== exp.ctime_ms) ||
        (exp.ino != null && stat.ino !== exp.ino)
      ) {
        throw Object.assign(Error(`素材源 [${i}] 在排队期间已发生变化，请重新创建请求`), { code: 'INPUT_CHANGED' });
      }
    }

    if (!integrityManaged) {
      const currentHash = await sha256Fn(resolvedPath);
      if (s.sha256 && s.sha256 !== currentHash) throw fail(`素材源 [${i}] SHA-256 哈希校验不匹配`);
      initialHashes.push({ path: resolvedPath, hash: currentHash });
    }

    const metadata = await probe(resolvedPath);
    const videoStream = metadata.streams?.find(st => st.codec_type === 'video');
    if (!videoStream) {
      throw fail(`素材源 [${i}] (${path.basename(resolvedPath)}) 未包含有效视觉/图像流`);
    }

    // Determine if it is a single image or a video
    const isImage = /(?:^|,)(?:image2|image2pipe|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|tiff_pipe)(?:,|$)/.test(metadata.format?.format_name || '');

    let duration = isImage ? 0 : await streamDuration({stream:videoStream,inputPath:resolvedPath,ffprobe:ffprobeBin,runner});
    if (!Number.isFinite(duration) || duration <= 0) {
      if (!isImage) throw fail(`素材源 [${i}] 的视频时长无法读取`);
      duration = 0;
    }

    const audioStream = metadata.streams?.find(st => st.codec_type === 'audio');
    const audioDuration = audioStream ? Number(audioStream.duration || metadata.format?.duration) : 0;

    probedSources.push({
      index: i,
      path: resolvedPath,
      is_image: isImage,
      video: videoStream,
      audio: audioStream,
      duration,
      audio_duration: audioDuration,
      video_start: Number(videoStream.start_time || 0),
      audio_start: Number(audioStream?.start_time || 0),
      metadata
    });
  }

  const baseIndex = inputPath ? probedSources.findIndex(s => s.path === path.resolve(inputPath)) : 0;
  if (baseIndex < 0) throw fail('sources 中缺少主输入素材');
  const baseSource = probedSources[baseIndex];
  if (baseSource.is_image) {
    throw fail(`主底片素材 sources[${baseIndex}] 必须是有效视频，不能为单张静态图片`);
  }
  if (!Number.isFinite(baseSource.duration) || baseSource.duration <= 0) {
    throw fail(`主底片素材 sources[${baseIndex}] 视频时长无效`);
  }

  // Target fps
  let baseFps = 24;
  if (baseSource.video.r_frame_rate) {
    const parts = baseSource.video.r_frame_rate.split('/');
    if (parts.length === 2 && Number(parts[1]) > 0) {
      const calc = Number(parts[0]) / Number(parts[1]);
      if (Number.isFinite(calc) && calc > 0 && calc <= 120) baseFps = Math.round(calc * 100) / 100;
    }
  }
  const fps = number(p.fps ?? baseFps, '输出帧率 fps', RESOURCE_LIMITS.MIN_FPS, RESOURCE_LIMITS.MAX_FPS);

  // Dimensions
  const baseW = baseSource.video.width;
  const baseH = baseSource.video.height;
  const width = number(p.width ?? baseW, '输出宽度 width', RESOURCE_LIMITS.MIN_DIMENSION, RESOURCE_LIMITS.MAX_DIMENSION, true);
  const height = number(p.height ?? baseH, '输出高度 height', RESOURCE_LIMITS.MIN_DIMENSION, RESOURCE_LIMITS.MAX_DIMENSION, true);
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw fail(`H.264 输出宽高必须为偶数，当前为 ${width}x${height}`);
  }

  // Base duration
  const baseDuration = baseSource.duration;
  if (baseDuration > RESOURCE_LIMITS.MAX_DURATION) {
    throw fail(`主视频时长 (${baseDuration}s) 超过系统资源上限 (${RESOURCE_LIMITS.MAX_DURATION}s)`);
  }

  // Audio mode
  const audioMode = p.audio_mode ?? 'source';
  if (!AUDIO_MODES.includes(audioMode)) {
    throw fail(`audio_mode 必须为 ${AUDIO_MODES.join('/')}，当前为: ${audioMode}`);
  }

  // Plan layers
  const plannedLayers = validateAndPlanLayers(p.layers || [], probedSources, baseDuration);

  report({
    stage: 'planning',
    message: `底片规格 ${width}x${height} @ ${fps}fps, 时长: ${baseDuration.toFixed(3)}s, 图层数量: ${plannedLayers.length}`
  });

  // Build FFmpeg command inputs
  const ffmpegArgs = [
    '-nostdin',
    '-y',
    '-copyts',
    '-v', 'error',
    '-threads', '2',
    '-filter_complex_threads', '2',
    '-protocol_whitelist', 'file,pipe'
  ];

  // Feed distinct sources as inputs
  for (let i = 0; i < probedSources.length; i++) {
    const src = probedSources[i];
    if (src.is_image) {
      ffmpegArgs.push('-loop', '1', '-protocol_whitelist', 'file,pipe', '-i', src.path);
    } else {
      ffmpegArgs.push('-protocol_whitelist', 'file,pipe', '-i', src.path);
    }
  }

  const filterChains = [];

  // 1. Prepare Base video [base_v]
  filterChains.push(
    `[${baseIndex}:v:0]setpts=PTS-(${baseSource.video_start})/TB,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}:start_time=0,format=rgba[base_v]`
  );

  let currentV = '[base_v]';

  // 2. Process each layer
  for (let i = 0; i < plannedLayers.length; i++) {
    const layer = plannedLayers[i];
    const srcIdx = layer.source;
    const src = probedSources[srcIdx];

    const rawLayerLabel = `[layer_raw_${i}]`;
    const scaledLayerLabel = `[layer_scaled_${i}]`;

    if (src.is_image) {
      filterChains.push(
        `[${srcIdx}:v:0]format=rgba${rawLayerLabel}`
      );
    } else {
      // Video layer: trim from source_in, align presentation timestamp with layer.start
      const trimStart = src.video_start + layer.source_in;
      filterChains.push(
        `[${srcIdx}:v:0]trim=start=${trimStart}:end=${trimStart+layer.duration},setpts=PTS-(${trimStart})/TB,fps=${fps}:start_time=0,setpts=PTS+${layer.start}/TB,format=rgba${rawLayerLabel}`
      );
    }

    // Scale layer according to fit mode
    filterChains.push(
      buildScaleFilter(rawLayerLabel, scaledLayerLabel, layer.width, layer.height, layer.fit)
    );

    let layerWithAlphaLabel = scaledLayerLabel;

    // Apply global opacity if < 1
    if (layer.opacity < 1) {
      const opacityLabel = `[layer_opac_${i}]`;
      filterChains.push(
        `${layerWithAlphaLabel}colorchannelmixer=aa=${layer.opacity.toFixed(4)},format=rgba${opacityLabel}`
      );
      layerWithAlphaLabel = opacityLabel;
    }

    // Handle mask if mask_source is specified
    if (layer.mask_source != null) {
      const maskIdx = layer.mask_source;
      const maskSrc = probedSources[maskIdx];
      const rawMaskLabel = `[mask_raw_${i}]`;
      const scaledMaskLabel = `[mask_scaled_${i}]`;
      const finalMaskLabel = `[mask_final_${i}]`;

      if (maskSrc.is_image) {
        filterChains.push(`[${maskIdx}:v:0]format=rgba${rawMaskLabel}`);
      } else {
        const maskTrimStart = maskSrc.video_start + layer.source_in;
        filterChains.push(
          `[${maskIdx}:v:0]trim=start=${maskTrimStart}:end=${maskTrimStart+layer.duration},setpts=PTS-(${maskTrimStart})/TB,fps=${fps}:start_time=0,setpts=PTS+${layer.start}/TB,format=rgba${rawMaskLabel}`
        );
      }

      // Scale mask to layer's width & height using 'fill'
      filterChains.push(
        `${rawMaskLabel}scale=${layer.width}:${layer.height},setsar=1,format=rgba${scaledMaskLabel}`
      );

      // Process mask to single gray stream
      let maskPipe = [];
      if (layer.mask_mode === 'alpha') {
        maskPipe.push('alphaextract');
      } else {
        maskPipe.push('format=gray');
      }
      if (layer.mask_invert) {
        maskPipe.push('negate');
      }
      maskPipe.push('format=gray');

      filterChains.push(
        `${scaledMaskLabel}${maskPipe.join(',')}${finalMaskLabel}`
      );

      // Combine Layer Alpha and Mask:
      // Split layer stream into base and alpha branch, extract alpha, multiply with mask, then alphamerge!
      const lBaseLabel = `[l_base_${i}]`;
      const lForALabel = `[l_fora_${i}]`;
      const layerALabel = `[layer_a_${i}]`;
      const maskCombLabel = `[mask_comb_${i}]`;
      const maskedLayerLabel = `[layer_masked_${i}]`;

      filterChains.push(
        `${layerWithAlphaLabel}split=2${lBaseLabel}${lForALabel}`,
        `${lForALabel}alphaextract,format=gray${layerALabel}`,
        `${layerALabel}${finalMaskLabel}blend=all_mode=multiply,format=gray${maskCombLabel}`,
        `${lBaseLabel}${maskCombLabel}alphamerge,format=rgba${maskedLayerLabel}`
      );

      layerWithAlphaLabel = maskedLayerLabel;
    }

    // Overlay onto current canvas
    const nextV = i === plannedLayers.length - 1 ? '[outv_rgba]' : `[v_comp_${i}]`;
    const overlayOpts = [
      `x=${layer.x}`,
      `y=${layer.y}`,
      `enable='gte(t,${layer.start})*lt(t,${layer.end})'`,
      'eof_action=pass',
      'repeatlast=0',
      'format=rgb'
    ].join(':');

    filterChains.push(
      `${currentV}${layerWithAlphaLabel}overlay=${overlayOpts}${nextV}`
    );
    currentV = nextV;
  }

  // Format final video output to yuv420p
  const finalV = plannedLayers.length > 0 ? '[outv_rgba]' : '[base_v]';
  filterChains.push(`${finalV}format=yuv420p[outv]`);

  ffmpegArgs.push(...filterGraphArgs(outputPath, filterChains));
  ffmpegArgs.push('-map', '[outv]');

  // Preserve the selected base video's audio timeline.
  const audioHandling = [];
  if (audioMode === 'source') {
    if (baseSource.audio) {
      ffmpegArgs.push('-map', `${baseIndex}:a:0`, '-af',
        `asetpts=PTS-(${baseSource.video_start})/TB,atrim=start=0:end=${baseDuration},aresample=48000:async=1:first_pts=0,apad,atrim=duration=${baseDuration}`,
        '-c:a', 'aac', '-b:a', '192k');
      audioHandling.push({
        source_index: baseIndex,
        mode: 'encode_aac_preserve_timeline',
        input_codec: baseSource.audio.codec_name,
        audio_start: baseSource.audio_start,
        video_start: baseSource.video_start,
        delay_sec: baseSource.audio_start - baseSource.video_start,
        note: '保留主底片原音轨与时间起点真实延迟'
      });
    } else {
      audioHandling.push({
        source_index: baseIndex,
        mode: 'none',
        note: '主底片无音轨，输出视频无音轨'
      });
    }
  } else {
    audioHandling.push({
      mode: 'none',
      note: 'audio_mode 为 none，输出视频不含音轨'
    });
  }

  // Video encode settings
  ffmpegArgs.push(
    '-t', String(baseDuration),
    '-r', String(fps),
    '-c:v', 'libx264',
    '-threads', '2',
    '-preset', 'fast',
    '-crf', '19',
    '-pix_fmt', 'yuv420p'
  );

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  ffmpegArgs.push('-movflags', '+faststart', outputPath);

  report({
    stage: 'executing',
    message: `正在执行视频图层与蒙版合成 (${plannedLayers.length} 图层, 时长 ${baseDuration.toFixed(2)}s)`
  });

  await runner(ffmpegBin, ffmpegArgs, { timeout: 600000 });

  // Post-execution verification
  report({ stage: 'validating', message: '成片已生成，正在校验输出可播放性、时长与帧率' });

  // Decode integrity check
  await runner(ffmpegBin, ['-nostdin', '-v', 'error', '-i', outputPath, '-f', 'null', '-'], { timeout: 120000 });

  const after = await probe(outputPath);
  const afterVideo = after.streams?.find(s => s.codec_type === 'video');
  const afterAudio = after.streams?.find(s => s.codec_type === 'audio');

  if (!afterVideo) {
    throw fail('成片解码检查失败：未找到有效视频流');
  }

  const actualDuration = Number(after.format?.duration);
  const tolerance = Math.max(1 / fps, 1024 / 48000) + 0.08; // allow small muxing jitter
  if (!Number.isFinite(actualDuration) || actualDuration <= 0 || Math.abs(actualDuration - baseDuration) > tolerance) {
    throw fail(`成片时长 (${actualDuration}s) 与底片时长 (${baseDuration}s) 不匹配`);
  }

  if (audioMode === 'none' && afterAudio) {
    throw fail('audio_mode 为 none 但成片中存在意外音轨');
  }
  if (audioMode === 'source' && baseSource.audio && !afterAudio) {
    throw fail('主底片含音轨且 audio_mode 为 source，但成片中缺少音轨');
  }

  // Re-verify sources integrity
  for (const item of initialHashes) {
    const postHash = await sha256Fn(item.path);
    if (postHash !== item.hash) {
      throw fail(`素材源在处理期间发生变更: ${item.path}`);
    }
  }

  return {
    before: probedSources.map(s => ({
      index: s.index,
      path: s.path,
      is_image: s.is_image,
      duration: s.duration,
      video: {
        width: s.video.width,
        height: s.video.height,
        r_frame_rate: s.video.r_frame_rate
      },
      has_audio: Boolean(s.audio)
    })),
    after: {
      width: afterVideo.width,
      height: afterVideo.height,
      duration: actualDuration,
      has_audio: Boolean(afterAudio),
      streams: after.streams?.length || 0
    },
    base_duration: baseDuration,
    base_source_index: baseIndex,
    planned_layers: plannedLayers,
    audio_handling: audioHandling,
    quality_status: 'review_required',
    quality_note: '视频图层与蒙版原生合成已完成解码检查与时长对齐；图层层次、透明抠像质量与构图节奏需人工/视觉核验。'
  };
}

const parameter_schema = {
  type: 'object',
  properties: {
    width: { type: 'integer', minimum: 16, maximum: 4096, description: '输出画面宽度，偶数' },
    height: { type: 'integer', minimum: 16, maximum: 4096, description: '输出画面高度，偶数' },
    fps: { type: 'number', minimum: 1, maximum: 120, description: '输出目标帧率' },
    audio_mode: { type: 'string', enum: ['source', 'none'], description: '音频保留模式：source 保留主视频原音轨，none 无音轨' },
    layers: {
      type: 'array',
      minItems: 0,
      maxItems: 64,
      title: '合成图层列表',
      items: {
        type: 'object',
        required: ['source'],
        properties: {
          source: { type: 'integer', minimum: 0, description: '素材源 sources 数组索引' },
          start: { type: 'number', minimum: 0, description: '在底片上的起始显示时间 (秒)' },
          end: { type: 'number', minimum: 0, description: '在底片上的结束显示时间 (秒)' },
          source_in: { type: 'number', minimum: 0, description: '视频素材源自身截取起点 (秒)' },
          x: { type: 'integer', minimum: -20000, maximum: 20000, description: '在画面中的 X 轴左上角坐标，支持负数裁切' },
          y: { type: 'integer', minimum: -20000, maximum: 20000, description: '在画面中的 Y 轴左上角坐标，支持负数裁切' },
          width: { type: 'integer', minimum: 2, maximum: 8192, description: '图层目标宽度' },
          height: { type: 'integer', minimum: 2, maximum: 8192, description: '图层目标高度' },
          fit: { type: 'string', enum: ['contain', 'cover', 'fill'], description: '缩放适配模式' },
          opacity: { type: 'number', minimum: 0, maximum: 1, description: '图层不透明度 (0-1)' },
          mask_source: { type: 'integer', minimum: 0, description: '蒙版素材 sources 索引' },
          mask_mode: { type: 'string', enum: ['luminance', 'alpha'], description: '蒙版模式：luminance 灰度/亮度蒙版，alpha 透明通道蒙版' },
          mask_invert: { type: 'boolean', description: '是否对蒙版执行反相' }
        }
      }
    }
  }
};

module.exports = {
  id: 'local.video.composite-layers',
  title: '视频图层与蒙版原生合成',
  description: '支持主底片视频基底叠加多层视频或图像图层，具备时间启停、坐标偏移(支持负坐标裁剪)、尺寸自适应适配、透明度调节及灰度/Alpha动态/静态蒙版遮罩。',
  kind: 'video',
  component_id: 'media.ffmpeg',
  source: 'https://ffmpeg.org/ffmpeg-filters.html#overlay',
  defaults: {
    audio_mode: 'source',
    layers: []
  },
  inputs: ['input_path', 'sources', 'parameters'],
  executeNative,
  parameter_schema
};
