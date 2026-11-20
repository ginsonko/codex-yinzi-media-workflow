'use strict';

/**
 * 创作台与媒体工作流 MCP 工具统一返回瘦身器（0.6.8 上下文防爆共享核心）
 *
 * 设计原则：
 * 1. 全链路唯一实现：同时供子模块 MCP 服务端（ESM import）与客户端宿主 media-quick.cjs（CommonJS require）调用，
 *    避免每个工具各写一套截断逻辑。
 * 2. 只留模型决策必看四要素：
 *    - 状态与标识（status / outcome / state / phase / id / job / task_id / generation_id / progress / 计价标量）
 *    - 文件路径与可下载链接（files / file / path / local_path / url / output_refs / artifacts / artifact_paths）
 *    - 出错原因与诊断建议（error / reason / message / code / diagnosis / diagnostics）
 *    - 下一步动作提示（next / next_action / next_actions / note / card / choice / review）
 * 3. 统一剥除非必看大载荷：
 *    - data URI 与长 base64 编码块
 *    - 供应商原始响应快照、完整目录报价快照、模型能力覆盖大表、请求体重复回显、FFmpeg/任务轮询长日志、旧事件与旧尝试历史
 */

const MAX_SESSION_RESULT_CHARS = 7200;
const MAX_SESSION_RESULT_TOKENS = 1850;
const MAX_ACTION_BUNDLE_CHARS = 4200;
const MAX_ACTION_BUNDLE_TOKENS = 1400;
const MAX_MODEL_PREVIEW = 60;

/** 保守估算混合中英文 JSON 的 token 数（汉字约 1.1 token/字，ASCII/JSON 约 3.8 字符/token） */
function estimateJsonTokens(text) {
  const s = String(text || '');
  let cjk = 0;
  let ascii = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fff) cjk++;
    else ascii++;
  }
  return Math.ceil(cjk * 1.1 + ascii / 3.8);
}

function fitsSessionBudget(jsonStr, maxChars, maxTokens) {
  return jsonStr.length <= maxChars && estimateJsonTokens(jsonStr) <= maxTokens;
}

/** 编排节点、生成记录、本地作业中模型无需阅读的冗余大字段集合 */
const BULKY_NODE_KEYS = new Set([
  'response_summary',
  'pricing_snapshot',
  'price_snapshot',
  'capability_snapshot',
  'provider_result',
  'request',
  'request_snapshot',
  'result_snapshot',
  'provider_config_snapshot',
  'submission_receipt',
  'contract_validation',
  'provider_prompt_receipt',
  'model_catalog_snapshot',
  'model_capability_overrides',
  'raw_receipt',
  'ffmpeg_stderr',
  'probe_streams',
  'ffprobe_raw',
  'logs',
  'transcript',
  'raw_history',
]);

/** 文件路径与下载链接字段集合：剥除 data URI，但不做短截断，防止截断真实路径导致后续读取失败 */
const PATH_KEYS = new Set([
  'path',
  'local_path',
  'source_path',
  'output_path',
  'manifest_path',
  'work_dir',
  'file',
  'files',
  'url',
  'urls',
  'image_url',
  'video_url',
  'audio_url',
  'first_frame_url',
  'last_frame_url',
  'frontend_url',
  'workbench_page',
  'artifact_paths',
  '看图用',
]);

/** 完整导出类工具：用户显式请求完整备份/审计包时不裁剪业务列表，仅剥除内联 base64 */
const FULL_EXPORT_TOOLS = new Set(['export_audit']);

/** 编排写操作回执工具：只需确认最新会话状态与当前节点摘要，无需携带大批历史事件 */
const COMPACT_BUNDLE_TOOLS = new Set([
  'begin_media_task',
  'create_session',
  'submit_plan',
  'session_action',
  'node_action',
  'update_node',
  'complete_session',
  'workflow_bridge',
]);

/**
 * 剥除字符串中的 data:...;base64,... 内联媒体与超长连续 base64 块
 * @param {string} value
 * @returns {string}
 */
