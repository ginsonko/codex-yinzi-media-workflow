// mediaExtensionCandidates.js
// 8项专业音视频FFmpeg扩展候选模块实现（与现有230合同去重，独立用户用途，可配置参数，具备可用默认）
// 兼容 localMediaOperations / localMediaExecutor 调用结构

function number(p, key, fallback, min, max) {
  const val = p[key] == null ? fallback : Number(p[key]);
  if (!Number.isFinite(val) || val < min || val > max) {
    throw new Error(`参数 ${key} 应在 ${min} 到 ${max} 之间`);
  }
  return val;
}
const n = number;

const operations = [];
const SUPPORTED_BM3D_GROUPS = Object.freeze([1, 4, 8, 16, 32, 64, 128, 256]);

function registerFilter({ id, title, kind, build, defaults = {}, validateParameters = null, prepare = null, description = '', source = '' }) {
  const fullId = `local.${kind}.${id}`;
  const op = {
    id: fullId,
    title,
    kind,
    component_id: 'media.ffmpeg',
    build,
    defaults,
    validateParameters,
    prepare,
    description,
    description_zh: description,
    source: source || `https://ffmpeg.org/ffmpeg-filters.html#${id}`
  };
  operations.push(op);
  return op;
}

// 1. 人声齿音/咝音削减与平滑
registerFilter({
  id: 'deesser',
  title: '人声齿音咝音削减',
  kind: 'audio',
  description: '自动检测并衰减人声高频齿音与嘶嘶杂音(De-Essing)，保持中频对白自然温润',
  defaults: {
    intensity: 0.12,
    max: 0.5,
    frequency: 0.5,
    mode: 1
  },
  validateParameters(p) {
    n(p, 'intensity', 0.12, 0, 1);
    n(p, 'max', 0.5, 0, 1);
    n(p, 'frequency', 0.5, 0, 1);
    n(p, 'mode', 1, 0, 2);
  },
  build(p) {
    const intensity = n(p, 'intensity', 0.12, 0, 1);
    const max = n(p, 'max', 0.5, 0, 1);
    const frequency = n(p, 'frequency', 0.5, 0, 1);
    const mode = Math.round(n(p, 'mode', 1, 0, 2));
    const modeStr = mode === 0 ? 'i' : mode === 2 ? 'e' : 'o';
    return `deesser=i=${intensity}:m=${max}:f=${frequency}:s=${modeStr}`;
  }
});

// 2. 非局部均值宽带音频降噪
registerFilter({
  id: 'anlmdn',
  title: '非局部均值音频降噪',
  kind: 'audio',
  description: '基于非局部均值(NLMeans)算法的宽带音频降噪，有效分离平稳背景底噪与瞬态音频',
  defaults: {
    strength: 0.00005,
    patch: 0.002,
    research: 0.006,
    smooth: 11
  },
  validateParameters(p) {
    n(p, 'strength', 0.00005, 0.00001, 10);
    n(p, 'patch', 0.002, 0.001, 0.1);
    n(p, 'research', 0.006, 0.002, 0.3);
    n(p, 'smooth', 11, 1, 1000);
  },
  async prepare({ ffmpeg, spawnImpl, timeoutMs } = {}) {
    const { prepareAnlmdnBuild } = require('./ffmpegBuildProbe');
    return prepareAnlmdnBuild({ ffmpeg, spawnImpl, timeoutMs });
  },
  build(p) {
    const s = n(p, 'strength', 0.00005, 0.00001, 10);
    const patch = n(p, 'patch', 0.002, 0.001, 0.1);
    const research = n(p, 'research', 0.006, 0.002, 0.3);
    const smooth = n(p, 'smooth', 11, 1, 1000);
    return `anlmdn=s=${s}:p=${patch}:r=${research}:m=${smooth}:o=o`;
  }
});

// 3. 音频晶体化与细节锐化
registerFilter({
  id: 'crystalizer',
  title: '音频细节晶体化锐化',
  kind: 'audio',
  description: '音频高频细节锐化与动态泛音放大滤镜，增强暗淡音轨的通透感与空间立体感',
  defaults: {
    intensity: 2.0,
    clipping: true
  },
  validateParameters(p) {
    n(p, 'intensity', 2.0, -10, 10);
  },
  build(p) {
    const intensity = n(p, 'intensity', 2.0, -10, 10);
    const clipping = p.clipping === false || p.clipping === 0 || p.clipping === '0' ? 0 : 1;
    return `crystalizer=i=${intensity}:c=${clipping}`;
  }
});

// 4. 虚拟低音/心理声学谐波增强
registerFilter({
  id: 'virtualbass',
  title: '虚拟低音谐波增强',
  kind: 'audio',
  description: '心理声学低频谐波发生器，在小型扬声器或耳机上产生超下潜听感的丰满虚拟低音',
  defaults: {
    cutoff: 250,
    strength: 2.0
  },
  validateParameters(p) {
    n(p, 'cutoff', 250, 100, 500);
    n(p, 'strength', 2.0, 0.5, 3.0);
  },
  build(p) {
    const cutoff = n(p, 'cutoff', 250, 100, 500);
    const strength = n(p, 'strength', 2.0, 0.5, 3.0);
    return `virtualbass=cutoff=${cutoff}:strength=${strength}`;
  }
});

