'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');

const {
  PARAMETER_BOUNDS,
  INTEGER_KEYS,
  DEFAULTS,
  LIMITATIONS,
  PARAMETER_SCHEMA_MASK,
  PARAMETER_SCHEMA_REPLACE,
} = require('./videoForegroundManifest');

const {
  ForegroundTemporalRefiner,
} = require('./videoForegroundTemporal');

const {
  transformVideoFrames,
  createVideoFrameReader,
} = require('./videoForegroundStream');

const fail = (code, message) => Object.assign(new Error(message), { code });
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function runCommand(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), options.timeout || 120000);
    child.stdout.on('data', b => { stdout = (stdout + b).slice(-1024 * 1024); });
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-1024 * 1024); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if ((options.exitCodes || [0]).includes(code)) resolve({ stdout, stderr, code });
      else reject(fail('COMMAND_FAILED', `进程失败 (${code}): ${stderr.slice(-1500)}`));
    });
  });
}

async function probeMedia(ffprobe, file) {
  const args = ['-v', 'error'];
  args.push('-show_streams', '-show_format', '-of', 'json', file);
  const res = await runCommand(ffprobe, args);
  try {
    return JSON.parse(res.stdout);
  } catch (err) {
    throw fail('MEDIA_PROBE_FAILED', `ffprobe 解析媒体失败: ${err.message}`);
  }
}

function alphaDecoderArgs(probe) {
  const video = probe.streams?.find(stream => stream.codec_type === 'video');
  const alpha = Object.entries(video?.tags || {}).some(([key, value]) => key.toLowerCase() === 'alpha_mode' && String(value) === '1');
  if (!alpha) return [];
  if (video.codec_name === 'vp9') return ['-c:v', 'libvpx-vp9'];
  if (video.codec_name === 'vp8') return ['-c:v', 'libvpx'];
  return [];
}

function outputExtension(parameters) {
  return { mp4: 'mp4', mov_alpha: 'mov', webm_alpha: 'webm' }[parameters.output_format || 'mp4'];
}

