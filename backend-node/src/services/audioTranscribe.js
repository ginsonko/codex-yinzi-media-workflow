'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const fail = (code, message) => Object.assign(new Error(message), { code });

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(fail('PROCESS_TIMEOUT', `执行超时 (${options.timeout || 60000}ms): ${executable}`));
    }, options.timeout || 60000);

    child.stdout.on('data', b => {
      stdout = (stdout + b).slice(-2 * 1024 * 1024);
      options.onOutput?.(String(b));
    });
    child.stderr.on('data', b => {
      stderr = (stderr + b).slice(-2 * 1024 * 1024);
      options.onErrorOutput?.(String(b));
    });
    child.on('error', e => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if ((options.exitCodes || [0]).includes(code)) {
        resolve({ stdout, stderr, code });
      } else {
        reject(fail('PROCESS_FAILED', `进程退出码非零 (${code}): ${stderr.slice(-1500)}`));
      }
    });
  });
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + Math.random().toString(36).slice(2) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function parseTimeMs(timeStr) {
  // Supports "00:01:23,456" or "00:01:23.456"
  const m = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/.exec((timeStr || '').trim());
  if (!m || Number(m[2]) >= 60 || Number(m[3]) >= 60) return NaN;
  return Number(m[1]) * 3600000 + Number(m[2]) * 60000 + Number(m[3]) * 1000 + Number(m[4]);
}

function formatSrtTime(ms) {
  const safeMs = Math.max(0, Math.round(ms));
  const h = Math.floor(safeMs / 3600000);
  const m = Math.floor((safeMs % 3600000) / 60000);
  const s = Math.floor((safeMs % 60000) / 1000);
  const millis = safeMs % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function formatVttTime(ms) {
  const safeMs = Math.max(0, Math.round(ms));
  const h = Math.floor(safeMs / 3600000);
  const m = Math.floor((safeMs % 3600000) / 60000);
  const s = Math.floor((safeMs % 60000) / 1000);
  const millis = safeMs % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function parseBoolean(val, fieldName) {
  if (val === undefined || val === null) return false;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') {
    if (val === 1) return true;
    if (val === 0) return false;
  }
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
  }
  throw fail('AUDIO_TRANSCRIBE_INVALID_TRANSLATE', `${fieldName} 必须是有效布尔值 (true/false) 或布尔字面量`);
}

function settings(p = {}) {
  const model = String(p.model || 'base').toLowerCase().trim();
  if (!['base', 'tiny'].includes(model)) {
    throw fail('AUDIO_TRANSCRIBE_INVALID_MODEL', `模型类型不支持: ${model}，目前支持 'base' 或 'tiny'`);
  }
  const language = p.language != null ? String(p.language).trim() : 'zh';
  if (!language) {
    throw fail('AUDIO_TRANSCRIBE_INVALID_LANGUAGE', 'language 语言代码不能为空 (支持如 zh, en, ja, 或 auto 自动探测)');
  }
  const threads = p.threads != null ? Number(p.threads) : Math.max(1, Math.min(4, os.cpus().length >> 1));
  if (!Number.isInteger(threads) || threads < 1 || threads > 32) {
    throw fail('AUDIO_TRANSCRIBE_INVALID_THREADS', '线程数应在 1 到 32 之间的整数');
  }
  const max_duration = p.max_duration != null ? Number(p.max_duration) : 7200;
  if (!Number.isFinite(max_duration) || max_duration < 1 || max_duration > 86400) {
    throw fail('AUDIO_TRANSCRIBE_INVALID_DURATION', 'max_duration 应在 1 到 86400 秒之间');
  }
  const timeline_offset_seconds = p.timeline_offset_seconds != null ? Number(p.timeline_offset_seconds) : 0;
  if (!Number.isFinite(timeline_offset_seconds)) {
    throw fail('AUDIO_TRANSCRIBE_INVALID_OFFSET', 'timeline_offset_seconds 应为有效浮点数');
  }

  // silence_threshold_db: 支持配置门限，或传 null / false / <= -120 关闭静音过滤
  let silence_threshold_db = -50;
  if (p.silence_threshold_db === null || p.silence_threshold_db === false || p.silence_threshold_db === 'disabled') {
    silence_threshold_db = null;
  } else if (p.silence_threshold_db != null) {
    const st = Number(p.silence_threshold_db);
    if (!Number.isFinite(st) || st > 0 || st < -120) {
      throw fail('AUDIO_TRANSCRIBE_INVALID_SILENCE_THOLD', 'silence_threshold_db 应在 -120 到 0 dB 之间，或设为 null 关闭静音门限');
    }
    silence_threshold_db = st <= -120 ? null : st;
  }

  const translate = parseBoolean(p.translate, 'translate');

  return {
    model,
    language,
    threads,
    max_duration,
    timeline_offset_seconds,
    silence_threshold_db,
    translate
  };
}

