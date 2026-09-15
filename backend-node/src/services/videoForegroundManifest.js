'use strict';

/**
 * Manifest definitions and parameter schemas for Video Foreground Operations.
 */

const PARAMETER_BOUNDS = {
  strength: [0.25, 4.0],
  threshold: [0, 250],
  feather_px: [0, 32],
  temporal_smooth: [0, 1.0],
  motion_threshold: [1, 100],
  motion_decay: [0, 0.5],
  inference_size: [128, 640],
  max_pixels: [1024, 40_000_000],
  min_foreground_coverage: [0, 0.5],
  max_foreground_coverage: [0.5, 1.0],
};

const INTEGER_KEYS = new Set([
  'threshold',
  'feather_px',
  'inference_size',
  'max_pixels',
  'motion_threshold',
  'mask_source',
  'bg_source',
]);

const DEFAULTS = {
  model: 'u2netp',
  strength: 1.0,
  threshold: 0,
  feather_px: 0,
  temporal_smooth: 0.25,
  motion_threshold: 24,
  motion_decay: 0.15,
  inference_size: 320,
  max_pixels: 24_000_000,
  min_foreground_coverage: 0.004,
  max_foreground_coverage: 0.985,
  route: 'auto',
  keep_source_alpha: true,
  bg_mode: 'cover', // 'cover' | 'contain' | 'fill'
  output_format: 'mp4', // 'mp4' | 'mov_alpha' | 'webm_alpha'
  transparent_bg: false, // if true in replace mode, outputs transparent foreground without external bg
};

const LIMITATIONS = Object.freeze([
  '自动路径基于 U2Net/U2NetP 显著性主体分割，侧重突出镜头中的人像、商品或单一运动主体，不是开放词表的多目标实例跟踪。',
  '对于极细微飘散发丝、网状细小孔洞（如自行车车架辐条缝隙）与复杂穿透遮挡，受限于 320x320 推理与上下采样，边缘可能出现轻度羽化或平滑。',
  '移动主体采用运动感知自适应时域滤波（Motion-Aware Temporal Refiner），帧差显著区域主动抑制历史混合，根除均值拖尾；低速/静止区域保持 EMA 抑制闪烁。',
  '无主体或对比度过低画面会自动判定为零对象（unchanged），输出物理全黑蒙版，回执覆盖度与实际像素完全一致（清零），不伪造全黑噪点亮斑。',
  '显式用户蒙版路线（user_mask）优先于自动分割，支持静态蒙版图（跨帧复用）与蒙版视频（逐帧同步读取）；背景支持静态图、动态视频及 MOV(qtrle)/WebM(vp9) 透明通道连续输出。',
  '本工具明确限定为本地视频主体提取与换背景候选，不得宣称为任意对象长期任意跟踪、语义角色替换或人脸绑定。',
]);

const PARAMETER_SCHEMA_MASK = {
  type: 'object',
  properties: {
    model: { type: 'string', enum: ['u2netp', 'u2net'], default: 'u2netp', description: '轻量 u2netp 为默认；完整 u2net 权重更大更慢' },
    route: { type: 'string', enum: ['auto', 'user_mask'], default: 'auto', description: 'auto 为本地 ONNX 分割，user_mask 为显式指定蒙版' },
    mask_source: { type: 'integer', minimum: 0, description: '用户蒙版视频或图片在 sources 中的索引' },
    output_format: { type: 'string', enum: ['mp4', 'mov_alpha', 'webm_alpha'], default: 'mp4', description: '输出视频封装格式，mov_alpha/webm_alpha 支持透明通道' },
    temporal_smooth: { type: 'number', minimum: 0, maximum: 1, default: 0.25, description: '静态区域时域平滑因子，抑制闪烁' },
    motion_threshold: { type: 'integer', minimum: 1, maximum: 100, default: 24, description: '运动像素判定阈值，超过则关闭时域平滑避免拖尾' },
    motion_decay: { type: 'number', minimum: 0, maximum: 0.5, default: 0.15, description: '运动区域的时域历史残留系数' },
    feather_px: { type: 'integer', minimum: 0, maximum: 32, default: 0, description: '蒙版边缘羽化半径' },
    strength: { type: 'number', minimum: 0.25, maximum: 4.0, default: 1.0, description: '蒙版强度对比度提升' },
    threshold: { type: 'integer', minimum: 0, maximum: 250, default: 0, description: '低置信度噪点截断' },
    model_dir: { type: 'string', description: '自定义模型目录' },
  },
};

const PARAMETER_SCHEMA_REPLACE = {
  type: 'object',
  properties: {
    ...PARAMETER_SCHEMA_MASK.properties,
    bg_source: { type: 'integer', minimum: 0, description: '替换背景图片或视频在 sources 中的索引（transparent_bg 为 true 时可省略）' },
    bg_mode: { type: 'string', enum: ['cover', 'contain', 'fill'], default: 'cover', description: '背景尺寸适配模式' },
    transparent_bg: { type: 'boolean', default: false, description: '透明背景输出模式，若为 true 且 output_format 为 mov_alpha/webm_alpha 则保留透明背景' },
    keep_source_alpha: { type: 'boolean', default: true, description: '若原前景带有透明通道则融合保留' },
  },
};

module.exports = {
  PARAMETER_BOUNDS,
  INTEGER_KEYS,
  DEFAULTS,
  LIMITATIONS,
  PARAMETER_SCHEMA_MASK,
  PARAMETER_SCHEMA_REPLACE,
};
