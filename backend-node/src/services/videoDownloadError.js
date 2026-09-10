const ERROR_BODY_LIMIT = 16 * 1024;

function redactDownloadMessage(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s"<>]+/gi, '[URL]')
    .replace(/\bBearer\s+[^\s";,]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[KEY]')
    .replace(/\b(api[_ -]?key|access_token|token|secret|signature)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 400);
}

async function readErrorBody(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    while (size <= ERROR_BODY_LIMIT) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      size += value.byteLength;
      if (size > ERROR_BODY_LIMIT) return null;
      chunks.push(Buffer.from(value));
    }
  } catch (_) {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
  return null;
}

async function videoDownloadError(response) {
  const body = await readErrorBody(response);
  const detail = body?.error && typeof body.error === 'object' ? body.error : body;
  const rawMessage = typeof detail?.message === 'string' ? detail.message : '';
  const explicitStatus = String(detail?.current_status || detail?.status || '').trim().toUpperCase();
  const awaitingArtifact = [200, 400, 409, 425, 503].includes(response.status)
    && (explicitStatus === 'FINALIZING'
      || (/\bnot (?:completed|ready)\b/i.test(rawMessage)
        && /\bcurrent(?: task)? status\s*[:=]\s*FINALIZING\b/i.test(rawMessage)));
  const safeMessage = redactDownloadMessage(rawMessage);
  const message = awaitingArtifact
    ? '服务端成片尚未就绪（FINALIZING），原任务已保留，正在恢复取回'
    : `下载地址返回 HTTP ${response.status}${safeMessage ? `：${safeMessage}` : ''}`;
  return Object.assign(new Error(message), {
    code: awaitingArtifact ? 'VIDEO_ARTIFACT_NOT_READY' : 'VIDEO_DOWNLOAD_HTTP_ERROR',
    http_status: response.status,
    provider_status: awaitingArtifact ? 'FINALIZING' : null,
  });
}

module.exports = { videoDownloadError };
