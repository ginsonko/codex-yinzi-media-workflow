const LOCAL_STATIC_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

function staticPathFromUrl(value) {
  try {
    const parsed = new URL(value, typeof window !== 'undefined' ? window.location.origin : 'http://localhost')
    if (parsed.pathname.startsWith('/static/')) return `${parsed.pathname}${parsed.search}`
    return null
  } catch (_) {
    return null
  }
}

/**
 * Resolve persisted media references against the current runtime.
 * Older acceptance rows may contain a localhost URL from a previous port;
 * the storage path is still authoritative, so keep only its /static path.
 */
export function resolveMediaUrl(value, fallback = '') {
  const raw = String(value || '').trim()
  if (!raw) return fallback
  if (raw.startsWith('data:') || raw.startsWith('blob:')) return raw
  if (raw.startsWith('/static/')) return raw
  if (raw.startsWith('static/')) return `/${raw}`

  if (/^https?:\/\//i.test(raw)) {
    const staticPath = staticPathFromUrl(raw)
    if (staticPath) return staticPath
    try {
      const parsed = new URL(raw)
      if (LOCAL_STATIC_HOSTS.has(parsed.hostname)) return fallback
    } catch (_) {}
    return raw
  }

  const marker = raw.replace(/\\/g, '/').indexOf('/static/')
  if (marker >= 0) return raw.slice(marker + 1)
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('file:')) return fallback

  const relative = raw.replace(/^\/+/, '').replace(/\\/g, '/')
  if (relative.includes('..') || /[\u0000-\u001f?#]/.test(relative)) return fallback
  return `/static/${relative}`
}

export function artifactMediaUrl(item = {}) {
  return resolveMediaUrl(item.url || item.preview_url || item.media_url || item.local_path || item.media_path, '')
}

// Backwards-compatible helpers used by the existing production/media pages.
// They now share the same stale-port and path-safety rules as orchestration.
export function normalizeLocalMediaUrl(value, currentOrigin) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (!/^https?:\/\//i.test(raw)) return raw
  try {
    const parsed = new URL(raw)
    if (!LOCAL_STATIC_HOSTS.has(parsed.hostname.toLowerCase()) || !parsed.pathname.startsWith('/static/')) return raw
    const origin = currentOrigin || (typeof window !== 'undefined' ? window.location.origin : '')
    return origin ? `${String(origin).replace(/\/$/, '')}${parsed.pathname}${parsed.search}${parsed.hash}` : raw
  } catch (_) { return raw }
}

export function assetImageUrl(item) {
  return resolveMediaUrl(item?.local_path || item?.image_url || item?.url, '')
}
export function storyboardImageUrl(item) { return assetImageUrl(item) }
export function storyboardVideoUrl(item) { return resolveMediaUrl(item?.video_local_path || item?.video_url || item?.url, '') }
export function audioUrl(localPath) { return resolveMediaUrl(localPath, '') }
