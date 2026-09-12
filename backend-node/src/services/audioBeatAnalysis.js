const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { run, writeJson } = require('./componentRuntime');

const fail = (code, message) => Object.assign(new Error(message), { code });
const round = n => Math.round(n * 1000000) / 1000000;
function number(value, fallback, min, max, name) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n < min || n > max) throw fail('BEAT_ANALYSIS_INPUT', `${name} 应在 ${min} 到 ${max} 之间`);
  return n;
}
function settings(p = {}) {
  const result = {
    window_ms: number(p.window_ms, 10, 5, 50, '分析窗口毫秒'),
    min_interval: number(p.min_interval, 0.15, 0.04, 2, '候选点最小间隔秒'),
    sensitivity: number(p.sensitivity, 1.5, 0.5, 5, '峰值灵敏度'),
    low_hz: number(p.low_hz, 40, 0, 7000, '最低频率'),
    high_hz: number(p.high_hz, 300, 20, 7900, '最高频率'),
    max_duration: number(p.max_duration, 14400, 1, 14400, '分析时长上限秒'),
  };
  if (result.high_hz <= result.low_hz) throw fail('BEAT_ANALYSIS_INPUT', '最高频率需要大于最低频率');
  return result;
}

// Streaming PCM reduces long-input memory to one RMS value per window.
function decodeEnvelope(bin, args, windowSamples, maxSamples, report) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const frames = []; let tail = Buffer.alloc(0), sum = 0, count = 0, samples = 0, stderr = '', failure, lastReport = 0;
    const timer = setTimeout(() => { failure = fail('BEAT_ANALYSIS_TIMEOUT', '音频解码超时，请按镜头或乐段拆分后继续'); child.kill(); }, 600000);
    child.stdout.on('data', chunk => {
      const buffer = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      const end = buffer.length - buffer.length % 4;
      for (let i = 0; i < end; i += 4) {
        const value = buffer.readFloatLE(i);
        if (!Number.isFinite(value)) { failure = fail('BEAT_ANALYSIS_DECODE', '解码音频含无效采样'); child.kill(); break; }
        sum += value * value; count++; samples++;
        if (samples > maxSamples) { failure = fail('BEAT_ANALYSIS_LIMIT', '素材超过分析时长上限，请分段处理或提高 max_duration'); child.kill(); break; }
        if (count === windowSamples) { frames.push(Math.sqrt(sum / count)); sum = 0; count = 0; }
      }
      tail = Buffer.from(buffer.subarray(end));
      if (Date.now() - lastReport > 1000) { report({ stage: 'analyzing_audio', message: `正在分析音频，已读取 ${(samples / 16000).toFixed(1)} 秒`, analyzed_seconds: samples / 16000 }); lastReport = Date.now(); }
    });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-3000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0 || !samples || tail.length) return reject(fail('BEAT_ANALYSIS_DECODE', `音频未完整解码 (${code})：${stderr}`));
      if (count) frames.push(Math.sqrt(sum / count));
      resolve({ frames, samples });
    });
  });
}

function analyzeEnvelope(frames, hop, p = {}) {
  const config = settings(p);
  const novelty = frames.map((value, i) => Math.max(0, value - (i ? frames.slice(Math.max(0, i - 3), i).reduce((a, b) => a + b, 0) / Math.min(i, 3) : 0)));
  const sum = [0], squared = [0];
  for (const n of novelty) { sum.push(sum.at(-1) + n); squared.push(squared.at(-1) + n * n); }
  const radius = Math.max(1, Math.round(1 / hop));
  const candidates = [];
  for (let i = 0; i < novelty.length; i++) {
    const start = Math.max(0, i - radius), end = Math.min(novelty.length, i + radius + 1), length = end - start;
    const mean = (sum[end] - sum[start]) / length;
    const deviation = Math.sqrt(Math.max(0, (squared[end] - squared[start]) / length - mean * mean));
    const threshold = Math.max(0.0003, mean + config.sensitivity * deviation);
    if (novelty[i] <= threshold || novelty[i] <= (novelty[i - 1] ?? -1) || novelty[i] < (novelty[i + 1] ?? -1)) continue;
    const candidate = { seconds: round(i * hop), strength: round(novelty[i]), threshold: round(threshold) };
    const previous = candidates.at(-1);
    if (previous && candidate.seconds - previous.seconds < config.min_interval) {
      if (candidate.strength > previous.strength) candidates[candidates.length - 1] = candidate;
    } else candidates.push(candidate);
  }
  const intervals = candidates.slice(1).map((item, i) => item.seconds - candidates[i].seconds);
  const sorted = [...intervals].sort((a, b) => a - b), median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const matching = median > 0 ? intervals.filter(n => Math.abs(n - median) <= Math.max(hop * 2, median * 0.12)).length : 0;
  const stability = intervals.length ? matching / intervals.length : 0;
  const tempo = intervals.length >= 4 && median >= 0.2 && median <= 2 && stability >= 0.7
    ? { bpm: round(60 / median), interval_seconds: round(median), interval_agreement: round(stability), basis: 'repeating_detected_transients', musical_tempo_confirmed: false } : null;
  const stride = Math.max(1, Math.ceil(frames.length / 1500));
  const envelope = [];
  for (let i = 0; i < frames.length; i += stride) envelope.push({ seconds: round(i * hop), rms: round(Math.max(...frames.slice(i, i + stride))) });
  return { onsets: candidates, tempo_hypothesis: tempo, envelope, time_resolution_seconds: hop,
    limitations: ['候选点来自所选频带的能量突变，可能包含人声、音效或非鼓点。', '节奏假设可能对应半拍或倍拍；变速、弱拍和无节拍音乐需要结合听感与画面选择。'] };
}

