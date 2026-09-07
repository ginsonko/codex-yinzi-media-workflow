const ASPECT_RATIO_SPECS = Object.freeze({
  '16:9': Object.freeze({ value: 16 / 9, orientation: 'landscape', label: '横屏 16:9' }),
  '9:16': Object.freeze({ value: 9 / 16, orientation: 'portrait', label: '竖屏 9:16' }),
  '1:1': Object.freeze({ value: 1, orientation: 'square', label: '方形 1:1' }),
  '4:3': Object.freeze({ value: 4 / 3, orientation: 'landscape', label: '横屏 4:3' }),
  '21:9': Object.freeze({ value: 21 / 9, orientation: 'landscape', label: '超宽屏 21:9' }),
});

function normalizeProductionAspectRatio(value, fallback = '16:9') {
  const normalized = String(value || '').trim().replace(/\uFF1A/g, ':');
  if (ASPECT_RATIO_SPECS[normalized]) return normalized;
  return ASPECT_RATIO_SPECS[fallback] ? fallback : '16:9';
}

function productionAspectSpec(value, fallback = '16:9') {
  const aspectRatio = normalizeProductionAspectRatio(value, fallback);
  return { aspect_ratio: aspectRatio, ...ASPECT_RATIO_SPECS[aspectRatio] };
}

function productionAspectPrompt(value) {
  const spec = productionAspectSpec(value);
  const direction = spec.orientation === 'portrait'
    ? '竖向构图，高度必须明显大于宽度'
    : spec.orientation === 'square'
      ? '方形构图，宽高基本相等'
      : '横向构图，宽度必须明显大于高度';
  return `目标画幅 ${spec.aspect_ratio}（${direction}）。最终单张画面的像素宽高比必须接近 ${spec.aspect_ratio}，不得用横图裁成竖图或用留白伪装画幅。`;
}

function validateProductionMediaAspect(width, height, expectedAspectRatio, options = {}) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error('媒体缺少可校验的像素尺寸');
  }
  const spec = productionAspectSpec(expectedAspectRatio);
  const actual = w / h;
  const relativeError = Math.abs(actual - spec.value) / spec.value;
  const tolerance = Math.max(0.01, Number(options.tolerance ?? 0.08));
  if (relativeError > tolerance) {
    const error = new Error(`媒体画幅 ${w}x${h}（${actual.toFixed(3)}）不符合任务要求 ${spec.aspect_ratio}`);
    error.code = 'PRODUCTION_ASPECT_RATIO_MISMATCH';
    error.details = {
      expected_aspect_ratio: spec.aspect_ratio,
      expected_value: spec.value,
      actual_value: actual,
      width: w,
      height: h,
      relative_error: relativeError,
      tolerance,
    };
    throw error;
  }
  return {
    expected_aspect_ratio: spec.aspect_ratio,
    actual_aspect_ratio: Number(actual.toFixed(6)),
    aspect_ratio_relative_error: Number(relativeError.toFixed(6)),
    aspect_ratio_tolerance: tolerance,
    aspect_ratio_valid: true,
  };
}

module.exports = {
  ASPECT_RATIO_SPECS,
  normalizeProductionAspectRatio,
  productionAspectSpec,
  productionAspectPrompt,
  validateProductionMediaAspect,
};