function stripDataUriAndBase64(value) {
  if (typeof value !== 'string' || value.length < 80) return value;
  return value
    .replace(/data:[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{64,}/g, '[data-uri omitted]')
    .replace(/[A-Za-z0-9+/]{320,}={0,2}/g, '[base64 omitted]');
}

/**
 * 安全截断普通文本（先剥除 base64 / data URI）
 * @param {any} value
 * @param {number} maxLen
 * @returns {any}
 */
function clipShort(value, maxLen = 240) {
  if (typeof value !== 'string') return value;
  const cleaned = stripDataUriAndBase64(value);
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned;
}

/**
 * 清理路径或 URL 字符串：剥除内联 data URI，完整保留真实磁盘路径和 http(s) 链接
 * @param {any} value
 * @returns {any}
 */
function cleanPathOrUrl(value) {
  if (typeof value !== 'string') return value;
  if (/^data:[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+;base64,/i.test(value.trim())) return '[data-uri omitted]';
  return clipShort(value, 2048);
}

/**
 * 通用递归对象精简：剥除 BULKY_NODE_KEYS 与 base64，保留路径完整并对普通长文本限长
 */
function slimObjectStrings(value, maxLen = 200, depth = 0, keyHint = '') {
  if (depth > 5) return '[clipped]';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return PATH_KEYS.has(keyHint) ? cleanPathOrUrl(value) : clipShort(value, maxLen);
  }
  if (Array.isArray(value)) {
    const limit = PATH_KEYS.has(keyHint) ? 40 : 12;
    return value.slice(0, limit).map((item) => slimObjectStrings(item, maxLen, depth + 1, keyHint));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (BULKY_NODE_KEYS.has(key)) continue;
      out[key] = slimObjectStrings(item, maxLen, depth + 1, key);
    }
    return out;
  }
  return clipShort(String(value), maxLen);
}

/**
 * 精简编排节点：移除大块快照与重复请求体，只留状态、输出文件引用、进度与错误原因
 */
function slimNodeForSession(node) {
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (BULKY_NODE_KEYS.has(key)) continue;
    if (key === 'decision' && value && typeof value === 'object') {
      const slimDecision = {};
      for (const [dk, dv] of Object.entries(value)) {
        if (BULKY_NODE_KEYS.has(dk)) continue;
        slimDecision[dk] = slimObjectStrings(dv, 160, 1, dk);
      }
      out.decision = slimDecision;
    } else if (key === 'output_refs' && Array.isArray(value)) {
      out.output_refs = value.slice(-8).map((ref) => ({
        ...(ref?.type ? { type: ref.type } : {}),
        ...(ref?.id != null ? { id: ref.id } : {}),
        ...(ref?.role ? { role: ref.role } : {}),
        ...(ref?.path ? { path: cleanPathOrUrl(ref.path) } : {}),
        ...(ref?.url ? { url: cleanPathOrUrl(ref.url) } : {}),
        ...(ref?.task_id ? { task_id: ref.task_id } : {}),
        ...(ref?.provider_task_id ? { provider_task_id: ref.provider_task_id } : {}),
      }));
    } else if (key === 'input_refs' && Array.isArray(value)) {
      out.input_refs = value.slice(-6).map((ref) => slimObjectStrings(ref, 160, 1));
    } else if (key === 'progress' && value && typeof value === 'object') {
      out.progress = slimObjectStrings(value, 220, 1);
    } else if (key === 'error' && value && typeof value === 'object') {
      out.error = slimObjectStrings(value, 320, 1);
    } else if (PATH_KEYS.has(key)) {
      out[key] = cleanPathOrUrl(value);
    } else {
      out[key] = typeof value === 'string' ? clipShort(value, 240) : value;
    }
  }
  return out;
}

/**
 * 精简图片/视频 generation 记录：只保留对账与交付必看的状态、ID、本地/远端路径与错误原因
 */
