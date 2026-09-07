export function numericIds(values) {
  return (Array.isArray(values) ? values : []).map(Number).filter(Number.isInteger);
}

export function sameIds(left, right) {
  const a = numericIds(left);
  const b = numericIds(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function contractFor(plan, shotVideos) {
  if (!plan?.content || plan.content.kind !== 'narration_plan') return null;
  const fingerprint = String(plan.content.confirmation_fingerprint || '').trim();
  const sourceShotIds = (shotVideos || [])
    .filter((item) => item.status === 'approved' && item.content?.included !== false)
    .sort((left, right) => Number(left.scope_id) - Number(right.scope_id))
    .map((item) => Number(item.id))
    .filter(Number.isInteger);
  return {
    planId: Number(plan.id),
    fingerprint,
    sourceShotIds,
    valid: Number.isInteger(Number(plan.id)) && fingerprint.length > 0 && sourceShotIds.length > 0,
  };
}

export function finalMatches(item, contract) {
  if (!contract?.valid || item?.content?.kind !== 'final_video') return false;
  return Number(item.content.narration_plan_artifact_id) === contract.planId
    && String(item.content.narration_confirmation_fingerprint || '') === contract.fingerprint
    && sameIds(item.content.source_shot_artifact_ids, contract.sourceShotIds);
}

export function actionMatches(item, contract) {
  if (!contract?.valid || item?.kind !== 'strict_merge') return false;
  return Number(item.request?.narration_plan_artifact_id) === contract.planId
    && String(item.request?.narration_confirmation_fingerprint || '') === contract.fingerprint
    && sameIds(item.request?.scene_ids, contract.sourceShotIds);
}

export function selectGenerationFailureAction(actions = [], {
  stage = '',
  scopeId = null,
  recoveredScopedStoryboard = false,
  activeProviderAction = null,
  finalEditState = null,
} = {}) {
  if (recoveredScopedStoryboard) return null;
  if (stage === 'shot_video') {
    if (activeProviderAction?.status === 'failed') return activeProviderAction;
    // Fixed-duration executions keep a failed child in auditable history. A
    // user-authorized retry marks that child cancelled before the replacement
    // segment is submitted, so it must remain actionable across refreshes.
    return (Array.isArray(actions) ? actions : [])
      .filter((item) => item.stage === 'shot_video'
        && item.kind === 'video_generate'
        && (scopeId == null || String(item.scope_id || '') === String(scopeId))
        && (item.status === 'failed'
          || (item.status === 'cancelled'
            && item.result?.retry_authorized === true
            && item.error_message)))
      .sort((left, right) => Number(right.id || 0) - Number(left.id || 0))[0] || null;
  }
  if (stage === 'final_edit' && finalEditState?.plan && finalEditState.contract?.valid) {
    return finalEditState.failedAction || null;
  }
  return (Array.isArray(actions) ? actions : [])
    .filter((item) => item.stage === stage
      && item.status === 'failed'
      && (scopeId == null || String(item.scope_id || '') === String(scopeId)))
    .sort((left, right) => Number(right.id) - Number(left.id))[0] || null;
}

export function selectFinalEditState(artifacts = [], actions = []) {
  const plan = artifacts.find((item) => item.stage === 'final_edit' && item.content?.kind === 'narration_plan') || null;
  const final = artifacts.find((item) => item.stage === 'final_edit' && item.content?.kind === 'final_video') || null;
  const shotVideos = artifacts.filter((item) => item.stage === 'shot_video');
  const contract = contractFor(plan, shotVideos);
  const matchingFinal = finalMatches(final, contract) ? final : null;
  const matchingActions = actions.filter((item) => actionMatches(item, contract)).sort((left, right) => Number(right.id) - Number(left.id));
  const action = matchingActions[0] || null;
  const pendingAction = action && ['reserved', 'submitted', 'waiting'].includes(action.status) ? action : null;
  const failedAction = action?.status === 'failed' ? action : null;
  const finalActive = matchingFinal && ['draft', 'reviewing', 'approved'].includes(matchingFinal.status) ? matchingFinal : null;
  const finalNeedsRebuild = Boolean(plan?.status === 'approved' && contract?.valid && !pendingAction && (!finalActive || ['rejected', 'invalidated', 'failed'].includes(final?.status)));
  let message = '确认旁白后，系统会在本地生成逐镜锁定的旁白、字幕和最终成片。';
  if (!plan) message = '等待旁白与原声设置。';
  else if (plan.status !== 'approved') message = `旁白修订 ${plan.revision || ''} 尚未确认，确认后才会开始最终合成。`;
  else if (pendingAction) message = `正在按旁白修订 ${plan.revision || ''} 重新剪辑合成，完成后会自动刷新。`;
  else if (finalActive?.status === 'draft' || finalActive?.status === 'reviewing') message = `旁白修订 ${plan.revision || ''} 的新成片已经生成，请播放检查后确认或打回。`;
  else if (finalActive?.status === 'approved') message = `旁白修订 ${plan.revision || ''} 的成片已确认，可以整理交付文件。`;
  else if (failedAction) message = `本地合成失败：${failedAction.error_message || '请检查旁白与 FFmpeg 状态后重试。'}`;
  else if (final && !matchingFinal) message = '当前画面仍是旧旁白版本；确认最新旁白后会自动重新合成。';
  else if (final?.status === 'rejected') message = '成片已打回。修改并确认旁白，或点击“重新剪辑合成”再次生成。';
  return {
    plan,
    final,
    contract,
    action,
    pendingAction,
    failedAction,
    matchingFinal,
    currentFinalId: matchingFinal?.id || null,
    finalNeedsRebuild,
    message,
    canRebuild: finalNeedsRebuild,
  };
}
