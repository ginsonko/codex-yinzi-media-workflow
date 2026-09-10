const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { run, sha256, writeJson } = require('./componentRuntime');

const fail = message => Object.assign(Error(message), { code: 'REVERSE_PROMPT_INPUT' });
const finite = (value, label, low, high) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < low || n > high) throw fail(`${label} 应在 ${low} 到 ${high} 之间`);
  return n;
};
const clean = (value, limit = 8000) => {
  const text = String(value ?? '').trim();
  if ([...text].length > limit) throw fail(`单项描述超过 ${limit} 字，请精简或分段；内容未被截断`);
  return text;
};
const round = value => Math.round(value * 1000000) / 1000000;

function selectFrames(timeline, { start = 0, end, frame_count = 24, timestamps } = {}) {
  if (!timeline.length) throw fail('视频没有可读取的帧时间');
  start = finite(start, '开始秒数', 0, timeline.at(-1));
  end = finite(end ?? timeline.at(-1), '结束秒数', start, timeline.at(-1));
  const count = finite(frame_count, '抽帧数量', 2, 120);
  if (!Number.isInteger(count)) throw fail('抽帧数量必须为整数');
  if (timestamps != null && (!Array.isArray(timestamps) || !timestamps.length || timestamps.length > 120)) throw fail('指定时间必须为 1–120 个秒数');
  const targets = timestamps ?? Array.from({ length: count }, (_, i) => start + (end - start) * i / (count - 1));
  const indices = new Set();
  for (const target of targets) {
    const t = finite(target, '关键帧秒数', start, end);
    let lo = 0, hi = timeline.length - 1;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (timeline[mid] < t) lo = mid + 1; else hi = mid; }
    if (lo > 0 && Math.abs(timeline[lo - 1] - t) < Math.abs(timeline[lo] - t)) lo--;
    indices.add(lo);
  }
  return [...indices].sort((a, b) => a - b).map((index, i) => ({ id: `K${String(i + 1).padStart(3, '0')}`, source_frame: index, seconds: timeline[index] }));
}