function slimGenerationRecord(gen) {
  if (!gen || typeof gen !== 'object') return gen;
  const out = {};
  const scalarKeys = [
    'id',
    'task_id',
    'provider_task_id',
    'provider',
    'model',
    'status',
    'provider_status',
    'generation_status',
    'download_status',
    'submission_status',
    'provider_submission_status',
    'http_status',
    'statusCode',
    'code',
    'error_code',
    'duration',
    'size',
    'aspect_ratio',
    'resolution',
  ];
  for (const k of scalarKeys) {
    if (gen[k] !== undefined && gen[k] !== null && gen[k] !== '') out[k] = gen[k];
  }
  for (const pk of ['local_path', 'video_url', 'image_url', 'url']) {
    if (gen[pk]) out[pk] = cleanPathOrUrl(gen[pk]);
  }
  for (const ek of ['error_msg', 'error_message', 'download_error', 'message', 'reason']) {
    if (gen[ek]) out[ek] = clipShort(String(gen[ek]), 360);
  }
  return out;
}

/**
 * 精简异步 task 记录：剥除轮询日志数组与快照，只保留状态、进度和错误信息
 */
function slimTaskRecord(task) {
  if (!task || typeof task !== 'object') return task;
  const out = {};
  for (const k of ['id', 'type', 'status', 'progress', 'provider_task_id', 'http_status', 'code', 'error_code']) {
    if (task[k] !== undefined && task[k] !== null && task[k] !== '') out[k] = task[k];
  }
  if (task.message) out.message = clipShort(String(task.message), 300);
  if (task.error) out.error = typeof task.error === 'string' ? clipShort(task.error, 360) : slimObjectStrings(task.error, 240, 1);
  return out;
}

/**
 * 保留最近 count 条事件（自动识别正序或倒序）
 */
function pickRecentEvents(events, count = 15) {
  if (!Array.isArray(events)) return [];
  if (events.length <= count) return events;
  const firstTs = Date.parse(events[0]?.created_at || events[0]?.at || '');
  const lastTs = Date.parse(events[events.length - 1]?.created_at || events[events.length - 1]?.at || '');
  if (Number.isFinite(firstTs) && Number.isFinite(lastTs) && firstTs > lastTs) {
    return events.slice(0, count);
  }
  return events.slice(-count);
}

/**
 * 提取会话包中的所有产物路径集合
 */
function collectArtifactPaths(data) {
  const artifactPaths = [];
  if (Array.isArray(data?.artifact_paths)) {
    for (const p of data.artifact_paths) {
      if (typeof p === 'string' && p) {
        const clean = cleanPathOrUrl(p);
        if (!artifactPaths.includes(clean)) artifactPaths.push(clean);
      }
    }
  }
  if (Array.isArray(data?.artifacts)) {
    for (const art of data.artifacts) {
      const p = art?.path || art?.local_path || art?.url;
      if (p && !artifactPaths.includes(p)) artifactPaths.push(cleanPathOrUrl(p));
    }
  }
  if (Array.isArray(data?.nodes)) {
    for (const n of data.nodes) {
      for (const ref of n?.output_refs || []) {
        if (ref?.path) {
          const clean = cleanPathOrUrl(ref.path);
          if (!artifactPaths.includes(clean)) artifactPaths.push(clean);
        }
      }
    }
  }
  return artifactPaths;
}

/**
 * 会话与会话列表统一瘦身器（供 get_session / list_sessions 及所有返回 bundle 的编排工具共用）：
 * - 始终清理节点中的 BULKY_NODE_KEYS（即使总字符数未超阈值也不向模型泄露几万字的快照）
 * - 超出安全上限时裁剪旧事件并附带 truncated: true 说明
 */
