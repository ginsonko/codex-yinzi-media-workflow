const acceptanceSafety = require('./acceptanceSafety');
const { videoDownloadError } = require('./videoDownloadError');

/** 轮询/同步返回的 video_url 须为 http(s)，避免中转 FAILURE 时 result_url 为错误文案 */
function resolveRemoteVideoUrl(videoUrl, fallbackError) {
  if (videoUrl && videoClient.isPlausibleHttpVideoUrl(videoUrl)) {
    return { ok: true, video_url: String(videoUrl).trim() };
  }
  if (videoUrl) {
    return { ok: false, error: (fallbackError || String(videoUrl)).slice(0, 500) };
  }
  return { ok: false, error: (fallbackError || '超时或失败').slice(0, 500) };
}

const VIDEO_SUBMISSION_STATUSES = new Set(['not_sent', 'rejected', 'accepted', 'ambiguous']);

function parseObject(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function submissionStatusForRow(row) {
  const stored = String(row?.submission_status || '').trim().toLowerCase();
  if (VIDEO_SUBMISSION_STATUSES.has(stored)) return stored;
  if (row?.provider_task_id || row?.generation_status === 'completed' || row?.status === 'completed') return 'accepted';
  if (row?.generation_status === 'ambiguous') return 'ambiguous';
  if (row?.generation_status === 'failed' || row?.status === 'failed') return 'ambiguous';
  return 'not_sent';
}

function sanitizeSubmissionReceipt(input = {}, status) {
  const receipt = input && typeof input === 'object' ? input : {};
  const recovery = receipt.smart_route_recovery && typeof receipt.smart_route_recovery === 'object'
    ? receipt.smart_route_recovery : null;
  return {
    version: 1,
    status,
    phase: receipt.phase ? String(receipt.phase).slice(0, 80) : status,
    http_status: receipt.http_status != null && Number.isInteger(Number(receipt.http_status)) ? Number(receipt.http_status) : null,
    error_code: receipt.error_code ? String(receipt.error_code).slice(0, 120) : null,
    request_id: receipt.request_id ? String(receipt.request_id).slice(0, 160) : null,
    response_request_id: receipt.response_request_id ? String(receipt.response_request_id).slice(0, 160) : null,
    provider_status: receipt.provider_status ? String(receipt.provider_status).slice(0, 80) : null,
    message: receipt.message ? String(receipt.message).slice(0, 500) : null,
    model: receipt.model ? String(receipt.model).slice(0, 240) : null,
    endpoint: receipt.endpoint ? String(receipt.endpoint).slice(0, 240) : null,
    reference_summary: receipt.reference_summary && typeof receipt.reference_summary === 'object'
      ? receipt.reference_summary
      : null,
    smart_route_recovery: recovery ? {
      version: 1,
      attempted: recovery.attempted === true,
      from_model: recovery.from_model ? String(recovery.from_model).slice(0, 240) : null,
      to_model: recovery.to_model ? String(recovery.to_model).slice(0, 240) : null,
      trigger: recovery.trigger ? String(recovery.trigger).slice(0, 160) : null,
      first_error_code: recovery.first_error_code ? String(recovery.first_error_code).slice(0, 120) : null,
      first_http_status: Number.isFinite(Number(recovery.first_http_status)) ? Number(recovery.first_http_status) : null,
      second_status: recovery.second_status ? String(recovery.second_status).slice(0, 40) : null,
      second_http_status: Number.isFinite(Number(recovery.second_http_status)) ? Number(recovery.second_http_status) : null,
      observed_at: recovery.observed_at || new Date().toISOString(),
    } : null,
    observed_at: receipt.observed_at || new Date().toISOString(),
  };
}

function persistVideoSubmissionState(db, videoGenId, status, input = {}) {
  const normalized = String(status || '').trim().toLowerCase();
  if (!VIDEO_SUBMISSION_STATUSES.has(normalized)) {
    throw new Error(`Unknown video submission status: ${status}`);
  }
  const incoming = { ...(input.receipt || {}) };
  const newDispatch = normalized === 'not_sent' || ['post_started', 'provider_dispatch_started'].includes(incoming.phase);
  if (!newDispatch) {
    const previous = parseObject(db.prepare('SELECT submission_receipt_json FROM video_generations WHERE id = ?').get(Number(videoGenId))?.submission_receipt_json);
    if (previous && (!incoming.model || !previous.model || incoming.model === previous.model)) {
      incoming.reference_summary ??= previous.reference_summary;
      incoming.endpoint ??= previous.endpoint;
      incoming.response_request_id ??= previous.response_request_id;
    }
  }
  const receipt = sanitizeSubmissionReceipt(incoming, normalized);
  const httpStatus = input.http_status != null && Number.isInteger(Number(input.http_status)) ? Number(input.http_status) : receipt.http_status;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE video_generations SET submission_status = ?, submission_http_status = ?,
     submission_receipt_json = ?, updated_at = ? WHERE id = ?`
  ).run(normalized, httpStatus, JSON.stringify(receipt), now, Number(videoGenId));
  return { status: normalized, http_status: httpStatus, receipt };
}

/** 将 video_generations 标为失败；若无 error_msg 列则只更新 status/updated_at */
function setVideoGenFailed(db, videoGenId, errorMsg, now, options = {}) {
  const submissionStatus = options.submission_status
    ? String(options.submission_status).trim().toLowerCase()
    : null;
  if (submissionStatus && VIDEO_SUBMISSION_STATUSES.has(submissionStatus)) {
    persistVideoSubmissionState(db, videoGenId, submissionStatus, {
      http_status: options.submission_http_status,
      receipt: options.submission_receipt,
    });
  }
  const generationStatus = options.generation_status
    || (submissionStatus === 'ambiguous' ? 'ambiguous' : 'failed');
  try {
    db.prepare(
      `UPDATE video_generations
       SET status = 'failed', generation_status = ?, error_msg = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      generationStatus, (errorMsg || '').slice(0, 500), now, videoGenId
    );
  } catch (e) {
    if ((e.message || '').includes('generation_status')) {
      db.prepare('UPDATE video_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?').run(
        'failed', (errorMsg || '').slice(0, 500), now, videoGenId
      );
    } else if ((e.message || '').includes('error_msg')) {
      db.prepare('UPDATE video_generations SET status = ?, updated_at = ? WHERE id = ?').run('failed', now, videoGenId);
    } else throw e;
  }
}

function list(db, query) {
  let sql = 'FROM video_generations WHERE deleted_at IS NULL';
  const params = [];
  if (query.drama_id) {
    sql += ' AND drama_id = ?';
    params.push(query.drama_id);
  }
  if (query.storyboard_id) {
    sql += ' AND storyboard_id = ?';
    params.push(query.storyboard_id);
  }
  // 与 Go 前端行为对齐：请求 status=processing 时，同时包含“刚结束”的记录（5 分钟内变为 completed/failed），
  // 这样轮询刷新后任务不会从列表消失，无需改 Vue
  if (query.status === 'processing') {
    sql += " AND (status = 'processing' OR (status IN ('completed','failed') AND updated_at >= datetime('now', '-5 minutes')))";
  } else if (query.status) {
    sql += ' AND status = ?';
    params.push(query.status);
  }
  const countRow = db.prepare('SELECT COUNT(*) as total ' + sql).get(...params);
  const total = countRow.total || 0;
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.page_size, 10) || 20));
  const offset = (page - 1) * pageSize;
  const rows = db.prepare('SELECT * ' + sql + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params, pageSize, offset);
  return { items: rows.map(rowToItem), total, page, pageSize };
}

