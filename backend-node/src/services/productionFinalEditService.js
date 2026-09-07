const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const repo = require('./productionRepository');
const videoMergeService = require('./videoMergeService');
const validation = require('./productionMediaValidation');
const storageLayout = require('./storageLayout');
const narrationPlan = require('./productionNarrationPlan');
const aiConfigService = require('./aiConfigService');
const {
  createFinalEditContract,
  finalVideoMatchesContract,
  sameOrderedIds,
  strictMergeActionMatchesContract,
} = require('./productionFinalEditContract');

function safeName(value, fallback = 'item') {
  const clean = String(value || fallback).trim().replace(/[\\/:*?"<>|#\x00-\x1f]/g, '_').replace(/\s+/g, '_');
  return clean.slice(0, 100) || fallback;
}

function collectPages(loadPage, pageSize) {
  const items = [];
  let page = 1;
  while (true) {
    const result = loadPage(page, pageSize);
    items.push(...(result.items || []));
    if (!result.pagination || page >= result.pagination.total_pages) break;
    page += 1;
  }
  return items;
}

function fileReceipt(filePath) {
  const hash = crypto.createHash('sha256');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  const handle = fs.openSync(filePath, 'r');
  let bytes = 0;
  try {
    while (true) {
      const read = fs.readSync(handle, chunk, 0, chunk.length, null);
      if (!read) break;
      hash.update(chunk.subarray(0, read));
      bytes += read;
    }
  } finally {
    fs.closeSync(handle);
  }
  return { bytes, sha256: hash.digest('hex') };
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = /(^|_)(api_?key|authorization|client_token|access_token|secret)$/i.test(key)
      ? '[REDACTED]'
      : redactSecrets(entry);
  }
  return result;
}

function createFinalEditService(db, cfg, log, injected = {}) {
  const validateVideo = injected.validateVideo || ((mediaPath, options) => validation.validateVideo(cfg, mediaPath, options));
  const mergeService = injected.mergeService || videoMergeService;

  function approvedShots(runId) {
    return repo.listArtifacts(db, runId, { stage: 'shot_video', current: true, status: 'approved', page_size: 200 }).items
      .filter((item) => item.content?.included !== false)
      .sort((a, b) => Number(a.scope_id) - Number(b.scope_id));
  }

  function approvedShotPlans(runId) {
    return repo.listArtifacts(db, runId, { stage: 'storyboard_plan', current: true, status: 'approved', page_size: 200 }).items
      .filter((item) => item.content?.included !== false)
      .sort((a, b) => Number(a.scope_id) - Number(b.scope_id));
  }

  function currentNarrationPlan(runId) {
    return repo.listArtifacts(db, runId, {
      stage: 'final_edit', scope_type: 'narration', scope_id: 'settings', current: true, page_size: 20,
    }).items[0] || null;
  }

  function currentFinalVideo(runId, status = null, contract = null) {
    const items = repo.listArtifacts(db, runId, {
      stage: 'final_edit', scope_type: 'run', scope_id: '', current: true,
      ...(status ? { status } : {}), page_size: 20,
    }).items;
    return items.find((item) => (
      (contract ? item.content?.kind === 'final_video' : item.content?.kind !== 'narration_plan')
      && item.media_path
      && (!contract || finalVideoMatchesContract(item, contract))
    )) || null;
  }

  function matchingStrictMergeAction(runId, contract) {
    return collectPages(
      (page, pageSize) => repo.listActions(db, runId, { page, page_size: pageSize }),
      200
    ).find((item) => strictMergeActionMatchesContract(item, contract)) || null;
  }

  function assertFinalVideoReviewable(artifact) {
    if (artifact?.content?.kind !== 'final_video') return artifact;
    const planArtifact = currentNarrationPlan(artifact.run_id);
    if (!planArtifact) return artifact;
    const contract = createFinalEditContract(planArtifact, approvedShots(artifact.run_id));
    if (planArtifact?.status !== 'approved' || !finalVideoMatchesContract(artifact, contract)) {
      const error = new Error('这份成片来自旧旁白或旧镜头，只能作为历史结果查看；请按最新旁白重新剪辑合成');
      error.code = 'FINAL_VIDEO_OUTDATED';
      throw error;
    }
    return artifact;
  }

  function assertFinalVideoImmutable(artifact) {
    if (artifact?.content?.kind !== 'final_video') return artifact;
    const error = new Error('最终成片不能通过改写文本来替换媒体；请修改旁白计划后重新剪辑合成');
    error.code = 'FINAL_VIDEO_MEDIA_IMMUTABLE';
    throw error;
  }

  function createNarrationPlanArtifact(run, expectedShots, shots, previous = null) {
    const content = narrationPlan.normalizeNarrationPlan(previous?.content || {}, expectedShots, shots);
    const artifact = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'final_edit',
      scope_type: 'narration',
      scope_id: 'settings',
      title: content.narration_enabled ? '旁白、字幕与原声设置' : '最终原声设置',
      content,
      status: 'draft',
      parent_artifact_id: previous?.id || null,
      depends_on: [...content.source_shot_artifact_ids, ...content.source_shot_video_artifact_ids],
    });
    repo.appendEvent(db, run.id, 'final_edit.narration_plan_created', {
      stage: 'final_edit', scope_type: 'narration', scope_id: 'settings',
      payload: {
        artifact_id: artifact.id,
        narration_enabled: content.narration_enabled,
        segment_count: content.segments.filter((segment) => segment.narration).length,
        voice_id: content.voice_id,
      },
    });
    return artifact;
  }

  function normalizeNarrationPlanEdit(artifact, input = {}) {
    const run = repo.getRun(db, artifact?.run_id);
    if (!run || artifact?.stage !== 'final_edit' || artifact?.content?.kind !== 'narration_plan') {
      throw new Error('当前产物不是旁白设置');
    }
    const expectedShots = approvedShotPlans(run.id);
    const shots = approvedShots(run.id);
    const incoming = input.content && typeof input.content === 'object' ? input.content : artifact.content;
    return {
      ...input,
      content: narrationPlan.normalizeNarrationPlan(incoming, expectedShots, shots),
      depends_on: [...expectedShots.map((item) => item.id), ...shots.map((item) => item.id)],
    };
  }

  function validateNarrationArtifact(artifact) {
    if (!artifact || artifact.stage !== 'final_edit' || artifact.content?.kind !== 'narration_plan') return null;
    const validated = narrationPlan.validateNarrationPlan(
      artifact.content,
      approvedShotPlans(artifact.run_id),
      approvedShots(artifact.run_id)
    );
    if (validated.narration_enabled && validated.voice_provider !== 'edge') {
      const providerConfig = aiConfigService.listConfigs(db, 'tts').find((item) => (
        item.is_active && String(item.provider || '').toLowerCase() === validated.voice_provider
      ));
      if (!providerConfig?.api_key) {
        const error = new Error(`尚未配置可用的 ${validated.voice_provider} TTS，请先在“AI 配置”中添加对应语音配置，或改用 Edge Neural`);
        error.code = 'TTS_CONFIG_MISSING';
        throw error;
      }
      if (validated.voice_provider === 'minimax' && !providerConfig.group_id) {
        const error = new Error('MiniMax TTS 配置缺少 Group ID，请补齐后再确认');
        error.code = 'TTS_CONFIG_MISSING';
        throw error;
      }
    }
    return validated;
  }

  function prepareExportDirectory(run) {
    const root = validation.storageRoot(cfg);
    const project = storageLayout.getProjectStorageSubdir(db, run.drama_id) || 'library';
    const dir = path.join(root, project, 'production-runs', safeName(run.id));
    const staging = `${dir}.staging-${crypto.randomUUID()}`;
    fs.mkdirSync(staging, { recursive: true });
    return { root, project, dir, staging };
  }

  function commitExportDirectory(paths) {
    const backup = `${paths.dir}.previous-${crypto.randomUUID()}`;
    let movedPrevious = false;
    try {
      if (fs.existsSync(paths.dir)) {
        fs.renameSync(paths.dir, backup);
        movedPrevious = true;
      }
      fs.renameSync(paths.staging, paths.dir);
      if (movedPrevious) fs.rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      try {
        if (!fs.existsSync(paths.dir) && movedPrevious && fs.existsSync(backup)) fs.renameSync(backup, paths.dir);
      } catch (_) {}
      try { if (fs.existsSync(paths.staging)) fs.rmSync(paths.staging, { recursive: true, force: true }); } catch (_) {}
      throw error;
    }
  }

  function materializeExport(runId) {
    const run = repo.getRun(db, runId);
    if (!run) throw new Error('制作任务不存在');
    if (run.status !== 'completed') throw new Error('只有全部阶段确认后才能导出');
    const planArtifact = currentNarrationPlan(runId);
    if (planArtifact && planArtifact.status !== 'approved') throw new Error('最新旁白计划尚未确认');
    const contract = planArtifact ? createFinalEditContract(planArtifact, approvedShots(runId)) : null;
    const final = currentFinalVideo(runId, 'approved', contract?.valid ? contract : null);
    if (!final || !final.media_path) throw new Error('缺少已确认的最终成片');
    const paths = prepareExportDirectory(run);
    try {
    const omittedStages = String(run.policy?.director_mode || 'auto') === 'off'
      ? new Set(['director_plan', 'director_preview'])
      : new Set();
    const artifacts = collectPages(
      (page, pageSize) => repo.listArtifacts(db, runId, { current: true, page, page_size: pageSize }),
      200
    )
      .filter((item) => item.status === 'approved'
        && item.content?.included !== false
        && !omittedStages.has(item.stage));
    const copied = new Map();
    const files = [];
    for (const artifact of artifacts) {
      let source = null;
      if (artifact.media_path) {
        try { source = validation.resolveLocalMediaPath(cfg, artifact.media_path); } catch (_) { source = null; }
      }
      const relativeName = artifact.media_path
        ? `${safeName(artifact.stage)}/${safeName(artifact.scope_type)}-${safeName(artifact.scope_id || 'run')}-r${artifact.revision}${path.extname(artifact.media_path) || '.bin'}`
        : `${safeName(artifact.stage)}/${safeName(artifact.scope_type)}-${safeName(artifact.scope_id || 'run')}-r${artifact.revision}.json`;
      let destination = path.join(paths.staging, relativeName);
      if (source) {
        const key = artifact.content_hash || source.relative_path;
        if (!copied.has(key)) {
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          try { fs.linkSync(source.absolute_path, destination); }
          catch (_) { fs.copyFileSync(source.absolute_path, destination); }
          copied.set(key, destination);
        } else {
          destination = copied.get(key);
        }
      } else {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, JSON.stringify(artifact.content, null, 2), 'utf8');
      }
      files.push({
        artifact_id: artifact.id,
        stage: artifact.stage,
        scope_id: artifact.scope_id,
        path: path.relative(paths.staging, destination).replace(/\\/g, '/'),
        source_path: artifact.media_path || null,
        artifact_content_hash: artifact.content_hash || null,
        ...fileReceipt(destination),
      });
    }
    const reviews = collectPages(
      (page, pageSize) => repo.listReviews(db, runId, { page, page_size: pageSize }),
      100
    );
    const actions = collectPages(
      (page, pageSize) => repo.listActions(db, runId, { page, page_size: pageSize }),
      200
    ).map(redactSecrets);
    const events = [];
    let beforeId = null;
    do {
      const page = repo.listEvents(db, runId, { limit: 200, ...(beforeId ? { before_id: beforeId } : {}) });
      events.push(...page.items);
      beforeId = page.next_before_id;
    } while (beforeId);
    const runPath = path.join(paths.staging, 'run.json');
    fs.writeFileSync(runPath, JSON.stringify(run, null, 2), 'utf8');
    const sidecars = [];
    for (const [kind, relativePath] of Object.entries({
      narration_audio: final.content?.narration_audio_path,
      subtitles: final.content?.subtitle_path,
    })) {
      if (!relativePath) continue;
      let source;
      try { source = validation.resolveLocalMediaPath(cfg, relativePath); } catch (_) { source = null; }
      if (!source || !fs.existsSync(source.absolute_path)) continue;
      const ext = path.extname(source.absolute_path) || (kind === 'subtitles' ? '.srt' : '.mp3');
      const destination = path.join(paths.staging, 'final_edit', `${kind}${ext}`);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source.absolute_path, destination);
      sidecars.push({
        kind,
        path: path.relative(paths.staging, destination).replace(/\\/g, '/'),
        source_path: relativePath,
        ...fileReceipt(destination),
      });
    }
    const manifest = {
      manifest_version: 3,
      run_id: run.id,
      drama_id: run.drama_id,
      episode_id: run.episode_id,
      graph_version: run.graph_version,
      generated_at: new Date().toISOString(),
      final_video: final.media_path,
      final_narration_audio: final.content?.narration_audio_path || null,
      final_subtitles: final.content?.subtitle_path || null,
      run_file: { path: 'run.json', ...fileReceipt(runPath) },
      files,
      sidecars,
      reviews,
      actions,
      events,
      policy: run.policy,
      usage: run.usage,
      export_omissions: {
        director_artifacts_omitted: omittedStages.size > 0,
        omitted_stages: [...omittedStages],
      },
    };
    const manifestPath = path.join(paths.staging, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    commitExportDirectory(paths);
    const committedManifestPath = path.join(paths.dir, 'manifest.json');
    return { directory: paths.dir, relative_directory: path.relative(paths.root, paths.dir).replace(/\\/g, '/'), manifest_path: committedManifestPath, manifest, zip_available: true };
    } catch (error) {
      try { if (fs.existsSync(paths.staging)) fs.rmSync(paths.staging, { recursive: true, force: true }); } catch (_) {}
      throw error;
    }
  }

  function createZip(runId) {
    const run = repo.getRun(db, runId);
    if (!run) throw new Error('制作任务不存在');
    const exportInfo = materializeExport(runId);
    const zipPath = path.join(path.dirname(exportInfo.directory), `${safeName(run.id)}.zip`);
    const zip = new AdmZip();
    zip.addLocalFolder(exportInfo.directory, 'production');
    zip.writeZip(zipPath);
    return { ...exportInfo, zip_path: zipPath, relative_zip_path: path.relative(validation.storageRoot(cfg), zipPath).replace(/\\/g, '/') };
  }

  async function ensureFinalEdit(run, options = {}) {
    const shots = approvedShots(run.id);
    const expectedShots = approvedShotPlans(run.id);
    if (!expectedShots.length) throw new Error('没有已确认的分镜');
    if (shots.length !== expectedShots.length) return { state: 'waiting_review', reason: 'shot_videos_incomplete' };
    let planArtifact = currentNarrationPlan(run.id);
    if (!planArtifact || ['rejected', 'invalidated', 'failed'].includes(planArtifact.status)) {
      planArtifact = createNarrationPlanArtifact(run, expectedShots, shots, planArtifact);
      if (!planArtifact.content.narration_enabled) {
        validateNarrationArtifact(planArtifact);
        planArtifact = repo.reviewArtifact(db, planArtifact.id, {
          reviewer_type: 'deterministic', decision: 'approved',
          reason: '当前分镜没有旁白文本，仅保留视频原声，无需调用 TTS',
        }).artifact;
      } else {
        repo.updateRun(db, run.id, run.review_owner === 'human'
          ? { status: 'waiting_review', waiting_reason: 'narration_confirmation' }
          : {
            status: 'running',
            waiting_reason: null,
            error_code: null,
            error_message: null,
          });
        return { state: 'progressed', reason: 'narration_plan_created', artifact: planArtifact };
      }
    }
    if (planArtifact.status !== 'approved') {
      return { state: 'stage_ready', reason: 'narration_confirmation', artifact: planArtifact };
    }
    const confirmedPlan = validateNarrationArtifact(planArtifact);
    const contract = createFinalEditContract(planArtifact, shots);
    if (!contract?.valid) throw new Error('旁白计划缺少确认指纹或已确认镜头来源');
    const matchingFinal = currentFinalVideo(run.id, null, contract);
    let action = matchingStrictMergeAction(run.id, contract);
    if (matchingFinal && ['draft', 'reviewing', 'approved'].includes(matchingFinal.status)) {
      return { state: 'stage_ready', artifact: matchingFinal };
    }
    const actionCanReconcileRejectedFinal = action
      && ['reserved', 'submitted', 'waiting', 'completed'].includes(action.status);
    if (matchingFinal
      && ['rejected', 'invalidated', 'failed'].includes(matchingFinal.status)
      && !options.force_rebuild
      && !actionCanReconcileRejectedFinal) {
      repo.updateRun(db, run.id, { status: 'waiting_review', waiting_reason: 'final_revision_required' });
      return { state: 'waiting_review', reason: 'final_revision_required', artifact: matchingFinal };
    }
    if (options.force_rebuild && action && ['completed', 'failed', 'cancelled'].includes(action.status)) action = null;
    if (action?.status === 'cancelled') action = null;
    if (action?.status === 'completed' && !matchingFinal) action = null;
    if (!action) {
      const revisionReason = String(options.revision_reason || '').trim().slice(0, 4000) || null;
      const attempt = repo.nextActionAttempt(db, run.id, 'final_edit', 'run', '', 'strict_merge');
      const actionKey = `final_edit:run:shots-${shots.map((item) => item.id).join('-')}:narration-${confirmedPlan.confirmation_fingerprint}:a${attempt}`;
      const segmentByShot = new Map(confirmedPlan.segments.map((item) => [String(item.shot_id), item]));
      const scenes = shots.map((shot) => ({
        scene_id: Number(shot.scope_id),
        shot_artifact_id: shot.id,
        video_url: shot.media_path,
        duration: Number(shot.content?.validation?.duration || 0) || Number(expectedShots.find((item) => item.scope_id === shot.scope_id)?.content?.duration || 5),
        title: shot.title,
        narration: segmentByShot.get(String(shot.scope_id))?.narration || '',
      }));
      const merge = mergeService.create(db, log, {
        episode_id: run.episode_id,
        drama_id: run.drama_id,
        title: `${run.id} 最终剪辑`,
        provider: 'ffmpeg',
        scenes,
        merge_options: {
          strict: true,
          strict_post_process: true,
          aspect_ratio: run.policy?.aspect_ratio || '16:9',
          narration_enabled: confirmedPlan.narration_enabled,
          narration_voice_provider: confirmedPlan.voice_provider,
          narration_voice_id: confirmedPlan.voice_id,
          narration_tts_model: confirmedPlan.voice_provider === 'edge' ? 'edge-neural-local' : undefined,
          narration_speed: confirmedPlan.speed,
          narration_volume: confirmedPlan.narration_volume,
          subtitle_mode: confirmedPlan.subtitle_mode,
          burn_narration_subtitles: confirmedPlan.subtitle_mode === 'burn',
          keep_provider_audio: confirmedPlan.keep_provider_audio,
          provider_audio_volume: confirmedPlan.provider_audio_volume,
          narration_ducking: confirmedPlan.ducking_enabled,
          max_narration_speed_ratio: confirmedPlan.max_speed_ratio,
          narration_timing_mode: 'shot_locked',
        },
      });
      action = repo.reserveAction(db, {
        run_id: run.id, action_key: actionKey, stage: 'final_edit', scope_type: 'run', scope_id: '', kind: 'strict_merge',
        attempt, request: {
          merge_id: merge.merge_id,
          scene_ids: shots.map((item) => item.id),
          narration_plan_artifact_id: planArtifact.id,
          narration_confirmation_fingerprint: confirmedPlan.confirmation_fingerprint,
          force_rebuild: options.force_rebuild === true,
          revision_reason: revisionReason,
        },
      }).action;
      action = repo.updateAction(db, action.id, { status: 'waiting', merge_id: merge.merge_id, task_id: merge.task_id });
      if (typeof mergeService.updateOptions === 'function') {
        const providerConfig = confirmedPlan.voice_provider === 'edge' ? null
          : aiConfigService.listConfigs(db, 'tts').find((item) => (
            item.is_active && String(item.provider || '').toLowerCase() === confirmedPlan.voice_provider
          ));
        mergeService.updateOptions(db, merge.merge_id, {
          cost_run_id: run.id,
          cost_action_id: action.id,
          narration_cost_group: confirmedPlan.voice_provider === 'edge' ? 'local' : '',
          narration_tts_model: providerConfig?.default_model
            || (Array.isArray(providerConfig?.model) ? providerConfig.model[0] : providerConfig?.model)
            || (confirmedPlan.voice_provider === 'edge' ? 'edge-neural-local' : ''),
        });
      }
      setImmediate(() => mergeService.processVideoMerge(
        db,
        log,
        merge.merge_id,
        cfg.storage?.base_url || '',
        validation.storageRoot(cfg)
      ));
      repo.updateRun(db, run.id, { status: 'waiting_provider', waiting_reason: 'final_merge' });
      return { state: 'waiting_provider', action, merge_id: merge.merge_id };
    }
    if (['reserved', 'submitted', 'waiting'].includes(action.status)) {
      const merge = mergeService.getById(db, action.merge_id);
      if (!merge || ['pending', 'processing'].includes(merge.status)) {
        repo.updateRun(db, run.id, { status: 'waiting_provider', waiting_reason: 'final_merge' });
        return { state: 'waiting_provider', action, merge };
      }
      if (merge.status !== 'completed') {
        repo.updateAction(db, action.id, { status: 'failed', error_code: 'FINAL_MERGE_FAILED', error_message: merge.error_msg || '严格合成失败' });
        repo.updateRun(db, run.id, { status: 'failed', error_code: 'FINAL_MERGE_FAILED', error_message: merge.error_msg || '严格合成失败' });
        return { state: 'failed', reason: 'final_merge_failed', merge };
      }
      const receipt = await validateVideo(merge.merged_url, {
        expected_duration: scenesDuration(expectedShots),
        duration_tolerance: Math.max(2, scenesDuration(expectedShots) * 0.25),
      });
      const latestPlanArtifact = currentNarrationPlan(run.id);
      const latestShots = approvedShots(run.id);
      const latestContract = createFinalEditContract(latestPlanArtifact, latestShots);
      if (latestPlanArtifact?.status !== 'approved'
        || !sameOrderedIds(latestContract?.source_shot_artifact_ids, contract.source_shot_artifact_ids)
        || latestContract?.narration_plan_artifact_id !== contract.narration_plan_artifact_id
        || latestContract?.narration_confirmation_fingerprint !== contract.narration_confirmation_fingerprint) {
        repo.updateAction(db, action.id, {
          status: 'completed',
          result: { receipt, stale_contract: true, stale_at: new Date().toISOString() },
        });
        repo.updateRun(db, run.id, { status: 'running', waiting_reason: null });
        return { state: 'progressed', reason: 'final_merge_contract_changed', action, receipt };
      }
      const mergedBase = String(merge.merged_url || '').replace(/\.mp4$/i, '');
      const narrationAudioPath = confirmedPlan.narration_enabled ? `${mergedBase}_narration.mp3` : null;
      const subtitlePath = confirmedPlan.narration_enabled && confirmedPlan.subtitle_mode !== 'off'
        ? `${mergedBase}_narration.srt`
        : null;
      for (const [label, relativePath] of [['旁白音轨', narrationAudioPath], ['字幕', subtitlePath]]) {
        if (!relativePath) continue;
        let resolved;
        try { resolved = validation.resolveLocalMediaPath(cfg, relativePath); } catch (_) { resolved = null; }
        if (!resolved || !fs.existsSync(resolved.absolute_path)) {
          throw new Error(`${label}交付文件未生成，不能创建最终成片产物`);
        }
      }
      const artifact = repo.createArtifact(db, {
        run_id: run.id, stage: 'final_edit', scope_type: 'run', scope_id: '', title: '最终剪辑成片',
        content: {
          kind: 'final_video',
          source_shot_artifact_ids: shots.map((item) => item.id),
          narration_plan_artifact_id: planArtifact.id,
          narration_confirmation_fingerprint: confirmedPlan.confirmation_fingerprint,
          narration_settings: confirmedPlan,
          narration_audio_path: narrationAudioPath,
          subtitle_path: subtitlePath,
          validation: receipt,
          revision_receipt: {
            force_rebuild: action.request?.force_rebuild === true,
            reason: action.request?.revision_reason || null,
            strict_merge_action_id: action.id,
          },
          included: true,
        },
        status: 'draft', media_path: receipt.relative_path, mime_type: 'video/mp4', content_hash: receipt.sha256,
        source_action_id: action.id, source_merge_id: action.merge_id, depends_on: [planArtifact.id, ...shots.map((item) => item.id)],
      });
      repo.updateAction(db, action.id, {
        status: 'completed',
        result: {
          artifact_id: artifact.id,
          receipt,
          revision_reason: action.request?.revision_reason || null,
        },
      });
      repo.updateRun(db, run.id, { status: 'running', waiting_reason: null });
      return { state: 'progressed', artifact, receipt };
    }
    return { state: 'waiting_review', reason: action.status };
  }

  function scenesDuration(shots) {
    return shots.reduce((sum, shot) => sum + (Number(shot.content?.duration) || 5), 0);
  }

  return {
    ensureFinalEdit,
    materializeExport,
    createZip,
    normalizeNarrationPlanEdit,
    validateNarrationArtifact,
    assertFinalVideoImmutable,
    assertFinalVideoReviewable,
  };
}

module.exports = { createFinalEditService };
