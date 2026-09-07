function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value).sort().reduce((result, key) => {
    if (value[key] !== undefined) result[key] = stableValue(value[key])
    return result
  }, {})
}

function fnv1a64(value) {
  let hash = 0xcbf29ce484222325n
  for (const char of String(value)) {
    hash ^= BigInt(char.codePointAt(0))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

/**
 * Identical submissions from two tabs share a short-lived logical key. The
 * server also hashes the complete body, so a key can never reuse changed work.
 */
export function batchRequestKey(payload, timestamp = Date.now()) {
  const bucket = Math.floor(Number(timestamp) / 120000)
  return `web-batch:${bucket}:${fnv1a64(JSON.stringify(stableValue(payload)))}`
}

export function batchItemCanRetry(item = {}) {
  return item.status === 'failed'
}

export function batchItemNeedsReview(item = {}) {
  return item.status === 'needs_review' || item.error_code === 'UPSTREAM_AMBIGUOUS'
}
