const crypto = require('node:crypto');
const repo = require('./productionRepository');
const textStages = require('./productionTextStages');
const { getYinziVideoCapability, capabilitySupportsRole } = require('./yinziVideoCapabilities');

const SHOT_DERIVED_STAGES = [
  'storyboard_images',
  'director_plan',
  'director_preview',
  'reference_bundle',
  'continuity_frame',
  'shot_video',
];

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function compareShots(left, right) {
  const leftNumber = Number(left.content?.number);
  const rightNumber = Number(right.content?.number);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return String(left.scope_id).localeCompare(String(right.scope_id), undefined, { numeric: true });
}

function listPlannedShots(db, runId, options = {}) {
  return repo.listArtifacts(db, runId, {
    stage: 'storyboard_plan',
    current: true,
    page_size: 200,
  }).items
    .filter((item) => options.include_excluded === true || item.content?.included !== false)
    .sort(compareShots);
}

function currentShot(db, runId, shotId) {
  return repo.listArtifacts(db, runId, {
    stage: 'storyboard_plan',
    scope_type: 'shot',
    scope_id: String(shotId),
    current: true,
    page_size: 10,
  }).items[0] || null;
}

function approvedAssets(db, runId) {
  return repo.listArtifacts(db, runId, {
    stage: 'asset_text',
    current: true,
    status: 'approved',
    page_size: 200,
  }).items.filter((item) => item.content?.included !== false)
    .map((item) => ({ artifact_id: item.id, scope_type: item.scope_type, scope_id: item.scope_id, ...item.content }));
}

function approvedScript(db, runId) {
  return repo.listArtifacts(db, runId, {
    stage: 'script', current: true, status: 'approved', page_size: 5,
  }).items[0] || null;
}

function assertExpectedVersion(run, expectedVersion) {
  if (expectedVersion == null) return;
  if (Number(expectedVersion) === Number(run.version)) return;
  const error = new Error('制作任务已在其它页面或自动流程中更新，请刷新后重试');
  error.code = 'VERSION_CONFLICT';
  throw error;
}

function codedError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function numberBetween(previous, next, usedNumbers) {
  const previousNumber = Number(previous?.content?.number);
  const nextNumber = Number(next?.content?.number);
  let candidate;
  if (Number.isFinite(previousNumber) && Number.isFinite(nextNumber) && nextNumber > previousNumber) {
    candidate = previousNumber + ((nextNumber - previousNumber) / 2);
  } else if (Number.isFinite(previousNumber)) {
    candidate = previousNumber + 1;
  } else if (Number.isFinite(nextNumber)) {
    candidate = Math.max(1, nextNumber - 1);
  } else {
    candidate = usedNumbers.length + 1;
  }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const normalized = Number(candidate.toFixed(6));
    if (!usedNumbers.some((value) => Math.abs(value - normalized) < 0.0000001)) return normalized;
    candidate += 0.000001;
  }
  return Number((Math.max(0, ...usedNumbers) + 1).toFixed(6));
}

function operationRuntime(run, shotId, patch = {}) {
  const runtime = clone(run.runtime);
  runtime.client_action_id = null;
  const autonomy = runtime.autonomy && typeof runtime.autonomy === 'object'
    ? runtime.autonomy
    : {};
  const objects = autonomy.objects && typeof autonomy.objects === 'object'
    ? { ...autonomy.objects }
    : {};
  for (const [key, value] of Object.entries(objects)) {
    const matchesScope = String(value?.scope_type || '') === 'shot'
      && String(value?.scope_id || '') === String(shotId);
    if (matchesScope || key.endsWith(`:shot:${shotId}`)) delete objects[key];
  }
  if (String(autonomy.intervention?.scope_type || '') === 'shot'
    && String(autonomy.intervention?.scope_id || '') === String(shotId)) {
    delete autonomy.intervention;
  }
  runtime.autonomy = { ...autonomy, objects, updated_at: new Date().toISOString() };
  const skipped = new Set((runtime.shot_pipeline?.skipped_shot_ids || []).map(String));
  if (patch.skipped === true) skipped.add(String(shotId));
  if (patch.skipped === false) skipped.delete(String(shotId));
  runtime.shot_pipeline = {
    ...(runtime.shot_pipeline || {}),
    mode: 'sequential',
    current_shot_id: patch.current_shot_id === undefined
      ? runtime.shot_pipeline?.current_shot_id || run.current_scope_id || null
      : patch.current_shot_id,
    skipped_shot_ids: [...skipped],
    last_shot_operation: patch.operation || null,
    last_shot_operation_at: new Date().toISOString(),
  };
  return runtime;
}

