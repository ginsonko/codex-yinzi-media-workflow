function text(value) {
  return value == null ? '' : String(value)
}

function artifactSignature(artifact = {}) {
  return [
    artifact.id,
    artifact.stage,
    artifact.scope_type,
    artifact.scope_id,
    artifact.revision,
    artifact.status,
    artifact.media_path,
    artifact.content?.included === false ? 'excluded' : 'included',
  ].map(text).join('|')
}

function actionSignature(action = {}) {
  return [
    action.id,
    action.stage,
    action.scope_type,
    action.scope_id,
    action.kind,
    action.attempt,
    action.status,
    action.provider_task_id,
    action.error_code,
  ].map(text).join('|')
}

export function productionSemanticProgressSignature(summary = {}) {
  const run = summary.run || summary
  const intervention = run?.runtime?.autonomy?.intervention || null
  return JSON.stringify({
    run: [
      run?.id,
      run?.status,
      run?.current_stage,
      run?.current_scope_type,
      run?.current_scope_id,
      run?.waiting_reason,
      run?.error_code,
      run?.completed_at,
    ].map(text),
    artifacts: (summary.artifacts || []).map(artifactSignature).sort(),
    actions: (summary.actions || []).map(actionSignature).sort(),
    intervention: intervention ? [
      intervention.object_key,
      intervention.reason,
      intervention.stage,
      intervention.scope_type,
      intervention.scope_id,
    ].map(text) : null,
  })
}

export function productionIdleBackoffDelay(consecutiveIdle, options = {}) {
  const base = Math.max(250, Number(options.baseDelayMs) || 3500)
  const ceiling = Math.max(base, Number(options.maxDelayMs) || 30000)
  const exponent = Math.max(0, Math.min(8, Number(consecutiveIdle || 1) - 1))
  return Math.min(ceiling, base * (2 ** exponent))
}