/**
 * 校验并规整字幕片段时间轴，防御负偏移与零长 cue
 */
function normalizeSegments(rawTrans, offsetMs) {
  if (!Array.isArray(rawTrans) || !Number.isFinite(offsetMs)) throw fail('AUDIO_TRANSCRIBE_INVALID_TIMESTAMPS', '转写结果缺少有效的字幕列表或时间偏移');
  const segments = [];
  let id = 1;
  let previousEnd = -Infinity;
  for (let i = 0; i < rawTrans.length; i++) {
    const item = rawTrans[i];
    if (!item || typeof item.text !== 'string') throw fail('AUDIO_TRANSCRIBE_OUTPUT_PARSE_FAILED', '转写字幕条目缺少有效文本');
    const text = item.text.trim();
    if (!text) continue;

    const rawFrom = item.offsets?.from != null ? item.offsets.from : parseTimeMs(item.timestamps?.from);
    const rawTo = item.offsets?.to != null ? item.offsets.to : parseTimeMs(item.timestamps?.to);

    if (!Number.isFinite(rawFrom) || !Number.isFinite(rawTo) || rawTo <= rawFrom || rawFrom < previousEnd) throw fail('AUDIO_TRANSCRIBE_INVALID_TIMESTAMPS', '字幕原始时间戳无效、重叠或不递增；已保留原始识别文件供恢复');
    previousEnd = rawTo;

    const fromMs = rawFrom + offsetMs;
    const toMs = rawTo + offsetMs;

    // 若字幕在时间轴原点 (0s) 之前完全结束，剔除该段，杜绝产生 00:00:00,000 --> 00:00:00,000 零长无效 cue
    if (toMs <= 0) continue;

    // 若字幕跨越 0 点，截断起始时间至 0，保持 start < end
    const cueStartMs = Math.max(0, fromMs);
    const cueEndMs = toMs;
    if (Math.round(cueEndMs) <= Math.round(cueStartMs)) continue;

    segments.push({
      id: id++,
      start_seconds: Math.round(cueStartMs) / 1000,
      end_seconds: Math.round(cueEndMs) / 1000,
      start_ms: Math.round(cueStartMs),
      end_ms: Math.round(cueEndMs),
      text
    });
  }
  return segments;
}

/**
 * 核心执行函数，遵循 executeNative 签名
 */