function actionIsLocalWaiting(action) {
  return action.kind === 'client_capture'
    && action.status === 'waiting'
    && !action.task_id
    && !action.generation_id
    && !action.provider_id;
}

function detachShotActions(db, runId, shotId, reason) {
  const now = new Date().toISOString();
  const actions = repo.listActions(db, runId, { page_size: 200 }).items
    .filter((action) => String(action.scope_type || '') === 'shot'
      && String(action.scope_id || '') === String(shotId));
  const receipts = [];
  for (const action of actions) {
    if (action.status === 'reserved') {
      const cancelled = repo.cancelReservedAction(db, action.id, {
        cancelled_reason: 'shot_skipped_before_submission',
        cancelled_at: now,
        detached_from_sequence: true,
        detached_reason: reason,
        detached_at: now,
        workflow_blocking: false,
      });
      receipts.push({ action_id: action.id, outcome: 'reservation_released', status: cancelled?.status || action.status });
      continue;
    }
    if (actionIsLocalWaiting(action)) {
      const cancelled = repo.updateAction(db, action.id, {
        status: 'cancelled',
        result: {
          ...(action.result || {}),
          cancelled_reason: 'shot_skipped_local_action',
          cancelled_at: now,
          detached_from_sequence: true,
          detached_reason: reason,
          detached_at: now,
          workflow_blocking: false,
        },
      });
      receipts.push({ action_id: action.id, outcome: 'local_action_cancelled', status: cancelled.status });
      continue;
    }
    const updated = repo.updateAction(db, action.id, {
      result: {
        ...(action.result || {}),
        source_artifact_id: action.result?.source_artifact_id ?? action.request?.source_artifact_id ?? null,
        bundle_artifact_id: action.result?.bundle_artifact_id ?? action.request?.bundle_artifact_id ?? null,
        detached_from_sequence: true,
        detached_reason: reason,
        detached_at: now,
        workflow_blocking: false,
      },
    });
    receipts.push({
      action_id: action.id,
      outcome: ['submitted', 'waiting', 'ambiguous'].includes(action.status)
        ? 'external_action_detached'
        : 'historical_action_annotated',
      status: updated.status,
    });
  }
  return receipts;
}

function markApprovedReplacement(db, artifact) {
  db.prepare(
    `UPDATE production_artifacts SET status = 'superseded', updated_at = ?
     WHERE run_id = ? AND stage = ? AND scope_type = ? AND scope_id = ?
       AND id <> ? AND status = 'approved' AND deleted_at IS NULL`
  ).run(
    new Date().toISOString(),
    artifact.run_id,
    artifact.stage,
    artifact.scope_type,
    artifact.scope_id,
    artifact.id
  );
}

