const response = require('../response');
const repo = require('../services/productionRepository');
const graph = require('../services/productionGraph');
const { createProductionService } = require('../services/productionService');
const reusableMediaService = require('../services/productionReusableMedia');
const costLedger = require('../services/productionCostLedger');
const blenderDirector = require('../services/blenderDirector');
const {
  DIRECTOR_MOTIONS,
  DIRECTOR_POSES,
  RECIPE_SHAPES,
  listDirectorAssets,
} = require('../services/productionDirectorAssets');

function sendError(res, log, label, error) {
  log.error(label, { error: error.message, code: error.code });
  const code = error.code || 'BAD_REQUEST';
  if (code === 'VERSION_CONFLICT') return response.error(res, 409, code, error.message);
  if (code === 'SHOT_OPERATION_BUSY') return response.error(res, 409, code, error.message);
  if (code === 'PRODUCTION_ASPECT_RATIO_LOCKED') return response.error(res, 409, code, error.message, error.details);
  if (code.startsWith('SERIES_')) return response.error(res, 409, code, error.message);
  if (code === 'STAGE_INCOMPLETE') return response.error(res, 409, code, error.message, error.details);
  if (code.includes('BUDGET')) return response.error(res, 409, code, error.message, error.details);
  if (code === 'AMBIGUOUS_ACTION') return response.error(res, 409, code, error.message);
  if (code.startsWith('BLENDER_')) return response.error(res, 400, code, error.message, error.details);
  if (code.startsWith('AMBIGUOUS_') || code.startsWith('PROVIDER_TASK_') || code.startsWith('VIDEO_GENERATION_') || code === 'VIDEO_CONFIG_UNAVAILABLE') {
    return response.error(res, 409, code, error.message, error.details);
  }
  if (['FINAL_VIDEO_OUTDATED', 'FINAL_VIDEO_MEDIA_IMMUTABLE'].includes(code)) {
    return response.error(res, 409, code, error.message);
  }
  return response.badRequest(res, error.message);
}

function publicProductionMediaItem(item, availability) {
  return {
    artifact_id: item.artifact_id,
    run_id: item.run_id,
    drama_id: item.drama_id,
    drama_title: item.drama_title,
    episode_id: item.episode_id,
    episode_title: item.episode_title,
    episode_number: item.episode_number,
    stage: item.stage,
    scope_type: item.scope_type,
    scope_id: item.scope_id,
    revision: item.revision,
    title: item.title,
    kind: item.kind,
    media_path: item.media_path,
    mime_type: item.mime_type,
    media_type: item.media_type,
    duration_seconds: item.duration_seconds,
    source_run_status: item.source_run_status,
    source_current_stage: item.source_current_stage,
    source_run_updated_at: item.source_run_updated_at,
    source_run_completed_at: item.source_run_completed_at,
    approved_at: item.approved_at,
    created_at: item.created_at,
    updated_at: item.updated_at,
    ...availability,
  };
}