// 5. 小波变换音频降噪
registerFilter({
  id: 'afwtdn',
  title: '小波变换自适应音频降噪',
  kind: 'audio',
  description: '基于小波分解(Wavelet Denoising)的时频联合降噪，擅长消除高频毛刺与环境白噪声',
  defaults: {
    sigma: 0.02,
    levels: 10,
    wavet: 4,
    percent: 85,
    softness: 1.0
  },
  validateParameters(p) {
    n(p, 'sigma', 0.02, 0, 1);
    n(p, 'levels', 10, 1, 12);
    n(p, 'wavet', 4, 0, 6);
    n(p, 'percent', 85, 0, 100);
    n(p, 'softness', 1.0, 0, 10);
  },
  build(p) {
    const sigma = n(p, 'sigma', 0.02, 0, 1);
    const levels = Math.round(n(p, 'levels', 10, 1, 12));
    const wavet = Math.round(n(p, 'wavet', 4, 0, 6));
    const percent = n(p, 'percent', 85, 0, 100);
    const softness = n(p, 'softness', 1.0, 0, 10);
    return `afwtdn=sigma=${sigma}:levels=${levels}:wavet=${wavet}:percent=${percent}:softness=${softness}`;
  }
});

// 6. 自适应时域平均视频降噪
registerFilter({
  id: 'atadenoise',
  title: '自适应时域平均视频降噪',
  kind: 'video',
  description: '自适应多帧时域联合均值降噪(Adaptive Temporal Averaging Denoiser)，抑制视频传感器时域噪点',
  defaults: {
    threshold_a: 0.02,
    threshold_b: 0.04,
    frames: 9
  },
  validateParameters(p) {
    n(p, 'threshold_a', 0.02, 0, 0.3);
    n(p, 'threshold_b', 0.04, 0, 5);
    n(p, 'frames', 9, 5, 129);
  },
  build(p) {
    const ta = n(p, 'threshold_a', 0.02, 0, 0.3);
    const tb = n(p, 'threshold_b', 0.04, 0, 5);
    let frames = Math.round(n(p, 'frames', 9, 5, 129));
    if (frames % 2 === 0) frames += 1; // atadenoise frames 必须为奇数
    return `atadenoise=0a=${ta}:0b=${tb}:1a=${ta}:1b=${tb}:2a=${ta}:2b=${tb}:s=${frames}`;
  }
});

// 7. 块匹配 3D 视频高保真时空降噪
registerFilter({
  id: 'bm3d',
  title: '块匹配3D高保真视频降噪',
  kind: 'video',
  description: '业界顶级图像/视频BM3D时空块匹配降噪，在强力去噪的同时最大程度保留边缘与高频纹理',
  defaults: {
    sigma: 2.0,
    block: 16,
    bstep: 4,
    group: 1,
    range: 9
  },
  validateParameters(p) {
    n(p, 'sigma', 2.0, 0, 100);
    n(p, 'block', 16, 8, 64);
    n(p, 'bstep', 4, 1, 64);
    const group = n(p, 'group', 1, 1, 256);
    if (!Number.isInteger(group) || !SUPPORTED_BM3D_GROUPS.includes(group)) {
      throw new Error(`参数 group 仅支持 ${SUPPORTED_BM3D_GROUPS.join(', ')}`);
    }
    n(p, 'range', 9, 1, 100);
  },
  build(p) {
    const sigma = n(p, 'sigma', 2.0, 0, 100);
    const block = Math.round(n(p, 'block', 16, 8, 64));
    const bstep = Math.round(n(p, 'bstep', 4, 1, 64));
    const group = Math.round(n(p, 'group', 1, 1, 256));
    const range = Math.round(n(p, 'range', 9, 1, 100));
    return `bm3d=sigma=${sigma}:block=${block}:bstep=${bstep}:group=${group}:range=${range}`;
  }
});

// 8. 对比度自适应锐化 (CAS)
registerFilter({
  id: 'cas',
  title: '对比度自适应锐化 (CAS)',
  kind: 'video',
  description: 'AMD Contrast Adaptive Sharpening算法移植，根据局部画面对比度自适应锐化，避免振铃伪影',
  defaults: {
    strength: 0.4,
    planes: 7
  },
  validateParameters(p) {
    n(p, 'strength', 0.4, 0, 1);
    n(p, 'planes', 7, 0, 15);
  },
  build(p) {
    const strength = n(p, 'strength', 0.4, 0, 1);
    const planes = Math.round(n(p, 'planes', 7, 0, 15));
    return `cas=strength=${strength}:planes=${planes}`;
  }
});

function getOperation(id) {
  return operations.find(o => o.id === id);
}

module.exports = {
  operations,
  getOperation,
  SUPPORTED_BM3D_GROUPS
};
