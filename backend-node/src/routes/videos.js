const response = require('../response');
const videoService = require('../services/videoService');
const taskService = require('../services/taskService');
const videoClient = require('../services/videoClient');
const { normalizeAspectRatioForApi } = videoClient;
const acceptanceSafety = require('../services/acceptanceSafety');

function publicVideoConfigSnapshot(config, model, routingReceipt = null) {
  return videoClient.buildProviderConfigSnapshot(config, model, routingReceipt);
}

/** Create one persisted video generation using the same path as the HTTP API.
 * Batch orchestration calls this helper so provider validation, snapshots and
 * idempotent local task creation stay in one place. */
function createGeneration(db, log, body = {}, options = {}) {
  const clientRequestKey = String(body.client_request_key || '').trim().slice(0, 240) || null;
  if (clientRequestKey) {
    const existing = db.prepare('SELECT id FROM video_generations WHERE client_request_key = ? AND deleted_at IS NULL').get(clientRequestKey);
    if (existing) return { ...videoService.getById(db, existing.id), reused: true };
  }
  acceptanceSafety.assertVideoSubmitAllowed({
    entry: options.entry || 'http_post_videos',
    model: body.model || null,
    drama_id: body.drama_id || null,
  });
  const task = taskService.createTask(db, log, 'video_generation', String(body.drama_id || ''));
  const now = new Date().toISOString();
  const dramaId = Number(body.drama_id) || 0;
  const storyboardId = body.storyboard_id != null ? Number(body.storyboard_id) : null;
  const provider = body.provider || 'chatfire';
  let prompt = body.prompt || '';
  const style = (body.style || '').toString().trim();
  if (style && !String(prompt || '').toLowerCase().includes(style.toLowerCase())) {
    prompt = prompt ? `${prompt}. Style: ${style}` : `Style: ${style}`;
  }
  const model = body.model ?? null;
  const videoConfig = videoClient.getDefaultVideoConfig(db, model, body.video_config_id);
  const videoConfigId = videoConfig?.id || null;
  const providerProtocol = videoConfig ? videoClient.resolveVideoProtocol(videoConfig, model) : null;
  const routingHint = {
    ...(body.routing_receipt && typeof body.routing_receipt === 'object' ? body.routing_receipt : {}),
    requested_model_explicit: Boolean(String(model || '').trim()),
  };
  const providerConfigSnapshot = publicVideoConfigSnapshot(videoConfig, model, routingHint);
  const duration = body.duration ?? null;
  let aspectRatio = null;
  if (body.aspect_ratio != null && String(body.aspect_ratio).trim() !== '') aspectRatio = normalizeAspectRatioForApi(body.aspect_ratio);
  if (!aspectRatio && dramaId) {
    try {
      const dramaRow = db.prepare('SELECT metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(dramaId);
      if (dramaRow?.metadata) {
        const meta = typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
        if (meta?.aspect_ratio) aspectRatio = normalizeAspectRatioForApi(meta.aspect_ratio);
      }
    } catch (_) {}
  }
  const resolution = body.resolution ?? null;
  const seed = body.seed != null ? Number(body.seed) : null;
  const cameraFixed = body.camera_fixed != null ? (body.camera_fixed ? 1 : 0) : null;
  const watermark = body.watermark != null ? (body.watermark ? 1 : 0) : 0;
  const imageUrl = body.image_url ?? null;
  const firstFrameUrl = body.first_frame_url ?? body.first_frame_local_path ?? null;
  const lastFrameUrl = body.last_frame_url ?? body.last_frame_local_path ?? null;
  const refImagesJson = Array.isArray(body.reference_image_urls) ? JSON.stringify(body.reference_image_urls) : null;
  const refVideosJson = Array.isArray(body.reference_video_urls) ? JSON.stringify(body.reference_video_urls) : null;
  const refAudiosJson = Array.isArray(body.reference_audio_urls) ? JSON.stringify(body.reference_audio_urls) : null;
  const promptContractJson = body.prompt_contract && typeof body.prompt_contract === 'object' ? JSON.stringify(body.prompt_contract) : null;
  const contractValidationMode = body.contract_validation_mode != null
    ? videoClient.normalizeContractValidationMode(body.contract_validation_mode)
    : (videoConfig && videoClient.resolveVideoProtocol(videoConfig, model) === 'yinzi' ? 'advisory' : 'strict');
  db.prepare(
    `INSERT INTO video_generations (
       drama_id, storyboard_id, provider, prompt, prompt_contract_json, model, duration, aspect_ratio,
       resolution, seed, camera_fixed, watermark, image_url, first_frame_url, last_frame_url,
       reference_image_urls, reference_video_urls, reference_audio_urls, status, generation_status,
       download_status, video_config_id, provider_protocol, provider_config_snapshot_json,
       contract_validation_mode, task_id, client_request_key, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', 'processing',
       'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    dramaId, storyboardId, provider, prompt, promptContractJson, model, duration, aspectRatio,
    resolution, seed, cameraFixed, watermark, imageUrl, firstFrameUrl, lastFrameUrl,
    refImagesJson, refVideosJson, refAudiosJson, videoConfigId, providerProtocol,
    providerConfigSnapshot ? JSON.stringify(providerConfigSnapshot) : null,
    contractValidationMode, task.id, clientRequestKey, now, now
  );
  const videoGenId = db.prepare('SELECT last_insert_rowid() as id').get().id;
  setImmediate(() => videoService.processVideoGeneration(db, log, videoGenId));
  return videoService.getById(db, videoGenId) || { id: videoGenId, task_id: task.id, status: 'processing' };
}

function routes(db, log) {
  return {
    list: (req, res) => {
      try {
        const query = { ...req.query };
        const { items, total, page, pageSize } = videoService.list(db, query);
        response.successWithPagination(res, items, total, page, pageSize);
      } catch (err) {
        log.error('videos list', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    create: (req, res) => {
      try {
        const item = createGeneration(db, log, req.body || {});
        response.created(res, item);
      } catch (err) {
        log.error('videos create', { error: err.message });
        if (err.acceptance_guard === true) {
          return response.error(res, err.http_status || 423, err.code, err.message);
        }
        response.internalError(res, err.message);
      }
    },
    get: (req, res) => {
      try {
        const item = videoService.getById(db, req.params.id);
        if (!item) return response.notFound(res, '记录不存在');
        response.success(res, item);
      } catch (err) {
        log.error('videos get', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    retryDownload: async (req, res) => {
      try {
        const item = videoService.getById(db, req.params.id);
        if (!item) return response.notFound(res, '记录不存在');
        if (item.generation_status !== 'completed') {
          return response.badRequest(res, '上游视频尚未完成，不能进入下载恢复');
        }
        const result = await videoService.resumeDownloadForVideoGeneration(db, log, req.params.id);
        response.success(res, { result, video: videoService.getById(db, req.params.id) });
      } catch (err) {
        log.error('videos retry download', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    delete: (req, res) => {
      try {
        const ok = videoService.deleteById(db, log, req.params.id);
        if (!ok) return response.notFound(res, '记录不存在');
        response.success(res, { message: '删除成功' });
      } catch (err) {
        log.error('videos delete', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    fromImage: (req, res) => {
      try {
        const task = taskService.createTask(db, log, 'video_generation', req.params.image_gen_id);
        response.success(res, { task_id: task.id });
      } catch (err) {
        log.error('videos fromImage', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    episodeBatch: (req, res) => {
      try {
        response.success(res, []);
      } catch (err) {
        log.error('videos episode batch', { error: err.message });
        response.internalError(res, err.message);
      }
    },
  };
}

module.exports = routes;
module.exports.createGeneration = createGeneration;