function archiveCurrentApprovedVideo(db, runId, shotId, reason) {
  const current = repo.listArtifacts(db, runId, {
    stage: 'shot_video', scope_type: 'shot', scope_id: String(shotId), current: true, page_size: 10,
  }).items[0];
  if (!current?.media_path) return null;
  const archived = repo.createArtifact(db, {
    run_id: runId,
    stage: 'shot_video',
    scope_type: 'shot',
    scope_id: String(shotId),
    title: current.title,
    content: {
      ...(current.content || {}),
      included: false,
      archive_only: true,
      detached_from_sequence: true,
      detached_reason: reason,
      detached_at: new Date().toISOString(),
    },
    status: 'approved',
    media_path: current.media_path,
    mime_type: current.mime_type,
    content_hash: current.content_hash,
    parent_artifact_id: current.id,
    source_action_id: current.source_action_id,
    source_task_id: current.source_task_id,
    source_generation_id: current.source_generation_id,
    source_merge_id: current.source_merge_id,
    depends_on: repo.listUpstreamArtifactIds(db, current.id),
  });
  markApprovedReplacement(db, archived);
  return archived;
}

function invalidateScopedDerivedArtifacts(db, runId, shotId, preservedIds = []) {
  const preserved = new Set(preservedIds.map(Number));
  const timestamp = new Date().toISOString();
  const ids = [];
  for (const stage of SHOT_DERIVED_STAGES) {
    const current = repo.listArtifacts(db, runId, {
      stage, scope_type: 'shot', scope_id: String(shotId), current: true, page_size: 20,
    }).items;
    for (const artifact of current) {
      if (preserved.has(Number(artifact.id))) continue;
      if (['superseded', 'invalidated'].includes(artifact.status)) continue;
      db.prepare('UPDATE production_artifacts SET status = ?, updated_at = ? WHERE id = ?')
        .run('invalidated', timestamp, artifact.id);
      ids.push(artifact.id);
    }
  }
  return ids;
}