function boundSessionResult(toolName, data, maxChars = MAX_SESSION_RESULT_CHARS) {
  if (!data || typeof data !== 'object') return data;

  if (toolName === 'list_sessions') {
    const rawJsonLen = JSON.stringify(data, null, 2).length;
    const rawItems = Array.isArray(data.items) ? data.items : Array.isArray(data.sessions) ? data.sessions : Array.isArray(data) ? data : null;
    if (!rawItems) return slimObjectStrings(data, 200, 0);
    const hasBulkyInItems = rawItems.some((item) => item && typeof item === 'object' && ('nodes' in item || 'events' in item || String(item.user_goal || '').length > 240));
    if (rawJsonLen <= maxChars && !hasBulkyInItems) return data;

    const slimItems = rawItems.map((item) => ({
      id: item?.id ?? item?.session_id ?? null,
      ...(item?.session_id ? { session_id: item.session_id } : {}),
      title: clipShort(item?.title || '', 120),
      status: item?.status || null,
      mode: item?.mode || null,
      user_goal: clipShort(item?.user_goal || '', 160),
      work_dir: item?.work_dir ? cleanPathOrUrl(item.work_dir) : null,
      updated_at: item?.updated_at || null,
      created_at: item?.created_at || null,
    }));
    const overLimit = rawJsonLen > maxChars;
    let count = slimItems.length;
    while (count > 1) {
      const candidate = {
        ...(Array.isArray(data) ? {} : { total: data.total ?? rawItems.length }),
        items: slimItems.slice(0, count),
        ...(overLimit || count < rawItems.length
          ? {
              truncated: true,
              truncation_note: `会话列表超过 ${maxChars} 字符安全上限，已精简字段并保留前 ${count}/${rawItems.length} 条摘要。`,
            }
          : {}),
      };
      if (JSON.stringify(candidate, null, 2).length <= maxChars) return candidate;
      count = Math.max(1, Math.floor(count * 0.7));
    }
    return {
      items: slimItems.slice(0, 1),
      truncated: true,
      truncation_note: `会话列表超过 ${maxChars} 字符安全上限，已裁剪至最小摘要。`,
    };
  }

  const isCompactAction = COMPACT_BUNDLE_TOOLS.has(toolName);
  const effectiveMax = isCompactAction ? Math.min(maxChars, MAX_ACTION_BUNDLE_CHARS) : maxChars;
  const effectiveMaxTokens = isCompactAction ? MAX_ACTION_BUNDLE_TOKENS : MAX_SESSION_RESULT_TOKENS;
  const rawJson = JSON.stringify(data, null, 2);
  const rawJsonLen = rawJson.length;
  const rawOverBudget = !fitsSessionBudget(rawJson, effectiveMax, effectiveMaxTokens);
  const artifactPaths = collectArtifactPaths(data);
  const allSlimNodes = Array.isArray(data.nodes) ? data.nodes.map(slimNodeForSession) : undefined;
  const defaultEventCount = isCompactAction ? 5 : 15;
  const recentEvents = Array.isArray(data.events)
    ? pickRecentEvents(data.events, rawOverBudget || isCompactAction ? defaultEventCount : 25).map((ev) => slimObjectStrings(ev, 100, 0))
    : undefined;

  const baseOut = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'nodes' || key === 'events' || BULKY_NODE_KEYS.has(key)) continue;
    if (key === 'session' && value && typeof value === 'object') {
      baseOut.session = slimObjectStrings(value, 240, 0);
    } else if (key === 'onboarding' && value && typeof value === 'object') {
      baseOut.onboarding = {
        ...(value.connected != null ? { connected: value.connected } : {}),
        ...(Array.isArray(value.next_steps) ? { next_steps: value.next_steps.slice(0, 4).map((s) => clipShort(String(s), 120)) } : {}),
      };
    } else if (key === 'artifacts' && Array.isArray(value)) {
      baseOut.artifacts = value.slice(-30).map((a) => ({
        ...(a?.artifact_id ? { artifact_id: a.artifact_id } : {}),
        ...(a?.id != null ? { id: a.id } : {}),
        ...(a?.type ? { type: a.type } : {}),
        ...(a?.title ? { title: clipShort(a.title, 80) } : {}),
        ...(a?.status ? { status: a.status } : {}),
        ...(a?.path ? { path: cleanPathOrUrl(a.path) } : {}),
        ...(a?.url ? { url: cleanPathOrUrl(a.url) } : {}),
      }));
    } else if (PATH_KEYS.has(key)) {
      baseOut[key] = cleanPathOrUrl(value);
    } else {
      baseOut[key] = slimObjectStrings(value, 240, 0, key);
    }
  }

  // 未超出阈值的小体积 get_session：仅剥除节点冗余大字段，保持原有结构且不打 truncated 标记
  if (!isCompactAction && !rawOverBudget) {
    const cleaned = {
      ...baseOut,
      ...(allSlimNodes ? { nodes: allSlimNodes } : {}),
      ...(recentEvents ? { events: recentEvents } : {}),
    };
    if (fitsSessionBudget(JSON.stringify(cleaned, null, 2), effectiveMax, effectiveMaxTokens)) return cleaned;
  }

  const tiers = isCompactAction
    ? [
        [20, 5],
        [10, 3],
        [5, 0],
      ]
    : [
        [allSlimNodes ? allSlimNodes.length : 0, 15],
        [25, 15],
        [15, 10],
        [10, 5],
        [6, 3],
      ];

  for (const [maxNodes, maxEvents] of tiers) {
    const slicedEvents = recentEvents ? (maxEvents > 0 ? recentEvents.slice(-maxEvents) : []) : undefined;
    const wasTrimmed =
      rawOverBudget ||
      (allSlimNodes && allSlimNodes.length > maxNodes) ||
      (Array.isArray(data.events) && slicedEvents && data.events.length > slicedEvents.length);
    const candidate = {
      ...baseOut,
      ...(allSlimNodes ? { nodes: allSlimNodes.slice(-maxNodes), ...(allSlimNodes.length > maxNodes || rawOverBudget ? { total_nodes: allSlimNodes.length } : {}) } : {}),
      ...(slicedEvents && (slicedEvents.length > 0 || !isCompactAction)
        ? { events: slicedEvents, ...(Array.isArray(data.events) && (data.events.length > slicedEvents.length || rawOverBudget) ? { total_events: data.events.length } : {}) }
        : {}),
      ...(artifactPaths.length ? { artifact_paths: artifactPaths.slice(-40) } : {}),
      ...(!isCompactAction && wasTrimmed
        ? {
            truncated: true,
            truncation_note: `会话返回超过 ${effectiveMax} 字符安全上限，已自动裁剪旧 events 与节点冗余大字段，保留会话状态、节点最新状态、最近 ${slicedEvents ? slicedEvents.length : 0} 条事件与产物路径。`,
          }
        : {}),
    };
    if (fitsSessionBudget(JSON.stringify(candidate, null, 2), effectiveMax, effectiveMaxTokens)) return candidate;
  }

  const fallbackSession =
    baseOut.session && typeof baseOut.session === 'object'
      ? { ...baseOut.session, ...(typeof baseOut.session.user_goal === 'string' ? { user_goal: clipShort(baseOut.session.user_goal, 80) } : {}) }
      : { id: data.id || data.session_id || null, status: data.status || null };
  const keptPaths = artifactPaths.length <= 20 ? artifactPaths : [...new Set([...artifactPaths.slice(0, 5), ...artifactPaths.slice(-15)])];
  return {
    session: fallbackSession,
    ...(baseOut.frontend_url ? { frontend_url: baseOut.frontend_url } : {}),
    total_nodes: allSlimNodes ? allSlimNodes.length : 0,
    nodes: (allSlimNodes || []).slice(-6).map((n) => ({
      node_key: n?.node_key || n?.id,
      status: n?.status,
      progress: n?.progress ? { state: n.progress.state, message: clipShort(n.progress.message || '', 80) } : undefined,
      output_refs: n?.output_refs,
    })),
    events: (recentEvents || []).slice(-3),
    ...(keptPaths.length ? { artifact_paths: keptPaths } : {}),
    truncated: true,
    truncation_note: `会话返回超过 ${effectiveMax} 字符安全上限，已压缩为精简摘要。`,
  };
}