async function prepare({ inputPath, outputPath, parameters, components, report }) {
  const bins = components['media.ffmpeg'].executables;
  const sharp = createRequire(path.join(components['media.sharp'].directory, 'package.json'))('sharp');
  const probe = JSON.parse((await run(bins.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', inputPath])).stdout);
  const video = probe.streams.find(s => s.codec_type === 'video');
  const duration = Math.max(Number(video?.duration) || 0, Number(probe.format?.duration) || 0);
  if (!video || !(duration > 0)) throw fail('需要包含视频帧的素材');
  if (duration > 600) throw fail('请先按镜头把长视频分为不超过 10 分钟的片段，再对各段反推');
  if (video.width * video.height > 40000000) throw fail('源帧超过 4000 万像素，请先选择需要分析的区域');
  report({ stage: 'frame_index', message: '正在读取真实帧时间，保持变帧率视频的时序' });
  let frameOutput = '';
  await run(bins.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', inputPath], { timeout: 120000, onOutput: chunk => { if (frameOutput.length < 16000000) frameOutput += chunk; } });
  if (frameOutput.length >= 16000000) throw fail('帧索引过大，请把素材分为更短片段');
  const indexed = JSON.parse(frameOutput).frames || [];
  if (indexed.some(f => !Number.isFinite(Number(f.best_effort_timestamp_time)))) throw fail('部分帧缺少时间戳，无法可靠绑定关键帧');
  const pts = indexed.map(f => Number(f.best_effort_timestamp_time));
  const origin = pts[0] || 0;
  const timeline = pts.map(t => round(t - origin));
  if (timeline.some((t, i) => i && t < timeline[i - 1])) throw fail('帧时间不递增，请先修复原片时间戳');
  const frames = selectFrames(timeline, parameters);
  const dir = path.dirname(outputPath);
  report({ stage: 'extract_frames', message: `正在提取 ${frames.length} 张原尺寸关键帧`, total: frames.length });
  const filter = 'select=' + frames.map(f => `eq(n\\,${f.source_frame})`).join('+');
  await run(bins.ffmpeg, ['-nostdin', '-y', '-v', 'error', '-threads', '2', '-filter_threads', '2', '-protocol_whitelist', 'file,pipe', '-i', inputPath, '-vf', filter, '-fps_mode', 'vfr', '-frames:v', String(frames.length), '-compression_level', '3', path.join(dir, 'frame-%03d.png')], { timeout: 600000 });
  const assets = [], boards = [];
  for (const [i, frame] of frames.entries()) {
    const file = path.join(dir, `frame-${String(i + 1).padStart(3, '0')}.png`);
    const m = await sharp(file).metadata();
    Object.assign(frame, { file: path.basename(file), width: m.width, height: m.height, sha256: await sha256(file) });
    assets.push({ file: frame.file, type: 'image', title: `${frame.id} · ${frame.seconds}s`, role: 'source_frame' });
  }
  const width = Math.max(...frames.map(f => f.width)), height = Math.max(...frames.map(f => f.height));
  const columns = Math.max(1, Math.min(2, Math.floor(8192 / width)));
  const rows = Math.max(1, Math.min(2, Math.floor(40000000 / (columns * width * (height + 36))), Math.floor(8192 / (height + 36))));
  const perBoard = columns * rows;
  for (let i = 0; i < frames.length; i += perBoard) {
    const group = frames.slice(i, i + perBoard), composite = [];
    const boardWidth = columns * width, boardHeight = Math.ceil(group.length / columns) * (height + 36);
    for (const [j, frame] of group.entries()) {
      const left = (j % columns) * width, top = Math.floor(j / columns) * (height + 36);
      composite.push({ input: path.join(dir, frame.file), left, top: top + 36 });
      const label = `<svg width="${width}" height="36"><text x="10" y="25" font-family="sans-serif" font-size="20" fill="white">${frame.id} / ${frame.seconds.toFixed(3)}s</text></svg>`;
      composite.push({ input: Buffer.from(label), left, top });
    }
    const file = `storyboard-${String(boards.length + 1).padStart(2, '0')}.png`;
    await sharp({ create: { width: boardWidth, height: boardHeight, channels: 3, background: '#181818' } }).composite(composite).png().toFile(path.join(dir, file));
    boards.push({ file, frame_ids: group.map(f => f.id), width: boardWidth, height: boardHeight, sha256: await sha256(path.join(dir, file)), source_pixels_preserved: true });
    assets.push({ file, type: 'image', title: `时间线故事板 ${boards.length}`, role: 'storyboard' });
    report({ stage: 'storyboards', message: `已合成 ${boards.length} 张原尺寸故事板` });
  }
  const manifest = { schema: 'yinzi.video-reverse/v1', status: 'awaiting_visual_analysis', goal: clean(parameters.goal), source: { path: inputPath, sha256: await sha256(inputPath), duration_seconds: duration, time_origin_seconds: origin, width: video.width, height: video.height, audio_streams: probe.streams.filter(s => s.codec_type === 'audio').length }, frames, storyboards: boards,
    next_step: 'Codex 查看故事板与必要的原帧，描述各时段主体动作、镜头、背景、文字、声音和转场，再调用 video_reverse_compile；不要把抽帧完成当成语义分析或效果验收。' };
  writeJson(outputPath, manifest);
  return { manifest, assets, quality_status: 'review_required', quality_note: '源帧和时间线已就绪，正在等待 Codex 看图反推镜头。', after: { format: 'json', frame_count: frames.length }, text_preview: manifest.next_step };
}

function compileManifest(manifest, parameters) {
  if (manifest.schema !== 'yinzi.video-reverse/v1' || !Array.isArray(manifest.frames) || !manifest.frames.length) throw fail('请使用反推准备工具生成的清单');
  const duration = finite(manifest.source?.duration_seconds, '源视频时长', 0.001, 600);
  const frames = new Map(manifest.frames.map(f => [f.id, f]));
  const observations = parameters.observations;
  if (!Array.isArray(observations) || !observations.length || observations.length > 120) throw fail('需要 Codex 看图后的逐镜头 observations，不能用文件名代替视觉分析');
  const goal = clean(parameters.goal || manifest.goal);
  if (!goal) throw fail('需要说明制作目标');
  const references = parameters.references || [];
  if (!Array.isArray(references)) throw fail('references 必须为按实际上传顺序填写的列表');
  const seenRefs = new Set();
  for (const ref of references) {
    if (!['image', 'video', 'audio'].includes(ref.type) || !Number.isInteger(ref.index) || ref.index < 1 || ref.index > 120) throw fail('参考素材需要 type 和从 1 开始的 index');
    const key = ref.type + ':' + ref.index;
    if (seenRefs.has(key)) throw fail('参考素材索引重复');
    seenRefs.add(key);
    if (!clean(ref.role)) throw fail('每份参考素材需要说明作用');
    for (const id of ref.frame_ids || []) if (!frames.has(id)) throw fail(`参考素材中的 ${id} 不在关键帧清单中`);
  }
  const warnings = [], shots = [];
  let previousEnd = 0;
  for (const raw of observations) {
    const start = finite(raw.start, '镜头开始秒数', 0, duration), end = finite(raw.end, '镜头结束秒数', start, duration);
    if (end === start || start < previousEnd - 0.001) throw fail('镜头应按时间排列，不能重叠或没有时长');
    if (start > previousEnd + 0.15) warnings.push(`${previousEnd}–${start}秒没有镜头描述`);
    if (!Array.isArray(raw.frame_ids) || !raw.frame_ids.length) throw fail('每个镜头需要实际看过的 frame_ids');
    for (const id of raw.frame_ids) {
      const frame = frames.get(id);
      if (!frame || frame.seconds < start - 0.15 || frame.seconds > end + 0.15) throw fail(`镜头 ${start}–${end}s 与关键帧 ${id} 的时间不对应`);
    }
    if (!clean(raw.description)) throw fail('每个镜头需要真实画面描述 description');
    const shot = { start, end, frame_ids: raw.frame_ids, description: clean(raw.description, 3000), camera: clean(raw.camera, 1000), background: clean(raw.background, 1000), transition: clean(raw.transition, 1000), audio: clean(raw.audio, 1000), uncertainties: clean(raw.uncertainties, 1000) };
    shots.push(shot); previousEnd = end;
  }
  if (previousEnd < duration - 0.15) warnings.push(`${previousEnd}–${duration}秒没有镜头描述`);
  const label = { image: '图片', video: '视频', audio: '音频' };
  const lines = [goal, ...references.map(r => `@${label[r.type]}${r.index}：${clean(r.role, 1000)}${r.frame_ids?.length ? `（${r.frame_ids.map(id => `${id}=${frames.get(id).seconds}s`).join('、')}）` : ''}`), '按原时间顺序执行以下镜头：', ...shots.map(s => `${s.start}–${s.end}秒：${[s.description, s.camera && '镜头：' + s.camera, s.background && '背景：' + s.background, s.transition && '转场：' + s.transition, s.audio && '声音：' + s.audio].filter(Boolean).join('；')}`)];
  if (parameters.preserve) lines.push('保留：' + clean(parameters.preserve));
  if (parameters.avoid) lines.push('避免：' + clean(parameters.avoid));
  lines.push('故事板拼版和时间标签仅为参考，不进入成片；输出连续全屏镜头。');
  const outputDuration = finite(parameters.output_duration ?? duration, '输出时长', 0.001, 600);
  if (parameters.timing_mode !== 'retime') {
    if (outputDuration < previousEnd - 0.05) throw fail('输出时长短于已描述时间线；请按片段编译，或明确选择 retime 并描述时间映射');
    lines.push(`保留前 ${previousEnd} 秒原时间节奏，不拉伸动作${outputDuration > previousEnd + 0.15 ? `；仅在此后延长结尾画面至 ${outputDuration} 秒` : ''}。`);
  } else lines.push(`输出 ${outputDuration} 秒；重定时方式：${clean(parameters.retime_instruction) || '按所述目标时间线执行'}。`);
  const prompt = lines.join('\n');
  const max = finite(parameters.max_prompt_chars ?? 8000, '提示词长度上限', 100, 32000);
  if ([...prompt].length > max) throw fail(`提示词有 ${[...prompt].length} 字，超过设定的 ${max} 字；请缩短描述或按镜头分段，工具不会静默截断关键要求`);
  return { schema: 'yinzi.video-reverse-prompt/v1', status: 'compiled_from_observations', source_sha256: manifest.source.sha256, goal, references, observations: shots, prompt, prompt_chars: [...prompt].length, warnings, acceptance_times: [...new Set(shots.flatMap(s => s.frame_ids.map(id => frames.get(id).seconds)))].sort((a, b) => a - b), quality_status: 'review_required', boundary: '工具验证时序与引用关系；描述由调用者看图提供，最终视频效果仍须实测。' };
}

async function compile({ inputPath, outputPath, parameters }) {
  if (fs.statSync(inputPath).size > 2000000) throw fail('反推清单超过 2MB，请使用准备工具的原始 JSON');
  const result = compileManifest(JSON.parse(fs.readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, '')), parameters);
  writeJson(outputPath, result);
  fs.writeFileSync(path.join(path.dirname(outputPath), 'prompt.txt'), result.prompt, 'utf8');
  return { ...result, assets: [{ file: 'prompt.txt', type: 'document', title: '可直接提交的视频提示词', role: 'compiled_prompt' }], text_preview: result.prompt, after: { format: 'json' }, quality_note: result.boundary };
}

const operations = [
  { id: 'local.video.reverse-prepare', title: '反推视频 · 提取关键帧与故事板', description: '自动准备组件，按真实帧时间提取原尺寸 PNG、分组故事板和可恢复清单。Codex 看图后继续编译提示词。', kind: 'document', phase: 'analyze', component_id: 'media.ffmpeg', additional_components: ['media.sharp'], output_extension: 'json', defaults: { frame_count: 24 }, executeNative: prepare, source: 'https://ffmpeg.org/ffmpeg-filters.html#select_002c-aselect' },
  { id: 'local.video.reverse-compile', title: '反推视频 · 生成匹配关键帧的提示词', description: '将 Codex 实际看图后的镜头描述、时间线和参考索引编译成视频提示词，保留不确定项与验收时间。无需额外模型配置。', kind: 'document', phase: 'analyze', component_id: null, output_extension: 'json', defaults: {}, executeNative: compile, source: 'https://github.com/ginsonko/codex-yinzi-media-workflow' },
];
operations[0].parameter_schema = { type: 'object', properties: { goal: { type: 'string', title: '制作目标' }, frame_count: { type: 'integer', minimum: 2, maximum: 120, default: 24, title: '关键帧数量' }, timestamps: { type: 'array', items: { type: 'number' }, title: '指定抽帧秒数' }, start: { type: 'number', minimum: 0, maximum: 600 }, end: { type: 'number', minimum: 0, maximum: 600 } } };
operations[1].parameter_schema = { type: 'object', properties: { goal: { type: 'string' }, observations: { type: 'array', items: { type: 'object' }, title: '逐镜头视觉描述' }, references: { type: 'array', items: { type: 'object' }, title: '实际引用顺序' }, output_duration: { type: 'number', minimum: 0.001, maximum: 600 }, max_prompt_chars: { type: 'integer', minimum: 100, maximum: 32000 }, preserve: { type: 'string' }, avoid: { type: 'string' } } };
module.exports = { operations, selectFrames, prepare, compileManifest, compile };
