const fs = require('node:fs');
const path = require('node:path');

const fail = (code, message) => Object.assign(new Error(message), { code });
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function wrapRawOutput(sharpInstance, outBuffer, width, height) {
  const sharpCtor = sharpInstance && typeof sharpInstance.constructor === 'function'
    ? sharpInstance.constructor
    : require('sharp');
  return sharpCtor(outBuffer, { raw: { width, height, channels: 4 } }).png();
}

/**
 * 1. 高低频分频分离与修饰 (local.image.frequency-separation)
 * 专业摄影修图必备：分离色彩基底(低频)与高频质感(纹理/毛孔/细线)
 * 允许独立平滑色彩层（消除暗沉/杂色）或增强/衰减纹理层。
 */
const freqDefaults = {
  radius: 4,              // 分频模糊半径 (1 ~ 64)
  texture_gain: 1.2,      // 高频质感增益 (0 ~ 3.0)
  color_blur_blend: 0.4,  // 色彩基底额外平滑混合 (0 ~ 1.0)
};
const freqBounds = {
  radius: [1, 64],
  texture_gain: [0, 3.0],
  color_blur_blend: [0, 1.0],
};

function validateFreqSeparation(p) {
  for (const [k, [min, max]] of Object.entries(freqBounds)) {
    const val = p[k];
    if (typeof val !== 'number' || !Number.isFinite(val) || val < min || val > max) {
      throw fail('INVALID_PARAMETERS', `${k} 需在 ${min} 到 ${max} 之间`);
    }
  }
}

async function applyFrequencySeparation(sharpInstance, p) {
  validateFreqSeparation(p);
  const { data: orig, info } = await sharpInstance
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  // 1. 低频层 (色彩基底)
  const lowFreq = await sharpInstance
    .clone()
    .blur(p.radius)
    .raw()
    .toBuffer();

  // 2. 更强平滑基底（用于消除杂色斑驳）
  let smoothedLow = lowFreq;
  if (p.color_blur_blend > 0) {
    smoothedLow = await sharpInstance
      .clone()
      .blur(p.radius * 2)
      .raw()
      .toBuffer();
  }

  const out = Buffer.from(orig);
  const len = width * height * 4;

  for (let i = 0; i < len; i += 4) {
    for (let c = 0; c < 3; c++) {
      const o = orig[i + c];
      const l = lowFreq[i + c];
      const sl = smoothedLow[i + c];

      // 高频细节残差
      const highFreq = o - l;

      // 调整后的低频基底
      const baseColor = l * (1 - p.color_blur_blend) + sl * p.color_blur_blend;

      // 合成 = 基底 + (高频 * 增益)
      const res = baseColor + highFreq * p.texture_gain;
      out[i + c] = clamp(Math.round(res), 0, 255);
    }
    out[i + 3] = orig[i + 3];
  }

  return wrapRawOutput(sharpInstance, out, width, height);
}

/**
 * 2. 双边滤波保边降噪 (local.image.bilateral-denoise)
 * 抑制平坦区域噪点，严格锁定边缘反差，避免模糊关键轮廓
 */
const bilateralDefaults = {
  spatial_sigma: 3,       // 空间邻域模糊半宽 (1 ~ 20)
  edge_threshold: 30,     // 边缘反差容差阈值 (5 ~ 120)
  mix: 0.75,              // 处理结果与原图混合比 (0 ~ 1.0)
};
const bilateralBounds = {
  spatial_sigma: [1, 20],
  edge_threshold: [5, 120],
  mix: [0, 1.0],
};

function validateBilateral(p) {
  for (const [k, [min, max]] of Object.entries(bilateralBounds)) {
    const val = p[k];
    if (typeof val !== 'number' || !Number.isFinite(val) || val < min || val > max) {
      throw fail('INVALID_PARAMETERS', `${k} 需在 ${min} 到 ${max} 之间`);
    }
  }
}

