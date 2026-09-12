const fs = require('node:fs');
const path = require('node:path');
const { run, sha256 } = require('./componentRuntime');

const fail = (message, code = 'COMPOSE_CLIPS_INVALID_INPUT') =>
  Object.assign(new Error(message), { code });

function number(value, name, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw fail(`${name} 应在 ${min} 到 ${max} 之间`);
  }
  return n;
}

const RESOURCE_LIMITS = {
  MAX_SOURCES: 64,
  MAX_CLIPS: 256,
  MAX_TOTAL_DURATION: 3600, // 1 hour max composite video
  MIN_FADE_DURATION: 0.01,
  MAX_FADE_DURATION: 30.0,
  MIN_DIMENSION: 16,
  MAX_DIMENSION: 4096,
  MIN_FPS: 1,
  MAX_FPS: 120
};

/**
 * Validates sources array and verifies identity / accessibility.
 */
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
 * Validates clips array and computes timeline layout.
 * Accurately prevents multi-segment crossfade collisions where overlapping durations
 * exceed an intermediate clip's total length.
 *
 * @param {Array} clips
 * @param {Array<number>} sourceDurations Durations probed from sources
 * @param {number} fps Output target fps used for minimum frame duration checks
 * @returns {{ plannedClips: Array<Object>, totalDuration: number }}
 */
function validateAndPlanTimeline(clips, sourceDurations, fps = 24) {
  if (!Array.isArray(clips) || clips.length === 0) {
    throw fail('clips 必须为非空片段数组');
  }
  if (clips.length > RESOURCE_LIMITS.MAX_CLIPS) {
    throw fail(`clips 数量超过系统资源上限 (${RESOURCE_LIMITS.MAX_CLIPS})`);
  }

  const minFrameDuration = 1 / fps;
  const rawPlanned = [];

  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (!c || typeof c !== 'object') {
      throw fail(`第 ${i} 个片段配置无效`);
    }

    const sourceIdx = Number(c.source);
    if (!Number.isInteger(sourceIdx) || sourceIdx < 0 || sourceIdx >= sourceDurations.length) {
      throw fail(`第 ${i} 个片段 source 索引 (${c.source}) 超出素材范围 [0, ${sourceDurations.length - 1}]`);
    }

    const maxSrcDuration = sourceDurations[sourceIdx];
    const sourceIn = number(c.source_in, `片段 [${i}] source_in`, 0, maxSrcDuration);
    const sourceOut = number(c.source_out, `片段 [${i}] source_out`, sourceIn, maxSrcDuration);
    const clipDuration = sourceOut - sourceIn;

    if (clipDuration <= 0) {
      throw fail(`片段 [${i}] 时长必须为正数 (当前: ${clipDuration}s)`);
    }

    if (clipDuration < minFrameDuration - 0.0001) {
      throw fail(`片段 [${i}] 时长 (${clipDuration.toFixed(4)}s) 小于目标帧率 (${fps}fps) 对应的单帧时长 (${minFrameDuration.toFixed(4)}s)`);
    }

    let transition = 'cut';
    let transitionDuration = 0;

    if (i > 0) {
      const rawTrans = c.transition ?? 'cut';
      if (rawTrans !== 'cut' && rawTrans !== 'fade') {
        throw fail(`片段 [${i}] 转场类型 (${rawTrans}) 不受支持，仅支持 'cut' 或 'fade'`);
      }
      transition = rawTrans;

      if (transition === 'fade') {
        transitionDuration = number(
          c.transition_duration ?? 0.5,
          `片段 [${i}] transition_duration`,
          RESOURCE_LIMITS.MIN_FADE_DURATION,
          RESOURCE_LIMITS.MAX_FADE_DURATION
        );

        if (transitionDuration >= clipDuration) {
          throw fail(`片段 [${i}] 淡化时长 (${transitionDuration}s) 必须小于当前段的时长 (${clipDuration.toFixed(3)}s)`);
        }
      }
    }

    rawPlanned.push({
      index: i,
      source: sourceIdx,
      source_in: sourceIn,
      source_out: sourceOut,
      duration: clipDuration,
      transition,
      transition_duration: transitionDuration
    });
  }

  // Cross-clip overlap validation:
  // For each intermediate clip i, the sum of incoming fade and outgoing fade
  // cannot exceed clip i's duration.
  for (let i = 0; i < rawPlanned.length; i++) {
    const incomingFade = rawPlanned[i].transition === 'fade' ? rawPlanned[i].transition_duration : 0;
    const outgoingFade = (i + 1 < rawPlanned.length && rawPlanned[i + 1].transition === 'fade')
      ? rawPlanned[i + 1].transition_duration
      : 0;

    if (incomingFade + outgoingFade >= rawPlanned[i].duration) {
      throw fail(
        `片段 [${i}] 入场淡化 (${incomingFade}s) 与出场淡化 (${outgoingFade}s) 的重叠总和不能超过或等于该片段自身时长 (${rawPlanned[i].duration.toFixed(3)}s)`
      );
    }
  }

  // Compute exact output timeline without premature lossy rounding
  let currentOutputTime = 0;
  const plannedClips = [];

  for (let i = 0; i < rawPlanned.length; i++) {
    const p = rawPlanned[i];
    const startInOutput = i === 0 ? 0 : currentOutputTime - p.transition_duration;
    const endInOutput = startInOutput + p.duration;
    currentOutputTime = endInOutput;

    plannedClips.push({
      ...p,
      timeline_start: startInOutput,
      timeline_end: endInOutput
    });
  }

  const totalDuration = currentOutputTime;
  if (totalDuration > RESOURCE_LIMITS.MAX_TOTAL_DURATION) {
    throw fail(`合成视频总时长 (${totalDuration.toFixed(2)}s) 超过系统资源上限 (${RESOURCE_LIMITS.MAX_TOTAL_DURATION}s)`);
  }

  return { plannedClips, totalDuration };
}