/**
 * 精简 list_model_candidates：剥除 settings 里的几十万字目录快照，保留连接元信息、分组与模型预览
 */
function slimModelCandidates(data, args = {}) {
  if (args && args._internal_full_catalog === true) return data;
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return data;
  return {
    ...data,
    items: data.items.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const out = { ...item };
      if (out.settings) {
        let parsed = out.settings;
        if (typeof parsed === 'string') {
          try {
            parsed = JSON.parse(parsed);
          } catch {
            parsed = null;
          }
        }
        if (parsed && typeof parsed === 'object') {
          const slimSettings = {};
          for (const [sk, sv] of Object.entries(parsed)) {
            if (BULKY_NODE_KEYS.has(sk)) continue;
            slimSettings[sk] = slimObjectStrings(sv, 120, 1, sk);
          }
          const catalogCount = Array.isArray(parsed?.model_catalog_snapshot?.models) ? parsed.model_catalog_snapshot.models.length : 0;
          if (catalogCount > 0) slimSettings.catalog_model_count = catalogCount;
          out.settings = slimSettings;
        } else if (typeof out.settings === 'string') {
          out.settings = clipShort(out.settings, 200);
        }
      }
      if (Array.isArray(out.model) && out.model.length > MAX_MODEL_PREVIEW) {
        const dflt = out.default_model ? [String(out.default_model)] : [];
        const preview = [...new Set([...dflt, ...out.model.slice(0, MAX_MODEL_PREVIEW).map(String)])];
        out.model_count = out.model.length;
        out.model = preview;
        out.model_note = `共 ${out.model_count} 个可用模型，已展示默认及前 ${preview.length} 个；知道模型名可直接传用。`;
      }
      return out;
    }),
  };
}

