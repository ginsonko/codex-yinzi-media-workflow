function text(value) {
  return value == null ? '' : String(value)
}

function firstValidShot(validShotIds) {
  return (validShotIds || []).map(text).find(Boolean) || null
}

export function resolveWorkflowFocus(previous = {}, next = {}) {
  const previousRunId = text(previous.runId)
  const nextRunId = text(next.runId)
  const previousActiveScopeId = text(previous.activeScopeId)
  const nextActiveScopeId = text(next.activeScopeId)
  const selectedShotId = text(previous.selectedShotId)
  const validShotIds = [...new Set((next.validShotIds || []).map(text).filter(Boolean))]
  const validSelection = selectedShotId && validShotIds.includes(selectedShotId)
  const runChanged = previousRunId !== nextRunId
  const activeShotChanged = !runChanged && previousActiveScopeId !== nextActiveScopeId

  if (runChanged || activeShotChanged) {
    const target = nextActiveScopeId || firstValidShot(validShotIds)
    return {
      selectedShotId: target,
      pinned: false,
      shouldScroll: Boolean(activeShotChanged && target),
      preserveViewport: false,
      reason: runChanged ? 'run_changed' : 'active_shot_changed',
    }
  }

  if (!validSelection && validShotIds.length) {
    const target = nextActiveScopeId && validShotIds.includes(nextActiveScopeId)
      ? nextActiveScopeId
      : firstValidShot(validShotIds)
    return {
      selectedShotId: target,
      pinned: false,
      shouldScroll: Boolean(target && selectedShotId),
      preserveViewport: !selectedShotId,
      reason: selectedShotId ? 'selection_missing' : 'initial_selection',
    }
  }

  return {
    selectedShotId: validSelection ? selectedShotId : (nextActiveScopeId || null),
    pinned: Boolean(previous.pinned && validSelection),
    shouldScroll: false,
    preserveViewport: true,
    reason: 'stable',
  }
}