function parseRate(str) {
  if (!str) return null;
  const parts = String(str).split('/').map(Number);
  if (parts.length === 2 && parts[1] > 0) return parts[0] / parts[1];
  const num = Number(str);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function parametersFor(raw = {}, isReplace = false) {
  const p = { ...DEFAULTS, ...raw };
  for (const [key, [min, max]] of Object.entries(PARAMETER_BOUNDS)) {
    if (p[key] == null) continue;
    const v = p[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max
      || (INTEGER_KEYS.has(key) && !Number.isInteger(v))) {
      throw fail('INVALID_PARAMETERS', `${key} 需为 ${min}–${max} 的${INTEGER_KEYS.has(key) ? '整数' : '数值'}`);
    }
  }

  if (!['u2netp', 'u2net'].includes(p.model)) throw fail('INVALID_PARAMETERS', 'model 仅支持 u2netp 或 u2net');
  if (!['auto', 'user_mask'].includes(p.route)) throw fail('INVALID_PARAMETERS', 'route 仅支持 auto 或 user_mask');
  if (typeof p.keep_source_alpha !== 'boolean') throw fail('INVALID_PARAMETERS', 'keep_source_alpha 需为布尔值');
  if (typeof p.transparent_bg !== 'boolean') throw fail('INVALID_PARAMETERS', 'transparent_bg 需为布尔值');

  if (!['mp4', 'mov_alpha', 'webm_alpha'].includes(p.output_format)) {
    throw fail('INVALID_PARAMETERS', 'output_format 仅支持 mp4, mov_alpha, webm_alpha');
  }
  if (isReplace && p.transparent_bg && p.output_format === 'mp4') {
    throw fail('INVALID_PARAMETERS', '透明背景需选择 mov_alpha 或 webm_alpha 输出格式');
  }

  if (p.mask_source != null && (!Number.isInteger(p.mask_source) || p.mask_source < 0)) {
    throw fail('INVALID_PARAMETERS', 'mask_source 必须是 sources 中的非负整数索引');
  }
  if (p.route === 'user_mask' && p.mask_source == null) {
    throw fail('INVALID_PARAMETERS', 'user_mask 路线需要指定 mask_source');
  }

  if (isReplace) {
    if (!p.transparent_bg) {
      if (p.bg_source == null || !Number.isInteger(p.bg_source) || p.bg_source < 0) {
        throw fail('INVALID_PARAMETERS', '非透明换背景视频需要指定 bg_source');
      }
    }
    if (!['cover', 'contain', 'fill'].includes(p.bg_mode)) {
      throw fail('INVALID_PARAMETERS', 'bg_mode 需为 cover, contain 或 fill');
    }
  }

  if (p.model_dir != null && typeof p.model_dir !== 'string') {
    throw fail('INVALID_PARAMETERS', 'model_dir 必须是目录路径字符串');
  }

  return p;
}

function sourceAt(sources, index, role) {
  if (!Number.isInteger(index) || !sources[index] || !sources[index].path) {
    throw fail('INVALID_SOURCES', `${role} 需要指向有效的 sources 数字索引`);
  }
  return sources[index].path;
}

function maskStats(mask) {
  if (!mask || !mask.length) throw fail('FOREGROUND_MASK_EMPTY', '主体蒙版为空');
  let sum = 0, sumSq = 0, min = 1, max = 0, above = 0;
  const len = mask.length;
  for (let i = 0; i < len; i++) {
    const v = mask[i] / 255;
    sum += v;
    sumSq += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
    if (mask[i] >= 16) above++;
  }
  const mean = sum / len;
  return {
    mean,
    std: Math.sqrt(Math.max(0, sumSq / len - mean * mean)),
    min,
    max,
    pixels: len,
    occupied: above / len,
  };
}

function classifyMask(stats, parameters, rawRange) {
  if (!stats || !stats.pixels) return { usable: false, unchanged: false, reason: 'invalid', code: 'FOREGROUND_MASK_INVALID', message: '主体蒙版为空' };
  if (parameters.route === 'user_mask') {
    return { usable: stats.max > 0, unchanged: false, reason: 'user_mask', review_required: true };
  }
  const span = rawRange && Number.isFinite(rawRange.max - rawRange.min) ? rawRange.max - rawRange.min : null;
  if (span != null && (span < 0.08 || rawRange.max < 0.12)) {
    return { usable: false, unchanged: true, reason: 'no_foreground', code: 'FOREGROUND_UNCHANGED', message: `模型响应过弱（span=${span.toFixed(4)}），按零对象处理` };
  }
  if (stats.max <= 1 / 255 || stats.mean < parameters.min_foreground_coverage) {
    return { usable: false, unchanged: true, reason: 'no_foreground', code: 'FOREGROUND_UNCHANGED', message: `未检出可用主体（mean=${stats.mean.toFixed(4)}）` };
  }
  if (stats.mean > parameters.max_foreground_coverage && stats.min > 0.2) {
    return { usable: true, unchanged: false, reason: 'near_full', review_required: true };
  }
  return { usable: true, unchanged: false, reason: 'ok', review_required: true };
}

function rembgNormalize(rgb, width, height) {
  const plane = width * height;
  if (rgb.length !== plane * 3) throw fail('FOREGROUND_INPUT_INVALID', 'RGB 缓冲尺寸不匹配');
  let peak = 1e-6;
  for (let i = 0; i < rgb.length; i++) if (rgb[i] > peak) peak = rgb[i];
  const out = new Float32Array(plane * 3);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let i = 0, p = 0; i < plane; i++, p += 3) {
    out[i] = (rgb[p] / peak - mean[0]) / std[0];
    out[plane + i] = (rgb[p + 1] / peak - mean[1]) / std[1];
    out[plane * 2 + i] = (rgb[p + 2] / peak - mean[2]) / std[2];
  }
  return out;
}

function decodeU2Net(output) {
  const data = output?.data;
  const dims = output?.dims || [];
  if (!data?.length || !dims.length) throw fail('FOREGROUND_MODEL_OUTPUT_INVALID', 'U2Net 输出为空');
  let spatial = data.length;
  let width = 320, height = 320;
  if (dims.length === 4) {
    height = dims[2]; width = dims[3]; spatial = width * height;
  } else if (dims.length === 3) {
    height = dims[1]; width = dims[2]; spatial = width * height;
  } else if (dims.length === 2) {
    height = dims[0]; width = dims[1]; spatial = width * height;
  }
  if (spatial <= 0 || data.length !== spatial) throw fail('FOREGROUND_MODEL_OUTPUT_INVALID', 'U2Net 输出布局不匹配');

  let min = Infinity, max = -Infinity;
  for (let i = 0; i < spatial; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) throw fail('FOREGROUND_MODEL_OUTPUT_INVALID', 'U2Net 输出含无效数值');
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  const mask = Buffer.alloc(spatial);
  if (!(span > 0) || !Number.isFinite(span)) return { mask, width, height, min, max };
  for (let i = 0; i < spatial; i++) {
    mask[i] = clamp(Math.round(((data[i] - min) / span) * 255), 0, 255);
  }
  return { mask, width, height, min, max };
}

