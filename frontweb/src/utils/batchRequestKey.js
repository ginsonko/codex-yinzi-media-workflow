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
 * One explicit submit intent owns a key. Transport recovery keeps that key;
 * a new click after a receipt gets a new identity even when its body matches.
 */
export function batchRequestKey(payload, intentId = crypto.randomUUID()) {
  return `web-batch:${intentId}:${fnv1a64(JSON.stringify(stableValue(payload)))}`
}

export function batchSubmission(payload, pending = null) {
  const signature = JSON.stringify(stableValue(payload))
  return pending?.signature === signature ? pending : { signature, key: batchRequestKey(payload) }
}

export function batchItemCanRetry(item = {}) {
  return Boolean(item.status)
}

export function batchItemNeedsReview(item = {}) {
  return item.status === 'needs_review' || item.error_code === 'UPSTREAM_AMBIGUOUS'
}