function rowToItem(r) {
  return {
    id: r.id,
    storyboard_id: r.storyboard_id,
    drama_id: r.drama_id,
    provider: r.provider,
    prompt: r.prompt,
    model: r.model,
    duration: r.duration,
    aspect_ratio: r.aspect_ratio,
    resolution: r.resolution,
    seed: r.seed,
    camera_fixed: r.camera_fixed == null ? null : Boolean(r.camera_fixed),
    watermark: r.watermark == null ? null : Boolean(r.watermark),
    image_gen_id: r.image_gen_id,
    image_url: r.image_url,
    first_frame_url: r.first_frame_url,
    last_frame_url: r.last_frame_url,
    reference_image_urls: r.reference_image_urls,
    reference_video_urls: r.reference_video_urls,
    reference_audio_urls: r.reference_audio_urls,
    video_url: r.video_url,
    local_path: r.local_path,
    status: r.status,
    generation_status: r.generation_status || legacyGenerationStatus(r),
    download_status: r.download_status || legacyDownloadStatus(r),
    remote_video_url: r.remote_video_url || null,
    download_source_url: r.download_source_url || null,
    download_requires_auth: Boolean(r.download_requires_auth),
    download_error: r.download_error || null,
    download_attempts: Number(r.download_attempts || 0),
    download_started_at: r.download_started_at || null,
    download_completed_at: r.download_completed_at || null,
    provider_completed_at: r.provider_completed_at || null,
    video_config_id: r.video_config_id == null ? null : Number(r.video_config_id),
    provider_protocol: r.provider_protocol || null,
    provider_config_snapshot: parseObject(r.provider_config_snapshot_json),
    submission_status: submissionStatusForRow(r),
    submission_http_status: r.submission_http_status == null ? null : Number(r.submission_http_status),
    submission_receipt: parseObject(r.submission_receipt_json),
    contract_validation_mode: videoClient.normalizeContractValidationMode(r.contract_validation_mode),
    contract_validation: parseObject(r.contract_validation_receipt_json),
    task_id: r.task_id,
    provider_task_id: r.provider_task_id,
    prompt_contract: parseObject(r.prompt_contract_json),
    provider_prompt_receipt: parseObject(r.provider_prompt_receipt_json),
    error_msg: r.error_msg,
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at,
  };
}

function buildReferenceTransport(row, lists = {}) {
  const referenceUrls = Array.isArray(lists.images) ? lists.images : [];
  const referenceVideoUrls = Array.isArray(lists.videos) ? lists.videos : [];
  const referenceAudioUrls = Array.isArray(lists.audios) ? lists.audios : [];
  const referenceCount = referenceUrls.length + referenceVideoUrls.length + referenceAudioUrls.length
    + (row.first_frame_url ? 1 : 0) + (row.last_frame_url ? 1 : 0);
  const hasReferences = referenceCount > 0;
  return {
    reference_count: referenceCount,
    image_url: hasReferences ? undefined : row.image_url,
    first_frame_url: row.first_frame_url || undefined,
    last_frame_url: row.last_frame_url || undefined,
    reference_urls: referenceUrls,
    reference_video_urls: referenceVideoUrls,
    reference_audio_urls: referenceAudioUrls,
  };
}

function getById(db, id) {
  const r = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  return r ? rowToItem(r) : null;
}

/**
 * Attach a user-supplied provider task id to an ambiguous local generation.
 * One read-only provider probe is required before the id is persisted.  The
 * probe never creates a task and the existing local generation remains the
 * sole workflow identity.
 */
async function attachProviderTaskForRecovery(db, log, videoGenId, providerTaskId, injected = {}) {
  const numericId = Number(videoGenId);
  const taskId = String(providerTaskId || '').trim();
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    const error = new Error('本地视频记录无效'); error.code = 'VIDEO_GENERATION_INVALID'; throw error;
  }
  if (!taskId) {
    const error = new Error('请填写银子 API 任务记录中的任务 ID'); error.code = 'PROVIDER_TASK_ID_REQUIRED'; throw error;
  }
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(numericId);
  if (!row) {
    const error = new Error('本地视频记录不存在'); error.code = 'VIDEO_GENERATION_NOT_FOUND'; throw error;
  }
  const existingTaskId = String(row.provider_task_id || '').trim();
  if (existingTaskId && existingTaskId !== taskId) {
    const error = new Error(`这条记录已经绑定上游任务 ${existingTaskId}，不能静默替换`);
    error.code = 'PROVIDER_TASK_ID_CONFLICT';
    throw error;
  }
  if (existingTaskId === taskId) {
    if (!injected.disable_resume) setImmediate(() => resumePollForVideoGeneration(db, log, numericId).catch((error) => {
      log.error('Attached provider task resume failed', { videoGenId: numericId, error: error.message });
    }));
    return { reused: true, generation: getById(db, numericId), probe: null };
  }
  const config = injected.video_config || resolvePersistedVideoConfig(db, row);
  if (!config) {
    const error = new Error('原视频配置已不可用，请先恢复对应 URL / Key 配置后再核对原任务');
    error.code = 'VIDEO_CONFIG_UNAVAILABLE';
    throw error;
  }
  const probe = injected.probe
    ? await injected.probe({ db, log, generation: rowToItem(row), provider_task_id: taskId, config })
    : await videoClient.pollVideoTask(db, log, numericId, taskId, config, 1, 0, row.prompt);
  const status = String(probe?.status || probe?.provider_status || '').trim().toLowerCase();
  const providerFailed = (Boolean(probe?.error) || ['failed', 'error', 'cancelled'].includes(status))
    && !probe?.pending && !probe?.video_url && !probe?.content_url;
  const recognized = Boolean(
    probe?.pending || probe?.video_url || probe?.content_url || probe?.progress != null
      || ['queued', 'pending', 'processing', 'running', 'completed', 'succeeded', 'success', 'failed', 'error'].includes(status)
  );
  if (!recognized) {
    const error = new Error('上游没有返回可验证的任务状态，暂未绑定；请核对任务 ID 后再试');
    error.code = 'PROVIDER_TASK_NOT_VERIFIED';
    error.details = { provider_status: status || null };
    throw error;
  }
  const now = new Date().toISOString();
  const completedUrl = probe?.video_url || probe?.content_url || null;
  // A terminal word without a retrievable URL is not enough to claim local
  // completion.  Keep polling the same task until a media address appears.
  const providerCompleted = Boolean(completedUrl);
  const requiresLocalDownload = providerCompleted && (
    Boolean(probe?.content_url)
    || videoClient.resolveVideoProtocol(config) === 'yinzi'
  );
  const nextGenerationStatus = providerFailed ? 'failed' : (providerCompleted ? 'completed' : 'processing');
  const nextStatus = providerFailed ? 'failed' : (providerCompleted && !requiresLocalDownload ? 'completed' : 'processing');
  const receipt = {
    ...(parseObject(row.submission_receipt_json) || {}),
    phase: 'provider_task_attached_by_user',
    request_id: taskId,
    provider_status: status || (providerFailed ? 'failed' : 'processing'),
     message: providerFailed
       ? String(probe.error).slice(0, 500)
       : (providerCompleted ? '已核对并找到用户提供的上游任务结果' : '已核对并绑定用户提供的上游任务 ID'),
    model: row.model || null,
    observed_at: now,
  };
  const tx = db.transaction(() => {
    persistVideoSubmissionState(db, numericId, 'accepted', {
      http_status: probe?.http_status,
      receipt,
    });
    db.prepare(
      `UPDATE video_generations SET provider_task_id = ?, status = ?, generation_status = ?,
       video_url = COALESCE(?, video_url), remote_video_url = COALESCE(?, remote_video_url),
       download_source_url = COALESCE(?, download_source_url), download_status = ?,
       provider_completed_at = CASE WHEN ? THEN COALESCE(provider_completed_at, ?) ELSE provider_completed_at END,
       completed_at = CASE WHEN ? AND ? = 'not_required' THEN COALESCE(completed_at, ?) ELSE completed_at END,
       error_msg = ?, updated_at = ? WHERE id = ?`
    ).run(
      taskId,
      nextStatus,
      nextGenerationStatus,
      completedUrl,
      completedUrl,
      completedUrl,
      providerCompleted ? (requiresLocalDownload ? 'pending' : 'not_required') : (row.download_status || 'pending'),
      providerCompleted ? 1 : 0,
      now,
      providerCompleted ? 1 : 0,
      requiresLocalDownload ? 'pending' : 'not_required',
      now,
      providerFailed ? String(probe.error).slice(0, 500) : null,
      now,
      numericId,
    );
  });
  tx.immediate();
  if (!providerFailed && (!providerCompleted || requiresLocalDownload) && !injected.disable_resume) {
    setImmediate(() => resumePollForVideoGeneration(db, log, numericId).catch((error) => {
      log.error('Attached provider task resume failed', { videoGenId: numericId, error: error.message });
    }));
  }
  return { reused: false, generation: getById(db, numericId), probe };
}

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const videoClient = require('./videoClient');
const taskService = require('./taskService');
const storageLayout = require('./storageLayout');
const costLedger = require('./productionCostLedger');
const { archiveDetachedVideoGeneration } = require('./productionDetachedMedia');
const smartRouteRecovery = require('./yinziSmartRouteRecovery');
const {
  getFfmpegPath,
  getFfprobePath,
  hasLocalFfmpeg,
  hasLocalFfprobe,
} = require('../utils/ffmpegPath');

