const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /(?:api[_-]?key|authorization|token)\s*[:=]\s*[^\s,;]+/gi,
  /[A-Za-z]:\\[^\r\n]+/g,
];

const AMBIGUOUS_CODES = new Set([
  'AMBIGUOUS_ACTION', 'IMAGE_CREATE_AMBIGUOUS', 'IMAGE_GENERATION_AMBIGUOUS',
  'VIDEO_CREATE_AMBIGUOUS',
]);

const BUDGET_CODES = new Set([
  'VIDEO_ATTEMPT_BUDGET', 'VIDEO_SECONDS_BUDGET', 'AUTOMATION_LIMIT_REACHED',
  'IMAGE_REVISION_LIMIT', 'DIRECTOR_REVISION_LIMIT', 'SHOT_VIDEO_ATTEMPT_LIMIT',
]);

const RESOURCE_CODES = new Set([
  'VIDEO_ROUTE_NO_ELIGIBLE_MODEL', 'VIDEO_ROUTE_CATALOG_UNAVAILABLE',
  'VIDEO_ROUTE_MODEL_UNAVAILABLE', 'VIDEO_ROUTE_GROUP_UNAVAILABLE',
  'VIDEO_CONFIG_UNAVAILABLE', 'VIDEO_CONFIG_INCOMPLETE',
  'STRICT_FIRST_FRAME_UNSUPPORTED', 'PRODUCTION_MEDIA_MISSING',
]);

const DETERMINISTIC_RESOURCE_PATTERNS = [
  /no eligible automatic route/i,
  /no available channel for model/i,
  /image generation is not enabled for this group/i,
  /\bmodel_not_found\b/i,
  /(?:当前|该|此).*模型.*没有可用.*(?:渠道|路由)/i,
  /(?:分组|group).*(?:未启用|不支持|not enabled).*(?:图片|图像|image|视频|video)/i,
];

const WORKFLOW_CONVERGENCE_CODES = new Set([
  'SOURCE_CHANGED_WHILE_ACTION_ACTIVE',
  'STALE_SOURCE_ARTIFACT',
  'STALE_REFERENCE_BUNDLE',
]);

const WORKFLOW_WAIT_CODES = new Set([
  'STAGE_HANDLER_PENDING',
  'VIDEO_PROMPT_PLAN_IN_PROGRESS',
  'IMAGE_GENERATION',
  'VIDEO_GENERATION',
  'SUPERSEDED_VIDEO_WAITING',
  'FINAL_MERGE',
  'PROVIDER_TASK_PENDING',
  'VIDEO_DOWNLOAD_PENDING',
  'VIDEO_DOWNLOAD_RETRY',
  'STATUS_CONVERGENCE_PENDING',
]);

function clean(value, max = 800) {
  let result = String(value || '');
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, '[REDACTED]');
  return result.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function objectKey(input = {}) {
  return [input.stage || 'unknown', input.scope_type || 'run', input.scope_id == null ? '' : input.scope_id]
    .map((item) => String(item))
    .join(':');
}

function limitFor(run, stage, kind = 'generation') {
  const budget = run?.budget || {};
  if (stage === 'shot_video') return Math.max(1, Number(budget.max_video_attempts_per_shot) || 2);
  if (['asset_images', 'storyboard_images'].includes(stage)) return Math.max(1, Number(budget.max_image_revisions) || 3);
  if (['director_plan', 'director_preview'].includes(stage)) return Math.max(1, Number(budget.max_director_revisions) || 2);
  if (kind === 'review' || ['script', 'asset_text', 'storyboard_plan'].includes(stage)) {
    return Math.max(1, Number(budget.max_text_revisions) || 3);
  }
  return Math.max(1, Number(budget.max_auto_recoveries) || 3);
}

