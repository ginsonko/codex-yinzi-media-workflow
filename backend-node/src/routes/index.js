const express = require('express');
const response = require('../response');
const dramaRoutes = require('./drama');
const taskRoutes = require('./task');
const settingsRoutes = require('./settings');
const aiConfigRoutes = require('./aiConfig');
const propRoutes = require('./prop');
const stubRoutes = require('./stub');
const characterLibraryRoutes = require('./characterLibrary');
const sceneLibraryRoutes = require('./sceneLibrary');
const propLibraryRoutes = require('./propLibrary');
const characterRoutes = require('./characters');
const uploadModule = require('./upload');
const sceneRoutes = require('./scenes');
const storyboardRoutes = require('./storyboards');
const tailFrameLinkRoutes = require('./storyboards_tail_link');
const imageRoutes = require('./images');
const videoRoutes = require('./videos');
const videoMergeRoutes = require('./videoMerges');
const assetRoutes = require('./assets');
const audioRoutes = require('./audio');
const promptOverridesRoutes = require('./promptOverrides');
const sceneModelMapRoutes = require('./sceneModelMap');
const productionRoutes = require('./production');
const advancedSettingsRoutes = require('./advancedSettings');
const assetImportRoutes = require('./assetImport');
const seriesGroupRoutes = require('./seriesGroups');
const templateRoutes = require('./templates');
const privacyDerivationRoutes = require('./privacyDerivations');
const orchestrationRoutes = require('./orchestration');
const mediaBatchRoutes = require('./mediaBatch');
const { createMediaBatchService } = require('../services/mediaBatchService');