const LEGACY_DOWNLOAD_FAILURE = /任务已完成.*(?:无法下载|下载到本地)|结果无法下载到本地|重试下载，不要重新提交生成/i;
const DOWNLOAD_LEASE_MS = 5 * 60 * 1000;
const activeVideoDownloads = new Set();

function legacyGenerationStatus(row) {
  if (!row) return null;
  if (row.status === 'completed') return 'completed';
  if (row.status === 'failed') return LEGACY_DOWNLOAD_FAILURE.test(String(row.error_msg || ''))
    && row.provider_task_id ? 'completed' : 'failed';
  if (row.status === 'processing' || row.status === 'pending') return 'processing';
  return row.status || null;
}

function legacyDownloadStatus(row) {
  const generationStatus = row?.generation_status || legacyGenerationStatus(row);
  if (generationStatus !== 'completed') return 'pending';
  if (row.local_path) return 'completed';
  if (LEGACY_DOWNLOAD_FAILURE.test(String(row.error_msg || ''))) return 'failed';
  return row.status === 'completed' ? 'not_required' : 'pending';
}

/** @returns {{ dir: string, relPrefix: string }} 与图片 uploads 一致的工程子目录规则 */
function resolveVideosDir(storagePath, projectSubdir) {
  const sub = projectSubdir && String(projectSubdir).trim();
  if (sub) {
    const relPrefix = `${sub.replace(/\\/g, '/')}/videos`;
    return { dir: path.join(storagePath, sub, 'videos'), relPrefix };
  }
  return { dir: path.join(storagePath, 'videos'), relPrefix: 'videos' };
}

/**
 * 将远程 video_url 下载到本地
 * @returns {string|null} 相对 storage 根的路径，如 projects/.../videos/vg_1_xxx.mp4；无工程时为 videos/...
 */
async function downloadVideoToLocal(storagePath, videoUrl, videoGenId, log, projectSubdir = null, requestOptions = {}) {
  if (!videoUrl || typeof videoUrl !== 'string') return null;
  const { dir, relPrefix } = resolveVideosDir(storagePath, projectSubdir);
  let temporaryPath = null;
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ext = (videoUrl.split('?')[0].match(/\.(mp4|webm|mov)$/i) || [])[1] || 'mp4';
    const name = `vg_${videoGenId}_${randomUUID().slice(0, 8)}.${ext}`;
    const filePath = path.join(dir, name);
    temporaryPath = `${filePath}.part-${randomUUID().slice(0, 8)}`;
    const fetchImpl = requestOptions.fetch_impl || fetch;
    const res = await fetchImpl(videoUrl, {
      method: 'GET',
      headers: requestOptions.headers || {},
      signal: AbortSignal.timeout(requestOptions.timeout_ms || 180000),
    });
    if (!res.ok) {
      log.warn('Download video failed', { status: res.status, videoGenId });
      throw await videoDownloadError(res);
    }
    const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) throw await videoDownloadError(res);
    if (contentType.includes('text/html') || contentType.includes('application/json') || contentType.includes('text/plain')) {
      throw new Error(`下载地址返回了非视频内容（${contentType || 'unknown'}）`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const maxBytes = Math.max(1024, Number(requestOptions.max_bytes) || 2 * 1024 * 1024 * 1024);
    if (buf.length > maxBytes) throw new Error(`视频文件超过允许大小 ${maxBytes} bytes`);
    fs.writeFileSync(temporaryPath, buf);
    validateDownloadedVideoFile(temporaryPath, {
      content_type: contentType,
      min_bytes: requestOptions.min_bytes,
      skip_probe: requestOptions.skip_probe,
    });
    fs.renameSync(temporaryPath, filePath);
    temporaryPath = null;
    const relativePath = `${relPrefix}/${name}`.replace(/\\/g, '/');
    log.info('Video saved to local', { videoGenId, local_path: relativePath, projectSubdir: projectSubdir || '(root)' });
    return relativePath;
  } catch (e) {
    if (temporaryPath) {
      try { fs.unlinkSync(temporaryPath); } catch (_) {}
    }
    log.warn('Download video error', { videoGenId, error: e.message });
    if (requestOptions.throw_on_error) throw e;
    return null;
  }
}

