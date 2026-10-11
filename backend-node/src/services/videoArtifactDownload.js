'use strict';
const fs = require('node:fs');
const { videoDownloadError } = require('./videoDownloadError');

function transportFailure(error) {
  return ['TimeoutError', 'AbortError'].includes(error?.name)
    || /timeout|timed out|fetch failed|terminated|socket|ECONNRESET|UND_ERR/i.test(`${error?.message} ${error?.cause?.code}`);
}
function invalid(message) { return Object.assign(new Error(message), { code: 'VIDEO_DOWNLOAD_INVALID' }); }
async function checkResponse(res) {
  if (!res.ok || /application\/json/i.test(res.headers.get('content-type') || '')) throw await videoDownloadError(res);
  const type = String(res.headers.get('content-type') || '').toLowerCase();
  if (/text\/(html|plain)/.test(type)) {
    await res.body?.cancel?.();
    throw invalid(`下载地址返回了非视频内容（${type}）`);
  }
  return type;
}

// The fallback only reads the same artifact. It never submits a generation.
async function downloadVideoArtifact(url, target, options = {}) {
  const fetchImpl = options.fetch_impl || fetch;
  const max = Math.max(1024, Number(options.max_bytes) || 2 * 1024 ** 3);
  const controller = new AbortController();
  const progress = (bytes, total, mode) => options.on_progress?.({ bytes, total, mode });
  const request = (extra = {}, range = false) => fetchImpl(url, {
    method: 'GET', headers: { ...options.headers, ...extra, 'Accept-Encoding': 'identity' },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(range ? (options.range_timeout_ms || 45000) : (options.timeout_ms || 180000))]),
  });
  async function fullResponse(res) {
    const type = await checkResponse(res);
    if (res.status !== 200) { await res.body?.cancel?.(); throw invalid('完整视频下载返回了不完整的响应'); }
    const total = Number(res.headers.get('content-length')) || null;
    if (total > max) { await res.body?.cancel?.(); throw invalid(`视频文件超过允许大小 ${max} bytes`); }
    const fd = fs.openSync(target, 'w'); let bytes = 0;
    try {
      for await (const chunk of res.body) {
        bytes += chunk.length;
        if (bytes > max) throw invalid(`视频文件超过允许大小 ${max} bytes`);
        fs.writeSync(fd, chunk); progress(bytes, total, 'full');
      }
      if (total !== null && bytes !== total) throw invalid('完整视频下载长度与响应不一致');
      return { content_type: type, bytes, mode: 'full' };
    } finally { fs.closeSync(fd); }
  }
  async function ranges() {
    const size = Math.max(1024, Math.min(8 * 1024 ** 2, Number(options.range_chunk_bytes) || 512 * 1024));
    let total, validator, type, downloaded = 0, next = 0;
    const fd = fs.openSync(target, 'w');
    async function chunk(start) {
      const end = total == null ? size - 1 : Math.min(total - 1, start + size - 1);
      const res = await request({ Range: `bytes=${start}-${end}`, ...(validator ? { 'If-Range': validator } : {}) }, true);
      type = await checkResponse(res);
      // Servers without Range support can still deliver the complete original.
      if (start === 0 && res.status === 200) return { full: res };
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') || '');
      const etag = res.headers.get('etag');
      const currentValidator = etag && !etag.startsWith('W/') ? etag : res.headers.get('last-modified');
      const expectedTotal = match && Number(match[3]);
      if (res.status !== 206 || !match || !Number.isSafeInteger(expectedTotal) || expectedTotal <= 0 || expectedTotal > max
        || Number(match[1]) !== start || Number(match[2]) !== Math.min(end, expectedTotal - 1)
        || (total != null && total !== expectedTotal) || (validator && validator !== currentValidator)) {
        await res.body?.cancel?.(); throw invalid('视频分段范围或文件标识不一致，已保留原任务等待恢复');
      }
      total = expectedTotal; validator ||= currentValidator;
      const expectedBytes = Number(match[2]) - start + 1, chunks = []; let length = 0;
      for await (const value of res.body) {
        length += value.length;
        if (length > expectedBytes) throw invalid('视频分段超过声明长度');
        chunks.push(Buffer.from(value));
      }
      if (length !== expectedBytes) throw invalid('视频分段未下载完整');
      fs.writeSync(fd, Buffer.concat(chunks), 0, length, start);
      downloaded += length; progress(downloaded, total, 'range');
      return {};
    }
    let full;
    try {
      full = (await chunk(0)).full;
      if (!full) {
        next = size;
        const worker = async () => {
          try { while (next < total && !controller.signal.aborted) { const start = next; next += size; await chunk(start); } }
          catch (error) { controller.abort(error); throw error; }
        };
        const settled = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(4, options.range_workers || 2)) }, worker));
        const failed = settled.find(result => result.status === 'rejected');
        if (failed) throw controller.signal.reason || failed.reason;
        if (downloaded !== total) throw invalid('视频分段总长度不完整');
      }
    } finally { fs.closeSync(fd); }
    return full ? fullResponse(full) : { content_type: type, bytes: total, mode: 'range' };
  }
  try {
    if (options.prefer_ranges) return await ranges();
    try { return await fullResponse(await request()); }
    catch (error) {
      if (!transportFailure(error) || options.range_fallback === false) throw error;
      progress(0, null, 'range');
      return await ranges();
    }
  } finally { controller.abort(); }
}

module.exports = { downloadVideoArtifact, transportFailure };