function classifyFailure(input = {}) {
  const code = clean(input.code || input.error_code || 'AUTOMATION_FAILURE', 120).toUpperCase();
  const message = clean(input.message || input.error_message || '', 800);
  const stage = clean(input.stage || '', 80).toLowerCase();
  if (WORKFLOW_CONVERGENCE_CODES.has(code) || /source_changed_while_action_active/i.test(message)) {
    return { category: 'workflow_convergence', recoverable: true, counts_as_failure: false, code, message };
  }
  if (WORKFLOW_WAIT_CODES.has(code)) {
    return { category: 'workflow_wait', recoverable: true, counts_as_failure: false, code, message };
  }
  if (AMBIGUOUS_CODES.has(code) || /ambiguous|结果不明确|状态不明确/i.test(message)) {
    return { category: 'ambiguous_external_task', recoverable: false, stop_reason: 'ambiguous_external_task', code, message };
  }
  if (BUDGET_CODES.has(code) || /超过预算|额度不足|budget/i.test(message)) {
    return { category: 'budget_exhausted', recoverable: false, stop_reason: 'budget_exhausted', code, message };
  }
  if (DETERMINISTIC_RESOURCE_PATTERNS.some((pattern) => pattern.test(`${code} ${message}`))) {
    return {
      category: 'resource_unavailable',
      recoverable: false,
      stop_reason: 'resource_unavailable',
      code,
      message,
    };
  }
  if (/未配置视频模型|video model (?:is )?not configured/i.test(message)
    && /VIDEO_(?:GENERATION|CREATE)_FAILED/.test(code)) {
    return { category: 'configuration_binding_failure', recoverable: true, allow_model_switch: false, code, message };
  }
  if (RESOURCE_CODES.has(code) || /没有可用|找不到.*模型|no enabled video configuration/i.test(message)) {
    return { category: 'resource_unavailable', recoverable: false, stop_reason: 'resource_unavailable', code, message };
  }
  const videoFailure = stage === 'shot_video' || /^VIDEO_/.test(code);
  const moderationRejected = /moderation|content[ _-]?policy|safety[ _-]?(?:policy|check|reject)|risk[ _-]?control|内容(?:安全)?审核|审核(?:未通过|不通过|失败|拒绝)|安全策略|风控(?:拦截|拒绝)?|敏感内容/i.test(message)
    || /(?:CONTENT|MODERATION|SAFETY|RISK_CONTROL).*(?:REJECT|FAILED|BLOCK)/.test(code);
  if (videoFailure && moderationRejected) {
    return { category: 'content_moderation_failure', recoverable: true, allow_model_switch: true, code, message };
  }
  if (/MODEL_UNAVAILABLE|PROVIDER|HTTP_?5\d\d|TIMEOUT|RATE_LIMIT|GENERATION_FAILED|CREATE_FAILED/.test(code)
    || /temporar|timeout|timed out|上游|审核|生成失败|不可用|限流/i.test(message)) {
    return { category: 'provider_or_content_failure', recoverable: true, allow_model_switch: true, code, message };
  }
  if (/VALIDATION|MISMATCH|STALE|INVALID/.test(code) || /校验|不一致|画幅|时长|编码|失效/i.test(message)) {
    return { category: 'validation_failure', recoverable: true, allow_model_switch: false, code, message };
  }
  return { category: 'unknown_failure', recoverable: true, allow_model_switch: false, code, message };
}

function recordAttempt(run, input = {}) {
  const runtime = JSON.parse(JSON.stringify(run?.runtime || {}));
  const autonomy = runtime.autonomy && typeof runtime.autonomy === 'object' ? runtime.autonomy : {};
  const objects = autonomy.objects && typeof autonomy.objects === 'object' ? autonomy.objects : {};
  const key = objectKey(input);
  const previous = objects[key] && typeof objects[key] === 'object' ? objects[key] : {};
  const kind = input.kind === 'review' ? 'review' : 'generation';
  const countKey = kind === 'review' ? 'consecutive_review_failures' : 'consecutive_generation_failures';
  const count = Math.max(0, Number(previous[countKey]) || 0) + 1;
  const configuredLimit = Number(input.limit);
  const limit = Number.isFinite(configuredLimit)
    ? Math.min(20, Math.max(1, Math.floor(configuredLimit)))
    : limitFor(run, input.stage, kind);
  const attempt = {
    at: input.at || new Date().toISOString(),
    kind,
    decision: clean(input.decision, 80) || null,
    error_code: clean(input.error_code || input.code, 120) || null,
    reason: clean(input.reason || input.message, 800),
    model: clean(input.model, 200) || null,
    action: clean(input.action, 120) || null,
  };
  objects[key] = {
    ...previous,
    stage: String(input.stage || 'unknown'),
    scope_type: String(input.scope_type || 'run'),
    scope_id: input.scope_id == null ? '' : String(input.scope_id),
    [countKey]: count,
    last_failure: attempt,
    attempts: [...(Array.isArray(previous.attempts) ? previous.attempts : []), attempt].slice(-12),
    escalated: input.force_escalate === true || count >= limit,
    escalation_reason: input.force_escalate === true
      ? clean(input.escalation_reason || 'automation_intervention_required', 120)
      : count >= limit ? 'automation_limit_reached' : null,
  };
  runtime.autonomy = { ...autonomy, objects, updated_at: attempt.at };
  return { runtime, key, count, limit, exhausted: objects[key].escalated, object: objects[key] };
}

