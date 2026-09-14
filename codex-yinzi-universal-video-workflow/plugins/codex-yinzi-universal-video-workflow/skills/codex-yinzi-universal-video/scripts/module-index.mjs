import crypto from 'node:crypto'

function integer(value, fallback, min, max, label) {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`)
  }
  return parsed
}

// Project the full local registry before printing, so large schemas never enter
// model context. Fingerprints detect catalog changes between compact pages.
export function compactModuleIndex(catalog, options = {}) {
  if (!catalog || !Array.isArray(catalog.items)) throw new Error('Module registry did not return an items array')
  if (catalog.total !== undefined && catalog.total !== catalog.items.length) {
    throw new Error('Module registry returned an incomplete catalog; cannot claim full coverage')
  }
  const limit = integer(options.limit, 60, 1, 100, 'limit')
  const offset = integer(options.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset')
  const ids = new Set()
  const rows = catalog.items.map(item => {
    if (!item || typeof item.module_id !== 'string' || !item.module_id.trim() || ids.has(item.module_id)) {
      throw new Error('Module registry contains a missing or duplicate module ID')
    }
    ids.add(item.module_id)
    const summary = String(item.description_zh || item.description || '').replace(/\s+/g, ' ').trim()
    return [item.module_id, String(item.title || ''), String(item.phase || ''),
      String(item.availability || 'unknown'), item.enabled !== false,
      [...summary].slice(0, 180).join(''), item.module_version ?? item.version ?? null]
  }).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  const end = Math.min(offset + limit, rows.length)
  const contracts = [...catalog.items].sort((a, b) => a.module_id < b.module_id ? -1 : a.module_id > b.module_id ? 1 : 0)
  return {
    schema: 'yinzi.module-index/v1',
    catalog_fingerprint: crypto.createHash('sha256').update(JSON.stringify(contracts)).digest('hex'),
    total: rows.length, offset, limit,
    next_offset: end < rows.length ? end : null,
    disabled_count: rows.filter(row => !row[4]).length,
    availability_note: 'Contract state only; inspect selected components for installation and platform readiness.',
    columns: ['module_id', 'title', 'phase', 'availability', 'enabled', 'summary', 'module_version'],
    rows: rows.slice(offset, end),
  }
}