function timelineSvg(analysis, duration) {
  const width = 1200, height = 260, plotWidth = 1120, left = 40;
  const max = Math.max(0.001, ...analysis.envelope.map(p => p.rms));
  const points = analysis.envelope.map(p => `${round(left + p.seconds / duration * plotWidth)},${round(205 - p.rms / max * 150)}`).join(' ');
  const markers = analysis.onsets.slice(0, 2000).map(p => `<path d="M${round(left + p.seconds / duration * plotWidth)} 42V210" stroke="#fdbb60" opacity=".5"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="1200" height="260" fill="#102432"/><text x="40" y="28" fill="#edf7fa" font-size="18" font-family="sans-serif">Audio transients / ${analysis.onsets.length} candidates / ${round(duration)} s</text><polyline points="${points}" fill="none" stroke="#46d2bd" stroke-width="2"/>${markers}<text x="40" y="240" fill="#b4c8d2" font-size="14" font-family="sans-serif">Candidate markers need listening and shot review. Original audio is preserved.</text></svg>`;
}

async function executeNative({ inputPath, outputPath, parameters = {}, components, report = () => {} }) {
  const p = settings(parameters), bins = components['media.ffmpeg'].executables;
  const probe = JSON.parse((await run(bins.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', inputPath])).stdout);
  const audio = probe.streams?.find(s => s.codec_type === 'audio');
  if (!audio) throw fail('BEAT_ANALYSIS_NO_AUDIO', '素材没有音轨，请选择配乐或包含声音的视频');
  const video = probe.streams.find(s => s.codec_type === 'video');
  const origin = Number((video || audio).start_time ?? probe.format?.start_time ?? 0);
  if (!Number.isFinite(origin)) throw fail('BEAT_ANALYSIS_TIME', '无法确定素材时间原点');
  const filters = [`asetpts=PTS-(${origin})/TB`, 'aresample=16000:async=1:first_pts=0'];
  if (p.low_hz) filters.push(`highpass=f=${p.low_hz}`);
  filters.push(`lowpass=f=${p.high_hz}`);
  const windowSamples = Math.round(p.window_ms * 16), hop = windowSamples / 16000;
  const decoded = await decodeEnvelope(bins.ffmpeg, ['-nostdin', '-v', 'error', '-threads', '2', '-copyts', '-protocol_whitelist', 'file,pipe', '-i', inputPath,
    '-map', '0:a:0', '-vn', '-af', filters.join(','), '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'], windowSamples, p.max_duration * 16000, report);
  const duration = decoded.samples / 16000, analysis = analyzeEnvelope(decoded.frames, hop, p);
  const document = { schema_version: 1, method: 'band_limited_rms_onset', source_timeline_origin: origin,
    decoded_duration: duration, parameters: p, ...analysis, quality_status: 'review_required' };
  writeJson(outputPath, document);
  fs.writeFileSync(path.join(path.dirname(outputPath), 'audio-timeline.svg'), timelineSvg(analysis, duration));
  return { before: { has_audio: true, source_timeline_origin: origin }, after: { duration, onset_count: analysis.onsets.length },
    quality_status: 'review_required', quality_note: '已解码并提取声音突变候选；需要结合听感和画面验收卡点。',
    tempo_hypothesis: analysis.tempo_hypothesis,
    assets: [{ file: 'audio-timeline.svg', type: 'image', title: '音频包络与候选卡点', role: 'audio_timeline' }] };
}

module.exports = { id: 'local.audio.analyze-beats', title: '音频节拍与瞬态分析',
  description: '本地解码配乐或视频音轨，提取候选卡点、能量包络和可核验的节奏假设，用于MAD、MV与鬼畜剪辑规划。',
  kind: 'document', phase: 'analyze', output_extension: 'json', component_id: 'media.ffmpeg', source: 'https://ffmpeg.org/ffmpeg-filters.html#aresample',
  defaults: {}, executeNative, analyzeEnvelope, settings,
  parameter_schema: { type: 'object', properties: {
    window_ms: { type: 'number', minimum: 5, maximum: 50, title: '分析窗口毫秒', default: 10 },
    min_interval: { type: 'number', minimum: 0.04, maximum: 2, title: '候选点最小间隔秒', default: 0.15 },
    sensitivity: { type: 'number', minimum: 0.5, maximum: 5, title: '峰值门槛倍数（小值检测更多）', default: 1.5 },
    low_hz: { type: 'number', minimum: 0, maximum: 7000, title: '频带下限Hz', default: 40 },
    high_hz: { type: 'number', minimum: 20, maximum: 7900, title: '频带上限Hz', default: 300 },
    max_duration: { type: 'number', minimum: 1, maximum: 14400, title: '分析时长上限秒', default: 14400 },
  } } };
