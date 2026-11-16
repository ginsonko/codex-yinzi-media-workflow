// 万能创作终端商业版的收费闸接口（宿主在 globalThis.__omniPaidGate 装闸，见 omni-creator electron/commerce-gate.cjs）：
// 付费的出图、出视频提交先交给闸，由它报价、确认，再带 X-Parameter-Quote 发出。没装闸或这个地址不归它管时原样发送。
//
// 付费上下文 paid_context 只来自现成的身份：发起这次生成的编排会话（orchestration_sessions）登记时写进
// source_context 的 omni_chat_id（宿主的对话 id）。从会话读不到就是 null，宿主按「不知道是哪个对话」处理（请用户确认），
// 这里绝不猜。

/** The host's gate when it covers this POST, else null. */
function gateFor(url) {
  const gate = globalThis.__omniPaidGate;
  return gate && typeof gate.covers === 'function' && gate.covers(url, 'POST') ? gate : null;
}

/**
 * The paid context of one generation, read from the orchestration session that asked for it.
 * @returns {{omni_chat_id: string, orchestration_session_id: string} | null}
 */
function paidContextOf(db, sessionId) {
  const id = String(sessionId || '').trim();
  if (!id || !db) return null;
  let row;
  try {
    row = db.prepare('SELECT source_context_json FROM orchestration_sessions WHERE id = ? AND deleted_at IS NULL').get(id);
  } catch {
    return null;
  }
  if (!row) return null;
  let ctx = {};
  try {
    ctx = JSON.parse(row.source_context_json || '{}') || {};
  } catch {
    ctx = {};
  }
  const chat = String(ctx.omni_chat_id || '').trim();
  return chat ? { omni_chat_id: chat, orchestration_session_id: id } : null;
}

/**
 * fetch for a paid submit: through the gate when it covers the URL. The timeout starts when the request really
 * leaves (after the user confirmed), so waiting for a confirmation never eats into it.
 */
function paidFetch(url, init = {}, { context = null, timeoutMs = 0 } = {}) {
  const send = (extra = {}) => fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), ...extra },
    ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  const gate = gateFor(url);
  return gate && typeof gate.runFetch === 'function' ? gate.runFetch({ url, body: init.body, ctx: context }, send) : send();
}

module.exports = { gateFor, paidContextOf, paidFetch };
