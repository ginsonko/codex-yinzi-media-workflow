// The launcher writes its JSON result to stdout even when it exits nonzero.
// execFile rejects in that case; its generic message omits that JSON entirely.
function safeDetail(value, redact) {
  return redact(String(value))
    .replace(/https?:\/\/[^\s<>"']+/gi, value => {
      try {
        const url = new URL(value)
        url.username = ''; url.password = ''; url.search = ''; url.hash = ''
        return url.href
      } catch { return '[URL redacted]' }
    })
    .replace(/\b(?:Proxy-)?Authorization\s*[:=]\s*(?:Basic|Bearer)\s+[^\s,;}]+/gi, 'Authorization: [REDACTED]')
    .replace(/\b(?:Proxy-)?Authorization\s*[:=]\s*Digest[^\r\n]*/gi, 'Authorization: [REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]')
}

export function runtimeLaunchFailure(error, redact = String) {
  let result
  for (const line of String(error?.stdout || '').trim().split(/\r?\n/).reverse()) {
    try {
      const candidate = JSON.parse(line)
      if (candidate?.ok === false && typeof candidate.error === 'string') { result = candidate; break }
    } catch { /* Build logs may precede the machine-readable result. */ }
  }
  const detail = safeDetail(result?.error || String(error?.stderr || '').trim() || error?.message || String(error), redact)
  const wrapped = new Error(`工作流尚未启动：${detail}。请根据上述原因检查原安装与运行时日志，保留原项目和数据。`)
  wrapped.code = 'RUNTIME_LAUNCH_FAILED'
  wrapped.details = {
    code: wrapped.code,
    reason: detail,
    reason_source: result ? 'launcher_stdout' : String(error?.stderr || '').trim() ? 'launcher_stderr' : 'process_error',
    exit_code: Number.isInteger(error?.code) ? error.code : null,
    signal: error?.signal || null,
  }
  wrapped.cause = error
  return wrapped
}