/**
 * 精简本地媒体处理作业（local_media_run / local_media_get_job / local_media_resume / blender_*）
 */
function slimLocalJob(job) {
  if (!job || typeof job !== 'object') return job;
  const out = {};
  for (const [k, v] of Object.entries(job)) {
    if (BULKY_NODE_KEYS.has(k)) continue;
    if (k === 'events' && Array.isArray(v)) {
      out.total_events = v.length;
      out.events = pickRecentEvents(v, 5).map((ev) => slimObjectStrings(ev, 180, 1));
    } else if (k === 'result' && v && typeof v === 'object') {
      out.result = slimObjectStrings(v, 240, 1);
    } else if (PATH_KEYS.has(k)) {
      out[k] = cleanPathOrUrl(v);
    } else {
      out[k] = slimObjectStrings(v, 240, 0, k);
    }
  }
  if (job.request && typeof job.request === 'object') {
    const reqSummary = {};
    if (job.request.input_path) reqSummary.input_path = cleanPathOrUrl(job.request.input_path);
    if (Array.isArray(job.request.sources)) {
      reqSummary.total_sources = job.request.sources.length;
      reqSummary.sources = job.request.sources.slice(0, 8).map((s) => ({
        ...(s?.role ? { role: s.role } : {}),
        ...(s?.path ? { path: cleanPathOrUrl(s.path) } : {}),
      }));
    }
    if (Object.keys(reqSummary).length) out.request_summary = reqSummary;
  }
  return out;
}

/**
 * 精简无限画布返回（creation_canvas get / operations / generate / job 等）：
 * 保留宿主 syncCanvas / prepCanvas / canvasSfx 与模型编排所需的全部节点状态、连线和媒体路径，
 * 剥除历史 runs、旧 jobs 步骤快照、节点旧 attempts 以及内联预览 base64。
 */