async function applyBilateralDenoise(sharpInstance, p) {
  validateBilateral(p);
  const { data: orig, info } = await sharpInstance
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  // 使用高斯引导层计算局部空间加权
  const guided = await sharpInstance
    .clone()
    .blur(p.spatial_sigma)
    .raw()
    .toBuffer();

  const out = Buffer.from(orig);
  const thresh = p.edge_threshold;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const oR = orig[idx], oG = orig[idx + 1], oB = orig[idx + 2];
      const gR = guided[idx], gG = guided[idx + 1], gB = guided[idx + 2];

      // 计算像素与引导模糊层的值差异（边缘强度度量）
      const lumDiff = Math.abs(oR - gR) * 0.299 + Math.abs(oG - gG) * 0.587 + Math.abs(oB - gB) * 0.114;

      // 如果差异大于阈值，说明是强边缘，衰减降噪权重以保护边缘锐利
      let bilateralWeight = 1.0;
      if (lumDiff > thresh) {
        bilateralWeight = Math.max(0, 1.0 - (lumDiff - thresh) / thresh);
      }
      const w = bilateralWeight * p.mix;

      out[idx] = clamp(Math.round(oR * (1 - w) + gR * w), 0, 255);
      out[idx + 1] = clamp(Math.round(oG * (1 - w) + gG * w), 0, 255);
      out[idx + 2] = clamp(Math.round(oB * (1 - w) + gB * w), 0, 255);
      out[idx + 3] = orig[idx + 3];
    }
  }

  return wrapRawOutput(sharpInstance, out, width, height);
}

/**
 * 3. 局部加光减光立体塑造 (local.image.dodge-burn)
 * 类似暗房 Dodge (提亮高光/中间调) 与 Burn (加深阴影) 增加立体感与视觉冲击力
 */
const dodgeBurnDefaults = {
  dodge_highlights: 0.25, // 高光提亮增益 (0 ~ 1.0)
  burn_shadows: 0.2,      // 暗部加深增益 (0 ~ 1.0)
  midtones_contrast: 0.15,// 中间调反差微调 (-0.5 ~ 0.5)
};
const dodgeBurnBounds = {
  dodge_highlights: [0, 1.0],
  burn_shadows: [0, 1.0],
  midtones_contrast: [-0.5, 0.5],
};

function validateDodgeBurn(p) {
  for (const [k, [min, max]] of Object.entries(dodgeBurnBounds)) {
    const val = p[k];
    if (typeof val !== 'number' || !Number.isFinite(val) || val < min || val > max) {
      throw fail('INVALID_PARAMETERS', `${k} 需在 ${min} 到 ${max} 之间`);
    }
  }
}

async function applyDodgeBurn(sharpInstance, p) {
  validateDodgeBurn(p);
  const { data: orig, info } = await sharpInstance
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const out = Buffer.from(orig);

  for (let i = 0; i < width * height * 4; i += 4) {
    const r = orig[i], g = orig[i + 1], b = orig[i + 2];
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255; // 归一化亮度

    // 阴影权重 (lum接近0最大，到0.5降为0)
    const shadowWeight = Math.max(0, 1 - lum * 2);
    // 高光权重 (lum从0.5起增加，到1最大)
    const highlightWeight = Math.max(0, (lum - 0.5) * 2);
    // 中间调权重
    const midtoneWeight = 1 - Math.abs(lum - 0.5) * 2;

    let shift = 0;
    // Dodge高光
    shift += highlightWeight * p.dodge_highlights * 45;
    // Burn阴影
    shift -= shadowWeight * p.burn_shadows * 40;
    // 中间调微反差
    shift += (lum - 0.5) * p.midtones_contrast * 30 * midtoneWeight;

    out[i] = clamp(Math.round(r + shift), 0, 255);
    out[i + 1] = clamp(Math.round(g + shift), 0, 255);
    out[i + 2] = clamp(Math.round(b + shift), 0, 255);
    out[i + 3] = orig[i + 3];
  }

  return wrapRawOutput(sharpInstance, out, width, height);
}

/**
 * 4. 专业电影感色彩分级 (local.image.color-grade)
 * 经典青橙(Teal-Orange)、胶片暖棕(Warm Bronze)、银盐冷峻(Cool Silver)三向色调分离
 */
const colorGradeDefaults = {
  preset: 'teal_orange', // teal_orange, warm_film, cool_noir, golden_hour
  strength: 0.65,        // 分级强度 (0 ~ 1.0)
  contrast: 1.08,        // 微反差 (0.5 ~ 2.0)
  saturation: 1.05,      // 饱和度乘数 (0 ~ 2.0)
};
const colorGradeBounds = {
  strength: [0, 1.0],
  contrast: [0.5, 2.0],
  saturation: [0, 2.0],
};