async function executeNative({ inputPath, outputPath, parameters = {}, components, report = () => {} }) {
  const p = settings(parameters);
  const ffmpegBins = components['media.ffmpeg']?.executables;
  if (!ffmpegBins?.ffmpeg || !ffmpegBins?.ffprobe) {
    throw fail('FFMPEG_MISSING', '缺少 media.ffmpeg 组件依赖，无法处理音频输入');
  }
  const whisperBins = components['media.whisper']?.executables;
  if (!whisperBins?.['whisper-cli']) {
    throw fail('WHISPER_MISSING', '缺少 media.whisper 组件依赖，无法执行离线语音识别');
  }

  report({ stage: 'inspecting_audio', message: '正在检查音频格式与音轨流' });

  // 1. FFprobe 格式探测
  let probeRaw;
  try {
    probeRaw = (await run(ffmpegBins.ffprobe, [
      '-v', 'error',
      '-show_streams',
      '-show_format',
      '-of', 'json',
      inputPath
    ], { timeout: 30000 })).stdout;
  } catch (err) {
    throw fail('AUDIO_TRANSCRIBE_CORRUPTED', `输入文件损坏或无法读取格式: ${err.message}`);
  }

  let probe;
  try {
    probe = JSON.parse(probeRaw);
  } catch {
    throw fail('AUDIO_TRANSCRIBE_CORRUPTED', 'FFprobe 输出解析失败');
  }

  const audioStream = probe.streams?.find(s => s.codec_type === 'audio');
  if (!audioStream) {
    throw fail('AUDIO_TRANSCRIBE_NO_AUDIO', '输入文件没有包含任何音轨');
  }

  let duration = Number(audioStream.duration) || 0;
  if (duration > p.max_duration) {
    throw fail('AUDIO_TRANSCRIBE_LIMIT', `音频时长 (${duration.toFixed(1)}s) 超出最大处理上限 (${p.max_duration}s)`);
  }

  // 视频原点与相对音轨偏移计算：
  // 当存在视频流时，成片播放时间原点（0s）与主视频流对齐；
  // 音轨相对视频的延迟为 audio_start - video_start。
  // 纯音频文件相对延迟为 0。
  const videoStream = probe.streams?.find(s => s.codec_type === 'video');
  let relativeAudioDelay = 0;
  if (videoStream) {
    const vStart = Number.isFinite(Number(videoStream.start_time))
      ? Number(videoStream.start_time)
      : (Number.isFinite(Number(probe.format?.start_time)) ? Number(probe.format.start_time) : 0);
    const aStart = Number.isFinite(Number(audioStream.start_time))
      ? Number(audioStream.start_time)
      : vStart;
    relativeAudioDelay = aStart - vStart;
  }
  const effectiveOffset = p.timeline_offset_seconds + relativeAudioDelay;

  // 2. 音频预处理：提取单声道 16000Hz PCM WAV 并计算音量 (volumedetect)
  const workDir = path.dirname(outputPath);
  fs.mkdirSync(workDir, { recursive: true });
  const tempWav = path.join(workDir, `resampled-${Math.random().toString(36).slice(2)}.wav`);

  report({ stage: 'preprocessing_audio', message: '正在重采样为 16kHz 单声道并检测音量' });

  let volumeOutput = '';
  try {
    const res = await run(ffmpegBins.ffmpeg, [
      '-nostdin', '-y',
      '-threads', '2',
      '-protocol_whitelist', 'file,pipe',
      '-i', inputPath,
      '-vn',
      '-map', '0:a:0',
      '-t', String(p.max_duration + 0.25),
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      '-af', 'asetpts=PTS-STARTPTS,aresample=16000:async=1:first_pts=0,volumedetect',
      tempWav
    ], {
      timeout: 180000,
      exitCodes: [0]
    });
    volumeOutput = res.stderr || '';
  } catch (err) {
    try { if (fs.existsSync(tempWav)) fs.unlinkSync(tempWav); } catch {}
    throw fail('AUDIO_PREPROCESS_FAILED', `音频提取重采样失败: ${err.message}`);
  }

  // 分析 volumedetect 结果
  try {
    const decoded = JSON.parse((await run(ffmpegBins.ffprobe, ['-v', 'error', '-show_format', '-of', 'json', tempWav], { timeout: 30000 })).stdout);
    duration = Number(decoded.format?.duration);
    if (!(duration > 0)) throw fail('AUDIO_TRANSCRIBE_CORRUPTED', '提取音轨没有有效时长');
    if (duration > p.max_duration + 0.001) throw fail('AUDIO_TRANSCRIBE_LIMIT', '音轨超过最大处理时长，请分段处理');
  } catch (error) { try { fs.unlinkSync(tempWav); } catch {} throw error; }
  const maxVolMatch = /max_volume:\s*(-?\d+(\.\d+)?)\s*dB/i.exec(volumeOutput);
  const meanVolMatch = /mean_volume:\s*(-?\d+(\.\d+)?)\s*dB/i.exec(volumeOutput);
  const maxVolume = maxVolMatch ? Number(maxVolMatch[1]) : null;
  const meanVolume = meanVolMatch ? Number(meanVolMatch[1]) : null;

  const isSilent = p.silence_threshold_db !== null && maxVolume !== null && maxVolume <= p.silence_threshold_db;

  // 派生文件路径
  const baseName = outputPath.replace(/\.[^.]+$/, '');
  const txtPath = baseName + '.txt';
  const srtPath = baseName + '.srt';
  const vttPath = baseName + '.vtt';

  if (isSilent) {
    // 静音段治理：抑制纯静音或底噪下的幻觉字幕生成，输出空字幕
    try { if (fs.existsSync(tempWav)) fs.unlinkSync(tempWav); } catch {}
    const emptyDocument = {
      schema_version: 1,
      method: 'whisper_cpp_cpu',
      model_selected: p.model,
      language: p.language,
      detected_language: null,
      duration_seconds: duration,
      timeline_offset_seconds: effectiveOffset,
      relative_audio_delay_seconds: relativeAudioDelay,
      volume_stats: { max_volume_db: maxVolume, mean_volume_db: meanVolume },
      is_silent: true,
      text: '',
      segments: [],
      parameters: p
    };
    writeJson(outputPath, emptyDocument);
    fs.writeFileSync(txtPath, '', 'utf8');
    fs.writeFileSync(srtPath, '', 'utf8');
    fs.writeFileSync(vttPath, 'WEBVTT\n\n', 'utf8');

    return {
      before: { has_audio: true, duration, relative_audio_delay: relativeAudioDelay },
      after: { segment_count: 0, text_length: 0, is_silent: true },
      quality_status: 'review_required',
      quality_note: `音频最大音量 (${maxVolume} dB) 低于静音门限 (${p.silence_threshold_db} dB)，已抑制字幕生成；若包含微弱人声可调低或关闭门限。`,
      assets: [
        { file: path.basename(txtPath), type: 'text', role: 'transcription_txt', title: '识别文本全文' },
        { file: path.basename(srtPath), type: 'subtitle', role: 'subtitles_srt', title: 'SubRip 字幕文件' },
        { file: path.basename(vttPath), type: 'subtitle', role: 'subtitles_vtt', title: 'WebVTT 字幕文件' }
      ]
    };
  }

  // 3. 执行 whisper.cpp 推理
  const whisperDir = path.dirname(whisperBins['whisper-cli']);
  const modelFile = path.resolve(whisperDir, '..', 'models', `ggml-${p.model}.bin`);
  if (!fs.existsSync(modelFile)) {
    try { if (fs.existsSync(tempWav)) fs.unlinkSync(tempWav); } catch {}
    throw fail('MODEL_NOT_FOUND', `找不到对应的 GGML 模型文件: ${modelFile}`);
  }

  const whisperOutputBase = path.join(workDir, `whisper-${Math.random().toString(36).slice(2)}`);

  const whisperArgs = [
    '-m', modelFile,
    '-f', tempWav,
    '-t', String(p.threads),
    '-otxt',
    '-osrt',
    '-ovtt',
    '-oj',
    '-of', whisperOutputBase
  ];

  // 修复 Issue 1: 无论具体语言还是 'auto'，都必须显式传 -l 参数
  if (p.language) {
    whisperArgs.push('-l', p.language);
  }
  if (p.translate) {
    whisperArgs.push('-tr');
  }

  report({ stage: 'transcribing', message: `正在使用 CPU 推理进行离线转写 (模型: ${p.model}, 语言: ${p.language}, 线程: ${p.threads})` });

  try {
    await run(whisperBins['whisper-cli'], whisperArgs, {
      cwd: whisperDir,
      timeout: Math.max(120000, Math.ceil(duration * 2000))
    });
  } catch (err) {
    throw fail('WHISPER_TRANSCRIBE_FAILED', `Whisper CPU 推理失败: ${err.message}`);
  } finally {
    try { if (fs.existsSync(tempWav)) fs.unlinkSync(tempWav); } catch {}
  }

  // 4. 解析与时间轴偏移重校准
  const rawJsonFile = whisperOutputBase + '.json';
  if (!fs.existsSync(rawJsonFile)) {
    throw fail('AUDIO_TRANSCRIBE_OUTPUT_MISSING', 'Whisper 推理未生成预期的 JSON 输出');
  }

  let rawData;
  try {
    rawData = JSON.parse(fs.readFileSync(rawJsonFile, 'utf8'));
  } catch (err) {
    throw fail('AUDIO_TRANSCRIBE_OUTPUT_PARSE_FAILED', `Whisper 输出 JSON 解析失败: ${err.message}`);
  }

  const offsetMs = Math.round(effectiveOffset * 1000);
  const rawTrans = rawData?.transcription;
  const segments = normalizeSegments(rawTrans, offsetMs);

  // 生成规整的 TXT, SRT, VTT
  const fullText = segments.map(s => s.text).join('\n');
  fs.writeFileSync(txtPath, fullText, 'utf8');

  let srtContent = '';
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    srtContent += `${i + 1}\n${formatSrtTime(s.start_ms)} --> ${formatSrtTime(s.end_ms)}\n${s.text}\n\n`;
  }
  fs.writeFileSync(srtPath, srtContent, 'utf8');

  let vttContent = 'WEBVTT\n\n';
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    vttContent += `${i + 1}\n${formatVttTime(s.start_ms)} --> ${formatVttTime(s.end_ms)}\n${s.text}\n\n`;
  }
  fs.writeFileSync(vttPath, vttContent, 'utf8');

  // 清理临时 whisper-cli 自动生成的原始文件
  for (const ext of ['.json', '.txt', '.srt', '.vtt']) {
    try {
      const f = whisperOutputBase + ext;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {}
  }

  const detectedLanguage = rawData.result?.language || (p.language === 'auto' ? null : p.language);
  const document = {
    schema_version: 1,
    method: 'whisper_cpp_cpu',
    model_selected: p.model,
    language: detectedLanguage || p.language,
    detected_language: detectedLanguage,
    duration_seconds: duration,
    timeline_offset_seconds: effectiveOffset,
    relative_audio_delay_seconds: relativeAudioDelay,
    volume_stats: { max_volume_db: maxVolume, mean_volume_db: meanVolume },
    is_silent: false,
    text: fullText,
    segments,
    parameters: p
  };

  writeJson(outputPath, document);

  // 修复 Issue 3: 严格统一质量状态为 review_required
  return {
    before: { has_audio: true, duration, relative_audio_delay: relativeAudioDelay },
    after: { segment_count: segments.length, text_length: fullText.length, is_silent: false },
    quality_status: 'review_required',
    quality_note: segments.length > 0
      ? '离线语音识别与字幕生成完成；实际文本准确度、同音字及音画对齐时序仍需复核。'
      : '音频转写完成但未提取到有效语音片段，已生成空字幕。',
    assets: [
      { file: path.basename(txtPath), type: 'text', title: '识别文本全文', role: 'transcription_txt' },
      { file: path.basename(srtPath), type: 'subtitle', title: 'SubRip 字幕文件', role: 'subtitles_srt' },
      { file: path.basename(vttPath), type: 'subtitle', title: 'WebVTT 字幕文件', role: 'subtitles_vtt' }
    ]
  };
}