function slimCanvasResult(data, args = {}) {
  if (!data || typeof data !== 'object') return data;
  if (args?.action === 'export') return data;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'runs' && Array.isArray(v)) {
      out.total_runs = v.length;
      out.recent_runs = v.slice(-2).map((r) => ({ id: r?.id, status: r?.status, error: r?.error ? clipShort(String(r.error), 200) : undefined }));
      continue;
    }
    if (k === 'jobs' && Array.isArray(v)) {
      out.total_jobs = v.length;
      out.recent_jobs = v.slice(-3).map((j) => ({
        id: j?.id,
        status: j?.status,
        progress: j?.progress ? slimObjectStrings(j.progress, 140, 1) : undefined,
        media: j?.media ? slimObjectStrings(j.media, 240, 1, 'media') : undefined,
        error: j?.error ? clipShort(String(j.error), 240) : undefined,
      }));
      continue;
    }
    if (k === 'steps' && Array.isArray(v)) {
      out.steps = v.slice(0, 30).map((s) => ({
        node_id: s?.node_id,
        status: s?.status,
        ...(s?.error ? { error: clipShort(String(s.error), 200) } : {}),
      }));
      continue;
    }
    if (k === 'nodes' && Array.isArray(v)) {
      out.nodes = v.map((node) => {
        if (!node || typeof node !== 'object') return node;
        const nd = node.data && typeof node.data === 'object' ? node.data : null;
        let slimData = nd;
        if (nd) {
          slimData = {};
          for (const [dk, dv] of Object.entries(nd)) {
            if (BULKY_NODE_KEYS.has(dk)) continue;
            if (dk === 'attempts' && Array.isArray(dv)) {
              if (dv.length) {
                const last = dv[dv.length - 1];
                slimData.attempt_count = dv.length;
                slimData.last_attempt = {
                  attempt_id: last?.attempt_id || last?.id,
                  status: last?.status,
                  ...(last?.error ? { error: clipShort(String(last.error), 200) } : {}),
                };
              }
              continue;
            }
            if (dk === 'media' && dv && typeof dv === 'object') {
              const cleanMedia = {};
              for (const [mk, mv] of Object.entries(dv)) {
                if (mk === 'preview_data_url' || mk === 'thumbnail_base64') continue;
                cleanMedia[mk] = PATH_KEYS.has(mk) ? cleanPathOrUrl(mv) : slimObjectStrings(mv, 200, 1, mk);
              }
              slimData.media = cleanMedia;
              continue;
            }
            if (dk === 'prompt' || dk === 'text') {
              slimData[dk] = clipShort(String(dv || ''), 500);
              continue;
            }
            slimData[dk] = slimObjectStrings(dv, 200, 1, dk);
          }
        }
        return {
          ...node,
          ...(slimData ? { data: slimData } : {}),
        };
      });
      continue;
    }
    out[k] = PATH_KEYS.has(k) ? cleanPathOrUrl(v) : slimObjectStrings(v, 240, 0, k);
  }
  return out;
}

/**
 * 精简宿主快速工具返回（create_image / create_video / wait_media 等）：
 * 确保异常堆栈、审查长列表或意外混入的 base64 被干净剥离，单次等待稳定 < 2k token。
 */