function createProductionShotService(db, options = {}) {
  const runTextAction = options.runTextAction;
  if (typeof runTextAction !== 'function') throw new Error('production shot service requires runTextAction');

  async function withLease(runId, input, operation, worker) {
    const initial = repo.getRun(db, runId);
    if (!initial) throw codedError('RUN_NOT_FOUND', '制作任务不存在');
    assertExpectedVersion(initial, input.expected_version);
    const owner = input.lease_owner || `shot-${operation}-${crypto.randomUUID()}`;
    const lease = repo.claimLease(db, runId, owner, input.lease_ttl_ms || 180000);
    if (!lease.claimed) throw codedError('SHOT_OPERATION_BUSY', '当前镜头正在被其它页面或自动流程处理，请稍后重试');
    let result;
    try {
      result = await worker(repo.getRun(db, runId));
    } finally {
      repo.releaseLease(db, runId, owner);
    }
    return { ...result, summary: repo.getRunSummary(db, runId) };
  }

  function operationOptions(run) {
    const capability = getYinziVideoCapability(run.policy?.video_model);
    const creativeMin = Math.max(1, Number(run.policy?.video_duration_min) || 1);
    const creativeMax = Math.max(creativeMin, Number(run.policy?.video_duration_max) || 60);
    return {
      duration_min: creativeMin,
      duration_max: creativeMax,
      provider_capability: capability || null,
      strict_first_frame_supported: capabilitySupportsRole(capability, 'image', 'first_frame'),
    };
  }

  function operationContext(run, plan) {
    const shots = listPlannedShots(db, run.id, { include_excluded: true });
    const index = shots.findIndex((item) => String(item.scope_id) === String(plan.scope_id));
    return {
      shots,
      index,
      previous: index > 0 ? shots[index - 1] : null,
      next: index >= 0 ? shots[index + 1] || null : null,
      assets: approvedAssets(db, run.id),
      script: approvedScript(db, run.id),
      material_context: textStages.materialContextText(run.policy),
    };
  }

  async function skipShot(runId, shotId, input = {}) {
    return withLease(runId, input, 'skip', async (run) => {
      const plan = currentShot(db, run.id, shotId);
      if (!plan) throw codedError('SHOT_NOT_FOUND', `找不到镜头 ${shotId}`);
      if (plan.content?.included === false) {
        return { state: 'unchanged', operation: 'skip', shot: plan, focus_shot_id: run.current_scope_id || null };
      }
      const reason = String(input.reason || '用户跳过此镜头').trim().slice(0, 1000);
      const plannedBefore = listPlannedShots(db, run.id);
      const targetIndex = plannedBefore.findIndex((item) => String(item.scope_id) === String(shotId));
      const nextShot = targetIndex >= 0 ? plannedBefore[targetIndex + 1] || null : null;
      const currentIndex = run.current_scope_id == null
        ? -1
        : plannedBefore.findIndex((item) => String(item.scope_id) === String(run.current_scope_id));
      const result = db.transaction(() => {
        const replacement = repo.createArtifact(db, {
          run_id: run.id,
          stage: 'storyboard_plan',
          scope_type: 'shot',
          scope_id: String(shotId),
          title: plan.title,
          content: {
            ...(plan.content || {}),
            included: false,
            shot_state: 'skipped',
            exclusion_reason: reason,
            skipped_at: new Date().toISOString(),
            skipped_from_artifact_id: plan.id,
          },
          status: 'approved',
          parent_artifact_id: plan.id,
          depends_on: repo.listUpstreamArtifactIds(db, plan.id),
        });
        markApprovedReplacement(db, replacement);
        repo.addReview(db, {
          run_id: run.id,
          artifact_id: replacement.id,
          reviewer_type: 'deterministic',
          decision: 'approved',
          reason,
          evidence: { operation: 'shot_skip', previous_artifact_id: plan.id },
        });
        const archivedVideo = archiveCurrentApprovedVideo(db, run.id, shotId, reason);
        const invalidatedByLineage = repo.invalidateDownstream(db, plan.id, 'shot_skipped', {
          preserve_artifact_ids: [replacement.id, archivedVideo?.id].filter(Boolean),
        });
        const invalidatedScoped = invalidateScopedDerivedArtifacts(
          db,
          run.id,
          shotId,
          [archivedVideo?.id].filter(Boolean)
        );
        const actions = detachShotActions(db, run.id, shotId, reason);
        const isCurrent = String(run.current_scope_id || '') === String(shotId);
        const remainingShots = plannedBefore.filter((item) => String(item.scope_id) !== String(shotId));
        let currentStage = run.current_stage;
        let currentScopeId = run.current_scope_id;
        let status = run.status;
        let waitingReason = run.waiting_reason;
        const sequenceAlreadyPassedTarget = currentIndex >= 0 && targetIndex >= 0 && targetIndex < currentIndex;
        const sequenceWasAtDelivery = run.current_stage === 'final_edit' || run.status === 'completed';
        if (isCurrent || sequenceAlreadyPassedTarget || sequenceWasAtDelivery) {
          currentStage = nextShot ? 'storyboard_plan' : 'final_edit';
          currentScopeId = nextShot?.scope_id || null;
          status = nextShot || remainingShots.length ? 'running' : 'waiting_review';
          waitingReason = nextShot || remainingShots.length ? null : 'no_included_shots';
        }
        const updated = repo.updateRun(db, run.id, {
          current_stage: currentStage,
          current_scope_type: currentScopeId == null ? null : 'shot',
          current_scope_id: currentScopeId,
          status,
          waiting_reason: waitingReason,
          error_code: null,
          error_message: null,
          completed_at: null,
          runtime: operationRuntime(run, shotId, {
            skipped: true,
            operation: 'skip',
            current_shot_id: currentScopeId,
          }),
        });
        repo.appendEvent(db, run.id, 'shot.skipped', {
          stage: 'storyboard_plan', scope_type: 'shot', scope_id: shotId,
          payload: {
            artifact_id: replacement.id,
            archived_video_artifact_id: archivedVideo?.id || null,
            invalidated_artifact_ids: [...new Set([...invalidatedByLineage, ...invalidatedScoped])],
            action_receipts: actions,
            next_shot_id: currentScopeId,
            reason,
          },
        });
        return {
          replacement,
          archivedVideo,
          actions,
          updated,
          focusShotId: currentScopeId || nextShot?.scope_id || remainingShots.at(-1)?.scope_id || null,
        };
      }).immediate();
      return {
        state: result.updated.status === 'waiting_review' ? 'waiting_review' : 'progressed',
        operation: 'skip',
        shot: result.replacement,
        archived_video: result.archivedVideo,
        action_receipts: result.actions,
        focus_shot_id: result.focusShotId,
      };
    });
  }

  async function restoreShot(runId, shotId, input = {}) {
    return withLease(runId, input, 'restore', async (run) => {
      const plan = currentShot(db, run.id, shotId);
      if (!plan) throw codedError('SHOT_NOT_FOUND', `找不到镜头 ${shotId}`);
      if (plan.content?.included !== false) {
        return { state: 'unchanged', operation: 'restore', shot: plan, focus_shot_id: shotId };
      }
      const reason = String(input.reason || '用户恢复已跳过镜头').trim().slice(0, 1000);
      const restored = db.transaction(() => {
        const content = { ...(plan.content || {}) };
        delete content.exclusion_reason;
        delete content.skipped_at;
        content.included = true;
        content.shot_state = 'planned';
        content.restored_at = new Date().toISOString();
        content.restored_from_artifact_id = plan.id;
        content.restore_reason = reason;
        const artifact = repo.createArtifact(db, {
          run_id: run.id,
          stage: 'storyboard_plan',
          scope_type: 'shot',
          scope_id: String(shotId),
          title: plan.title,
          content,
          status: 'draft',
          parent_artifact_id: plan.id,
          depends_on: repo.listUpstreamArtifactIds(db, plan.id),
        });
        const updated = repo.updateRun(db, run.id, {
          current_stage: 'storyboard_plan',
          current_scope_type: 'shot',
          current_scope_id: String(shotId),
          status: run.review_owner === 'human' ? 'waiting_review' : 'running',
          waiting_reason: run.review_owner === 'human' ? 'stage_review' : null,
          error_code: null,
          error_message: null,
          completed_at: null,
          runtime: operationRuntime(run, shotId, {
            skipped: false,
            operation: 'restore',
            current_shot_id: String(shotId),
          }),
        });
        repo.appendEvent(db, run.id, 'shot.restored', {
          stage: 'storyboard_plan', scope_type: 'shot', scope_id: shotId,
          payload: { artifact_id: artifact.id, skipped_artifact_id: plan.id, reason },
        });
        return { artifact, updated };
      }).immediate();
      return {
        state: restored.updated.status === 'running' ? 'progressed' : 'waiting_review',
        operation: 'restore',
        shot: restored.artifact,
        focus_shot_id: String(shotId),
      };
    });
  }

  async function reviseShot(runId, shotId, input = {}) {
    return withLease(runId, input, 'revise', async (run) => {
      const plan = currentShot(db, run.id, shotId);
      if (!plan || plan.content?.included === false) throw codedError('SHOT_NOT_ACTIVE', '请先恢复已跳过镜头再修改');
      const instruction = String(input.instruction || input.reason || '').trim();
      if (!instruction && !input.content) throw codedError('SHOT_INSTRUCTION_REQUIRED', '请说明这个镜头需要怎样修改');
      const context = operationContext(run, plan);
      const normalizeOptions = operationOptions(run);
      let revisedShot;
      if (input.content) {
        revisedShot = textStages.normalizeShotRevision({ shot: input.content }, null, plan.content?.number || shotId, normalizeOptions);
      } else {
        const generated = await runTextAction(run, {
          stage: 'storyboard_plan', scope_type: 'shot', scope_id: String(shotId), kind: 'shot_revise',
          prompts: textStages.shotRevisionPrompts({
            instruction,
            shot: plan.content,
            previous_shot: context.previous?.content,
            next_shot: context.next?.content,
            assets: context.assets,
            material_context: context.material_context,
            ...normalizeOptions,
          }),
          prompt_id: 'production.shot_revise.system',
          normalize: (raw) => ({
            shot: textStages.normalizeShotRevision(raw, null, plan.content?.number || shotId, normalizeOptions),
          }),
          max_tokens: 9000, temperature: 0.35, scene_key: 'production_shot_revise',
        });
        if (generated.waiting) return { state: 'waiting_task', operation: 'revise', ...generated };
        revisedShot = generated.shot;
      }
      const livePlan = currentShot(db, run.id, shotId);
      if (!livePlan || livePlan.id !== plan.id) throw codedError('VERSION_CONFLICT', '镜头在 AI 修改期间发生了变化，请刷新后重试');
      const created = db.transaction(() => {
        const artifact = repo.createArtifact(db, {
          run_id: run.id,
          stage: 'storyboard_plan',
          scope_type: 'shot',
          scope_id: String(shotId),
          title: revisedShot.title,
          content: {
            ...revisedShot,
            included: true,
            revision_instruction: instruction,
            revised_from_artifact_id: plan.id,
            shot_operation: 'revise',
          },
          status: 'draft',
          parent_artifact_id: plan.id,
          depends_on: repo.listUpstreamArtifactIds(db, plan.id),
        });
        const updated = repo.updateRun(db, run.id, {
          current_stage: 'storyboard_plan', current_scope_type: 'shot', current_scope_id: String(shotId),
          status: run.review_owner === 'human' ? 'waiting_review' : 'running',
          waiting_reason: run.review_owner === 'human' ? 'stage_review' : null,
          error_code: null, error_message: null, completed_at: null,
          runtime: operationRuntime(run, shotId, { operation: 'revise', current_shot_id: String(shotId) }),
        });
        repo.appendEvent(db, run.id, 'shot.revision_requested', {
          stage: 'storyboard_plan', scope_type: 'shot', scope_id: shotId,
          payload: { artifact_id: artifact.id, source_artifact_id: plan.id, instruction },
        });
        return { artifact, updated };
      }).immediate();
      return {
        state: created.updated.status === 'running' ? 'progressed' : 'waiting_review',
        operation: 'revise', shot: created.artifact, focus_shot_id: String(shotId),
      };
    });
  }

  async function splitShot(runId, shotId, input = {}) {
    return withLease(runId, input, 'split', async (run) => {
      const plan = currentShot(db, run.id, shotId);
      if (!plan || plan.content?.included === false) throw codedError('SHOT_NOT_ACTIVE', '请先恢复已跳过镜头再拆分');
      const instruction = String(input.instruction || input.reason || '').trim();
      if (!instruction && !input.content) throw codedError('SHOT_INSTRUCTION_REQUIRED', '请说明未展示的内容或希望怎样拆分');
      const context = operationContext(run, plan);
      if (context.shots.filter((item) => item.content?.included !== false).length + 1 > Number(run.budget?.max_shots || 12)) {
        throw codedError('SHOT_COUNT_BUDGET', '拆分后会超过当前任务允许的镜头数量上限');
      }
      const usedNumbers = context.shots.map((item) => Number(item.content?.number)).filter(Number.isFinite);
      const insertedNumber = numberBetween(plan, context.next, usedNumbers);
      const insertedScopeId = String(insertedNumber);
      const normalizeOptions = operationOptions(run);
      let split;
      if (input.content?.current_shot && input.content?.next_shot) {
        split = textStages.normalizeShotSplit(
          input.content,
          null,
          plan.content?.number || shotId,
          insertedNumber,
          normalizeOptions
        );
      } else {
        const generated = await runTextAction(run, {
          stage: 'storyboard_plan', scope_type: 'shot', scope_id: String(shotId), kind: 'shot_split',
          prompts: textStages.shotSplitPrompts({
            instruction,
            shot: plan.content,
            previous_shot: context.previous?.content,
            next_shot: context.next?.content,
            assets: context.assets,
            material_context: context.material_context,
            current_number: plan.content?.number || shotId,
            next_number: insertedNumber,
            ...normalizeOptions,
          }),
          prompt_id: 'production.shot_split.system',
          normalize: (raw) => textStages.normalizeShotSplit(
            raw,
            null,
            plan.content?.number || shotId,
            insertedNumber,
            normalizeOptions
          ),
          max_tokens: 12000, temperature: 0.35, scene_key: 'production_shot_split',
        });
        if (generated.waiting) return { state: 'waiting_task', operation: 'split', ...generated };
        split = generated;
      }
      const livePlan = currentShot(db, run.id, shotId);
      if (!livePlan || livePlan.id !== plan.id || currentShot(db, run.id, insertedScopeId)) {
        throw codedError('VERSION_CONFLICT', '镜头序列在 AI 拆分期间发生了变化，请刷新后重试');
      }
      const created = db.transaction(() => {
        const dependencies = repo.listUpstreamArtifactIds(db, plan.id);
        const currentArtifact = repo.createArtifact(db, {
          run_id: run.id, stage: 'storyboard_plan', scope_type: 'shot', scope_id: String(shotId),
          title: split.current_shot.title,
          content: {
            ...split.current_shot,
            included: true,
            split_instruction: instruction,
            split_from_artifact_id: plan.id,
            split_role: 'current',
            shot_operation: 'split',
          },
          status: 'draft', parent_artifact_id: plan.id, depends_on: dependencies,
        });
        const nextArtifact = repo.createArtifact(db, {
          run_id: run.id, stage: 'storyboard_plan', scope_type: 'shot', scope_id: insertedScopeId,
          title: split.next_shot.title,
          content: {
            ...split.next_shot,
            included: true,
            split_instruction: instruction,
            split_from_artifact_id: plan.id,
            split_parent_artifact_id: currentArtifact.id,
            split_role: 'inserted',
            shot_operation: 'split',
          },
          status: 'draft', depends_on: [...new Set([...dependencies, currentArtifact.id])],
        });
        const updated = repo.updateRun(db, run.id, {
          current_stage: 'storyboard_plan', current_scope_type: 'shot', current_scope_id: String(shotId),
          status: run.review_owner === 'human' ? 'waiting_review' : 'running',
          waiting_reason: run.review_owner === 'human' ? 'stage_review' : null,
          error_code: null, error_message: null, completed_at: null,
          runtime: operationRuntime(run, shotId, { operation: 'split', current_shot_id: String(shotId) }),
        });
        repo.appendEvent(db, run.id, 'shot.split', {
          stage: 'storyboard_plan', scope_type: 'shot', scope_id: shotId,
          payload: {
            source_artifact_id: plan.id,
            current_artifact_id: currentArtifact.id,
            inserted_artifact_id: nextArtifact.id,
            inserted_scope_id: insertedScopeId,
            instruction,
          },
        });
        return { currentArtifact, nextArtifact, updated };
      }).immediate();
      return {
        state: created.updated.status === 'running' ? 'progressed' : 'waiting_review',
        operation: 'split',
        shot: created.currentArtifact,
        inserted_shot: created.nextArtifact,
        focus_shot_id: String(shotId),
      };
    });
  }

  async function pickupShot(runId, input = {}) {
    return withLease(runId, input, 'pickup', async (run) => {
      const instruction = String(input.instruction || input.reason || '').trim();
      if (!instruction && !input.content) throw codedError('SHOT_INSTRUCTION_REQUIRED', '请说明需要补拍什么内容');
      const shots = listPlannedShots(db, run.id, { include_excluded: true });
      const activeShots = shots.filter((item) => item.content?.included !== false);
      if (activeShots.length + 1 > Number(run.budget?.max_shots || 12)) {
        throw codedError('SHOT_COUNT_BUDGET', '补拍后会超过当前任务允许的镜头数量上限');
      }
      const afterId = input.after_shot_id ?? run.current_scope_id ?? activeShots.at(-1)?.scope_id;
      const afterIndex = afterId == null
        ? activeShots.length - 1
        : activeShots.findIndex((item) => String(item.scope_id) === String(afterId));
      const previous = afterIndex >= 0 ? activeShots[afterIndex] : activeShots.at(-1) || null;
      const next = afterIndex >= 0 ? activeShots[afterIndex + 1] || null : null;
      const usedNumbers = shots.map((item) => Number(item.content?.number)).filter(Number.isFinite);
      const insertedNumber = numberBetween(previous, next, usedNumbers);
      const insertedScopeId = String(insertedNumber);
      const normalizeOptions = operationOptions(run);
      const assets = approvedAssets(db, run.id);
      const script = approvedScript(db, run.id);
      const materialContext = textStages.materialContextText(run.policy);
      let pickup;
      if (input.content) {
        pickup = textStages.normalizeShotRevision({ shot: input.content }, null, insertedNumber, normalizeOptions);
      } else {
        const generated = await runTextAction(run, {
          stage: 'storyboard_plan', scope_type: 'shot', scope_id: insertedScopeId, kind: 'shot_pickup',
          prompts: textStages.shotPickupPrompts({
            instruction,
            previous_shot: previous?.content,
            next_shot: next?.content,
            script: script?.content?.text || '',
            assets,
            material_context: materialContext,
            number: insertedNumber,
            ...normalizeOptions,
          }),
          prompt_id: 'production.shot_pickup.system',
          normalize: (raw) => ({
            shot: textStages.normalizeShotRevision(raw, null, insertedNumber, normalizeOptions),
          }),
          max_tokens: 9000, temperature: 0.4, scene_key: 'production_shot_pickup',
        });
        if (generated.waiting) return { state: 'waiting_task', operation: 'pickup', ...generated };
        pickup = generated.shot;
      }
      if (currentShot(db, run.id, insertedScopeId)) {
        throw codedError('VERSION_CONFLICT', '镜头序列在 AI 补拍期间发生了变化，请刷新后重试');
      }
      const created = db.transaction(() => {
        const dependencies = [
          ...(script ? [script.id] : []),
          ...assets.map((item) => item.artifact_id),
          ...(previous ? [previous.id] : []),
        ];
        const artifact = repo.createArtifact(db, {
          run_id: run.id, stage: 'storyboard_plan', scope_type: 'shot', scope_id: insertedScopeId,
          title: pickup.title,
          content: {
            ...pickup,
            included: true,
            pickup_instruction: instruction,
            pickup_after_shot_id: previous?.scope_id || null,
            pickup_before_shot_id: next?.scope_id || null,
            shot_operation: 'pickup',
          },
          status: 'draft', depends_on: [...new Set(dependencies)],
        });
        const updated = repo.updateRun(db, run.id, {
          current_stage: 'storyboard_plan', current_scope_type: 'shot', current_scope_id: insertedScopeId,
          status: run.review_owner === 'human' ? 'waiting_review' : 'running',
          waiting_reason: run.review_owner === 'human' ? 'stage_review' : null,
          error_code: null, error_message: null, completed_at: null,
          runtime: operationRuntime(run, insertedScopeId, { operation: 'pickup', current_shot_id: insertedScopeId }),
        });
        repo.appendEvent(db, run.id, 'shot.pickup_added', {
          stage: 'storyboard_plan', scope_type: 'shot', scope_id: insertedScopeId,
          payload: {
            artifact_id: artifact.id,
            after_shot_id: previous?.scope_id || null,
            before_shot_id: next?.scope_id || null,
            instruction,
          },
        });
        return { artifact, updated };
      }).immediate();
      return {
        state: created.updated.status === 'running' ? 'progressed' : 'waiting_review',
        operation: 'pickup', shot: created.artifact, focus_shot_id: insertedScopeId,
      };
    });
  }

  return { skipShot, restoreShot, reviseShot, splitShot, pickupShot };
}

module.exports = { createProductionShotService, listPlannedShots, compareShots };
