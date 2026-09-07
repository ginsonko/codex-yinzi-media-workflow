export function runtimeIdentityKey(identity) {
  if (!identity) return ''
  return [identity.schema, identity.app_version, identity.source_revision, identity.database?.fingerprint, identity.orchestration_router]
    .map((value) => String(value ?? 'unknown')).join('|')
}

export function canWriteRuntime({ identity, baselineKey, error = '', mismatch = false } = {}) {
  return Boolean(identity && baselineKey && !error && !mismatch && runtimeIdentityKey(identity) === baselineKey)
}