function clearObject(run, input = {}) {
  const runtime = JSON.parse(JSON.stringify(run?.runtime || {}));
  const autonomy = runtime.autonomy && typeof runtime.autonomy === 'object' ? runtime.autonomy : {};
  const objects = autonomy.objects && typeof autonomy.objects === 'object' ? { ...autonomy.objects } : {};
  delete objects[objectKey(input)];
  runtime.autonomy = { ...autonomy, objects, updated_at: new Date().toISOString() };
  return runtime;
}

function objectState(run, input = {}) {
  const objects = run?.runtime?.autonomy?.objects;
  if (!objects || typeof objects !== 'object') return null;
  return objects[objectKey(input)] || null;
}

function diagnosticPrompts(input = {}) {
  const failure = classifyFailure(input);
  const context = {
    stage: clean(input.stage, 80),
    scope_type: clean(input.scope_type, 80),
    scope_id: clean(input.scope_id, 120),
    error_code: failure.code,
    safe_error: failure.message,
    category: failure.category,
    current_model: clean(input.model, 200) || null,
    attempt: Math.max(1, Number(input.attempt) || 1),
    compatible_model_switch_allowed: input.allow_model_switch === true,
  };
  return {
    system: `You diagnose a bounded AI film-production workflow failure. Return one JSON object only:
{"action":"retry_same_model|switch_model|revise_prompt|stop","root_cause":"...","correction":"...","model_requirements":"..."}
Choose stop only when the evidence says retrying would repeat a non-recoverable failure. Convert content or prompt failures into a concise positive correction that the next generation planner can apply. Never request credentials, local paths, database content, or hidden request headers.`,
    user: `Sanitized failure context:\n${JSON.stringify(context)}\nSelect exactly one allowed action and give a concrete correction.`,
  };
}

function normalizeDiagnosis(raw, fallback = {}) {
  let parsed = raw;
  if (typeof raw === 'string') {
    const cleanRaw = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    try { parsed = JSON.parse(cleanRaw); } catch (_) { parsed = {}; }
  }
  const allowed = new Set(['retry_same_model', 'switch_model', 'revise_prompt', 'stop']);
  const defaultAction = fallback.allow_model_switch ? 'switch_model' : 'retry_same_model';
  return {
    action: allowed.has(parsed?.action) ? parsed.action : defaultAction,
    root_cause: clean(parsed?.root_cause || fallback.root_cause || fallback.reason || '未获得可解析的诊断结果', 800),
    correction: clean(parsed?.correction || fallback.correction || fallback.reason || '保持已确认设定并重新生成', 1600),
    model_requirements: clean(parsed?.model_requirements || fallback.model_requirements || '', 800),
  };
}

function escalationSummary(state = {}) {
  const attempts = Array.isArray(state.attempts) ? state.attempts : [];
  const failure = classifyFailure({
    code: state.last_failure?.error_code,
    message: state.last_failure?.reason,
    stage: state.stage,
  });
  const resourceUnavailable = failure.category === 'resource_unavailable';
  return {
    title: resourceUnavailable ? '当前模型暂无可用渠道' : '自动处理已达到上限',
    reason: clean(state.last_failure?.reason || '连续尝试未解决当前问题', 800),
    attempted: attempts.map((item) => ({
      at: item.at,
      kind: item.kind,
      action: item.action,
      model: item.model,
      error_code: item.error_code,
      reason: item.reason,
    })),
    normalized_category: failure.category,
    retryable: failure.recoverable,
    suggestion: resourceUnavailable
      ? '系统已停止重复提交。请在“检查模型与配置”中选择另一个已配置且可用的图片/视频渠道，或等待当前上游恢复后再继续。'
      : '请检查最后一次诊断、可用模型和剩余额度后，再决定重试、修改内容或切换为人工模式。',
    next_actions: resourceUnavailable
      ? ['switch_configured_channel', 'wait_for_provider_recovery']
      : ['inspect_diagnosis', 'revise_or_retry'],
  };
}

module.exports = {
  classifyFailure,
  clearObject,
  diagnosticPrompts,
  escalationSummary,
  limitFor,
  normalizeDiagnosis,
  objectKey,
  objectState,
  recordAttempt,
  sanitizeFailureText: clean,
};