/**
 * Native execution implementation.
 */
async function composeClips({ inputPath, outputPath, parameters: p = {}, components, report = () => {}, sources = [], integrityManaged = false }) {
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
  let effectiveSources = [];
  if (Array.isArray(sources) && sources.length > 0) {
    effectiveSources = sources;
  } else if (inputPath) {
    effectiveSources = [{ path: inputPath, role: 'primary' }];
  } else {
    throw fail('缺少输入源文件列表 sources 或 inputPath');
  }

  validateSources(effectiveSources);

  // Pre-execution integrity & probing
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

    // Verify identity if provided by executor snapshot
    if (s.identity) {
      const exp = s.identity;
      if (
        (exp.size != null && stat.size !== exp.size) ||
        (exp.mtime_ms != null && stat.mtimeMs !== exp.mtime_ms) ||
        (exp.ctime_ms != null && stat.ctimeMs !== exp.ctime_ms) ||
        (exp.ino != null && stat.ino !== exp.ino)
      ) {
        throw Object.assign(Error(`素材源 [${i}] 在排队期间已发生变化，请使用当前素材重新创建请求`), { code: 'INPUT_CHANGED' });
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
      throw fail(`素材源 [${i}] (${path.basename(resolvedPath)}) 未包含有效视频流`);
    }

    const duration = Number(videoStream.duration || metadata.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw fail(`素材源 [${i}] 无法读取有效视频时长`);
    }

    const audioStream = metadata.streams?.find(st => st.codec_type === 'audio');
    const audioDuration = audioStream ? Number(audioStream.duration || metadata.format?.duration) : 0;

    probedSources.push({
      index: i,
      path: resolvedPath,
      video: videoStream,
      audio: audioStream,
      duration,
      audio_duration: audioDuration,
      video_start: Number(videoStream.start_time || 0),
      audio_start: Number(audioStream?.start_time || 0),
      metadata
    });
  }

  // Audio mode validation
  const audioMode = p.audio_mode ?? 'source';
  if (audioMode !== 'source' && audioMode !== 'none') {
    throw fail(`audio_mode 必须为 'source' 或 'none'，当前为: ${audioMode}`);
  }

  // Dimension & FPS validation
  const firstVideo = probedSources[0].video;
  const width = number(p.width ?? firstVideo.width ?? 1280, '输出宽度 width', RESOURCE_LIMITS.MIN_DIMENSION, RESOURCE_LIMITS.MAX_DIMENSION);
  const height = number(p.height ?? firstVideo.height ?? 720, '输出高度 height', RESOURCE_LIMITS.MIN_DIMENSION, RESOURCE_LIMITS.MAX_DIMENSION);
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw fail(`H.264 输出宽高必须为偶数，当前为 ${width}x${height}`);
  }

  const fps = number(p.fps ?? 24, '输出帧率 fps', RESOURCE_LIMITS.MIN_FPS, RESOURCE_LIMITS.MAX_FPS);

  // Validate clips:
  // When clips is not provided, use the entire duration of the primary source without truncation!
  const rawClips = p.clips && p.clips.length > 0
    ? p.clips
    : [{ source: 0, source_in: 0, source_out: probedSources[0].duration }];

  const requested = validateAndPlanTimeline(
    rawClips,
    probedSources.map(s => s.duration),
    fps
  );
  // Quantize cumulative boundaries once, rather than rounding every short clip
  // independently and accumulating timing drift through the edit.
  const plannedClips = requested.plannedClips.map((clip,i,all) => {
    const startFrame=Math.round(clip.timeline_start*fps),endFrame=Math.round(clip.timeline_end*fps);
    const fadeFrames=i ? Math.round(all[i-1].timeline_end*fps)-startFrame : 0;
    if(endFrame<=startFrame)throw fail(`片段 [${i}] 在输出帧网格上不足一帧`);
    return {...clip,requested_duration:clip.duration,requested_timeline_start:clip.timeline_start,requested_timeline_end:clip.timeline_end,
      timeline_start:startFrame/fps,timeline_end:endFrame/fps,duration:(endFrame-startFrame)/fps,frame_count:endFrame-startFrame,
      requested_transition:clip.transition,transition:fadeFrames ? clip.transition : 'cut',transition_duration:fadeFrames/fps};
  });
  const totalFrames=Math.round(requested.totalDuration*fps),totalDuration=totalFrames/fps;
  for(let i=0;i<plannedClips.length;i++)if(plannedClips[i].transition_duration+(plannedClips[i+1]?.transition_duration||0)>=plannedClips[i].duration)throw fail(`片段 [${i}] 的转场在输出帧网格上没有独立画面`);

  report({
    stage: 'planning',
    message: `已规划 ${plannedClips.length} 个片段，预计合成总时长: ${totalDuration.toFixed(2)}s`
  });

  // Track audio handling details for audit
  const audioHandling = [];

  // Build FFmpeg command inputs and filtergraph
  // Pure argv array, shell: false, no shell string concatenation
  const ffmpegArgs = [
    '-nostdin',
    '-y',
    '-copyts',
    '-v', 'error',
    '-threads', '2',
    '-filter_complex_threads', '2',
    '-protocol_whitelist', 'file,pipe'
  ];

  // Each distinct source path is supplied as -protocol_whitelist file,pipe -i <path>
  for (let i = 0; i < probedSources.length; i++) {
    ffmpegArgs.push('-protocol_whitelist', 'file,pipe', '-i', probedSources[i].path);
  }

  if (audioMode === 'source') {
    for (let i = 0; i < plannedClips.length; i++) {
      const clip = plannedClips[i];
      const src = probedSources[clip.source];
      if (!src.audio) {
        audioHandling.push({
          clip_index: i,
          source_index: clip.source,
          mode: 'silent_pad',
          note: `源素材 [${clip.source}] 无音轨，使用 anullsrc 补齐 ${clip.duration.toFixed(3)}s 等长静音保持对齐`
        });
      } else {
        audioHandling.push({
          clip_index: i,
          source_index: clip.source,
          mode: 'source_audio',
          note: `提取源素材 [${clip.source}] 伴音，必要时静音补齐至 ${clip.duration.toFixed(3)}s 并重采样至 48000Hz 立体声`
        });
      }
    }
  } else {
    audioHandling.push({
      mode: 'none',
      note: 'audio_mode 为 none，输出视频不含音轨'
    });
  }

  // Build filter complex
  const filterChains = [];

  // Step 1: Pre-process each clip's video and audio stream
  for (let i = 0; i < plannedClips.length; i++) {
    const clip = plannedClips[i];
    const srcInputIdx = clip.source;

    // Video pipeline: trim -> setpts -> scale (contain) -> pad (center) -> setsar -> fps -> settb -> format
    const vFilter = [
      `[${srcInputIdx}:v:0]trim=start=${probedSources[srcInputIdx].video_start+clip.source_in}:end=${probedSources[srcInputIdx].video_start+clip.source_out}`,
      `setpts=PTS-(${probedSources[srcInputIdx].video_start+clip.source_in})/TB`,
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
      'setsar=1',
      `fps=${fps}:start_time=0`,
      `tpad=stop_mode=clone:stop_duration=${1/fps}`,
      `trim=end_frame=${clip.frame_count}`,
      'settb=AVTB',
      'format=yuv420p[v_clip_' + i + ']'
    ].join(',');
    filterChains.push(vFilter);

    // Audio pipeline
    if (audioMode === 'source') {
      const src = probedSources[clip.source];
      const relativeAudioStart=src.audio_start-src.video_start;
      const knownAudioEnd=Number.isFinite(src.audio_duration)&&src.audio_duration>0 ? relativeAudioStart+src.audio_duration : Infinity;
      if (src.audio && relativeAudioStart < clip.source_out && knownAudioEnd > clip.source_in) {
        // apad + atrim=duration ensures that even if audio stream is shorter than the requested video segment,
        // it will be padded with exact silence to prevent audio from shifting early.
        const aFilter = [
          `[${srcInputIdx}:a:0]asetpts=PTS-(${src.video_start})/TB`,
          `atrim=start=${clip.source_in}:end=${clip.source_out}`,
          `asetpts=PTS-(${clip.source_in})/TB`,
          'aresample=48000:async=1:first_pts=0',
          'apad',
          `atrim=duration=${clip.duration}`,
          'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a_clip_' + i + ']'
        ].join(',');
        filterChains.push(aFilter);
      } else {
        // Use filter-level anullsrc of exact duration
        const aFilter = [
          `anullsrc=r=48000:cl=stereo`,
          `atrim=duration=${clip.duration}`,
          'asetpts=PTS-STARTPTS',
          'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a_clip_' + i + ']'
        ].join(',');
        filterChains.push(aFilter);
      }
    }
  }

  // Step 2: Assemble clips sequentially using concat or xfade/acrossfade
  let currentV = '[v_clip_0]';
  let currentA = audioMode === 'source' ? '[a_clip_0]' : null;
  let accumulatedOffset = plannedClips[0].duration;

  for (let i = 1; i < plannedClips.length; i++) {
    const clip = plannedClips[i];
    const nextV = `[v_clip_${i}]`;
    const nextA = audioMode === 'source' ? `[a_clip_${i}]` : null;

    const outV = i === plannedClips.length - 1 ? '[outv]' : `[v_stage_${i}]`;
    const outA = audioMode === 'source'
      ? (i === plannedClips.length - 1 ? '[outa]' : `[a_stage_${i}]`)
      : null;

    if (clip.transition === 'fade') {
      const offset = accumulatedOffset - clip.transition_duration;
      // Video crossfade
      filterChains.push(`${currentV}${nextV}xfade=transition=fade:duration=${clip.transition_duration}:offset=${offset.toFixed(6)}${outV}`);
      // Audio crossfade
      if (audioMode === 'source') {
        filterChains.push(`${currentA}${nextA}acrossfade=d=${clip.transition_duration}${outA}`);
      }
      accumulatedOffset = offset + clip.duration;
    } else {
      // Hard cut (concat)
      filterChains.push(`${currentV}${nextV}concat=n=2:v=1:a=0${outV}`);
      if (audioMode === 'source') {
        filterChains.push(`${currentA}${nextA}concat=n=2:v=0:a=1${outA}`);
      }
      accumulatedOffset += clip.duration;
    }

    currentV = outV;
    if (audioMode === 'source') {
      currentA = outA;
    }
  }

  // If only 1 clip, map directly
  if (plannedClips.length === 1) {
    filterChains.push(`${currentV}null[outv]`);
    if (audioMode === 'source') {
      filterChains.push(`${currentA}anull[outa]`);
    }
  }

  ffmpegArgs.push('-filter_complex', filterChains.join(';'));
  ffmpegArgs.push('-map', '[outv]');
  if (audioMode === 'source') {
    ffmpegArgs.push('-map', '[outa]');
  }

  ffmpegArgs.push(
    '-t', String(totalDuration),
    '-r', String(fps),
    '-c:v', 'libx264',
    '-threads', '2',
    '-preset', 'fast',
    '-crf', '19',
    '-pix_fmt', 'yuv420p'
  );

  if (audioMode === 'source') {
    ffmpegArgs.push(
      '-c:a', 'aac',
      '-b:a', '160k'
    );
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  ffmpegArgs.push('-movflags', '+faststart', outputPath);

  report({
    stage: 'executing',
    message: `正在使用 FFmpeg 渲染合成 ${plannedClips.length} 个镜头成片 (${totalDuration.toFixed(2)}s)`
  });

  await runner(ffmpegBin, ffmpegArgs, { timeout: 600000 });

  // Post-execution validation
  report({ stage: 'validating', message: '成片已生成，正在校验播放性与参数' });

  // Decode integrity check
  await runner(ffmpegBin, ['-nostdin', '-v', 'error', '-i', outputPath, '-f', 'null', '-'], { timeout: 120000 });

  const after = await probe(outputPath);
  const afterVideo = after.streams?.find(s => s.codec_type === 'video');
  const afterAudio = after.streams?.find(s => s.codec_type === 'audio');

  if (!afterVideo) {
    throw fail('成片解码检查失败：未找到有效视频流');
  }

  const actualDuration = Number(after.format?.duration);
  const tolerance=Math.max(1/fps,1024/48000)+0.002;
  if (!Number.isFinite(actualDuration) || actualDuration<=0 || Math.abs(actualDuration - totalDuration) > tolerance) {
    throw fail(`成片时长 (${actualDuration}s) 与帧网格计划 (${totalDuration}s) 不匹配`);
  }
  if(Number.isFinite(Number(afterVideo.nb_frames))&&Number(afterVideo.nb_frames)!==totalFrames)throw fail(`成片帧数 (${afterVideo.nb_frames}) 与计划 (${totalFrames}) 不匹配`);

  if (audioMode === 'none' && afterAudio) {
    throw fail('audio_mode 为 none 但成片中存在意外音轨');
  }
  if (audioMode === 'source' && !afterAudio) {
    throw fail('audio_mode 为 source 但成片中缺少音轨');
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
    timeline: plannedClips,
    audio_handling: audioHandling,
    total_duration: totalDuration,
    requested_duration: requested.totalDuration,
    total_frames: totalFrames,
    timestamp_quantization: 'cumulative_boundaries_to_nearest_output_frame',
    quality_status: 'review_required',
    quality_note: '多素材剪辑、转场、画幅 contain 对齐、音轨重采样与无声补齐已通过解码检查；艺术质感与分镜节奏需由 Codex / 人工核对。'
  };
}