module.exports = {
  id: 'local.audio.transcribe',
  title: '离线语音识别与字幕生成',
  description: '基于 whisper.cpp 原生二进制与多语言 GGML 模型进行全离线语音识别，精确导出包含时间戳的 TXT、SRT 与 WebVTT 字幕。',
  kind: 'document',
  phase: 'transcribe',
  output_extension: 'json',
  component_id: 'media.whisper',
  additional_components: ['media.ffmpeg'],
  source: 'https://github.com/ggml-org/whisper.cpp',
  defaults: {
    model: 'base',
    language: 'zh',
    timeline_offset_seconds: 0,
    silence_threshold_db: -50,
    translate: false
  },
  executeNative,
  settings,
  validateParameters: settings,
  normalizeSegments,
  parameter_schema: {
    type: 'object',
    properties: {
      model: {
        type: 'string',
        enum: ['base', 'tiny'],
        title: 'GGML 模型大小 (默认 base，可选 tiny)',
        default: 'base'
      },
      language: {
        type: 'string',
        title: '语音识别语言代码 (如 zh, en, ja，或 auto 自动探测)',
        default: 'zh'
      },
      threads: {
        type: 'integer',
        minimum: 1,
        maximum: 32,
        title: 'CPU 计算线程数 (默认自动分配)'
      },
      translate: {
        type: 'boolean',
        title: '是否自动翻译为英文',
        default: false
      },
      timeline_offset_seconds: {
        type: 'number',
        title: '字幕时间轴基准平移量 (秒)',
        default: 0
      },
      silence_threshold_db: {
        type: 'number',
        minimum: -120,
        maximum: 0,
        title: '静音判定门限 (dB，低于此值不产生幻觉字幕，传 null 关闭)',
        default: -50
      },
      max_duration: {
        type: 'number',
        minimum: 1,
        maximum: 86400,
        title: '最大处理音频时长上限 (秒)',
        default: 7200
      }
    }
  }
};
