const repo = require('./productionRepository');

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function archiveDetachedVideoGeneration(db, input = {}) {
  if (!tableExists(db, 'production_actions') || !tableExists(db, 'production_artifacts')) return [];
  const generationId = Number(input.generation_id);
  if (!Number.isInteger(generationId) || generationId <= 0) return [];
  const mediaPath = String(input.local_path || input.remote_url || '').trim();
  if (!mediaPath) return [];
  const actionIds = db.prepare(
    `SELECT id FROM production_actions
     WHERE generation_id = ? AND kind = 'video_generate'
     ORDER BY id`
  ).all(generationId).map((row) => Number(row.id));
  const archived = [];
  for (const actionId of actionIds) {
    const action = repo.getAction(db, actionId);
    if (!action?.result?.detached_from_sequence) continue;
    const existing = db.prepare(
      `SELECT id FROM production_artifacts
       WHERE source_action_id = ? AND stage = 'shot_video' AND deleted_at IS NULL
       ORDER BY revision DESC LIMIT 1`
    ).get(action.id);
    if (existing) {
      const artifact = repo.getArtifact(db, existing.id);
      if (artifact) archived.push(artifact);
      continue;
    }
    const sourceArtifactId = Number(action.result?.source_artifact_id ?? action.request?.source_artifact_id);
    const bundleArtifactId = Number(action.result?.bundle_artifact_id ?? action.request?.bundle_artifact_id);
    const source = Number.isInteger(sourceArtifactId) ? repo.getArtifact(db, sourceArtifactId) : null;
    const dependencies = [sourceArtifactId, bundleArtifactId]
      .filter((id) => Number.isInteger(id) && repo.getArtifact(db, id));
    const artifact = repo.createArtifact(db, {
      run_id: action.run_id,
      stage: 'shot_video',
      scope_type: 'shot',
      scope_id: action.scope_id || source?.scope_id || '',
      title: source?.title || `Skipped shot ${action.scope_id || ''}`.trim(),
      content: {
        source_artifact_id: source?.id || sourceArtifactId || null,
        bundle_artifact_id: Number.isInteger(bundleArtifactId) ? bundleArtifactId : null,
        provider_generation_id: generationId,
        routing_receipt: action.request?.routing_receipt || null,
        routing_material_signature: action.request?.routing_material_signature || null,
        included: false,
        archive_only: true,
        detached_from_sequence: true,
        detached_reason: action.result?.detached_reason || 'shot_skipped',
        detached_at: action.result?.detached_at || null,
      },
      status: 'approved',
      media_path: mediaPath,
      mime_type: 'video/mp4',
      source_action_id: action.id,
      source_task_id: action.task_id || null,
      source_generation_id: generationId,
      depends_on: dependencies,
    });
    repo.appendEvent(db, action.run_id, 'shot.detached_video_archived', {
      stage: 'shot_video',
      scope_type: 'shot',
      scope_id: action.scope_id,
      payload: {
        action_id: action.id,
        artifact_id: artifact.id,
        generation_id: generationId,
        local: Boolean(input.local_path),
      },
    });
    archived.push(artifact);
  }
  return archived;
}

module.exports = { archiveDetachedVideoGeneration };
