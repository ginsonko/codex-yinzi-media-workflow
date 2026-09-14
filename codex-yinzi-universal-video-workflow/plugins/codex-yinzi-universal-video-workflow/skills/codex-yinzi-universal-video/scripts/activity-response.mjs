// Keep progress receipts small even when an older runtime returns a full bundle.
// Full task history remains available through get_session / CLI get.
export function activityResponse(result, detail = 'summary') {
  if (detail === 'full' || !result?.session?.id) return result
  const session = result.session
  const summary = result.response_detail === 'summary'
  const activity = summary ? result.activity : session.source_context?.activity
  const limits = { stage: 80, state: 40, message: 1600, next_action: 800, updated_at: 80 }
  const clipped = []
  const compact = activity == null ? null : { needs_user: Boolean(activity.needs_user) }
  if (compact) for (const [key, limit] of Object.entries(limits)) {
    const value = String(activity[key] ?? '')
    const points = Array.from(value)
    compact[key] = points.length > limit ? points.slice(0, limit).join('') + '…' : value
    if (points.length > limit) clipped.push(`activity.${key}`)
  }
  return {
    schema_version: 1, response_detail: 'summary',
    // Older runtimes do not report whether this request was replayed.
    reused: typeof result.reused === 'boolean' ? result.reused : null,
    session: { id: session.id, status: session.status, version: session.version, updated_at: session.updated_at },
    activity: compact,
    analysis_report_available: summary ? Boolean(result.analysis_report_available) : session.source_context?.analysis_report != null,
    event: summary && result.event ? { id: result.event.id, event_type: result.event.event_type } : null,
    details_path: `/api/v1/orchestration-sessions/${encodeURIComponent(session.id)}`,
    ...(clipped.length ? { truncated_fields: clipped } : {}),
  }
}