async function upsampleGray(sharp, gray, srcW, srcH, width, height) {
  const out = Buffer.from(await sharp(gray, { raw: { width: srcW, height: srcH, channels: 1 } })
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .toColourspace('b-w')
    .raw({ depth: 'uchar' })
    .toBuffer());
  if (out.length !== width * height) throw fail('FOREGROUND_MASK_INVALID', `蒙版尺寸异常：期望 ${width * height}，实际 ${out.length}`);
  return out;
}

function resolveModelFile(componentDir, parameters) {
  const filename = parameters.model === 'u2net' ? 'u2net.onnx' : 'u2netp.onnx';
  const dirs = [];
  if (parameters.model_dir) dirs.push(parameters.model_dir);
  if (process.env.YINZI_FOREGROUND_MODEL_DIR) dirs.push(process.env.YINZI_FOREGROUND_MODEL_DIR);
  if (componentDir) dirs.push(path.join(componentDir, 'models'), componentDir);

  for (const d of dirs.filter(Boolean)) {
    const resolved = path.resolve(d);
    const file = path.join(resolved, filename);
    if (fs.existsSync(file)) {
      return { directory: resolved, onnx: file, model: parameters.model };
    }
  }
  throw fail('FOREGROUND_MODEL_MISSING', `主体分割模型尚未准备（需要 ${filename}）。未把用户蒙版当作自动分割成功。`);
}

function compositeCutoutToRgba(fgRgba, bgRgba, mask, width, height, keepSourceAlpha = true, transparentBg = false) {
  const n = width * height;
  const out = Buffer.alloc(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const srcA = keepSourceAlpha ? (fgRgba[p + 3] / 255) : 1;
    const alpha = (mask[i] / 255) * srcA;

    if (transparentBg) {
      // Output RGBA with alpha channel preserved
      out[p] = fgRgba[p];
      out[p + 1] = fgRgba[p + 1];
      out[p + 2] = fgRgba[p + 2];
      out[p + 3] = clamp(Math.round(alpha * 255), 0, 255);
    } else {
      // Blend over background
      const invAlpha = 1 - alpha;
      out[p] = clamp(Math.round(fgRgba[p] * alpha + bgRgba[p] * invAlpha), 0, 255);
      out[p + 1] = clamp(Math.round(fgRgba[p + 1] * alpha + bgRgba[p + 1] * invAlpha), 0, 255);
      out[p + 2] = clamp(Math.round(fgRgba[p + 2] * alpha + bgRgba[p + 2] * invAlpha), 0, 255);
      out[p + 3] = 255; // Full opaque composite
    }
  }
  return out;
}

function maskToRgbaGray(mask, width, height) {
  const n = width * height;
  const out = Buffer.alloc(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = mask[i];
    out[p] = v;
    out[p + 1] = v;
    out[p + 2] = v;
    out[p + 3] = 255;
  }
  return out;
}

