const crypto = require('node:crypto');

// A provider configuration is mutable in the settings UI, while a submitted
// generation must remain explainable and idempotent.  Keep a small, secret-free
// identity beside every production request so a later retry can tell whether
// it is still using the live configuration.
const SECRET_KEY_RE = /(api[_-]?key|access[_-]?key|secret|token|password|authorization|credential)/i;

function sanitizeForFingerprint(value, key = '') {
  if (SECRET_KEY_RE.test(String(key || ''))) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => sanitizeForFingerprint(item));
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, childKey) => {
      out[childKey] = sanitizeForFingerprint(value[childKey], childKey);
      return out;
    }, {});
  }
  return value == null ? null : value;
}

function configFingerprint(config) {
  if (!config || typeof config !== 'object') return null;
  const payload = {
    id: config.id == null ? null : Number(config.id),
    service_type: config.service_type || null,
    provider: config.provider || null,
    api_protocol: config.api_protocol || null,
    base_url: config.base_url || null,
    endpoint: config.endpoint || null,
    query_endpoint: config.query_endpoint || null,
    content_endpoint: config.content_endpoint || null,
    model: Array.isArray(config.model) ? config.model : config.model == null ? [] : [config.model],
    default_model: config.default_model || null,
    settings: sanitizeForFingerprint(settingsForFingerprint(config.settings)),
    is_active: config.is_active !== false,
    // The row timestamp is operational metadata, not provider configuration
    // identity. Saving an unrelated setting must not invalidate an approved
    // media/reference binding; material changes are already covered by the
    // secret-free fields above.
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function parseSettings(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function settingsForFingerprint(value) {
  const parsed = parseSettings(value);
  // Discovery persists a credential-scoped catalog snapshot in settings. It
  // is volatile evidence and must not change the provider configuration
  // identity used by an approved reference bundle.
  const { model_catalog_snapshot: _catalogSnapshot, ...stable } = parsed;
  return stable;
}

function identityForConfig(config) {
  if (!config || config.id == null) return null;
  return {
    version: 1,
    id: Number(config.id),
    updated_at: config.updated_at ? String(config.updated_at) : null,
    fingerprint: configFingerprint(config),
  };
}

function identityFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const id = Number(snapshot.config_id ?? snapshot.image_config_id ?? snapshot.video_config_id);
  const updatedAt = snapshot.config_updated_at ?? snapshot.image_config_updated_at ?? snapshot.video_config_updated_at;
  const fingerprint = snapshot.config_fingerprint
    ?? snapshot.image_config_fingerprint
    ?? snapshot.video_config_fingerprint;
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return {
    version: Number(snapshot.config_identity_version || 1),
    id,
    updated_at: updatedAt ? String(updatedAt) : null,
    fingerprint: fingerprint ? String(fingerprint) : null,
  };
}

function sameIdentity(left, right) {
  if (!left || !right) return false;
  if (Number(left.id) !== Number(right.id)) return false;
  if (left.fingerprint && right.fingerprint) return left.fingerprint === right.fingerprint;
  if (left.updated_at && right.updated_at) return left.updated_at === right.updated_at;
  // An old request may contain only the config id.  Treat that as equal only
  // when the live record also has no revision information; otherwise it is
  // stale/unknown and must not silently reuse the old request.
  return !left.updated_at && !right.updated_at && !left.fingerprint && !right.fingerprint;
}

function attachSnapshotFields(snapshot, identity, prefix = '') {
  const next = { ...(snapshot || {}) };
  if (!identity) return next;
  const p = prefix ? `${prefix}_` : '';
  next[`${p}config_identity_version`] = identity.version;
  next[`${p}config_id`] = identity.id;
  next[`${p}config_updated_at`] = identity.updated_at;
  next[`${p}config_fingerprint`] = identity.fingerprint;
  return next;
}

module.exports = {
  configFingerprint,
  identityForConfig,
  identityFromSnapshot,
  sameIdentity,
  attachSnapshotFields,
};