function validateColorGrade(p) {
  for (const [k, [min, max]] of Object.entries(colorGradeBounds)) {
    const val = p[k];
    if (typeof val !== 'number' || !Number.isFinite(val) || val < min || val > max) {
      throw fail('INVALID_PARAMETERS', `${k} 需在 ${min} 到 ${max} 之间`);
    }
  }
  if (!['teal_orange', 'warm_film', 'cool_noir', 'golden_hour'].includes(p.preset)) {
    throw fail('INVALID_PARAMETERS', 'preset 必须是 teal_orange, warm_film, cool_noir 或 golden_hour');
  }
}

async function applyColorGrade(sharpInstance, p) {
  validateColorGrade(p);
  const { data: orig, info } = await sharpInstance
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const out = Buffer.from(orig);

  // 阴影偏色与高光偏色目标向量
  let sR = 0, sG = 0, sB = 0; // shadows
  let hR = 0, hG = 0, hB = 0; // highlights

  if (p.preset === 'teal_orange') {
    // 经典电影青橙：暗部偏青蓝 (Teal)，高光偏暖橙 (Orange)
    sR = -18; sG = 8; sB = 22;
    hR = 25; hG = 12; hB = -12;
  } else if (p.preset === 'warm_film') {
    // 温暖胶片感：暗部偏暖棕，高光偏柔黄
    sR = 15; sG = 5; sB = -10;
    hR = 20; hG = 18; hB = 4;
  } else if (p.preset === 'cool_noir') {
    // 冷色调黑色电影：全频偏冷蓝灰色
    sR = -10; sG = 0; sB = 25;
    hR = -5; hG = 8; hB = 20;
  } else if (p.preset === 'golden_hour') {
    // 黄金时刻暖阳：金黄灿烂
    sR = 10; sG = 4; sB = -15;
    hR = 35; hG = 22; hB = -10;
  }

  const str = p.strength;
  const sat = p.saturation;
  const cont = p.contrast;

  for (let i = 0; i < width * height * 4; i += 4) {
    let r = orig[i], g = orig[i + 1], b = orig[i + 2];

    // 反差微调
    r = clamp((r - 128) * cont + 128, 0, 255);
    g = clamp((g - 128) * cont + 128, 0, 255);
    b = clamp((b - 128) * cont + 128, 0, 255);

    // 饱和度调整
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    r = clamp(lum + (r - lum) * sat, 0, 255);
    g = clamp(lum + (g - lum) * sat, 0, 255);
    b = clamp(lum + (b - lum) * sat, 0, 255);

    const normLum = lum / 255;
    const shadowWeight = Math.max(0, 1 - normLum * 1.6);
    const highlightWeight = Math.max(0, (normLum - 0.35) * 1.5);

    const shiftR = (shadowWeight * sR + highlightWeight * hR) * str;
    const shiftG = (shadowWeight * sG + highlightWeight * hG) * str;
    const shiftB = (shadowWeight * sB + highlightWeight * hB) * str;

    out[i] = clamp(Math.round(r + shiftR), 0, 255);
    out[i + 1] = clamp(Math.round(g + shiftG), 0, 255);
    out[i + 2] = clamp(Math.round(b + shiftB), 0, 255);
    out[i + 3] = orig[i + 3];
  }

  return wrapRawOutput(sharpInstance, out, width, height);
}

/**
 * 5. 焦点引导光学暗角 (local.image.vignette)
 * 自然平滑的椭圆暗角，引导观众目光聚焦于主体画面中央
 */
const vignetteDefaults = {
  radius_ratio: 0.85,    // 视野中心清晰圆半径比例 (0.2 ~ 1.5)
  falloff_feather: 0.45, // 边缘衰减羽化度 (0.1 ~ 0.9)
  darkness: 0.5,         // 边缘压暗深度 (0 ~ 1.0)
  tint_color: '#000000', // 暗角阴影颜色
};
const vignetteBounds = {
  radius_ratio: [0.2, 1.5],
  falloff_feather: [0.1, 0.9],
  darkness: [0, 1.0],
};

function validateVignette(p) {
  for (const [k, [min, max]] of Object.entries(vignetteBounds)) {
    const val = p[k];
    if (typeof val !== 'number' || !Number.isFinite(val) || val < min || val > max) {
      throw fail('INVALID_PARAMETERS', `${k} 需在 ${min} 到 ${max} 之间`);
    }
  }
}