function routes(db, cfg, log, injected = {}) {
  const service = createProductionService(db, cfg, log, injected);
  const blender = injected.blenderDirector || blenderDirector;
  return {
    graph: (_req, res) => response.success(res, {
      graph_version: graph.GRAPH_VERSION,
      handler_version: graph.HANDLER_VERSION,
      stages: graph.STAGES,
      macros: graph.MACROS,
      director_assets: listDirectorAssets(),
      director_poses: DIRECTOR_POSES,
      director_motions: DIRECTOR_MOTIONS,
      director_recipe_shapes: RECIPE_SHAPES,
    }),
    blenderCapability: (_req, res) => {
      try { response.success(res, blender.detectBlender(cfg)); }
      catch (error) { sendError(res, log, 'blender capability probe', error); }
    },
    prepareBlenderSmoke: (req, res) => {
      try { response.success(res, blender.prepareBlenderSmoke(cfg, req.body || {})); }
      catch (error) { sendError(res, log, 'blender smoke prepare', error); }
    },
    renderBlenderScene: (req, res) => {
      try { response.success(res, blender.runBlenderRender(cfg, req.body || {})); }
      catch (error) { sendError(res, log, 'blender scene render', error); }
    },
    productionMedia: (req, res) => {
      try {
        const result = repo.listProductionMedia(db, req.query || {});
        const items = result.items.map((item) => publicProductionMediaItem(
          item,
          reusableMediaService.inspectArtifactMedia(cfg, item),
        ));
        const available = items.filter((item) => item.available).length;
        response.success(res, {
          ...result,
          items,
          availability: { available, unavailable: items.length - available },
        });
      } catch (error) { sendError(res, log, 'production media list', error); }
    },
    listRuns: (req, res) => {
      try { response.success(res, repo.listRuns(db, req.query)); }
      catch (error) { sendError(res, log, 'production list', error); }
    },
    createRun: (req, res) => {
      try {
        const result = repo.createRun(db, req.body || {});
        if (result.reused) return response.success(res, { ...result, summary: repo.getRunSummary(db, result.run.id) });
        response.created(res, { ...result, summary: repo.getRunSummary(db, result.run.id) });
      } catch (error) { sendError(res, log, 'production create', error); }
    },
    getRun: (req, res) => {
      try {
        const summary = repo.getRunSummary(db, req.params.id);
        if (!summary) return response.notFound(res, '制作任务不存在');
        response.success(res, summary);
      } catch (error) { sendError(res, log, 'production get', error); }
    },
    costs: (req, res) => {
      try {
        if (!repo.getRun(db, req.params.id)) return response.notFound(res, '制作任务不存在');
        response.success(res, costLedger.listRunCosts(db, req.params.id, req.query || {}));
      } catch (error) { sendError(res, log, 'production costs', error); }
    },
    videoRouting: async (req, res) => {
      try { response.success(res, await service.getVideoRouting(req.params.id, req.query || {})); }
      catch (error) { sendError(res, log, 'production video routing get', error); }
    },
    updateVideoRouting: async (req, res) => {
      try { response.success(res, await service.updateVideoRouting(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'production video routing update', error); }
    },
    preflight: (req, res) => {
      try { response.success(res, service.preflight(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'production preflight', error); }
    },
    updateRun: (req, res) => {
      try {
        const summary = service.updateRunControl(req.params.id, req.body || {});
        if (!summary) return response.notFound(res, '制作任务不存在');
        response.success(res, summary);
      } catch (error) { sendError(res, log, 'production update', error); }
    },
    start: (req, res) => {
      try {
        let run = repo.getRun(db, req.params.id);
        if (!run) return response.notFound(res, '制作任务不存在');
        if (run.status === 'draft' && run.current_stage === 'story_input') {
          const result = repo.transitionRun(db, run.id, {
            next_stage_strategy: req.body?.next_stage_strategy || run.next_stage_strategy,
            expected_version: req.body?.expected_version,
          });
          run = result.run;
        } else {
          run = repo.updateRun(db, run.id, { status: 'running', waiting_reason: null }, req.body?.expected_version);
        }
        repo.appendEvent(db, run.id, 'run.started', { stage: run.current_stage });
        response.success(res, repo.getRunSummary(db, run.id));
      } catch (error) { sendError(res, log, 'production start', error); }
    },
    advance: async (req, res) => {
      try { response.success(res, await service.advance(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'production advance', error); }
    },
    rebuildFinalEdit: async (req, res) => {
      try { response.success(res, await service.rebuildFinalEdit(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'production final edit rebuild', error); }
    },
    clientResult: async (req, res) => {
      try { response.success(res, await service.acceptClientResult(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'production client result', error); }
    },
    exportRun: (req, res) => {
      try { response.success(res, service.exportRun(req.params.id)); }
      catch (error) { sendError(res, log, 'production export', error); }
    },
    zipRun: (req, res) => {
      try { response.success(res, service.zipRun(req.params.id)); }
      catch (error) { sendError(res, log, 'production zip', error); }
    },
    pause: (req, res) => {
      try {
        const run = repo.updateRun(db, req.params.id, { status: 'paused', waiting_reason: 'user_paused' }, req.body?.expected_version);
        if (!run) return response.notFound(res, '制作任务不存在');
        repo.appendEvent(db, run.id, 'run.paused', { stage: run.current_stage });
        response.success(res, repo.getRunSummary(db, run.id));
      } catch (error) { sendError(res, log, 'production pause', error); }
    },
    resume: (req, res) => {
      try {
        const summary = service.updateRunControl(req.params.id, {
          status: 'running',
          waiting_reason: null,
          error_code: null,
          error_message: null,
          resolve_intervention: true,
          expected_version: req.body?.expected_version,
        });
        if (!summary) return response.notFound(res, '制作任务不存在');
        repo.appendEvent(db, summary.run.id, 'run.resumed', { stage: summary.run.current_stage });
        response.success(res, summary);
      } catch (error) { sendError(res, log, 'production resume', error); }
    },
    retry: (req, res) => {
      try { response.success(res, service.authorizeRetry(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'production retry', error); }
    },
    reconcileAction: async (req, res) => {
      try { response.success(res, await service.reconcileAction(req.params.id, req.params.actionId, req.body || {})); }
      catch (error) { sendError(res, log, 'production action reconcile', error); }
    },
    recoverStoryboard: (req, res) => {
      try { response.success(res, service.recoverScopedShotRevision(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'production storyboard recovery', error); }
    },
    skipDirector: async (req, res) => {
      try { response.success(res, await service.skipDirectorForShot(req.params.id, req.params.shotId, req.body || {})); }
      catch (error) { sendError(res, log, 'production director skip', error); }
    },
    disableDirector: async (req, res) => {
      try { response.success(res, await service.disableDirectorAndContinue(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'production director disable', error); }
    },
    skipShot: async (req, res) => {
      try { response.success(res, await service.skipShot(req.params.id, req.params.shotId, req.body || {})); }
      catch (error) { sendError(res, log, 'production shot skip', error); }
    },
    restoreShot: async (req, res) => {
      try { response.success(res, await service.restoreShot(req.params.id, req.params.shotId, req.body || {})); }
      catch (error) { sendError(res, log, 'production shot restore', error); }
    },
    reviseShot: async (req, res) => {
      try { response.success(res, await service.reviseShot(req.params.id, req.params.shotId, req.body || {})); }
      catch (error) { sendError(res, log, 'production shot revise', error); }
    },
    splitShot: async (req, res) => {
      try { response.success(res, await service.splitShot(req.params.id, req.params.shotId, req.body || {})); }
      catch (error) { sendError(res, log, 'production shot split', error); }
    },
    pickupShot: async (req, res) => {
      try { response.success(res, await service.pickupShot(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'production shot pickup', error); }
    },
    cancel: (req, res) => {
      try {
        const run = repo.updateRun(db, req.params.id, { status: 'cancelled', waiting_reason: 'user_cancelled' }, req.body?.expected_version);
        if (!run) return response.notFound(res, '制作任务不存在');
        repo.appendEvent(db, run.id, 'run.cancelled', { stage: run.current_stage });
        response.success(res, repo.getRunSummary(db, run.id));
      } catch (error) { sendError(res, log, 'production cancel', error); }
    },
    detach: async (req, res) => {
      try {
        const result = await service.detachRunView(req.params.id, req.body || {});
        if (!result) return response.notFound(res, '制作任务不存在');
        response.success(res, result);
      } catch (error) { sendError(res, log, 'production detach view', error); }
    },
    cancelAction: async (req, res) => {
      try {
        const result = await service.cancelRunAction(req.params.id, req.body || {});
        if (!result || result.status === 'not_found') return response.notFound(res, '当前没有可取消的任务动作');
        response.success(res, result);
      } catch (error) { sendError(res, log, 'production cancel action', error); }
    },
    cancelLocal: async (req, res) => {
      try {
        const result = await service.cancelRunAction(req.params.id, {
          ...(req.body || {}), cancel_mode: 'cancel_local_request',
        });
        if (!result || result.status === 'not_found') return response.notFound(res, '当前没有可停止的任务动作');
        response.success(res, result);
      } catch (error) { sendError(res, log, 'production cancel local observation', error); }
    },
    cancelProvider: async (req, res) => {
      try {
        const result = await service.cancelRunAction(req.params.id, {
          ...(req.body || {}), cancel_mode: 'cancel_provider_task',
        });
        if (!result || result.status === 'not_found') return response.notFound(res, '当前没有可取消的任务动作');
        response.success(res, result);
      } catch (error) { sendError(res, log, 'production cancel provider task', error); }
    },
    transition: (req, res) => {
      try {
        const result = service.transition(req.params.id, req.body || {});
        response.success(res, { ...result, summary: repo.getRunSummary(db, req.params.id) });
      } catch (error) { sendError(res, log, 'production transition', error); }
    },
    returnToStage: (req, res) => {
      try {
        const run = repo.getRun(db, req.params.id);
        if (!run) return response.notFound(res, '制作任务不存在');
        const target = String(req.body?.stage || '');
        if (!graph.getStage(target) || graph.stageIndex(target) >= graph.stageIndex(run.current_stage)) {
          throw new Error('只能返回已经经过的上游阶段');
        }
        const updated = repo.updateRun(db, run.id, {
          current_stage: target,
          status: 'waiting_review',
          waiting_reason: 'returned_for_revision',
          error_code: null,
          error_message: null,
          completed_at: null,
          runtime: { ...run.runtime, client_action_id: null },
        }, req.body?.expected_version);
        repo.appendEvent(db, run.id, 'run.returned', { stage: target, payload: { from: run.current_stage, reason: req.body?.reason || null } });
        response.success(res, repo.getRunSummary(db, updated.id));
      } catch (error) { sendError(res, log, 'production return', error); }
    },
    listArtifacts: (req, res) => {
      try {
        if (!repo.getRun(db, req.params.id)) return response.notFound(res, '制作任务不存在');
        response.success(res, repo.listArtifacts(db, req.params.id, req.query));
      } catch (error) { sendError(res, log, 'production artifacts', error); }
    },
    reusableMedia: (req, res) => {
      try {
        const result = repo.listReusableMedia(db, req.params.id, req.query);
        if (!result) return response.notFound(res, '制作任务不存在');
        const items = result.items.map((item) => publicProductionMediaItem(
          item,
          reusableMediaService.inspectArtifactMedia(cfg, item),
        ));
        const available = items.filter((item) => item.available).length;
        response.success(res, {
          ...result,
          items,
          availability: { available, unavailable: items.length - available },
        });
      } catch (error) { sendError(res, log, 'production reusable media', error); }
    },
    materializeReusableMedia: async (req, res) => {
      try {
        const targetRun = repo.getRun(db, req.params.id);
        const artifact = repo.getArtifact(db, req.params.artifactId);
        const sourceRun = artifact ? repo.getRun(db, artifact.run_id) : null;
        if (!targetRun || !artifact || !sourceRun) return response.notFound(res, 'Historical media not found');
        const crossProject = Number(sourceRun.drama_id) !== Number(targetRun.drama_id);
        if (crossProject && req.body?.allow_cross_project !== true) {
          return response.badRequest(res, '跨项目复用需要在素材库中明确选择“全部项目”');
        }
        if (artifact.status !== 'approved'
          || !['asset_images', 'storyboard_images', 'director_preview', 'shot_video', 'final_edit'].includes(artifact.stage)) {
          return response.badRequest(res, 'Historical media is not approved or cannot be reused');
        }
        const prepared = await reusableMediaService.materializeArtifactMedia(cfg, artifact);
        response.success(res, {
          artifact_id: artifact.id,
          source_run_id: sourceRun.id,
          source_drama_id: Number(sourceRun.drama_id),
          target_run_id: targetRun.id,
          target_drama_id: Number(targetRun.drama_id),
          cross_project: crossProject,
          ...prepared,
        });
      } catch (error) { sendError(res, log, 'production reusable media materialize', error); }
    },
    addArtifact: async (req, res) => {
      try {
        const artifact = await service.addManualArtifact(req.params.id, req.body || {});
        response.created(res, artifact);
      } catch (error) { sendError(res, log, 'production artifact add', error); }
    },
    updateArtifact: (req, res) => {
      try { response.success(res, service.updateArtifact(req.params.artifactId, req.body || {})); }
      catch (error) { sendError(res, log, 'production artifact edit', error); }
    },
    reviewArtifact: async (req, res) => {
      try { response.success(res, await service.reviewArtifact(req.params.artifactId, { reviewer_type: 'human', ...(req.body || {}) })); }
      catch (error) { sendError(res, log, 'production artifact review', error); }
    },
    excludeArtifact: async (req, res) => {
      try {
        const artifact = repo.getArtifact(db, req.params.artifactId);
        if (artifact?.stage === 'storyboard_plan' && artifact.scope_type === 'shot') {
          return response.success(res, await service.skipShot(
            artifact.run_id,
            artifact.scope_id,
            req.body || {},
          ));
        }
        response.success(res, repo.excludeArtifact(db, req.params.artifactId, req.body || {}));
      }
      catch (error) { sendError(res, log, 'production artifact exclude', error); }
    },
    restoreArtifact: async (req, res) => {
      try {
        const artifact = repo.getArtifact(db, req.params.artifactId);
        if (artifact?.stage === 'storyboard_plan' && artifact.scope_type === 'shot') {
          return response.success(res, await service.restoreShot(
            artifact.run_id,
            artifact.scope_id,
            req.body || {},
          ));
        }
        response.success(res, repo.restoreArtifact(db, req.params.artifactId, req.body || {}));
      }
      catch (error) { sendError(res, log, 'production artifact restore', error); }
    },
    confirmDirectClip: (req, res) => {
      try {
        const artifact = repo.getArtifact(db, req.params.artifactId);
        if (!artifact || artifact.stage !== 'shot_video' || artifact.content?.direct_clip_candidate !== true) throw Object.assign(new Error('当前产物不是待确认的直接视频片段'), { code: 'DIRECT_CLIP_NOT_CANDIDATE' });
        if (artifact.content?.included === true && artifact.content?.inclusion_pending_confirmation !== true) return response.success(res, artifact);
        // A rapid double-click may send the original candidate id twice. Read
        // the current revision for this shot and return an already approved
        // direct clip instead of creating another revision.
        const current = repo.listArtifacts(db, artifact.run_id, {
          stage: 'shot_video',
          scope_type: artifact.scope_type,
          scope_id: artifact.scope_id,
          current: true,
          page_size: 10,
        }).items[0];
        if (current && current.id !== artifact.id && current.content?.direct_clip_candidate === true
          && current.content?.included === true && current.content?.inclusion_pending_confirmation !== true
          && current.status === 'approved') return response.success(res, current);
        // Confirmation is an approval decision, not a generic restore. Create
        // an immutable included revision and approve it so final-edit planning
        // can consume the clip immediately.
        const replacement = repo.editArtifact(db, artifact.id, {
          content: {
            ...artifact.content,
            included: true,
            inclusion_pending_confirmation: false,
            exclusion_reason: null,
          },
        });
        const reviewed = repo.reviewArtifact(db, replacement.id, {
          reviewer_type: 'human',
          decision: 'approved',
          reason: String(req.body?.reason || '用户确认作为直接视频片段使用'),
        });
        response.success(res, reviewed.artifact);
      } catch (error) { sendError(res, log, 'production direct clip confirm', error); }
    },
    updateDirectClip: (req, res) => {
      try {
        const artifact = repo.getArtifact(db, req.params.artifactId);
        if (!artifact || artifact.stage !== 'shot_video' || artifact.content?.direct_clip_candidate !== true) throw Object.assign(new Error('当前产物不是可编辑的直接视频片段候选'), { code: 'DIRECT_CLIP_NOT_CANDIDATE' });
        const input = req.body || {};
        const directClip = { ...(artifact.content.direct_clip || {}), source_start_seconds: Math.max(0, Number(input.source_start_seconds ?? artifact.content.direct_clip?.source_start_seconds) || 0), source_end_seconds: input.source_end_seconds == null || input.source_end_seconds === '' ? null : Math.max(0, Number(input.source_end_seconds) || 0), speed: Math.max(0.25, Math.min(4, Number(input.speed ?? artifact.content.direct_clip?.speed) || 1)), keep_audio: input.keep_audio == null ? artifact.content.direct_clip?.keep_audio !== false : input.keep_audio === true, subtitle_mode: ['inherit', 'off', 'sidecar'].includes(String(input.subtitle_mode || 'inherit')) ? String(input.subtitle_mode || 'inherit') : 'inherit' };
        const replacement = repo.editArtifact(db, artifact.id, { content: { ...artifact.content, direct_clip: directClip } });
        response.success(res, replacement);
      } catch (error) { sendError(res, log, 'production direct clip update', error); }
    },
    suggestArtifact: async (req, res) => {
      try { response.success(res, await service.suggestArtifact(req.params.artifactId, req.body || {})); }
      catch (error) { sendError(res, log, 'production artifact suggest', error); }
    },
    assist: async (req, res) => {
      try {
        if (!req.body?.field_key && !req.body?.field) throw new Error('field_key 必填');
        response.success(res, await service.assist(req.body || {}));
      } catch (error) { sendError(res, log, 'production assist', error); }
    },
    events: (req, res) => {
      try { response.success(res, repo.listEvents(db, req.params.id, req.query)); }
      catch (error) { sendError(res, log, 'production events', error); }
    },
    reviews: (req, res) => {
      try { response.success(res, repo.listReviews(db, req.params.id, req.query)); }
      catch (error) { sendError(res, log, 'production reviews', error); }
    },
    actions: (req, res) => {
      try { response.success(res, repo.listActions(db, req.params.id, req.query)); }
      catch (error) { sendError(res, log, 'production actions', error); }
    },
  };
}

module.exports = routes;
