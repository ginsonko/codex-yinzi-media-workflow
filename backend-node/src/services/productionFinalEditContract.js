function orderedNumericIds(values) {
  return (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isInteger);
}

function sameOrderedIds(left, right) {
  const a = orderedNumericIds(left);
  const b = orderedNumericIds(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function createFinalEditContract(narrationArtifact, shotVideoArtifacts) {
  if (!narrationArtifact || narrationArtifact.content?.kind !== 'narration_plan') return null;
  const artifactId = Number(narrationArtifact.id);
  const fingerprint = String(narrationArtifact.content?.confirmation_fingerprint || '').trim();
  const shotIds = (Array.isArray(shotVideoArtifacts) ? shotVideoArtifacts : [])
    .filter((artifact) => artifact?.content?.included !== false)
    .map((artifact) => Number(artifact.id))
    .filter(Number.isInteger);
  return {
    narration_plan_artifact_id: Number.isInteger(artifactId) ? artifactId : null,
    narration_confirmation_fingerprint: fingerprint,
    source_shot_artifact_ids: shotIds,
    valid: Number.isInteger(artifactId) && artifactId > 0 && fingerprint.length > 0 && shotIds.length > 0,
  };
}

function finalVideoMatchesContract(artifact, contract) {
  if (!contract?.valid || artifact?.content?.kind !== 'final_video') return false;
  return Number(artifact.content?.narration_plan_artifact_id) === contract.narration_plan_artifact_id
    && String(artifact.content?.narration_confirmation_fingerprint || '') === contract.narration_confirmation_fingerprint
    && sameOrderedIds(artifact.content?.source_shot_artifact_ids, contract.source_shot_artifact_ids);
}

function strictMergeActionMatchesContract(action, contract) {
  if (!contract?.valid || action?.kind !== 'strict_merge') return false;
  return Number(action.request?.narration_plan_artifact_id) === contract.narration_plan_artifact_id
    && String(action.request?.narration_confirmation_fingerprint || '') === contract.narration_confirmation_fingerprint
    && sameOrderedIds(action.request?.scene_ids, contract.source_shot_artifact_ids);
}

module.exports = {
  createFinalEditContract,
  finalVideoMatchesContract,
  orderedNumericIds,
  sameOrderedIds,
  strictMergeActionMatchesContract,
};