async function muxSoundtrack({ ffmpeg, videoFile, audioFile, outputFile, duration, offset = 0 }) {
  const args = ['-nostdin', '-y', '-v', 'error', '-i', videoFile];
  if (audioFile) {
    args.push('-i', audioFile, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy');
    // Check if audio needs AAC or PCM
    if (outputFile.endsWith('.mov')) {
      args.push('-c:a', 'pcm_s16le');
    } else if (outputFile.endsWith('.webm')) {
      args.push('-c:a', 'libopus');
    } else {
      args.push('-c:a', 'aac');
    }
    const filters = ['asetpts=PTS-STARTPTS'];
    if (offset > 0) filters.push(`adelay=${Math.round(offset * 1000)}:all=1`);
    else if (offset < 0) filters.push(`atrim=start=${-offset}`, 'asetpts=PTS-STARTPTS');
    filters.push('apad', `atrim=duration=${duration}`);
    args.push('-af', filters.join(','));
  } else {
    args.push('-map', '0:v:0', '-c:v', 'copy');
  }
  args.push('-t', String(duration));
  if (outputFile.endsWith('.mp4') || outputFile.endsWith('.mov')) {
    args.push('-movflags', '+faststart');
  }
  args.push(outputFile);
  await runCommand(ffmpeg, args, { timeout: 180000 });
}

/**
 * Execute Video Foreground Processing (Mask or Replace)
 */
async function executeVideoForeground({
  mode = 'mask', // 'mask' | 'replace'
  inputPath,
  outputPath,
  parameters: raw = {},
  components = {},
  sources = [],
  report = () => {},
  ensureComponent,
  signal,
}) {
  const isReplace = mode === 'replace';
  const p = parametersFor(raw, isReplace);

  // Auto-acquire components if ensureComponent provided
  if (ensureComponent) {
    if (!components['media.ffmpeg']) components['media.ffmpeg'] = await ensureComponent('media.ffmpeg');
    if (!components['media.sharp']) components['media.sharp'] = await ensureComponent('media.sharp');
    if (p.route === 'auto' && !components['vision.foreground-seg']) {
      components['vision.foreground-seg'] = await ensureComponent('vision.foreground-seg');
    }
  }

  const ffmpeg = components['media.ffmpeg']?.executables?.ffmpeg || 'ffmpeg';
  const ffprobe = components['media.ffmpeg']?.executables?.ffprobe || 'ffprobe';

  let sharp;
  if (components['media.sharp']?.directory) {
    sharp = createRequire(path.join(components['media.sharp'].directory, 'package.json'))('sharp');
  } else {
    try {
      sharp = require('sharp');
    } catch {
      throw fail('DEPENDENCY_MISSING', '未找到 sharp 组件，请在 components["media.sharp"] 提供已安装目录');
    }
  }
  sharp.cache(false);
  sharp.concurrency(2);

  const before = await probeMedia(ffprobe, inputPath);
  const video = before.streams?.find(s => s.codec_type === 'video');
  const audio = before.streams?.find(s => s.codec_type === 'audio');

  if (!video) throw fail('INPUT_MISSING', '输入没有视频轨');
  const duration = Number(video.duration || before.format?.duration);
  if (!(duration > 0)) throw fail('INPUT_MISSING', '无法读取视频时长');

  const fps = parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate);
  if (!Number.isFinite(fps) || fps <= 0) throw fail('INPUT_TIMING', '无法确定视频帧率');

  const list = sources.length ? sources : [{ path: inputPath }];
  const workDir = fs.mkdtempSync(path.join(path.dirname(outputPath), 'fg-stream-'));

  const started = Date.now();
  const refiner = new ForegroundTemporalRefiner({
    temporalSmooth: p.temporal_smooth,
    motionThresholdRgb: p.motion_threshold,
    motionDecayFactor: p.motion_decay,
    featherPx: p.feather_px,
    strength: p.strength,
    threshold: p.threshold,
  });

  let session = null;
  let ort = null;
  let modelInfo = null;
  let userMaskStaticBuffer = null;
  let userMaskVideoReader = null;
  let bgStaticBuffer = null;
  let bgVideoReader = null;

  try {
    // Get actual width and height from first frame
    const sampleFrame = path.join(workDir, 'geometry.png');
    await runCommand(ffmpeg, ['-nostdin', '-y', '-v', 'error', '-i', inputPath, '-frames:v', '1', sampleFrame]);
    const sampleMeta = await sharp(sampleFrame).metadata();
    const width = sampleMeta.width;
    const height = sampleMeta.height;
    fs.unlinkSync(sampleFrame);

    if (p.route === 'user_mask') {
      const userMaskPath = sourceAt(list, p.mask_source, 'mask_source');
      const maskProbe = await probeMedia(ffprobe, userMaskPath);
      const isMaskVideo = Boolean(maskProbe.streams?.some(s => s.codec_type === 'video' && Number(s.duration || maskProbe.format?.duration) > 0));

      if (isMaskVideo) {
        // Stream mask video synchronously frame-by-frame
        userMaskVideoReader = createVideoFrameReader({
          ffmpeg,
          inputPath: userMaskPath,
          width,
          height,
          fps,
          duration,
          pixFmt: 'gray',
          decoderArgs: alphaDecoderArgs(maskProbe),
          signal,
        });
      } else {
        // Static image mask: load once, resize, luminance extract
        const rawMask = await sharp(userMaskPath, { failOn: 'error', limitInputPixels: p.max_pixels })
          .autoOrient()
          .resize(width, height, { fit: 'fill' })
          .ensureAlpha()
          .raw()
          .toBuffer();
        userMaskStaticBuffer = Buffer.alloc(width * height);
        for (let i = 0, q = 0; i < userMaskStaticBuffer.length; i++, q += 4) {
          userMaskStaticBuffer[i] = Math.round((0.2126 * rawMask[q] + 0.7152 * rawMask[q + 1] + 0.0722 * rawMask[q + 2]) * (rawMask[q + 3] / 255));
        }
      }
    } else {
      // Auto route: Load ONNX model
      const segCompDir = components['vision.foreground-seg']?.directory;
      if (!segCompDir) {
        throw fail('DEPENDENCY_MISSING', '未指定 components["vision.foreground-seg"] 且为 auto 路线');
      }
      const located = resolveModelFile(segCompDir, p);
      ort = createRequire(path.join(segCompDir, 'package.json'))('onnxruntime-node');
      session = await ort.InferenceSession.create(located.onnx, {
        executionProviders: ['cpu'],
        intraOpNumThreads: 2,
        interOpNumThreads: 1,
      });
      modelInfo = { onnx: located.onnx, model: located.model };
    }

    if (isReplace && !p.transparent_bg) {
      const bgPath = sourceAt(list, p.bg_source, 'bg_source');
      const bgProbe = await probeMedia(ffprobe, bgPath);
      const isBgVideo = Boolean(bgProbe.streams?.some(s => s.codec_type === 'video' && Number(s.duration || bgProbe.format?.duration) > 0));

      if (isBgVideo) {
        bgVideoReader = createVideoFrameReader({
          ffmpeg,
          inputPath: bgPath,
          width,
          height,
          fps,
          duration,
          pixFmt: 'rgba',
          decoderArgs: alphaDecoderArgs(bgProbe),
          signal,
        });
      } else {
        bgStaticBuffer = await sharp(bgPath, { failOn: 'error', limitInputPixels: p.max_pixels })
          .autoOrient()
          .resize(width, height, { fit: p.bg_mode })
          .ensureAlpha()
          .toColourspace('srgb')
          .raw()
          .toBuffer();
      }
    }

    // Determine output file container and intermediate format
    let container = 'mp4';
    let interimExt = '.mp4';
    if (p.output_format === 'mov_alpha' || outputPath.endsWith('.mov')) {
      container = 'mov_alpha';
      interimExt = '.mov';
    } else if (p.output_format === 'webm_alpha' || outputPath.endsWith('.webm')) {
      container = 'webm_alpha';
      interimExt = '.webm';
    }

    const tempProcessedVideo = path.join(workDir, `video-stream${interimExt}`);
    let totalCoverage = 0;
    let firstCoverage = null;
    let lastCoverage = 0;
    let firstFrameMask = null;
    let sawForeground = false;
    let rawRange = null;

    const streamResult = await transformVideoFrames({
      ffmpeg,
      inputPath,
      outputPath: tempProcessedVideo,
      width,
      height,
      fps,
      duration,
      signal,
      container,
      decoderArgs: alphaDecoderArgs(before),
      transform: async (currentRgba, frameIndex) => {
        let frameMask;
        if (p.route === 'user_mask') {
          if (userMaskVideoReader) {
            frameMask = await userMaskVideoReader.nextFrame();
            if (!frameMask) frameMask = Buffer.alloc(width * height, 0);
          } else {
            frameMask = userMaskStaticBuffer;
          }
        } else {
          // Auto segmentation via U2Net
          const size = p.inference_size;
          const rgb = await sharp(currentRgba, { raw: { width, height, channels: 4 } })
            .flatten({ background: '#000000' })
            .resize(size, size, { fit: 'fill', kernel: 'lanczos3' })
            .removeAlpha()
            .toColourspace('srgb')
            .raw()
            .toBuffer();

          const normInput = rembgNormalize(rgb, size, size);
          const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', normInput, [1, 3, size, size]) };
          const outputs = await session.run(feeds);
          const fused = outputs['1959'] || outputs[session.outputNames[0]];
          const decoded = decodeU2Net(fused);
          rawRange = { min: decoded.min, max: decoded.max };
          frameMask = await upsampleGray(sharp, decoded.mask, decoded.width, decoded.height, width, height);
        }

        // Apply motion-aware temporal smoothing
        const refinedMask = refiner.next(currentRgba, frameMask, width, height);
        const stats = maskStats(refinedMask);
        const verdict = classifyMask(stats, p, rawRange);

        let finalMask = refinedMask;
        // If unchanged/zero-object detected, physical mask must be zeroed out
        if (verdict.unchanged) {
          finalMask = Buffer.alloc(refinedMask.length, 0);
          totalCoverage += 0;
          if (firstCoverage == null) {
            firstCoverage = 0;
            firstFrameMask = Buffer.from(finalMask);
          }
          lastCoverage = 0;
        } else {
          totalCoverage += stats.mean;
          if (firstCoverage == null) {
            firstCoverage = stats.mean;
            firstFrameMask = Buffer.from(refinedMask);
          }
          lastCoverage = stats.mean;
          if (verdict.usable) {
            sawForeground = true;
          }
        }

        if (frameIndex % Math.max(1, Math.round(fps / 2)) === 0) {
          report({
            stage: 'executing',
            message: `连续处理主体第 ${frameIndex + 1} 帧`,
            completed: frameIndex + 1,
          });
        }

        // Generate frame output
        if (mode === 'mask') {
          // Output mask as grayscale RGBA
          return maskToRgbaGray(finalMask, width, height);
        } else {
          // Replace mode
          let currentBg = bgStaticBuffer;
          if (bgVideoReader) {
            currentBg = await bgVideoReader.nextFrame();
            if (!currentBg) currentBg = bgStaticBuffer || currentRgba;
          }

          if (verdict.usable) {
            return compositeCutoutToRgba(currentRgba, currentBg, finalMask, width, height, p.keep_source_alpha, p.transparent_bg);
          } else {
            // Unchanged zero-object: return background, transparent empty frame, or original frame
            if (p.transparent_bg) {
              return Buffer.alloc(width * height * 4, 0); // Completely transparent
            } else {
              return currentBg || currentRgba;
            }
          }
        }
      },
    });

    // Save first frame mask as visual preview asset
    const maskThumbPath = path.join(path.dirname(outputPath), `${path.basename(outputPath, path.extname(outputPath))}-first-mask.png`);
    if (firstFrameMask) {
      await sharp(firstFrameMask, { raw: { width, height, channels: 1 } }).png().toFile(maskThumbPath);
    }

    // Mux soundtrack with proper PTS and audio offsets
    const videoStart = Number(video.start_time) || 0;
    const audioStart = Number(audio?.start_time) || 0;
    const offset = audioStart - videoStart;

    await muxSoundtrack({
      ffmpeg,
      videoFile: tempProcessedVideo,
      audioFile: audio ? inputPath : null,
      outputFile: outputPath,
      duration,
      offset,
    });

    // Verify output stream and timing
    const after = await probeMedia(ffprobe, outputPath);
    const outVideo = after.streams?.find(s => s.codec_type === 'video');
    const outAudio = after.streams?.find(s => s.codec_type === 'audio');

    if (!outVideo || (audio && !outAudio)) {
      throw fail('OUTPUT_UNPLAYABLE', '输出视频缺少预期的视音频轨道');
    }

    const outputDuration = Number(outVideo.duration || after.format?.duration);
    if (Math.abs(outputDuration - duration) > Math.max(1 / fps + 0.02, 0.05)) {
      throw fail('OUTPUT_TIMING', `输出时长与原视频不匹配: 原时长 ${duration}, 输出时长 ${outputDuration}`);
    }

    const isUnchanged = !sawForeground && p.route === 'auto';
    const avgCoverage = isUnchanged ? 0 : (streamResult.frame_count > 0 ? totalCoverage / streamResult.frame_count : 0);

    const qualityStatus = isUnchanged ? 'unchanged' : 'review_required';
    const qualityNote = isUnchanged
      ? '未检测到可用主体（全流程零对象），已按未改变场景清零输出，不是模型损坏。'
      : p.route === 'auto'
      ? '已应用本地 U2Net 显著性主体分割与运动感知自适应平滑；请核对边缘清晰度、发丝、孔洞及运动连续性。'
      : '使用用户显式蒙版渲染，不代表自动识别能力。';

    const result = {
      status: isUnchanged ? 'unchanged' : 'succeeded',
      mode,
      route: p.route,
      output_format: p.output_format,
      transparent_bg: p.transparent_bg,
      quality_status: qualityStatus,
      quality_note: qualityNote,
      limitations: LIMITATIONS,
      before: {
        width,
        height,
        duration,
        fps,
        has_audio: Boolean(audio),
      },
      after: {
        width,
        height,
        duration: outputDuration,
        has_audio: Boolean(outAudio),
        codec_name: outVideo.codec_name,
        pix_fmt: outVideo.pix_fmt,
      },
      frame_count: streamResult.frame_count,
      processing: 'streaming',
      model: modelInfo,
      temporal_filter: {
        type: 'motion_aware_adaptive',
        temporal_smooth: p.temporal_smooth,
        motion_threshold: p.motion_threshold,
        motion_decay: p.motion_decay,
        feather_px: p.feather_px,
      },
      mask_coverage: {
        mean: isUnchanged ? 0 : avgCoverage,
        first: isUnchanged ? 0 : firstCoverage,
        last: isUnchanged ? 0 : lastCoverage,
      },
      processing_seconds: (Date.now() - started) / 1000,
      assets: [
        {
          file: path.basename(maskThumbPath),
          type: 'image',
          role: 'foreground_first_mask',
          title: '首帧主体蒙版',
        },
      ],
    };

    const receiptPath = path.join(path.dirname(outputPath), `${path.basename(outputPath, path.extname(outputPath))}-receipt.json`);
    fs.writeFileSync(receiptPath, JSON.stringify(result, null, 2));
    result.assets.push({
      file: path.basename(receiptPath),
      type: 'document',
      role: 'execution_receipt',
      title: '主体连续处理回执',
    });

    return result;
  } finally {
    await Promise.all([userMaskVideoReader?.close(), bgVideoReader?.close()]);
    refiner.reset();
    await session?.release?.();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

const videoForegroundMaskOperation = {
  id: 'local.video.foreground-mask',
  title: '视频主体蒙版流式提取',
  kind: 'video',
  description: '逐帧流式分割提取视频前景主体灰度蒙版，运动感知时域平滑，保持原声音视频时序与帧数。',
  description_zh: '逐帧流式分割提取视频前景主体灰度蒙版，运动感知时域平滑，保持原声音视频时序与帧数。',
  component_id: 'media.ffmpeg',
  additional_components: ['media.sharp'],
  resource_group: 'cpu-memory-heavy',
  output_extension: 'mp4',
  outputExtension,
  inputs: ['input_path', 'sources', 'parameters'],
  executeNative: context => executeVideoForeground({ ...context, mode: 'mask' }),
  validateParameters: p => parametersFor(p, false),
  defaults: DEFAULTS,
  parameter_schema: PARAMETER_SCHEMA_MASK,
};

const videoForegroundReplaceOperation = {
  id: 'local.video.foreground-replace',
  title: '视频主体连续抠像与背景合成',
  kind: 'video',
  description: '视频主体逐帧连续抠图并与指定背景图/视频融合，运动自适应边缘平滑，原声精确对齐。',
  description_zh: '视频主体逐帧连续抠图并与指定背景图/视频融合，运动自适应边缘平滑，原声精确对齐。',
  component_id: 'media.ffmpeg',
  additional_components: ['media.sharp'],
  resource_group: 'cpu-memory-heavy',
  output_extension: 'mp4',
  outputExtension,
  inputs: ['input_path', 'sources', 'parameters'],
  executeNative: context => executeVideoForeground({ ...context, mode: 'replace' }),
  validateParameters: p => parametersFor(p, true),
  defaults: DEFAULTS,
  parameter_schema: PARAMETER_SCHEMA_REPLACE,
};

module.exports = {
  videoForegroundMaskOperation,
  videoForegroundReplaceOperation,
  executeVideoForeground,
  parametersFor,
  maskStats,
  classifyMask,
  decodeU2Net,
  rembgNormalize,
  resolveModelFile,
  alphaDecoderArgs,
  probeMedia,
  LIMITATIONS,
};