function slimQuickMediaResult(data) {
  if (!data || typeof data !== 'object') return data;
  const passthroughKeys = new Set([
    'card',
    'prompt_check',
    'delivered_size',
    'camera',
    'choice',
    'renamed',
    'diagnosis',
    'progress',
    'upstream',
    'connections',
  ]);
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (BULKY_NODE_KEYS.has(k)) continue;
    if (PATH_KEYS.has(k)) {
      out[k] = Array.isArray(v) ? v.map(cleanPathOrUrl) : cleanPathOrUrl(v);
    } else if (k === 'error' || k === 'reason' || k === 'message') {
      out[k] = typeof v === 'string' ? clipShort(v, 360) : slimObjectStrings(v, 240, 1);
    } else if (k === 'failed' && Array.isArray(v)) {
      out.failed = v.slice(0, 8).map((f) => ({
        ...(f?.error ? { error: clipShort(String(f.error), 360) } : {}),
        ...(f?.reason ? { reason: clipShort(String(f.reason), 360) } : {}),
        ...(f?.unclear ? { unclear: true } : {}),
      }));
    } else if ((k === 'available' || k === 'alternatives' || k === 'candidates') && Array.isArray(v)) {
      out[k] = v.slice(0, 80).map((item) => clipShort(String(item), 100));
    } else if (k === 'review' && v && typeof v === 'object') {
      const rv = { ...v };
      if (typeof rv.summary === 'string') rv.summary = clipShort(rv.summary, 360);
      if (Array.isArray(rv.issues)) rv.issues = rv.issues.slice(0, 6).map((iss) => slimObjectStrings(iss, 220, 1));
      if (Array.isArray(rv.media_notes)) rv.media_notes = rv.media_notes.slice(0, 6).map((mn) => slimObjectStrings(mn, 180, 1));
      out.review = rv;
    } else if (k === 'note' || k === 'next' || k === 'say') {
      out[k] = typeof v === 'string' ? clipShort(v, 600) : v;
    } else if (passthroughKeys.has(k)) {
      out[k] = v;
    } else if (typeof v === 'string') {
      out[k] = clipShort(v, 400);
    } else if (v && typeof v === 'object') {
      out[k] = slimObjectStrings(v, 240, 1, k);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 统一工具返回瘦身总入口：根据返回数据结构特征与工具契约自动套用同一套瘦身规则
 * @param {string} toolName 工具名称
 * @param {any} data 原始返回数据
 * @param {object} [args] 调用参数
 * @returns {any}
 */
function slimToolResult(toolName, data, args = {}) {
  if (data == null) return data;
  if (typeof data === 'string') return stripDataUriAndBase64(data);
  if (typeof data !== 'object') return data;
  if (FULL_EXPORT_TOOLS.has(toolName)) return data;
  // 作品监督便携包导入/导出与 report_activity 显式 full 模式保持契约原样
  if (toolName === 'style_supervisors' && args?.action === 'export') return data;
  if (toolName === 'report_activity' && args?.response_detail === 'full') return data;

  // 1. 模型候选配置表
  if (toolName === 'list_model_candidates') {
    return slimModelCandidates(data, args);
  }

  // 2. 无限画布
  if (toolName === 'creation_canvas') {
    return slimCanvasResult(data, args);
  }

  // 3. 对账与单次生成工具（reconcile_video / reconcile_image / generate_video_once / generate_image_once）
  if (
    toolName === 'reconcile_video' ||
    toolName === 'reconcile_image' ||
    toolName === 'generate_video_once' ||
    toolName === 'generate_image_once'
  ) {
    const out = {};
    for (const [k, v] of Object.entries(data)) {
      if (k === 'generation') out.generation = slimGenerationRecord(v);
      else if (k === 'task') out.task = slimTaskRecord(v);
      else if (k === 'node') out.node = slimNodeForSession(v);
      else if (k === 'diagnostics' && Array.isArray(v)) {
        out.diagnostics = v.slice(0, 8).map((d) => slimObjectStrings(d, 220, 1));
      } else if (PATH_KEYS.has(k)) {
        out[k] = cleanPathOrUrl(v);
      } else if (typeof v === 'string') {
        out[k] = clipShort(v, 360);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  // 4. 本地媒体作业与 Blender / 视频反推作业
  if (
    toolName === 'local_media_get_job' ||
    toolName === 'local_media_run' ||
    toolName === 'local_media_resume' ||
    toolName === 'video_reverse_prepare' ||
    toolName === 'video_reverse_compile' ||
    toolName === 'blender_get_job' ||
    toolName === 'blender_render_once' ||
    toolName === 'blender_resume_job'
  ) {
    if (data.job && typeof data.job === 'object') {
      return { ...slimObjectStrings(data, 240, 0), job: slimLocalJob(data.job) };
    }
    return slimLocalJob(data);
  }

  // 5. 编排会话查询与所有返回会话 bundle 的工具（统一走 boundSessionResult）
  if (
    toolName === 'get_session' ||
    toolName === 'list_sessions' ||
    COMPACT_BUNDLE_TOOLS.has(toolName) ||
    ('session' in data && ('nodes' in data || 'events' in data))
  ) {
    if (data.bundle && typeof data.bundle === 'object') {
      const { bundle, ...rest } = data;
      return {
        ...slimObjectStrings(rest, 240, 0),
        bundle: boundSessionResult(toolName, bundle),
      };
    }
    return boundSessionResult(toolName, data);
  }

  // 6. 宿主快速生成/等待工具与通用兜底（剥除 base64 / 超长错误详情）
  if (toolName === 'create_image' || toolName === 'create_video' || toolName === 'wait_media' || 'status' in data || 'error' in data || 'message' in data) {
    return slimQuickMediaResult(data);
  }

  return slimObjectStrings(data, 500, 0);
}

module.exports = {
  MAX_SESSION_RESULT_CHARS,
  BULKY_NODE_KEYS,
  PATH_KEYS,
  stripDataUriAndBase64,
  clipShort,
  slimObjectStrings,
  slimNodeForSession,
  slimGenerationRecord,
  slimTaskRecord,
  boundSessionResult,
  slimToolResult,
};