function validateDownloadedVideoFile(filePath, options = {}) {
  const stat = fs.statSync(filePath);
  const minBytes = Math.max(64, Number(options.min_bytes) || 1024);
  if (!stat.isFile() || stat.size < minBytes) throw new Error(`下载的视频文件过小（${stat.size} bytes）`);
  const header = Buffer.alloc(Math.min(32, stat.size));
  const fd = fs.openSync(filePath, 'r');
  try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
  const prefix = header.toString('utf8').trimStart().toLowerCase();
  if (prefix.startsWith('<!doctype') || prefix.startsWith('<html') || prefix.startsWith('{') || prefix.startsWith('[')) {
    throw new Error('下载结果是错误页面或 JSON，不是视频文件');
  }
  if (!options.skip_probe && hasLocalFfprobe()) {
    const probe = spawnSync(getFfprobePath(), [
      '-v', 'error', '-show_entries', 'format=duration,format_name',
      '-show_entries', 'stream=codec_type,width,height', '-of', 'json', filePath,
    ], { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    if (probe.status !== 0) throw new Error(`ffprobe 无法识别下载的视频：${String(probe.stderr || '').slice(-240)}`);
    const receipt = JSON.parse(probe.stdout || '{}');
    const videoStream = (receipt.streams || []).find((stream) => stream.codec_type === 'video');
    if (!videoStream) throw new Error('下载文件不包含视频轨道');
    return {
      bytes: stat.size,
      duration: Number(receipt.format?.duration || 0),
      width: Number(videoStream.width || 0),
      height: Number(videoStream.height || 0),
      format_name: receipt.format?.format_name || null,
    };
  }
  const isIsoMedia = header.length >= 12 && header.subarray(4, 8).toString('ascii') === 'ftyp';
  const isWebm = header.length >= 4 && header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3;
  const isMpeg = header.length >= 4 && header[0] === 0x00 && header[1] === 0x00 && header[2] === 0x01;
  if (!isIsoMedia && !isWebm && !isMpeg && !String(options.content_type || '').startsWith('video/')) {
    throw new Error('下载文件没有可识别的视频容器签名');
  }
  return { bytes: stat.size, format_name: isIsoMedia ? 'iso-media' : isWebm ? 'webm' : isMpeg ? 'mpeg' : 'video' };
}

/** 与图生 aspectRatioToSize 对齐的归一化分辨率（偶数像素，便于 H.264） */
function targetVideoPixelsForAspect(aspectRatio) {
  const r = String(aspectRatio || '16:9').trim();
  const map = {
    '16:9': { w: 2560, h: 1440 },
    '9:16': { w: 1440, h: 2560 },
    '1:1': { w: 1920, h: 1920 },
    '4:3': { w: 1920, h: 1440 },
    '3:4': { w: 1440, h: 1920 },
    '3:2': { w: 2560, h: 1708 },
    '2:3': { w: 1708, h: 2560 },
    '21:9': { w: 2560, h: 1080 },
  };
  if (map[r]) return map[r];
  const m = r.match(/^(\d+)\s*:\s*(\d+)$/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a > 0 && b > 0 && a !== b) {
      if (a > b) {
        const w = 2560;
        const h = Math.max(2, Math.round((w * b) / a / 2) * 2);
        return { w, h };
      }
      const h = 2560;
      const w = Math.max(2, Math.round((h * a) / b / 2) * 2);
      return { w, h };
    }
  }
  return { w: 1280, h: 720 };
}

/**
 * 用 ffmpeg 将视频缩放并加黑边到固定分辨率，避免 Grok 等返回实际像素不一致导致连播时画面跳动。
 */
function normalizeVideoFileToTargetPixels(absPath, tw, th, log, videoGenId) {
  if (!absPath || !tw || !th || !fs.existsSync(absPath)) return false;
  if (!hasLocalFfmpeg()) {
    log.info('[视频] 未找到 ffmpeg，跳过画幅归一化', { videoGenId });
    return false;
  }
  const ffmpeg = getFfmpegPath();
  const vf = `scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:black`;
  const tmpOut = absPath + '.norm-' + randomUUID().slice(0, 8) + (path.extname(absPath) || '.mp4');
  const baseArgs = ['-y', '-i', absPath, '-vf', vf, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
  let r = spawnSync(ffmpeg, [...baseArgs, '-c:a', 'copy', tmpOut], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) {
    r = spawnSync(ffmpeg, [...baseArgs, '-an', tmpOut], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  }
  if (r.status !== 0) {
    log.warn('[视频] 画幅归一化失败（保留原文件）', {
      videoGenId,
      stderr: (r.stderr || '').slice(-500),
    });
    try {
      fs.unlinkSync(tmpOut);
    } catch (_) {}
    return false;
  }
  try {
    fs.unlinkSync(absPath);
    fs.renameSync(tmpOut, absPath);
    log.info('[视频] 已统一画幅尺寸', { videoGenId, w: tw, h: th });
    return true;
  } catch (e) {
    log.warn('[视频] 替换归一化文件失败', { videoGenId, error: e.message });
    try {
      fs.unlinkSync(tmpOut);
    } catch (_) {}
    return false;
  }
}

function maybeNormalizeVideoAfterDownload(storagePath, localPath, row, videoGenId, log) {
  if (!localPath) return;
  const abs = path.join(storagePath, localPath);
  const dim = targetVideoPixelsForAspect(row.aspect_ratio);
  normalizeVideoFileToTargetPixels(abs, dim.w, dim.h, log, videoGenId);
}

/** 防止同一 videoGenId 重复发起 poll（含重启恢复） */
const activeVideoPolls = new Set();

function resolveStoragePath(cfg) {
  return path.isAbsolute(cfg.storage?.local_path)
    ? cfg.storage.local_path
    : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function settleAcceptedVideoCost(db, videoGenId, log) {
  if (!tableExists(db, 'production_actions') || !tableExists(db, 'cost_ledger')) return;
  const actions = db.prepare(
    `SELECT run_id, action_key FROM production_actions
     WHERE generation_id = ? AND kind = 'video_generate'`
  ).all(Number(videoGenId));
  for (const action of actions) {
    costLedger.transition(db, `production:${action.run_id}:${action.action_key}`, 'settled', {
      note: '上游视频任务已完成；本地下载作为零费用恢复步骤独立进行',
    });
  }
  if (actions.length) log.info('Settled accepted video generation cost', { videoGenId, actions: actions.length });
}

function resolvePersistedVideoConfig(db, row) {
  const config = videoClient.getDefaultVideoConfig(db, row.model, row.video_config_id);
  if (row.video_config_id != null && Number(config?.id) !== Number(row.video_config_id)) return null;
  const snapshot = parseObject(row.provider_config_snapshot_json);
  return videoClient.applyProviderConfigSnapshot(config, snapshot);
}

/**
 * A smart Yinzi route may be rejected before task creation when the selected
 * public route has no eligible upstream channel. That one deterministic case
 * can use a verified alternate from the frozen Key-scoped catalog. Every
 * other failure remains terminal/ambiguous and is never re-submitted.
 */
async function callVideoApiWithSmartRecovery(db, log, row, config, requestOptions) {
  const initialSnapshot = requestOptions.provider_config_snapshot
    || parseObject(row.provider_config_snapshot_json);
  const initialModel = String(
    requestOptions.model || initialSnapshot?.model || config?.default_model || ''
  ).trim();
  acceptanceSafety.assertVideoSubmitAllowed({
    entry: 'video_service_provider_create',
    generation_id: row?.id || null,
    model: initialModel || null,
  });
  const firstResult = await videoClient.callVideoApi(db, log, {
    ...requestOptions,
    provider_config_snapshot: initialSnapshot,
  });
  if (!smartRouteRecovery.isDeterministicNoEligibleAutomaticRoute(firstResult)
    || !smartRouteRecovery.isAutomaticRouteRequest(config, row, initialSnapshot)) {
    return {
      result: firstResult,
      model: initialModel,
      snapshot: initialSnapshot,
      recovery: null,
    };
  }

  const candidate = smartRouteRecovery.selectVerifiedFallbackModel({
    config,
    row,
    snapshot: initialSnapshot,
    duration: requestOptions.duration,
    currentModel: initialModel,
  });
  if (!candidate) {
    log.warn('Smart Yinzi route rejected without a verified compatible alternate', {
      videoGenId: row.id,
      model: initialModel,
    });
    return {
      result: firstResult,
      model: initialModel,
      snapshot: initialSnapshot,
      recovery: { version: 1, attempted: false, reason: 'no_verified_compatible_alternate' },
    };
  }

  const nextSnapshot = videoClient.buildProviderConfigSnapshot(config, candidate.model, {
    automatic_route: true,
    smart_routing: true,
    requested_model_explicit: false,
    smart_route_recovery_attempted: true,
    smart_routing_candidate: candidate.smart_routing_candidate === true,
    capability_model: candidate.model,
    ...(Object.prototype.hasOwnProperty.call(candidate, 'capabilities')
      ? { capability_snapshot: candidate.capabilities }
      : {}),
    capability_source: candidate.capability_source || 'model_catalog_snapshot',
    contract_status: candidate.contract_status || (candidate.capabilities ? 'known' : 'missing'),
    catalog_verified: candidate.catalog_verified === true,
    provider_protocol_snapshot: candidate.provider_protocol_snapshot || candidate,
  });
  if (initialSnapshot?.model_catalog_snapshot && !nextSnapshot.model_catalog_snapshot) {
    nextSnapshot.model_catalog_snapshot = initialSnapshot.model_catalog_snapshot;
  }
  nextSnapshot.smart_route_recovery_attempted = true;
  nextSnapshot.smart_route_recovery_from = initialModel || null;

  // Freeze the alternate on the generation row before the second request so
  // a restart cannot fall back to the rejected model or create a third try.
  const now = new Date().toISOString();
  try {
    db.prepare(
      `UPDATE video_generations SET model = ?, provider_protocol = ?,
       provider_config_snapshot_json = ?, updated_at = ? WHERE id = ?`
    ).run(
      candidate.model,
      videoClient.resolveVideoProtocol(config, candidate.model),
      JSON.stringify(nextSnapshot),
      now,
      Number(row.id)
    );
  } catch (error) {
    log.warn('Could not persist smart route alternate snapshot before retry', {
      videoGenId: row.id,
      error: error.message,
    });
  }
  row.model = candidate.model;
  row.provider_protocol = videoClient.resolveVideoProtocol(config, candidate.model);
  row.provider_config_snapshot_json = JSON.stringify(nextSnapshot);
  Object.assign(config, videoClient.applyProviderConfigSnapshot(config, nextSnapshot));

  log.warn('Recovering deterministic Yinzi smart-route rejection once', {
    videoGenId: row.id,
    fromModel: initialModel || null,
    toModel: candidate.model,
  });
  const secondResult = await videoClient.callVideoApi(db, log, {
    ...requestOptions,
    model: candidate.model,
    provider_config_snapshot: nextSnapshot,
  });
  const recovery = smartRouteRecovery.recoverySummary(
    firstResult,
    initialModel,
    candidate.model,
    secondResult
  );
  return {
    result: {
      ...secondResult,
      smart_route_recovery: recovery,
      submission_receipt: secondResult.submission_receipt
        ? { ...secondResult.submission_receipt, smart_route_recovery: recovery }
        : secondResult.submission_receipt,
    },
    model: candidate.model,
    snapshot: nextSnapshot,
    recovery,
  };
}

function providerReceiptJson(receipt) {
  return receipt && typeof receipt === 'object' ? JSON.stringify(receipt) : null;
}

function persistCompletedReferences(db, log, row, videoGenId, videoUrl, localPath, options = {}) {
  const now = new Date().toISOString();
  const persistedVideoUrl = (options.prefer_local_url || row.download_requires_auth) && localPath
    ? `/static/${localPath}`
    : videoUrl;
  if (row.storyboard_id) {
    try {
      db.prepare('UPDATE storyboards SET video_url = ?, local_path = ?, updated_at = ? WHERE id = ?').run(
        persistedVideoUrl, localPath || null, now, row.storyboard_id
      );
    } catch (_) {}
  }
  if (row.task_id) {
    taskService.updateTaskResult(db, row.task_id, {
      video_generation_id: videoGenId,
      video_url: persistedVideoUrl,
      status: 'completed',
      provider_prompt_receipt: options.provider_prompt_receipt || undefined,
    });
  }
  try {
    archiveDetachedVideoGeneration(db, {
      generation_id: videoGenId,
      local_path: localPath,
      remote_url: persistedVideoUrl,
    });
  } catch (error) {
    log.warn('Detached production video could not be archived', {
      videoGenId,
      error: error.message,
    });
  }
  log.info('Video generation and delivery completed', {
    id: videoGenId,
    video_url: persistedVideoUrl,
    local_path: localPath || null,
  });
  return persistedVideoUrl;
}

function markProviderCompleted(db, log, videoGenId, row, videoUrl, options = {}) {
  const now = new Date().toISOString();
  const requireLocal = options.require_local === true;
  const sourceUrl = options.download_url || videoUrl;
  const receipt = providerReceiptJson(options.provider_prompt_receipt);
  persistVideoSubmissionState(db, videoGenId, 'accepted', {
    receipt: {
      phase: 'provider_completed',
      request_id: row.provider_task_id || null,
      provider_status: 'completed',
      model: row.model || null,
    },
  });
  db.prepare(
    `UPDATE video_generations SET
       status = ?, generation_status = 'completed', download_status = ?,
       video_url = ?, remote_video_url = ?, download_source_url = ?, download_requires_auth = ?,
       provider_prompt_receipt_json = COALESCE(?, provider_prompt_receipt_json),
       provider_completed_at = COALESCE(provider_completed_at, ?), completed_at = ?,
       error_msg = NULL, download_error = NULL, updated_at = ?
     WHERE id = ?`
  ).run(
    requireLocal ? 'processing' : 'completed',
    requireLocal ? 'pending' : 'not_required',
    videoUrl,
    videoUrl,
    sourceUrl,
    options.headers?.Authorization ? 1 : 0,
    receipt,
    now,
    requireLocal ? null : now,
    now,
    videoGenId
  );
  settleAcceptedVideoCost(db, videoGenId, log);
  if (row.task_id) {
    if (requireLocal) {
      taskService.updateTaskStatus(db, row.task_id, 'processing', 92, '上游生成已完成，正在取回视频文件…');
    } else {
      persistCompletedReferences(db, log, row, videoGenId, videoUrl, null, options);
    }
  } else if (!requireLocal) {
    persistCompletedReferences(db, log, row, videoGenId, videoUrl, null, options);
  }
  log.info('Provider video generation completed', {
    id: videoGenId,
    provider_task_id: row.provider_task_id || null,
    download_required: requireLocal,
  });
}

function acquireDownloadLease(db, videoGenId, owner, leaseMs = DOWNLOAD_LEASE_MS) {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const info = db.prepare(
    `UPDATE video_generations SET
       status = 'processing', download_status = 'downloading', download_lease_owner = ?,
       download_lease_expires_at = ?, download_started_at = COALESCE(download_started_at, ?),
       download_attempts = COALESCE(download_attempts, 0) + 1, updated_at = ?
     WHERE id = ? AND generation_status = 'completed'
       AND download_status IN ('pending', 'failed', 'downloading', 'waiting_provider')
       AND (download_lease_owner IS NULL OR download_lease_owner = ''
         OR download_lease_expires_at IS NULL OR download_lease_expires_at <= ?
         OR download_lease_owner = ?)`
  ).run(owner, expiresAt, nowIso, nowIso, Number(videoGenId), nowIso, owner);
  return info.changes === 1;
}

function markDownloadFailure(db, log, videoGenId, row, error) {
  const now = new Date().toISOString();
  const message = String(error?.message || error || '视频下载失败').slice(0, 500);
  const waitingProvider = error?.code === 'VIDEO_ARTIFACT_NOT_READY';
  db.prepare(
    `UPDATE video_generations SET
       status = 'processing', download_status = ?, download_error = ?, error_msg = NULL,
       download_lease_owner = NULL, download_lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND generation_status = 'completed'`
  ).run(waitingProvider ? 'waiting_provider' : 'failed', message, now, Number(videoGenId));
  if (row.task_id) {
    taskService.updateTaskStatus(db, row.task_id, 'processing', 92, waitingProvider
      ? message : `上游报告生成完成，取回失败，正在自动重试：${message}`);
  }
  log.warn(waitingProvider ? 'Provider video artifact is still finalizing' : 'Provider video completed but local delivery failed', {
    videoGenId,
    provider_task_id: row.provider_task_id || null,
    error: message,
  });
}

function completeVideoDownload(db, log, videoGenId, row, localPath, options = {}) {
  const now = new Date().toISOString();
  const remoteVideoUrl = options.remote_video_url || row.remote_video_url || row.video_url;
  const persistedVideoUrl = (options.prefer_local_url || row.download_requires_auth) && localPath
    ? `/static/${localPath}`
    : remoteVideoUrl;
  db.prepare(
    `UPDATE video_generations SET
       status = 'completed', generation_status = 'completed', download_status = 'completed',
       video_url = ?, remote_video_url = COALESCE(?, remote_video_url), local_path = ?,
       download_error = NULL, error_msg = NULL, download_lease_owner = NULL,
       download_lease_expires_at = NULL, download_completed_at = ?, completed_at = ?, updated_at = ?
     WHERE id = ? AND generation_status = 'completed'`
  ).run(persistedVideoUrl, remoteVideoUrl || null, localPath, now, now, now, Number(videoGenId));
  persistCompletedReferences(db, log, row, videoGenId, remoteVideoUrl, localPath, {
    prefer_local_url: options.prefer_local_url || row.download_requires_auth,
    provider_prompt_receipt: options.provider_prompt_receipt,
  });
}

function scheduleDownloadRetry(db, log, videoGenId, attempts = 1) {
  const delay = Math.min(10 * 60 * 1000, Math.max(15000, 15000 * (2 ** Math.min(5, Math.max(0, attempts - 1)))));
  const timer = setTimeout(() => {
    resumeDownloadForVideoGeneration(db, log, videoGenId).catch((error) => {
      log.error('Video download retry failed to start', { videoGenId, error: error.message });
    });
  }, delay);
  timer.unref?.();
}

async function refreshCompletedDownloadSource(db, log, videoGenId, row, config) {
  if (!row.provider_task_id || !config) return null;
  const result = await videoClient.pollVideoTask(
    db, log, videoGenId, row.provider_task_id, config, 1, 0, row.prompt
  );
  const resolved = resolveRemoteVideoUrl(result.video_url, result.error);
  let sourceUrl = null;
  let remoteVideoUrl = null;
  let requiresAuth = false;
  if (resolved.ok) {
    sourceUrl = resolved.video_url;
    remoteVideoUrl = resolved.video_url;
  } else if (result.content_url) {
    sourceUrl = result.content_url;
    remoteVideoUrl = row.remote_video_url || result.content_url;
    requiresAuth = true;
  } else if (result.pending) {
    throw new Error('原上游任务暂未返回可下载地址，请稍后继续取回');
  } else {
    throw new Error(resolved.error || '无法从原上游任务刷新下载地址');
  }
  db.prepare(
    `UPDATE video_generations SET
       remote_video_url = COALESCE(?, remote_video_url), download_source_url = ?,
       download_requires_auth = ?, provider_prompt_receipt_json = COALESCE(?, provider_prompt_receipt_json),
       updated_at = ? WHERE id = ?`
  ).run(
    remoteVideoUrl,
    sourceUrl,
    requiresAuth ? 1 : 0,
    providerReceiptJson(result.provider_prompt_receipt),
    new Date().toISOString(),
    Number(videoGenId)
  );
  return { source_url: sourceUrl, remote_video_url: remoteVideoUrl, requires_auth: requiresAuth };
}

async function resumeDownloadForVideoGeneration(db, log, videoGenId, injected = {}) {
  const numericId = Number(videoGenId);
  if (activeVideoDownloads.has(numericId)) return { state: 'already_running' };
  const owner = `download-${process.pid}-${randomUUID()}`;
  if (!acquireDownloadLease(db, numericId, owner, injected.lease_ms || DOWNLOAD_LEASE_MS)) {
    const current = db.prepare('SELECT * FROM video_generations WHERE id = ?').get(numericId);
    return { state: current?.download_status === 'completed' ? 'completed' : 'leased', generation: current || null };
  }
  activeVideoDownloads.add(numericId);
  let row = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(numericId);
  try {
    const cfg = injected.config || require('../config').loadConfig();
    const storagePath = resolveStoragePath(cfg);
    const projectSubdir = storageLayout.getProjectStorageSubdir(db, row.drama_id);
    const config = injected.video_config || resolvePersistedVideoConfig(db, row);
    if (row.video_config_id != null && !config) {
      throw new Error(`原视频配置 #${row.video_config_id} 已不可用，请重新绑定该配置后继续下载；不会重新生成视频`);
    }
    let sourceUrl = row.download_source_url || row.remote_video_url || row.video_url;
    let remoteVideoUrl = row.remote_video_url || row.video_url || null;
    let requiresAuth = Boolean(row.download_requires_auth);
    const downloader = injected.download || downloadVideoToLocal;
    const attempt = async () => downloader(
      storagePath,
      sourceUrl,
      numericId,
      log,
      projectSubdir,
      {
        headers: requiresAuth && config?.api_key ? { Authorization: `Bearer ${config.api_key}` } : {},
        timeout_ms: injected.timeout_ms,
        throw_on_error: true,
        fetch_impl: injected.fetch_impl,
        skip_probe: injected.skip_probe,
        min_bytes: injected.min_bytes,
      }
    );
    let localPath = null;
    let firstError = null;
    if (sourceUrl) {
      try { localPath = await attempt(); } catch (error) { firstError = error; }
    }
    // An explicit not-ready response needs time, not a second immediate GET.
    if (firstError?.code === 'VIDEO_ARTIFACT_NOT_READY') throw firstError;
    if (!localPath && row.provider_task_id) {
      const refreshed = injected.refresh_source
        ? await injected.refresh_source({ db, log, videoGenId: numericId, row, config })
        : await refreshCompletedDownloadSource(db, log, numericId, row, config);
      if (refreshed) {
        sourceUrl = refreshed.source_url;
        remoteVideoUrl = refreshed.remote_video_url || remoteVideoUrl;
        requiresAuth = Boolean(refreshed.requires_auth);
        localPath = await attempt();
      }
    }
    if (!localPath) throw firstError || new Error('原任务没有可用的下载地址');
    maybeNormalizeVideoAfterDownload(storagePath, localPath, row, numericId, log);
    row = db.prepare('SELECT * FROM video_generations WHERE id = ?').get(numericId);
    completeVideoDownload(db, log, numericId, row, localPath, {
      remote_video_url: remoteVideoUrl,
      prefer_local_url: requiresAuth,
      provider_prompt_receipt: row.provider_prompt_receipt_json
        ? JSON.parse(row.provider_prompt_receipt_json) : undefined,
    });
    return { state: 'completed', local_path: localPath };
  } catch (error) {
    markDownloadFailure(db, log, numericId, row, error);
    const updated = db.prepare('SELECT download_attempts FROM video_generations WHERE id = ?').get(numericId);
    if (!injected.disable_retry) scheduleDownloadRetry(db, log, numericId, Number(updated?.download_attempts || 1));
    return { state: error?.code === 'VIDEO_ARTIFACT_NOT_READY' ? 'waiting_provider' : 'download_failed', error: error.message };
  } finally {
    activeVideoDownloads.delete(numericId);
  }
}

async function finalizeSuccessfulVideo(db, log, videoGenId, row, rowForAspect, videoUrl, logLabel, options = {}) {
  markProviderCompleted(db, log, videoGenId, row, videoUrl, options);
  if (options.require_local) {
    const result = await resumeDownloadForVideoGeneration(db, log, videoGenId, {
      timeout_ms: options.timeout_ms,
    });
    log.info('Video local delivery result' + (logLabel ? ` (${logLabel})` : ''), {
      id: videoGenId,
      state: result.state,
    });
  }
}

async function pollProviderTaskAndFinalize(db, log, videoGenId, row, rowForAspect, providerTaskId, config) {
  const cfg = require('../config').loadConfig();
  const POLL_INTERVAL_MS = 10000;
  const { resolveVideoGenerationTimeoutMinutes } = require('../config/videoGeneration');
  const generationTimeoutMinutes = resolveVideoGenerationTimeoutMinutes(cfg);
  const pollMaxAttempts = Math.max(
    1,
    Math.ceil((generationTimeoutMinutes * 60 * 1000) / POLL_INTERVAL_MS)
  );
  const pollResult = await videoClient.pollVideoTask(
    db,
    log,
    videoGenId,
    providerTaskId,
    config,
    pollMaxAttempts,
    POLL_INTERVAL_MS,
    row.prompt,
    (observation) => require('./videoPollProgress').recordPollProgress(db, videoGenId, providerTaskId, observation)
  );
  const now = new Date().toISOString();
  const polledVideo = resolveRemoteVideoUrl(pollResult.video_url, pollResult.error);
  if (polledVideo.ok) {
    await finalizeSuccessfulVideo(
      db, log, videoGenId, row, rowForAspect, polledVideo.video_url, 'after poll',
      {
        require_local: videoClient.resolveVideoProtocol(config) === 'yinzi',
        provider_prompt_receipt: pollResult.provider_prompt_receipt,
      }
    );
  } else if (pollResult.content_url) {
    await finalizeSuccessfulVideo(
      db,
      log,
      videoGenId,
      row,
      rowForAspect,
      pollResult.content_url,
      'authenticated content fallback',
      {
        download_url: pollResult.content_url,
        headers: { Authorization: 'Bearer ' + (config.api_key || '') },
        require_local: true,
        prefer_local_url: true,
        provider_prompt_receipt: pollResult.provider_prompt_receipt,
      }
    );
  } else if (pollResult.pending) {
    db.prepare(
      `UPDATE video_generations SET status = 'processing', generation_status = 'processing',
       error_msg = NULL, updated_at = ? WHERE id = ?`
    ).run(
      now, videoGenId
    );
    if (row.task_id) {
      taskService.updateTaskStatus(
        db,
        row.task_id,
        'processing',
        pollResult.progress != null && Number.isFinite(Number(pollResult.progress))
          ? Math.min(99, Number(pollResult.progress)) : taskService.getTask(db, row.task_id)?.progress ?? 20,
        '上游仍在排队或生成，稍后继续检查…'
      );
    }
    log.warn('Video polling window ended while provider task is still active; scheduling continuation', {
      id: videoGenId,
      provider_task_id: providerTaskId,
      provider_status: pollResult.status,
      provider_progress: pollResult.progress,
    });
    setTimeout(() => {
      resumePollForVideoGeneration(db, log, videoGenId).catch((error) => {
        log.error('Video poll continuation failed to start', { id: videoGenId, error: error.message });
      });
    }, 10000);
  } else {
    setVideoGenFailed(db, videoGenId, polledVideo.error, now);
    if (row.task_id) taskService.updateTaskError(db, row.task_id, polledVideo.error);
    log.error('Video generation failed (after poll)', { id: videoGenId, error: polledVideo.error });
  }
}

/**
 * 服务重启后恢复对厂商异步任务的轮询（需已持久化 provider_task_id）
 */
async function resumePollForVideoGeneration(db, log, videoGenId) {
  if (activeVideoPolls.has(videoGenId)) {
    log.info('Video poll already active, skip resume', { videoGenId });
    return;
  }
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(videoGenId));
  if (!row) return;
  const generationStatus = row.generation_status || legacyGenerationStatus(row);
  if (generationStatus === 'completed') {
    if (!['completed', 'not_required'].includes(row.download_status || legacyDownloadStatus(row))) {
      return resumeDownloadForVideoGeneration(db, log, videoGenId);
    }
    return;
  }
  if (generationStatus !== 'processing') return;
  const providerTaskId = row.provider_task_id && String(row.provider_task_id).trim();
  if (!providerTaskId) return;

  const config = resolvePersistedVideoConfig(db, row);
  if (!config) {
    const now = new Date().toISOString();
    const message = row.video_config_id != null
      ? `原视频配置 #${row.video_config_id} 已不可用，请重新绑定后继续查询原任务；不会重新生成视频`
      : '未配置视频模型，无法继续查询原任务';
    db.prepare(
      `UPDATE video_generations SET status = 'processing', generation_status = 'processing',
       error_msg = ?, updated_at = ? WHERE id = ?`
    ).run(message, now, Number(videoGenId));
    if (row.task_id) taskService.updateTaskStatus(db, row.task_id, 'processing', 20, message);
    return;
  }

  activeVideoPolls.add(videoGenId);
  log.info('Resuming video generation poll after restart', {
    videoGenId,
    provider_task_id: providerTaskId,
  });
  try {
    let aspectForVideo = row.aspect_ratio;
    if (aspectForVideo) {
      const n = videoClient.normalizeAspectRatioForApi(aspectForVideo);
      if (n) aspectForVideo = n;
    }
    const rowForAspect = { ...row, aspect_ratio: aspectForVideo || row.aspect_ratio };
    await pollProviderTaskAndFinalize(db, log, videoGenId, row, rowForAspect, providerTaskId, config);
  } catch (err) {
    const latest = db.prepare('SELECT * FROM video_generations WHERE id = ?').get(Number(videoGenId));
    if ((latest?.generation_status || legacyGenerationStatus(latest)) === 'completed') {
      markDownloadFailure(db, log, videoGenId, latest, err);
    } else {
      const now = new Date().toISOString();
      setVideoGenFailed(db, videoGenId, err.message, now);
      if (row.task_id) taskService.updateTaskError(db, row.task_id, err.message);
      log.error('Video generation resume poll error', { id: videoGenId, error: err.message });
    }
  } finally {
    activeVideoPolls.delete(videoGenId);
  }
}

function backfillVideoDeliveryState(db, log) {
  const rows = db.prepare(
    `SELECT * FROM video_generations
     WHERE deleted_at IS NULL AND (generation_status IS NULL OR download_status IS NULL)`
  ).all();
  const update = db.prepare(
    `UPDATE video_generations SET
       status = ?, generation_status = ?, download_status = ?, remote_video_url = COALESCE(remote_video_url, ?),
       download_source_url = COALESCE(download_source_url, ?), download_error = COALESCE(download_error, ?),
       provider_completed_at = COALESCE(provider_completed_at, ?), error_msg = ?, updated_at = ?
     WHERE id = ?`
  );
  const tx = db.transaction(() => {
    for (const row of rows) {
      const generationStatus = legacyGenerationStatus(row);
      const downloadStatus = legacyDownloadStatus(row);
      const historicalDownloadFailure = generationStatus === 'completed' && downloadStatus === 'failed';
      const timestamp = row.updated_at || row.completed_at || new Date().toISOString();
      update.run(
        historicalDownloadFailure ? 'processing' : row.status,
        generationStatus,
        downloadStatus,
        row.video_url || null,
        row.video_url || null,
        historicalDownloadFailure ? row.error_msg : null,
        generationStatus === 'completed' ? timestamp : null,
        historicalDownloadFailure ? null : row.error_msg,
        new Date().toISOString(),
        row.id
      );
    }
    db.prepare(
      `UPDATE video_generations SET download_status = 'failed', download_lease_owner = NULL,
       download_lease_expires_at = NULL, updated_at = ?
       WHERE generation_status = 'completed' AND download_status = 'downloading'
         AND (download_lease_expires_at IS NULL OR download_lease_expires_at <= ?)`
    ).run(new Date().toISOString(), new Date().toISOString());
  });
  tx.immediate();
  if (rows.length) log.info('Backfilled video delivery state', { count: rows.length });
  return rows.length;
}

/** 启动时分别恢复上游轮询和本地下载；任何恢复路径都不会创建新视频任务。 */
function resumeProcessingVideoGenerations(db, log) {
  backfillVideoDeliveryState(db, log);
  const stuck = db
    .prepare(
      `SELECT * FROM video_generations
       WHERE generation_status = 'processing' AND deleted_at IS NULL
         AND (provider_task_id IS NULL OR TRIM(provider_task_id) = '')`
    )
    .all();
  for (const s of stuck) {
    const now = new Date().toISOString();
    const submissionStatus = submissionStatusForRow(s);
    const definitelyNotSent = submissionStatus === 'not_sent';
    const stuckMsg = definitelyNotSent
      ? '服务重启前视频请求尚未发送，已安全停止；本次视频额度可返还'
      : '服务重启后无法确认创建结果（缺少厂商任务 ID），已停止自动重提以避免重复扣费';
    setVideoGenFailed(db, s.id, stuckMsg, now, {
      submission_status: definitelyNotSent ? 'not_sent' : 'ambiguous',
      generation_status: definitelyNotSent ? 'failed' : 'ambiguous',
      submission_receipt: {
        phase: definitelyNotSent ? 'restart_before_post' : 'restart_ambiguous_post',
        model: s.model || null,
        message: stuckMsg,
      },
    });
    if (s.task_id) taskService.updateTaskError(db, s.task_id, stuckMsg);
    log.warn(definitelyNotSent ? 'Stopped unsent video generation after restart' : 'Marked interrupted video creation as ambiguous', {
      videoGenId: s.id,
      submission_status: definitelyNotSent ? 'not_sent' : 'ambiguous',
    });
  }

  const resumable = db
    .prepare(
      `SELECT id FROM video_generations
       WHERE generation_status = 'processing' AND deleted_at IS NULL
         AND provider_task_id IS NOT NULL AND TRIM(provider_task_id) != ''`
    )
    .all();
  if (resumable.length) {
    log.info('Resuming video generation polls', { count: resumable.length });
  }
  for (const r of resumable) {
    setImmediate(() => {
      resumePollForVideoGeneration(db, log, r.id).catch((e) => {
        log.error('resumePollForVideoGeneration unhandled', { videoGenId: r.id, error: e.message });
      });
    });
  }
  const downloads = db.prepare(
    `SELECT id FROM video_generations
     WHERE generation_status = 'completed' AND download_status IN ('pending', 'failed', 'waiting_provider')
       AND deleted_at IS NULL`
  ).all();
  if (downloads.length) log.info('Resuming completed video downloads', { count: downloads.length });
  for (const row of downloads) {
    setImmediate(() => {
      resumeDownloadForVideoGeneration(db, log, row.id).catch((error) => {
        log.error('resumeDownloadForVideoGeneration unhandled', { videoGenId: row.id, error: error.message });
      });
    });
  }
}

async function processVideoGeneration(db, log, videoGenId) {
  const existing = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(videoGenId));
  if (!existing) {
    log.error('Video generation not found', { id: videoGenId });
    return;
  }
  const existingGenerationStatus = existing.generation_status || legacyGenerationStatus(existing);
  if (existingGenerationStatus === 'completed') {
    if (!['completed', 'not_required'].includes(existing.download_status || legacyDownloadStatus(existing))) {
      return resumeDownloadForVideoGeneration(db, log, videoGenId);
    }
    return;
  }
  if (existingGenerationStatus === 'processing' && existing.provider_task_id) {
    return resumePollForVideoGeneration(db, log, videoGenId);
  }
  if (['failed', 'ambiguous'].includes(existingGenerationStatus)) {
    log.warn('Refusing to resubmit terminal or ambiguous video generation', {
      videoGenId,
      generation_status: existingGenerationStatus,
    });
    return;
  }
  if (activeVideoPolls.has(videoGenId)) {
    log.info('Video generation already in progress, skip duplicate', { videoGenId });
    return;
  }
  activeVideoPolls.add(videoGenId);
  log.info('processVideoGeneration started', { videoGenId });
  const row = existing;
  const now = new Date().toISOString();
  try {
    db.prepare(
      `UPDATE video_generations SET status = 'processing', generation_status = 'processing',
       download_status = COALESCE(download_status, 'pending'), error_msg = NULL, updated_at = ? WHERE id = ?`
    ).run(now, videoGenId);
    const loadConfig = require('../config').loadConfig;
    const cfg = loadConfig();
    const filesBaseUrl = (cfg.storage && cfg.storage.base_url) ? String(cfg.storage.base_url).replace(/\/$/, '') : '';
    const storageLocalPath = path.isAbsolute(cfg.storage?.local_path)
      ? cfg.storage.local_path
      : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
    const config = resolvePersistedVideoConfig(db, row);
    if (!config) {
      setVideoGenFailed(db, videoGenId, '未配置视频模型', now, {
        submission_status: 'not_sent',
        submission_receipt: { phase: 'video_config_resolution', model: row.model || null },
      });
      if (row.task_id) taskService.updateTaskError(db, row.task_id, '未配置视频模型');
      return;
    }
    const parseReferenceList = (raw) => {
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
      } catch (_) {
        return [];
      }
    };
    const reference_urls = parseReferenceList(row.reference_image_urls);
    const reference_video_urls = parseReferenceList(row.reference_video_urls);
    const reference_audio_urls = parseReferenceList(row.reference_audio_urls);
    // 优先使用分镜自身的镜头时长（storyboard.duration），其次用 video_generations.duration
    let effectiveDuration = row.duration || null;
    if (row.storyboard_id) {
      const sb = db.prepare('SELECT duration FROM storyboards WHERE id = ?').get(row.storyboard_id);
      if (sb && sb.duration > 0) {
        effectiveDuration = sb.duration;
        log.info('使用分镜镜头时长', { storyboard_id: row.storyboard_id, duration: effectiveDuration, video_gen_id: videoGenId });
      }
    }
    let aspectForVideo = row.aspect_ratio;
    if (aspectForVideo) {
      const n = videoClient.normalizeAspectRatioForApi(aspectForVideo);
      if (n) aspectForVideo = n;
    }
    if (!aspectForVideo && row.drama_id) {
      try {
        const dramaRow = db.prepare('SELECT metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(row.drama_id);
        if (dramaRow && dramaRow.metadata) {
          const meta =
            typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
          if (meta && meta.aspect_ratio) {
            aspectForVideo = videoClient.normalizeAspectRatioForApi(meta.aspect_ratio);
          }
        }
      } catch (_) {}
    }
    const rowForAspect = { ...row, aspect_ratio: aspectForVideo || row.aspect_ratio };
    const referenceTransport = buildReferenceTransport(row, {
      images: reference_urls, videos: reference_video_urls, audios: reference_audio_urls,
    });
    if (row.task_id && referenceTransport.reference_count > 0) {
      taskService.updateTaskStatus(
        db,
        row.task_id,
        'processing',
        5,
        `正在准备 ${referenceTransport.reference_count} 个参考媒体…`
      );
    }
    if (videoClient.resolveVideoProtocol(config, row.model) !== 'yinzi') {
      persistVideoSubmissionState(db, videoGenId, 'ambiguous', {
        receipt: {
          phase: 'provider_dispatch_started',
          model: row.model || null,
          endpoint: config.endpoint || null,
        },
      });
    }
    const videoRequestOptions = {
      prompt: row.prompt,
      model: row.model,
      duration: effectiveDuration,
      aspect_ratio: rowForAspect.aspect_ratio,
      resolution: row.resolution,
      seed: row.seed,
      camera_fixed: row.camera_fixed,
      watermark: row.watermark,
      provider: row.provider,
      drama_id: row.drama_id,
      storyboard_id: row.storyboard_id || undefined,
      image_url: referenceTransport.image_url,
      first_frame_url: referenceTransport.first_frame_url,
      last_frame_url: referenceTransport.last_frame_url,
      reference_urls: referenceTransport.reference_urls,
      reference_video_urls: referenceTransport.reference_video_urls,
      reference_audio_urls: referenceTransport.reference_audio_urls,
      contract_validation_mode: videoClient.normalizeContractValidationMode(row.contract_validation_mode),
      files_base_url: filesBaseUrl,
      storage_local_path: storageLocalPath,
      video_gen_id: videoGenId,
      video_config_id: row.video_config_id,
      provider_config_snapshot: parseObject(row.provider_config_snapshot_json),
      on_submission_state: (submission) => {
        persistVideoSubmissionState(db, videoGenId, submission.status, {
          http_status: submission.http_status, receipt: submission.receipt,
        });
        const phase = submission.receipt?.phase;
        const message = phase === 'post_started'
          ? '视频请求正在提交，等待服务返回任务编号'
          : phase === 'task_id_received'
            ? '服务已返回任务编号，正在查询生成进度'
            : phase === 'direct_video_received'
              ? '服务已返回视频，正在准备下载'
              : null;
        if (row.task_id && message) {
          const task = taskService.getTask(db, row.task_id);
          if (task && ['pending', 'processing'].includes(task.status)) {
            taskService.updateTaskStatus(db, row.task_id, 'processing', task.progress, message);
          }
        }
      },
    };
    const recoveredCall = await callVideoApiWithSmartRecovery(
      db,
      log,
      row,
      config,
      videoRequestOptions
    );
    const result = recoveredCall.result;
    if (recoveredCall.model && recoveredCall.model !== videoRequestOptions.model) {
      row.model = recoveredCall.model;
      row.provider_protocol = videoClient.resolveVideoProtocol(config, recoveredCall.model);
      row.provider_config_snapshot_json = recoveredCall.snapshot
        ? JSON.stringify(recoveredCall.snapshot) : row.provider_config_snapshot_json;
    }
    if (result.submission_status) {
      persistVideoSubmissionState(db, videoGenId, result.submission_status, {
        http_status: result.submission_http_status,
        receipt: result.submission_receipt,
      });
    }
    if (result.contract_validation) {
      try {
        db.prepare(
          'UPDATE video_generations SET contract_validation_receipt_json = ?, updated_at = ? WHERE id = ?'
        ).run(JSON.stringify(result.contract_validation), new Date().toISOString(), videoGenId);
      } catch (_) {
        // Older ad-hoc databases may not have the optional receipt column;
        // dispatch behavior remains valid because the action/request receipt
        // still carries the same warnings.
      }
    }
    const now2 = new Date().toISOString();
    if (result.error) {
      const submissionStatus = result.submission_status
        || (result.ambiguous_submission ? 'ambiguous' : 'ambiguous');
      setVideoGenFailed(db, videoGenId, result.error, now2, {
        submission_status: submissionStatus,
        submission_http_status: result.submission_http_status,
        submission_receipt: result.submission_receipt,
        generation_status: submissionStatus === 'ambiguous' ? 'ambiguous' : 'failed',
      });
      if (row.task_id) taskService.updateTaskError(db, row.task_id, result.error);
      log.error('Video generation failed', {
        id: videoGenId, error: result.error, submission_status: submissionStatus,
      });
      return;
    }
    const directVideo = resolveRemoteVideoUrl(result.video_url, result.error);
    if (directVideo.ok) {
      persistVideoSubmissionState(db, videoGenId, 'accepted', {
        http_status: result.submission_http_status,
        receipt: result.submission_receipt || { phase: 'direct_video_received', model: row.model || null },
      });
      await finalizeSuccessfulVideo(
        db, log, videoGenId, row, rowForAspect, directVideo.video_url, '',
        { require_local: videoClient.resolveVideoProtocol(config) === 'yinzi' }
      );
      return;
    }
    if (result.video_url) {
      setVideoGenFailed(db, videoGenId, directVideo.error, now2, {
        submission_status: result.submission_status || 'ambiguous',
        submission_http_status: result.submission_http_status,
        submission_receipt: result.submission_receipt,
        generation_status: 'ambiguous',
      });
      if (row.task_id) taskService.updateTaskError(db, row.task_id, directVideo.error);
      log.error('Video generation failed', { id: videoGenId, error: directVideo.error });
      return;
    }
    if (result.task_id) {
      persistVideoSubmissionState(db, videoGenId, 'accepted', {
        http_status: result.submission_http_status,
        receipt: result.submission_receipt || {
          phase: 'task_id_received', request_id: result.task_id, model: row.model || null,
        },
      });
      db.prepare(
        `UPDATE video_generations SET status = 'processing', generation_status = 'processing',
         provider_task_id = ?, updated_at = ? WHERE id = ?`
      ).run(result.task_id, now2, videoGenId);
      await pollProviderTaskAndFinalize(db, log, videoGenId, row, rowForAspect, result.task_id, config);
      return;
    }
    setVideoGenFailed(db, videoGenId, '未返回 task_id 或 video_url', now2, {
      submission_status: 'ambiguous',
      generation_status: 'ambiguous',
      submission_receipt: { phase: 'success_without_authority', model: row.model || null },
    });
    if (row.task_id) taskService.updateTaskError(db, row.task_id, '未返回 task_id 或 video_url');
  } catch (err) {
    const latest = db.prepare('SELECT * FROM video_generations WHERE id = ?').get(Number(videoGenId));
    if ((latest?.generation_status || legacyGenerationStatus(latest)) === 'completed') {
      markDownloadFailure(db, log, videoGenId, latest, err);
    } else {
      const now2 = new Date().toISOString();
      const submissionStatus = latest?.provider_task_id
        ? 'accepted'
        : submissionStatusForRow(latest) === 'not_sent' ? 'ambiguous' : submissionStatusForRow(latest);
      setVideoGenFailed(db, videoGenId, err.message, now2, {
        submission_status: submissionStatus,
        generation_status: submissionStatus === 'ambiguous' ? 'ambiguous' : 'failed',
        submission_receipt: parseObject(latest?.submission_receipt_json) || {
          phase: 'unhandled_dispatch_error', model: row?.model || null, message: err.message,
        },
      });
      if (row && row.task_id) taskService.updateTaskError(db, row.task_id, err.message);
      log.error('Video generation error', {
        id: videoGenId, error: err.message, submission_status: submissionStatus,
      });
    }
  } finally {
    activeVideoPolls.delete(videoGenId);
  }
}

function deleteById(db, log, id) {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE video_generations SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, Number(id));
  return result.changes > 0;
}

module.exports = {
  list,
  getById,
  deleteById,
  processVideoGeneration,
  resumeProcessingVideoGenerations,
  resumePollForVideoGeneration,
  resumeDownloadForVideoGeneration,
  attachProviderTaskForRecovery,
  downloadVideoToLocal,
  _rowToItem: rowToItem,
  _buildReferenceTransport: buildReferenceTransport,
  _backfillVideoDeliveryState: backfillVideoDeliveryState,
  _acquireDownloadLease: acquireDownloadLease,
  _markProviderCompleted: markProviderCompleted,
  _validateDownloadedVideoFile: validateDownloadedVideoFile,
  _persistVideoSubmissionState: persistVideoSubmissionState,
  _submissionStatusForRow: submissionStatusForRow,
  _callVideoApiWithSmartRecovery: callVideoApiWithSmartRecovery,
};