module.exports = {
  id: 'local.video.compose-clips',
  title: '多素材视频剪辑合成原生执行器',
  description: '支持多个不同尺寸、帧率及有声/无声音视频素材的有序重剪，支持硬切与平滑淡化转场，采用 contain 补黑边对齐画幅，对齐 timebase 与采样率。',
  kind: 'video',
  component_id: 'media.ffmpeg',
  source: 'https://ffmpeg.org/ffmpeg-filters.html#xfade',
  inputs: ['input_path','sources','parameters'],
  defaults: {
    fps: 24,
    audio_mode: 'source'
  },
  executeNative: composeClips,
  validateSources,
  validateAndPlanTimeline,
  RESOURCE_LIMITS,
  parameter_schema: {
    type: 'object',
    properties: {
      clips: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            source: { type: 'integer', minimum: 0, title: '素材源数字索引' },
            source_in: { type: 'number', minimum: 0, title: '片段源入点秒数' },
            source_out: { type: 'number', minimum: 0, title: '片段源出点秒数' },
            transition: { type: 'string', enum: ['cut', 'fade'], default: 'cut', title: '转场方式' },
            transition_duration: { type: 'number', minimum: 0.01, maximum: 30, default: 0.5, title: '淡化时长秒数' }
          },
          required: ['source', 'source_in', 'source_out']
        },
        title: '剪辑片段序列'
      },
      width: { type: 'integer', minimum: 16, maximum: 4096, title: '目标宽度 (偶数)' },
      height: { type: 'integer', minimum: 16, maximum: 4096, title: '目标高度 (偶数)' },
      fps: { type: 'number', minimum: 1, maximum: 120, default: 24, title: '目标帧率' },
      audio_mode: { type: 'string', enum: ['source', 'none'], default: 'source', title: '音频处理模式' }
    }
  }
};