function setupRouter(cfg, db, log, injected = {}) {
  const r = express.Router();
  const { buildRuntimeIdentity } = require('../services/runtimeIdentity');
  const desktopShortcut = require('../services/desktopShortcutService');
  const drama = dramaRoutes(db, cfg, log);
  const task = taskRoutes(db, log);
  const settings = settingsRoutes(db, cfg, log);
  const aiConfig = aiConfigRoutes(db, log, cfg);
  const prop = propRoutes(db, log, cfg);
  const stub = stubRoutes(db, cfg, log);
  const sceneModelMap = sceneModelMapRoutes(db, log);
  
  const uploadService = require('../services/uploadService');
  const charLibrary = characterLibraryRoutes(db, cfg, log);
  const sceneLibrary = sceneLibraryRoutes(db, cfg, log);
  const propLibrary = propLibraryRoutes(db, cfg, log);
  const characters = characterRoutes(db, cfg, log, uploadService);
  const uploadHandlers = uploadModule.routes(cfg, log, db);
  const scenes = sceneRoutes(db, log, cfg);
  const storyboards = storyboardRoutes(db, log);
  const tailFrameLink = tailFrameLinkRoutes(db, cfg, log);
  const images = imageRoutes(db, cfg, log);
  const videos = videoRoutes(db, log);
  const videoMerges = videoMergeRoutes(db, log);
  const assets = assetRoutes(db, log, cfg);
  const audio = audioRoutes(db, log, cfg);
  const promptOverrides = promptOverridesRoutes.routes(db, log);
  const production = productionRoutes(db, cfg, log, injected.production || {});
  const advancedSettings = advancedSettingsRoutes(db, cfg, log, injected.advancedSettings || {});
  const assetImports = assetImportRoutes(db, cfg, log, injected);
  const seriesGroups = seriesGroupRoutes(db, log);
  const templates = templateRoutes(log);
  const privacyDerivations = privacyDerivationRoutes(db, cfg, log);
  const orchestration = orchestrationRoutes(db, log, cfg, injected.orchestration || {});
  r.blenderService = orchestration.blenderService;
  const mediaBatch = createMediaBatchService(db, log, {
    config: cfg,
    dispatchVideo: (body) => {
      const { createGeneration } = require('./videos');
      return createGeneration(db, log, body, { entry: 'media_batch_video' });
    },
  });
  mediaBatch.resumeAll();
  r.mediaBatchService = mediaBatch;

  // Read-only process/database identity used by the UI and Codex adapters to
  // prevent split-brain when more than one local backend is running.
  r.get('/runtime-identity', (req, res) => {
    response.success(res, buildRuntimeIdentity(cfg, { canonical: process.env.YINZI_WORKFLOW_CANONICAL === '1' }));
  });
  r.post('/runtime/desktop-shortcut', (req, res) => {
    try {
      response.success(res, desktopShortcut.createWindowsShortcut());
    } catch (error) {
      const status = error.code === 'SHORTCUT_WINDOWS_ONLY' ? 400 : 500;
      response.error(res, status, error.code || 'SHORTCUT_CREATE_FAILED', error.message);
    }
  });

  // ---------- Codex-led open-world orchestration ----------
  // These endpoints describe and record dynamic plans. They do not replace
  // the existing production workflow or silently execute paid providers.
  r.get('/orchestration-modules', orchestration.listModules);
  r.post('/orchestration-modules', orchestration.registerModule);
  r.post('/orchestration-modules/import', orchestration.importModules);
  r.get('/orchestration-modules/export', orchestration.exportModules);
  r.put('/orchestration-modules/:moduleId', orchestration.updateModule);
  r.delete('/orchestration-modules/:moduleId', orchestration.deleteModule);
  r.get('/orchestration-modules/:moduleId', orchestration.getModule);
  r.get('/orchestration-onboarding', orchestration.onboarding);
  r.get('/runtime-work-status', (req, res) => {
    const sources = { async_tasks:['pending','processing','running'], media_batches:['queued','running','paused'], production_runs:['running'], orchestration_blender_jobs:['queued','running'] };
    const counts = {};
    for (const [table, statuses] of Object.entries(sources)) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      counts[table] = db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE status IN (${statuses.map(() => '?').join(',')})`).get(...statuses).n;
    }
    counts.analysis = db.prepare("SELECT COUNT(*) n FROM orchestration_sessions WHERE deleted_at IS NULL AND (status='running' OR (status='draft' AND json_extract(source_context_json,'$.activity.state')='working'))").get().n;
    response.success(res, { busy: Object.values(counts).some(n => n > 0), counts });
  });
  r.get('/orchestration-sessions', orchestration.listSessions);
  r.get('/orchestration-artifacts', orchestration.searchArtifacts);
  r.post('/orchestration-sessions/begin', orchestration.beginWork);
  r.post('/orchestration-sessions/:id/activity', orchestration.reportActivity);
  r.post('/orchestration-sessions', orchestration.createSession);
  r.get('/orchestration-sessions/:id', orchestration.getSession);
  r.get('/orchestration-sessions/:id/blender/jobs', orchestration.blenderJobs);
  r.get('/orchestration-sessions/:id/blender/jobs/:jobId', orchestration.blenderJob);
  r.patch('/orchestration-sessions/:id', orchestration.updateSession);
  r.put('/orchestration-sessions/:id/plan', orchestration.submitPlan);
  r.post('/orchestration-sessions/:id/confirm', orchestration.confirmPlan);
  r.post('/orchestration-sessions/:id/start', orchestration.startSession);
  r.post('/orchestration-sessions/:id/complete', orchestration.completeSession);
  const creativePreferences = require('../services/creativePreferences');
  r.get('/creative-preferences', (req,res) => response.success(res,{...creativePreferences.get(db), profiles:creativePreferences.PROFILES}));
  r.put('/creative-preferences', (req,res) => { try { response.success(res,creativePreferences.set(db,req.body)); } catch(error) { response.error(res,400,error.code || 'INVALID_PREFERENCES',error.message); } });
  r.patch('/orchestration-sessions/:id/nodes/:nodeId', orchestration.updateNode);
  r.post('/orchestration-sessions/:id/nodes/:nodeId/retry', orchestration.retryNode);
  r.post('/orchestration-sessions/:id/nodes/:nodeId/actions/:action', orchestration.actOnNode);
  r.post('/orchestration-sessions/:id/nodes/:nodeId/external-request', orchestration.reserveExternalRequest);
  r.post('/orchestration-sessions/:id/nodes/:nodeId/blender/render', orchestration.renderBlender);
  r.post('/orchestration-sessions/:id/blender/jobs/:jobId/resume', orchestration.resumeBlender);
  r.post('/orchestration-sessions/:id/blender/jobs/:jobId/cancel', orchestration.cancelBlender);
  r.post('/orchestration-sessions/:id/pause', orchestration.pauseSession);
  r.post('/orchestration-sessions/:id/resume', orchestration.resumeSession);
  r.post('/orchestration-sessions/:id/checkpoint', orchestration.saveCheckpoint);
  r.get('/orchestration-sessions/:id/events', orchestration.events);
  r.post('/orchestration-sessions/:id/events', orchestration.recordEvent);
  r.get('/orchestration-sessions/:id/export', orchestration.exportSession);
  r.get('/orchestration-sessions/:id/artifacts', orchestration.artifacts);
  r.post('/orchestration-sessions/:id/artifacts', orchestration.registerArtifact);
  r.get('/orchestration-sessions/:id/feedback', orchestration.feedback);
  r.post('/orchestration-sessions/:id/feedback', orchestration.recordFeedback);
  r.get('/orchestration-sessions/:id/delivery', orchestration.delivery);
  r.post('/orchestration-sessions/:id/delivery', orchestration.prepareDelivery);

  // ---------- durable image/video batches ----------
  const batches = mediaBatchRoutes(mediaBatch, log);
  r.get('/media-batches', batches.list);
  r.post('/media-batches', batches.create);
  r.get('/media-batches/:id', batches.get);
  r.post('/media-batches/:id/pause', batches.pause);
  r.post('/media-batches/:id/resume', batches.resume);
  r.post('/media-batches/:id/items/:itemId/retry', batches.retry);
  r.post('/media-batches/:id/items/:itemId/retry-download', batches.retryDownload);

  // ---------- production workflow ----------
  r.get('/production-graph', production.graph);
  // Capability and smoke preparation are read-only. The compatibility render
  // endpoint executes locally; orchestration jobs offer cancellation/recovery.
  r.get('/production-director/blender/capability', production.blenderCapability);
  r.post('/production-director/blender/smoke/prepare', production.prepareBlenderSmoke);
  r.post('/production-director/blender/render', production.renderBlenderScene);
  r.get('/production-media', production.productionMedia);
  r.get('/production-runs', production.listRuns);
  r.post('/production-runs', production.createRun);
  r.get('/production-runs/:id', production.getRun);
  r.get('/production-runs/:id/costs', production.costs);
  r.get('/production-runs/:id/video-routing', production.videoRouting);
  r.patch('/production-runs/:id/video-routing', production.updateVideoRouting);
  r.post('/production-runs/:id/preflight', production.preflight);
  r.patch('/production-runs/:id', production.updateRun);
  r.post('/production-runs/:id/start', production.start);
  r.post('/production-runs/:id/advance', production.advance);
  r.post('/production-runs/:id/final-edit/rebuild', production.rebuildFinalEdit);
  r.post('/production-runs/:id/client-result', production.clientResult);
  r.post('/production-runs/:id/export', production.exportRun);
  r.post('/production-runs/:id/export.zip', production.zipRun);
  r.post('/production-runs/:id/pause', production.pause);
  r.post('/production-runs/:id/resume', production.resume);
  r.post('/production-runs/:id/retry', production.retry);
  r.post('/production-runs/:id/actions/:actionId/reconcile', production.reconcileAction);
  r.post('/production-runs/:id/recover-storyboard', production.recoverStoryboard);
  r.post('/production-runs/:id/shots/:shotId/skip-director', production.skipDirector);
  r.post('/production-runs/:id/director/disable', production.disableDirector);
  r.post('/production-runs/:id/shots/:shotId/skip', production.skipShot);
  r.post('/production-runs/:id/shots/:shotId/restore', production.restoreShot);
  r.post('/production-runs/:id/shots/:shotId/revise', production.reviseShot);
  r.post('/production-runs/:id/shots/:shotId/split', production.splitShot);
  r.post('/production-runs/:id/shots/pickup', production.pickupShot);
  r.post('/production-runs/:id/cancel', production.cancel);
  r.post('/production-runs/:id/detach', production.detach);
  r.post('/production-runs/:id/cancel-action', production.cancelAction);
  // Explicit aliases make the three P2 semantics discoverable to clients
  // while keeping the compact action endpoint backward compatible.
  r.post('/production-runs/:id/cancel-local', production.cancelLocal);
  r.post('/production-runs/:id/cancel-provider', production.cancelProvider);
  r.post('/production-runs/:id/transition', production.transition);
  r.post('/production-runs/:id/return', production.returnToStage);
  r.get('/production-runs/:id/artifacts', production.listArtifacts);
  r.get('/production-runs/:id/reusable-media', production.reusableMedia);
  r.post('/production-runs/:id/reusable-media/:artifactId/materialize', production.materializeReusableMedia);
  r.post('/production-runs/:id/artifacts', production.addArtifact);
  r.get('/production-runs/:id/events', production.events);
  r.get('/production-runs/:id/reviews', production.reviews);
  r.get('/production-runs/:id/actions', production.actions);
  r.patch('/production-artifacts/:artifactId', production.updateArtifact);
  r.post('/production-artifacts/:artifactId/review', production.reviewArtifact);
  r.post('/production-artifacts/:artifactId/exclude', production.excludeArtifact);
  r.post('/production-artifacts/:artifactId/restore', production.restoreArtifact);
  r.post('/production-artifacts/:artifactId/confirm-direct-clip', production.confirmDirectClip);
  r.patch('/production-artifacts/:artifactId/direct-clip', production.updateDirectClip);
  r.post('/production-artifacts/:artifactId/suggest', production.suggestArtifact);
  r.post('/production-assist', production.assist);

  // ---------- V0.4 P3 imports and series groups ----------
  r.get('/templates', templates.list);
  r.get('/templates/:id', templates.get);
  r.get('/privacy-derivations', privacyDerivations.list);
  r.post('/privacy-derivations', privacyDerivations.derive);
  r.delete('/privacy-derivations/:id', privacyDerivations.remove);
  r.get('/asset-import-sessions', assetImports.list);
  r.post('/asset-import-sessions', assetImports.create);
  r.get('/asset-import-sessions/:id', assetImports.get);
  r.post('/asset-import-sessions/:id/upload', ...assetImports.upload);
  r.post('/asset-import-sessions/:id/scan', assetImports.scan);
  r.post('/asset-import-sessions/:id/reorganize', assetImports.reorganize);
  r.patch('/asset-import-sessions/:id/plan', assetImports.updatePlan);
  r.get('/asset-import-sessions/:id/plan', assetImports.plan);
  r.post('/asset-import-sessions/:id/apply', assetImports.apply);
  r.post('/asset-import-sessions/:id/rollback', assetImports.rollback);
  r.get('/series-groups', seriesGroups.list);
  r.post('/series-groups', seriesGroups.create);
  r.get('/series-groups/:id', seriesGroups.get);
  r.post('/series-groups/:id/episodes', seriesGroups.addEpisode);
  r.get('/series-groups/:id/assets', seriesGroups.assets);
  r.post('/series-groups/:id/assets', seriesGroups.upsertAsset);
  r.post('/series-groups/:id/reuse', seriesGroups.reuse);
  r.post('/series-groups/:id/fork', seriesGroups.fork);

  // ---------- dramas ----------
  r.get('/dramas', drama.listDramas);
  r.post('/dramas', drama.createDrama);
  r.get('/dramas/stats', drama.getDramaStats);
  // 导出/导入（放在 :id 路由前，避免被 :id 捕获）
  r.get('/dramas/:id/export', drama.exportDrama);
  const multer = require('multer');
  const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });
  r.post('/dramas/import', importUpload.single('file'), drama.importDrama);
  r.post('/dramas/import-novel', importUpload.single('file'), async (req, res) => {
    try {
      const novelImportService = require('../services/novelImportService');
      let text = '';
      if (req.file && req.file.buffer) {
        text = req.file.buffer.toString('utf8');
      } else if (req.body && req.body.text) {
        text = req.body.text;
      }
      if (!text.trim()) return response.badRequest(res, '请上传小说文本文件或提供 text 参数');
      const title = req.body?.title || '';
      const maxChapters = Number(req.body?.max_chapters) || 20;
      const aiSummarize = req.body?.ai_summarize === 'true' || req.body?.ai_summarize === true;
      const result = await novelImportService.importNovel(db, log, { text, title, maxChapters, aiSummarize });
      response.success(res, result);
    } catch (err) {
      log.error('dramas import-novel', { error: err.message });
      response.internalError(res, err.message);
    }
  });
  r.get('/dramas/examples', drama.listExamples);
  r.post('/dramas/import-example', drama.importExample);
  r.put('/dramas/:id/outline', drama.saveOutline);
  r.get('/dramas/:id/characters', drama.getCharacters);
  r.put('/dramas/:id/characters', drama.saveCharacters);
  r.put('/dramas/:id/episodes', drama.saveEpisodes);
  r.put('/dramas/:id/progress', drama.saveProgress);
  r.put('/dramas/:id/canvas-layout', drama.saveCanvasLayout);
  r.get('/dramas/:id/props', drama.listProps);
  r.get('/dramas/:id', drama.getDrama);
  r.put('/dramas/:id', drama.updateDrama);
  r.delete('/dramas/:id', drama.deleteDrama);

  // ---------- ai-configs ----------
  r.get('/ai-configs', aiConfig.list);
  r.get('/ai-configs/candidates', aiConfig.candidates);
  r.post('/ai-configs', aiConfig.create);
  r.post('/ai-configs/test', aiConfig.testConnection);
  r.post('/ai-configs/discover-models', aiConfig.discoverModels);
  r.get('/ai-configs/yinzi/catalog', aiConfig.yinziCatalog);
  r.get('/ai-configs/distribution-profile', aiConfig.distributionProfile);
  r.post('/ai-configs/yinzi/preview', aiConfig.previewYinzi);
  r.post('/ai-configs/yinzi/setup', aiConfig.setupYinzi);
  r.post('/ai-configs/image-yinzi/setup', aiConfig.setupImageYinzi);
  r.post('/ai-configs/laoli/setup', aiConfig.setupLaoli);
  r.post('/ai-configs/jimeng2-list-assets', aiConfig.listJimeng2MaterialAssets);
  r.post('/ai-configs/model-ark-asset', aiConfig.modelArkAsset);
  r.get('/ai-configs/vendor-lock', aiConfig.vendorLock);  // 必须在 /:id 之前
  r.put('/ai-configs/bulk-update-key', aiConfig.bulkUpdateKey);  // 必须在 /:id 之前
  r.get('/ai-configs/:id/model-capabilities', aiConfig.modelCapabilities);
  r.put('/ai-configs/:id/model-capabilities', aiConfig.updateModelCapabilities);
  r.get('/ai-configs/:id', aiConfig.get);
  r.put('/ai-configs/:id', aiConfig.update);
  r.delete('/ai-configs/:id', aiConfig.delete);

  // ---------- generation (角色生成：AI + 入库 + 任务结果) ----------
  r.post('/generation/characters', (req, res) => {
    const characterGenerationService = require('../services/characterGenerationService');
    try {
      const body = req.body || {};
      if (!body.drama_id) {
        return response.badRequest(res, 'drama_id 必填');
      }
      const taskId = characterGenerationService.generateCharacters(db, cfg, log, body);
      response.success(res, { task_id: taskId, status: 'pending' });
    } catch (err) {
      log.error('generation/characters', { error: err.message });
      response.internalError(res, err.message || '创建任务失败');
    }
  });

  // 故事生成：带 drama_id 时异步生成并入库；否则同步返回 episodes（兼容旧调用）
  r.post('/generation/story', async (req, res) => {
    const storyGenerationService = require('../services/storyGenerationService');
    try {
      const body = req.body || {};
      if (body.drama_id) {
        const taskId = storyGenerationService.startStoryGeneration(db, log, body);
        return response.success(res, { task_id: taskId, status: 'pending' });
      }
      const result = await storyGenerationService.generateStory(db, log, body);
      response.success(res, result);
    } catch (err) {
      log.error('generation/story', { error: err.message });
      if (err.message && (err.message.includes('未配置') || err.message.includes('必填') || err.message.includes('不存在'))) {
        return response.badRequest(res, err.message);
      }
      response.internalError(res, err.message || '故事生成失败');
    }
  });

  // ---------- character-library ----------
  r.get('/character-library', charLibrary.list);
  r.post('/character-library', charLibrary.create);
  r.get('/character-library/:id', charLibrary.get);
  r.put('/character-library/:id', charLibrary.update);
  r.delete('/character-library/:id', charLibrary.delete);

  // ---------- scene-library ----------
  r.get('/scene-library', sceneLibrary.list);
  r.post('/scene-library', sceneLibrary.create);
  r.get('/scene-library/:id', sceneLibrary.get);
  r.put('/scene-library/:id', sceneLibrary.update);
  r.delete('/scene-library/:id', sceneLibrary.delete);

  // ---------- prop-library ----------
  r.get('/prop-library', propLibrary.list);
  r.post('/prop-library', propLibrary.create);
  r.get('/prop-library/:id', propLibrary.get);
  r.put('/prop-library/:id', propLibrary.update);
  r.delete('/prop-library/:id', propLibrary.delete);

  // ---------- characters ----------
  r.get('/characters/:id', characters.getOne);
  r.put('/characters/:id', characters.update);
  r.delete('/characters/:id', characters.delete);
  r.post('/characters/batch-generate-images', characters.batchGenerateImages);
  r.post('/characters/:id/generate-image', characters.generateImage);
  r.post('/characters/:id/generate-four-view-image', characters.generateFourViewImage);
  r.post('/characters/:id/generate-prompt', characters.generatePrompt);
  r.post('/characters/:id/upload-image', uploadModule.multerSingle, characters.uploadImage);
  r.put('/characters/:id/image', characters.putImage);
  r.put('/characters/:id/image-from-library', characters.imageFromLibrary);
  r.post('/characters/:id/add-to-library', characters.addToLibrary);
  r.post('/characters/:id/add-to-material-library', characters.addToMaterialLibrary);
  r.post('/characters/:id/sd2-certify', characters.sd2Certify);
  r.post('/characters/:id/sd2-certify/refresh', characters.sd2CertifyRefresh);
  r.post('/characters/:id/sd2-voice-upload', uploadModule.multerAudioSingle, characters.sd2VoiceUpload);
  r.post('/characters/:id/sd2-voice-refresh', characters.sd2VoiceRefresh);
  r.post('/characters/:id/extract-from-image', characters.extractFromImage);
  r.post('/characters/:id/extract-anchors', characters.extractAnchors);

  // ---------- props ----------
  r.get('/props/:id', prop.getPropById);
  r.post('/props', prop.createProp);
  r.put('/props/:id', prop.updateProp);
  r.delete('/props/:id', prop.deleteProp);
  r.post('/props/:id/generate', prop.generateImage);
  r.post('/props/:id/generate-prompt', prop.generatePropPrompt);
  r.post('/props/:id/add-to-library', prop.addToLibrary);
  r.post('/props/:id/add-to-material-library', prop.addToMaterialLibrary);
  r.post('/props/:id/extract-from-image', prop.extractPropFromImage);

  // ---------- vision: 从图片提取描述（不依赖已有实体 ID）----------
  r.post('/extract-description-from-image', async (req, res) => {
    const { image_url, entity_type, entity_name } = req.body || {};
    if (!image_url) return response.badRequest(res, '缺少 image_url');
    if (!['character', 'scene', 'prop'].includes(entity_type)) return response.badRequest(res, 'entity_type 需为 character/scene/prop');
    try {
      const { extractDescriptionFromImage } = require('../services/aiClient');
      const out = await extractDescriptionFromImage(db, log, entity_type, image_url, entity_name);
      if (!out.ok) return response.badRequest(res, out.error);
      response.success(res, { description: out.description });
    } catch (err) {
      log.error('extract-description-from-image', { error: err.message });
      response.internalError(res, err.message);
    }
  });

  // ---------- upload ----------
  r.post('/upload/image', uploadModule.multerSingle, uploadHandlers.uploadImage);
  r.post('/upload/reference-media', uploadModule.multerReferenceMediaSingle, uploadHandlers.uploadReferenceMedia);

  // ---------- episodes ----------
  // 注意：drama.generateStoryboard 已处理所有逻辑（包括参数解析），这里统一使用 drama 模块的实现
  // 之前可能有部分路由指向了 storyboards.episodeStoryboardsGenerate，这可能导致参数解析不一致
  r.post('/episodes/:episode_id/storyboards', drama.generateStoryboard);
  r.post('/episodes/:episode_id/props/extract', prop.extractProps);
  r.post('/episodes/:episode_id/characters/extract', stub.episodeCharactersExtract);
  r.get('/episodes/:episode_id/storyboards', storyboards.episodeStoryboardsGet);
  r.post('/episodes/:episode_id/finalize', drama.finalizeEpisode);
  r.get('/episodes/:episode_id/download', drama.downloadEpisodeVideo);

  // ---------- tasks ----------
  r.get('/tasks/:task_id', task.getTaskStatus);
  r.post('/tasks/:task_id/cancel', task.cancelTaskStatus);
  r.get('/tasks', task.getResourceTasks);

  // ---------- scenes ----------
  r.get('/scenes/:scene_id', scenes.getOne);
  r.post('/scenes/:scene_id/generate-prompt', scenes.generatePrompt);
  r.put('/scenes/:scene_id', scenes.update);
  r.put('/scenes/:scene_id/prompt', scenes.updatePrompt);
  r.delete('/scenes/:scene_id', scenes.delete);
  r.post('/scenes/generate-image', scenes.generateImage);
  r.post('/scenes', scenes.create);
  r.post('/scenes/:scene_id/generate-four-view-image', scenes.generateFourViewImage);
  r.post('/scenes/:scene_id/add-to-library', scenes.addToLibrary);
  r.post('/scenes/:scene_id/add-to-material-library', scenes.addToMaterialLibrary);
  r.post('/scenes/:scene_id/extract-from-image', scenes.extractFromImage);

  // ---------- images ----------
  r.get('/images', images.list);
  r.post('/images', images.create);
  r.get('/images/episode/:episode_id/backgrounds', images.episodeBackgrounds);
  r.post('/images/episode/:episode_id/backgrounds/extract', images.episodeBackgroundsExtract);
  r.post('/images/episode/:episode_id/batch', images.episodeBatch);
  r.post('/images/scene/:scene_id', images.scene);
  r.post('/images/upload', images.upload);
  r.get('/images/:id', images.get);
  r.delete('/images/:id', images.delete);

  // ---------- videos ----------
  r.get('/videos', videos.list);
  r.post('/videos', videos.create);
  r.post('/videos/image/:image_gen_id', videos.fromImage);
  r.post('/videos/episode/:episode_id/batch', videos.episodeBatch);
  r.get('/videos/:id', videos.get);
  r.post('/videos/:id/retry-download', videos.retryDownload);
  r.delete('/videos/:id', videos.delete);

  // ---------- video-merges ----------
  r.get('/video-merges', videoMerges.list);
  r.post('/video-merges', videoMerges.create);
  r.get('/video-merges/:merge_id', videoMerges.get);
  r.delete('/video-merges/:merge_id', videoMerges.delete);

  // ---------- assets ----------
  r.get('/assets', assets.list);
  r.post('/assets', assets.create);
  r.post('/assets/import/image/:image_gen_id', assets.importImage);
  r.post('/assets/import/video/:video_gen_id', assets.importVideo);
  r.get('/assets/:id/download', assets.download);
  r.get('/assets/:id', assets.get);
  r.put('/assets/:id', assets.update);
  r.delete('/assets/:id', assets.delete);

  // ---------- storyboards ----------
  r.get('/storyboards/episode/:episode_id/generate', storyboards.episodeStoryboardsGenerate);
  r.post('/storyboards', storyboards.create);
  r.post('/storyboards/:id/insert-before', storyboards.insertBefore);
  r.get('/storyboards/:id', storyboards.getOne);
  r.put('/storyboards/:id', storyboards.update);
  r.delete('/storyboards/:id', storyboards.delete);
  r.post('/storyboards/:id/props', prop.associateProps);
  r.post('/storyboards/:id/frame-prompt', storyboards.framePrompt);
  r.get('/storyboards/:id/frame-prompts', storyboards.framePromptsGet);
  r.put('/storyboards/:id/frame-prompts/:frame_type', storyboards.framePromptSave);
  r.post('/storyboards/:id/link-tail-frame', tailFrameLink.linkTailFrame);
  r.post('/storyboards/:id/polish-prompt', storyboards.polishPrompt);
  r.post('/storyboards/:id/universal-segment-polish-stream', storyboards.polishUniversalSegmentStream);
  r.post('/storyboards/:id/classic-video-prompt-polish-stream', storyboards.polishClassicVideoPromptStream);
  r.post('/storyboards/:id/universal-segment-prompt-stream', storyboards.generateUniversalSegmentStream);
  r.post('/storyboards/:id/universal-segment-prompt', storyboards.generateUniversalSegmentPrompt);
  r.post('/storyboards/batch-infer-params', storyboards.batchInferParams);
  r.post('/storyboards/:id/upscale', storyboards.upscale);
  r.post('/storyboards/:id/regenerate-layout-description', storyboards.regenerateLayoutDescription);
  r.post('/storyboards/:id/rebuild-video-prompt', storyboards.rebuildVideoPrompt);
  r.post('/storyboards/:id/split-by-audio', storyboards.splitByAudio);

  // ---------- audio ----------
  r.post('/audio/extract', audio.extract);
  r.post('/audio/extract/batch', audio.extractBatch);

  // ---------- settings ----------
  r.get('/settings/language', settings.getLanguage);
  r.put('/settings/language', settings.updateLanguage);
  r.get('/settings/generation', settings.getGenerationSettings);
  r.put('/settings/generation', settings.updateGenerationSettings);

  // ---------- advanced settings, prices, budgets and portable backups ----------
  r.get('/settings/advanced/summary', advancedSettings.summary);
  r.get('/settings/advanced/prompts', advancedSettings.listPrompts);
  r.put('/settings/advanced/prompts/:promptId', advancedSettings.updatePrompt);
  r.delete('/settings/advanced/prompts/:promptId', advancedSettings.resetPrompt);
  r.post('/settings/advanced/prompts/export', advancedSettings.exportPrompts);
  r.post('/settings/advanced/prompts/preview-import', advancedSettings.previewPromptImport);
  r.post('/settings/advanced/prompts/apply-import', advancedSettings.applyPromptImport);
  r.get('/settings/advanced/prices', advancedSettings.listPrices);
  r.put('/settings/advanced/prices', advancedSettings.upsertPrice);
  r.post('/settings/advanced/prices/yinzi/sync', advancedSettings.syncYinziPrices);
  r.get('/settings/advanced/budget-defaults', advancedSettings.getBudgetDefaults);
  r.put('/settings/advanced/budget-defaults', advancedSettings.updateBudgetDefaults);
  r.get('/settings/advanced/automation-preferences', advancedSettings.getAutomationPreferences);
  r.put('/settings/advanced/automation-preferences', advancedSettings.updateAutomationPreferences);
  r.post('/settings/advanced/config-bundles/export', advancedSettings.exportBundle);
  r.post('/settings/advanced/config-bundles/preview', advancedSettings.previewBundle);
  r.post('/settings/advanced/config-bundles/apply', advancedSettings.applyBundle);
  r.get('/settings/advanced/backups', advancedSettings.listBackups);
  r.post('/settings/advanced/backups', advancedSettings.createBackup);
  r.post('/settings/advanced/backups/:id/preview-rollback', advancedSettings.previewRollback);
  r.post('/settings/advanced/backups/:id/rollback', advancedSettings.rollback);

  // ---------- prompt overrides ----------
  r.get('/settings/prompts', promptOverrides.list);
  r.put('/settings/prompts/:key', promptOverrides.update);
  r.delete('/settings/prompts/:key', promptOverrides.reset);

  // ---------- scene model map ----------
  r.get('/scene-model-map', sceneModelMap.list);
  r.post('/scene-model-map', sceneModelMap.create);
  r.get('/scene-model-map/:key', sceneModelMap.get);
  r.put('/scene-model-map/:key', sceneModelMap.update);
  r.delete('/scene-model-map/:key', sceneModelMap.delete);

  // 启动时将已有的覆盖加载到 promptI18n 内存缓存
  try {
    const promptI18n = require('../services/promptI18n');
    const promptOverridesService = require('../services/promptOverridesService');
    const saved = promptOverridesService.listOverrides(db);
    promptI18n.loadOverridesIntoCache(saved);
  } catch (e) {
    console.warn('Failed to load prompt overrides:', e.message);
  }

  return r;
}

module.exports = { setupRouter };