async function applyVignette(sharpInstance, p) {
  validateVignette(p);
  const sharpCtor = sharpInstance.constructor;
  const tint = await sharpCtor({ create: { width: 1, height: 1, channels: 3, background: p.tint_color } }).raw().toBuffer();
  const { data: orig, info } = await sharpInstance
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const out = Buffer.from(orig);

  const cx = width / 2;
  const cy = height / 2;
  const maxR = Math.hypot(cx, cy);
  const innerR = maxR * p.radius_ratio * (1 - p.falloff_feather);
  const outerR = maxR * p.radius_ratio;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const dist = Math.hypot(x - cx, y - cy);

      if (dist <= innerR) continue;

      let factor = 0;
      if (dist >= outerR) {
        factor = p.darkness;
      } else {
        const t = (dist - innerR) / (outerR - innerR);
        // smoothstep
        factor = p.darkness * t * t * (3 - 2 * t);
      }

      const mult = 1.0 - factor;
      out[idx] = Math.round(orig[idx] * mult + tint[0] * factor);
      out[idx + 1] = Math.round(orig[idx + 1] * mult + tint[1] * factor);
      out[idx + 2] = Math.round(orig[idx + 2] * mult + tint[2] * factor);
      out[idx + 3] = orig[idx + 3];
    }
  }

  return wrapRawOutput(sharpInstance, out, width, height);
}

/**
 * 6. 镜头胶片颗粒质感 (local.image.film-grain)
 * 拟真模拟胶卷有机颗粒，消除数字数码感，增加大片质感
 */
const grainDefaults = {
  intensity: 0.12,       // 颗粒强度 (0.01 ~ 0.5)
  size: 1,               // 颗粒粗细 (1 or 2)
  monochrome: true,      // 单色颗粒还是彩色颗粒
};
const grainBounds = {
  intensity: [0.01, 0.5],
  size: [1, 2],
};

function validateFilmGrain(p) {
  for (const [k, [min, max]] of Object.entries(grainBounds)) {
    const val = p[k];
    if (typeof val !== 'number' || !Number.isFinite(val) || val < min || val > max) {
      throw fail('INVALID_PARAMETERS', `${k} 需在 ${min} 到 ${max} 之间`);
    }
  }
}

// 快速轻量线性同余确定性伪随机数生成器（保证相同种子或图像可复核）
function createLCG(seed = 123456789) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return (s >>> 0) / 4294967296;
  };
}

async function applyFilmGrain(sharpInstance, p) {
  validateFilmGrain(p);
  const { data: orig, info } = await sharpInstance
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const out = Buffer.from(orig);

  const rand = createLCG(width * 1000 + height);
  const maxNoise = p.intensity * 255;
  const step = p.size === 2 ? 2 : 1;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const noise = (rand() - 0.5) * 2 * maxNoise;
      const noiseG = p.monochrome ? noise : (rand() - 0.5) * 2 * maxNoise;
      const noiseB = p.monochrome ? noise : (rand() - 0.5) * 2 * maxNoise;

      for (let dy = 0; dy < step && (y + dy) < height; dy++) {
        for (let dx = 0; dx < step && (x + dx) < width; dx++) {
          const idx = ((y + dy) * width + (x + dx)) * 4;
          out[idx] = clamp(Math.round(orig[idx] + noise), 0, 255);
          out[idx + 1] = clamp(Math.round(orig[idx + 1] + noiseG), 0, 255);
          out[idx + 2] = clamp(Math.round(orig[idx + 2] + noiseB), 0, 255);
          out[idx + 3] = orig[idx + 3];
        }
      }
    }
  }

  return wrapRawOutput(sharpInstance, out, width, height);
}

module.exports = {
  applyFrequencySeparation,
  freqDefaults,
  freqBounds,
  applyBilateralDenoise,
  bilateralDefaults,
  bilateralBounds,
  applyDodgeBurn,
  dodgeBurnDefaults,
  dodgeBurnBounds,
  applyColorGrade,
  colorGradeDefaults,
  colorGradeBounds,
  applyVignette,
  vignetteDefaults,
  vignetteBounds,
  applyFilmGrain,
  grainDefaults,
  grainBounds,
};
