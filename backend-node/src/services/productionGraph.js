const GRAPH_VERSION = 1;
const HANDLER_VERSION = 1;

const STAGES = Object.freeze([
  { key: 'story_input', macro: 'story', label: '故事输入', scope: 'run', subjective: false },
  { key: 'script', macro: 'story', label: '剧本', scope: 'run', subjective: true },
  { key: 'asset_text', macro: 'assets', label: '资源设定', scope: 'resource', subjective: true },
  { key: 'asset_images', macro: 'assets', label: '资源图', scope: 'resource', source_stage: 'asset_text', subjective: true, media: 'image' },
  { key: 'storyboard_plan', macro: 'previs', label: '分镜脚本', scope: 'shot', subjective: true },
  { key: 'storyboard_images', macro: 'previs', label: '分镜图', scope: 'shot', source_stage: 'storyboard_plan', subjective: true, media: 'image' },
  { key: 'director_plan', macro: 'previs', label: '导演台方案', scope: 'shot', source_stage: 'storyboard_plan', subjective: true },
  { key: 'director_preview', macro: 'previs', label: '3D 分镜视频', scope: 'shot', source_stage: 'director_plan', subjective: true, media: 'video' },
  { key: 'reference_bundle', macro: 'video', label: '参考包', scope: 'shot', source_stage: 'storyboard_plan', subjective: false },
  { key: 'shot_video', macro: 'video', label: '镜头视频', scope: 'shot', source_stage: 'storyboard_plan', subjective: true, media: 'video', paid: true },
  { key: 'final_edit', macro: 'delivery', label: '剪辑交付', scope: 'run', source_stage: 'shot_video', subjective: true, media: 'video' },
]);

// Derived implementation artifacts participate in lineage and export, but are
// not user-facing workflow steps and therefore stay outside STAGES.
const INTERNAL_ARTIFACT_STAGES = Object.freeze([
  { key: 'continuity_frame', macro: 'video', label: '衔接尾帧', scope: 'shot', subjective: false, media: 'image', internal: true },
]);

const MACROS = Object.freeze([
  { key: 'story', label: '故事' },
  { key: 'assets', label: '资产' },
  { key: 'previs', label: '分镜与预演' },
  { key: 'video', label: '视频生成' },
  { key: 'delivery', label: '剪辑交付' },
]);

const REVIEW_OWNERS = new Set(['human', 'ai', 'auto_accept']);
const NEXT_STRATEGIES = new Set(['auto_generate', 'manual_add']);
const RUN_STATUSES = new Set([
  'draft', 'running', 'waiting_review', 'waiting_client', 'waiting_provider',
  'paused', 'completed', 'failed', 'cancelled',
]);
const ARTIFACT_STATUSES = new Set([
  'draft', 'reviewing', 'approved', 'rejected', 'superseded', 'invalidated', 'failed',
]);
const ACTION_STATUSES = new Set([
  'reserved', 'submitted', 'waiting', 'completed', 'failed', 'ambiguous', 'cancelled',
]);
const REVIEW_TYPES = new Set(['human', 'ai', 'deterministic']);
const REVIEW_DECISIONS = new Set(['approved', 'rejected', 'needs_human']);

function getStage(key) {
  return STAGES.find((item) => item.key === key)
    || INTERNAL_ARTIFACT_STAGES.find((item) => item.key === key)
    || null;
}

function stageIndex(key) {
  return STAGES.findIndex((item) => item.key === key);
}

function nextStage(key) {
  const index = stageIndex(key);
  return index >= 0 && index < STAGES.length - 1 ? STAGES[index + 1] : null;
}

function stagesAfter(key) {
  const index = stageIndex(key);
  return index < 0 ? [] : STAGES.slice(index + 1).map((item) => item.key);
}

function assertEnum(value, allowed, field) {
  if (!allowed.has(value)) throw new Error(`${field} 不支持值 ${value}`);
  return value;
}

function normalizeReviewOwner(value) {
  return assertEnum(value || 'human', REVIEW_OWNERS, 'review_owner');
}

function normalizeNextStrategy(value) {
  return assertEnum(value || 'auto_generate', NEXT_STRATEGIES, 'next_stage_strategy');
}

module.exports = {
  GRAPH_VERSION,
  HANDLER_VERSION,
  STAGES,
  INTERNAL_ARTIFACT_STAGES,
  MACROS,
  REVIEW_OWNERS,
  NEXT_STRATEGIES,
  RUN_STATUSES,
  ARTIFACT_STATUSES,
  ACTION_STATUSES,
  REVIEW_TYPES,
  REVIEW_DECISIONS,
  getStage,
  stageIndex,
  nextStage,
  stagesAfter,
  assertEnum,
  normalizeReviewOwner,
  normalizeNextStrategy,
};
