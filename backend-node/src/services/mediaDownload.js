'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform, Readable } = require('node:stream');
const { spawn } = require('node:child_process');

const fail = (code, message, extra = {}) => {
  const err = new Error(`[${code}] ${message}`);
  return Object.assign(err, { code, ...extra });
};

/**
 * Calculates SHA-256 digest of a local file.
 */
async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/**
 * Executes a process safely with array args (zero shell expansion).
 */
function runProcess(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd || process.cwd(),
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(fail('PROCESS_TIMEOUT', `执行超时 (${options.timeout || 60000}ms): ${path.basename(bin)}`));
    }, options.timeout || 60000);

    child.stdout.on('data', d => {
      // Keep a bounded diagnostic tail for logs. Large machine-readable JSON
      // must use runProcessToFile instead of this memory slice.
      stdout = (stdout + d).slice(-256 * 1024);
      options.onOutput?.(d.toString());
    });
    child.stderr.on('data', d => {
      stderr = (stderr + d).slice(-1024 * 1024);
      options.onErrorOutput?.(d.toString());
    });

    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', code => {
      clearTimeout(timer);
      if ((options.exitCodes || [0]).includes(code)) {
        resolve({ stdout, stderr, code });
      } else {
        reject(fail('PROCESS_FAILED', `本地进程未成功退出 (${code}): ${stderr.slice(-1000)}`, { stdout, stderr, code }));
      }
    });
  });
}

/**
 * Runs a process and writes stdout to a file with a hard size cap.
 * Used for yt-dlp --dump-single-json so a 1MB memory slice cannot truncate JSON.
 */
function runProcessToFile(bin, args, outFile, options = {}) {
  const maxBytes = Number(options.maxStdoutBytes || 32 * 1024 * 1024);
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const out = fs.createWriteStream(outFile);
    const child = spawn(bin, args, {
      cwd: options.cwd || process.cwd(),
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let written = 0;
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      failOut(fail('PROCESS_TIMEOUT', `执行超时 (${options.timeout || 60000}ms): ${path.basename(bin)}`));
    }, options.timeout || 60000);

    const failOut = err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { out.destroy(); } catch {}
      reject(err);
    };

    child.stdout.on('data', d => {
      written += d.length;
      if (written > maxBytes) {
        child.kill();
        failOut(fail('YTDLP_JSON_TOO_LARGE', `站点 JSON 超过上限 (${maxBytes} 字节)`));
        return;
      }
      out.write(d);
    });
    child.stderr.on('data', d => {
      stderr = (stderr + d).slice(-256 * 1024);
    });
    child.on('error', err => failOut(err));
    child.on('close', code => {
      out.end(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if ((options.exitCodes || [0]).includes(code)) {
          resolve({ path: outFile, bytes: written, stderr, code });
        } else {
          reject(fail('PROCESS_FAILED', `本地进程未成功退出 (${code}): ${stderr.slice(-1000)}`, { stderr, code }));
        }
      });
    });
  });
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function unlinkQuiet(filePath) {
  try { fs.unlinkSync(filePath); } catch {}
}

/**
 * Checks whether an IPv4 address string falls into loopback or private ranges.
 */
function checkIpv4Address(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
    return { isIp: false };
  }
  const [a, b] = parts;
  // 127.0.0.0/8 (Loopback)
  const isLoopback = a === 127;
  // 0.0.0.0/8 (Current network / non-routable / binds to all local interfaces)
  const isZeroNetwork = a === 0;
  // Private & link-local ranges
  const isPrivate = (
    a === 10 || // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) || // 169.254.0.0/16 Link-local / Cloud metadata
    (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 Carrier-grade NAT
  );
  return { isIp: true, isLoopback: isLoopback || isZeroNetwork, isPrivate };
}

/**
 * Checks whether an IPv6 address falls into loopback or private ranges.
 */
function checkIpv6Address(rawIp) {
  let ip = rawIp.toLowerCase().replace(/^\[|\]$/g, '');

  // Check IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or normalized hex ::ffff:7f00:1)
  if (ip.startsWith('::ffff:')) {
    const tail = ip.slice(7);
    if (tail.includes('.')) {
      return checkIpv4Address(tail);
    }
    const hexParts = tail.split(':');
    if (hexParts.length === 2) {
      const high = parseInt(hexParts[0], 16);
      const low = parseInt(hexParts[1], 16);
      const b1 = (high >> 8) & 0xff;
      const b2 = high & 0xff;
      const b3 = (low >> 8) & 0xff;
      const b4 = low & 0xff;
      return checkIpv4Address(`${b1}.${b2}.${b3}.${b4}`);
    }
  }

  // ::1 or :: or 0:0:0:0:0:0:0:1
  const isLoopback = ip === '::1' || ip === '::' || ip === '0:0:0:0:0:0:0:1' || ip === '0:0:0:0:0:0:0:0';
  // Unique local (fc00::/7) or Link-local (fe80::/10)
  const isPrivate = ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb');
  return { isIp: true, isLoopback, isPrivate };
}

/**
 * Validates download URL safety with full coverage of loopback variants and private IP ranges.
 * Only HTTP and HTTPS are permitted.
 * Credentials in URL are strictly forbidden.
 */
function validateUrl(urlStr, options = {}) {
  const allowLoopback = typeof options === 'boolean' ? options : Boolean(options.allowLoopback);
  const allowedHosts = new Set(
    Array.isArray(options.allowedHosts) ? options.allowedHosts.map(h => h.toLowerCase()) : []
  );

  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw fail('INVALID_URL', '素材下载地址不是合法的标准 URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw fail('DISALLOWED_PROTOCOL', `仅支持 HTTP 或 HTTPS 协议，当前协议为: ${parsed.protocol}`);
  }

  if (parsed.username || parsed.password) {
    throw fail('DISALLOWED_CREDENTIALS', '安全限制：禁止在下载 URL 中包含嵌入用户名或密码');
  }

  const hostname = parsed.hostname.toLowerCase();

  // If user explicitly whitelisted this exact host
  if (allowedHosts.has(hostname)) {
    return parsed.href;
  }

  // Hostname aliases for local machine
  const isLocalHostDomain = (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  );

  if (isLocalHostDomain && !allowLoopback) {
    throw fail('DISALLOWED_LOOPBACK', '安全限制：禁止直接请求本机回环或本地主机名 (localhost)');
  }

  // Check IPv6
  if (hostname.includes(':') || hostname.startsWith('[')) {
    const ipv6Check = checkIpv6Address(hostname);
    if (ipv6Check.isLoopback && !allowLoopback) {
      throw fail('DISALLOWED_LOOPBACK', `安全限制：禁止请求本机 IPv6 回环或未指定地址 (${hostname})`);
    }
    if (ipv6Check.isPrivate && !allowLoopback) {
      throw fail('DISALLOWED_PRIVATE_NETWORK', `安全限制：禁止请求 IPv6 私有或链路本地保留地址 (${hostname})`);
    }
  } else {
    // Check IPv4
    const ipv4Check = checkIpv4Address(hostname);
    if (ipv4Check.isIp) {
      if (ipv4Check.isLoopback && !allowLoopback) {
        throw fail('DISALLOWED_LOOPBACK', `安全限制：禁止请求本机 IPv4 回环或全零绑定地址 (${hostname})`);
      }
      if (ipv4Check.isPrivate && !allowLoopback) {
        throw fail('DISALLOWED_PRIVATE_NETWORK', `安全限制：禁止请求局域网内部保留地址 (${hostname})`);
      }
    }
  }

  return parsed.href;
}

/**
 * Sniffs media type, format, and mime from the initial byte chunk of a file.
 */
function sniffMediaType(buffer, contentTypeHeader = '') {
  if (!buffer || buffer.length === 0) {
    return { category: 'unknown', format: null, mime: 'application/octet-stream', isErrorText: false };
  }

  // 1. Check for text/JSON/HTML error content
  const headStr = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('utf8').trim();
  const lowerHeader = (contentTypeHeader || '').toLowerCase();

  if (lowerHeader.includes('application/json') || headStr.startsWith('{') || headStr.startsWith('[')) {
    let parsed = null;
    try {
      parsed = JSON.parse(headStr);
    } catch {
      parsed = null;
    }
    const errorShaped = (
      /^\{\s*"(error|message|code)"/i.test(headStr) ||
      (parsed && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && (
        Object.prototype.hasOwnProperty.call(parsed, 'error') ||
        parsed.status === 'error' ||
        parsed.ok === false
      ))
    );
    if (errorShaped) {
      return { category: 'document', format: 'json', mime: 'application/json', isErrorText: true };
    }
    if (parsed) {
      return { category: 'document', format: 'json', mime: 'application/json', isErrorText: false };
    }
  }

  if (lowerHeader.includes('text/html') || /^<!DOCTYPE\s+html/i.test(headStr) || /^<html/i.test(headStr)) {
    return { category: 'document', format: 'html', mime: 'text/html', isErrorText: true };
  }

  if (lowerHeader.includes('text/plain') && !buffer.includes(0x00)) {
    return { category: 'document', format: 'txt', mime: 'text/plain', isErrorText: false };
  }

  // 2. Magic byte sniffers
  const len = buffer.length;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (len >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
      buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return { category: 'image', format: 'png', mime: 'image/png', isErrorText: false };
  }

  // JPEG: FF D8 FF
  if (len >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { category: 'image', format: 'jpg', mime: 'image/jpeg', isErrorText: false };
  }

  // GIF: GIF87a / GIF89a
  if (len >= 6 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38 &&
      (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61) {
    return { category: 'image', format: 'gif', mime: 'image/gif', isErrorText: false };
  }

  // WEBP: RIFF....WEBP
  if (len >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return { category: 'image', format: 'webp', mime: 'image/webp', isErrorText: false };
  }

  // MP4 / MOV / M4A: byte 4-7 is 'ftyp' or starts with 'moov'
  if (len >= 12 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
    const brand = buffer.subarray(8, 12).toString('ascii');
    const isAudioOnly = brand.startsWith('M4A') || brand.startsWith('mp4a');
    return {
      category: isAudioOnly ? 'audio' : 'video',
      format: isAudioOnly ? 'm4a' : 'mp4',
      mime: isAudioOnly ? 'audio/mp4' : 'video/mp4',
      isErrorText: false
    };
  }

  // Matroska / WebM: EBML header 1A 45 DF A3
  if (len >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    const isWebm = buffer.subarray(0, Math.min(len, 64)).includes(Buffer.from('webm', 'ascii'));
    return {
      category: 'video',
      format: isWebm ? 'webm' : 'mkv',
      mime: isWebm ? 'video/webm' : 'video/x-matroska',
      isErrorText: false
    };
  }

  // AVI: RIFF....AVI
  if (len >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x41 && buffer[9] === 0x56 && buffer[10] === 0x49 && buffer[11] === 0x20) {
    return { category: 'video', format: 'avi', mime: 'video/x-msvideo', isErrorText: false };
  }

  // WAV: RIFF....WAVE
  if (len >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x41 && buffer[10] === 0x56 && buffer[11] === 0x45) {
    return { category: 'audio', format: 'wav', mime: 'audio/wav', isErrorText: false };
  }

  // MP3: ID3 header
  if (len >= 3 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    return { category: 'audio', format: 'mp3', mime: 'audio/mpeg', isErrorText: false };
  }

  // MP3 frame sync: 11 bits set (0xFF 0xFB/F3/F2/E0)
  if (len >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    return { category: 'audio', format: 'mp3', mime: 'audio/mpeg', isErrorText: false };
  }

  // FLAC: fLaC
  if (len >= 4 && buffer[0] === 0x66 && buffer[1] === 0x4c && buffer[2] === 0x61 && buffer[3] === 0x43) {
    return { category: 'audio', format: 'flac', mime: 'audio/flac', isErrorText: false };
  }

  // OGG: OggS
  if (len >= 4 && buffer[0] === 0x4f && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) {
    return { category: 'audio', format: 'ogg', mime: 'audio/ogg', isErrorText: false };
  }

  // PDF: %PDF-
  if (len >= 5 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46 && buffer[4] === 0x2d) {
    return { category: 'document', format: 'pdf', mime: 'application/pdf', isErrorText: false };
  }

  // Content-Type is only a hint. Unknown bytes must not be registered as document.
  return {
    category: 'unknown',
    format: null,
    mime: (lowerHeader.split(';')[0] || 'application/octet-stream').trim() || 'application/octet-stream',
    isErrorText: false
  };
}

/**
 * Validates that actual sniffed category and format satisfy the allowed_formats parameter.
 */
function isFormatAllowed(sniffed, allowedFormats) {
  if (!sniffed || sniffed.category === 'unknown') {
    return false;
  }
  if (!allowedFormats || !Array.isArray(allowedFormats) || allowedFormats.length === 0) {
    return true;
  }
  const normalized = allowedFormats.map(f => String(f).toLowerCase().trim());
  if (normalized.includes(sniffed.category)) {
    return true;
  }
  if (sniffed.format && normalized.includes(sniffed.format.toLowerCase())) {
    return true;
  }
  return false;
}

const REGISTERABLE_DOCUMENTS = new Set(['pdf', 'txt', 'json', 'md', 'csv', 'srt', 'vtt']);

/**
 * Decode-level verification. Magic bytes alone cannot prove a truncated ftyp or broken PNG is media.
 */
async function verifyDecodedMedia(filePath, sniffed, { ffprobeBin = null, sharp = null, maxDuration = Infinity } = {}) {
  if (!sniffed || sniffed.category === 'unknown' || !sniffed.format) {
    throw fail('UNKNOWN_MEDIA', '无法识别为可登记的媒体或文档类型');
  }

  if (sniffed.category === 'video' || sniffed.category === 'audio') {
    if (!ffprobeBin || !fs.existsSync(ffprobeBin)) {
      throw fail('PROBE_UNAVAILABLE', '缺少 ffprobe，无法验证音视频可解码');
    }
    let probeRes;
    try {
      probeRes = await runProcess(ffprobeBin, [
        '-v', 'error',
        '-show_format',
        '-show_streams',
        '-of', 'json',
        filePath
      ], { timeout: 20000 });
    } catch (err) {
      throw fail('MEDIA_UNDECODABLE', `媒体无法解码: ${err.message}`);
    }
    let data;
    try {
      data = JSON.parse(probeRes.stdout);
    } catch {
      throw fail('MEDIA_UNDECODABLE', 'ffprobe 输出不可解析');
    }
    const streams = data.streams || [];
    const duration = Math.max(0, Number(data.format?.duration) || 0, ...streams.map(s => Number(s.duration) || 0));
    if (duration > maxDuration) throw fail('DURATION_EXCEEDED', `实际媒体时长 (${duration} 秒) 超过允许上限 (${maxDuration} 秒)`);
    if (sniffed.category === 'video' && !streams.some(s => s.codec_type === 'video')) {
      throw fail('MEDIA_UNDECODABLE', '容器缺少可解码视频流');
    }
    if (sniffed.category === 'audio' && !streams.some(s => s.codec_type === 'audio')) {
      throw fail('MEDIA_UNDECODABLE', '容器缺少可解码音频流');
    }
    const ffmpegBin = path.join(path.dirname(ffprobeBin), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (!fs.existsSync(ffmpegBin)) throw fail('PROBE_UNAVAILABLE', '缺少 ffmpeg，无法验证音视频实际解码');
    try {
      await runProcess(ffmpegBin, ['-nostdin','-v','error','-xerror','-threads','2','-protocol_whitelist','file,pipe','-i',filePath,
        '-map',sniffed.category === 'video' ? '0:v:0' : '0:a:0','-t','2','-f','null','-'], {timeout:30000});
    } catch (err) { throw fail('MEDIA_UNDECODABLE', `媒体内容解码失败: ${err.message}`); }
    return { probe: data, verification_level:'metadata_and_first_two_seconds' };
  }

  if (sniffed.category === 'image') {
    if (!sharp) {
      throw fail('PROBE_UNAVAILABLE', '缺少 sharp，无法验证图像可解码');
    }
    try {
      const meta = await sharp(filePath, { failOn: 'error', limitInputPixels: 100000000 }).metadata();
      if (!meta.width || !meta.height) {
        throw fail('MEDIA_UNDECODABLE', '图像缺少有效画幅');
      }
      await sharp(filePath, { failOn:'error', limitInputPixels:100000000 }).resize({width:32,height:32,fit:'inside'}).raw().toBuffer();
      return { probe: meta };
    } catch (err) {
      if (err.code === 'MEDIA_UNDECODABLE' || err.code === 'PROBE_UNAVAILABLE') throw err;
      throw fail('MEDIA_UNDECODABLE', `图像无法解码: ${err.message}`);
    }
  }

  if (sniffed.category === 'document') {
    if (!REGISTERABLE_DOCUMENTS.has(sniffed.format)) {
      throw fail('UNKNOWN_MEDIA', `文档类型不受理: ${sniffed.format}`);
    }
    return { probe: null };
  }

  throw fail('UNKNOWN_MEDIA', `未知媒体类别: ${sniffed.category}`);
}

/**
 * Downloads a direct media file over Node HTTP(S) with support for Range resumption.
 */
async function downloadDirect(url, targetPath, options = {}) {
  const {
    maxBytes = 500 * 1024 * 1024,
    timeoutMs = 60000,
    allowLoopback = false,
    allowedHosts = [],
    onProgress = () => {},
    expectedSha256 = null,
    fetcher = fetch
  } = options;

  let currentUrl = validateUrl(url, { allowLoopback, allowedHosts });
  const partPath = targetPath + '.part';
  const metaPath = targetPath + '.meta.json';
  const partMetaPath = partPath + '.meta.json';

  async function revalidateCachedIdentity(meta, size) {
    if (expectedSha256 && meta.sha256 === expectedSha256) {
      return { reuse: true, reason: 'expected_sha256' };
    }
    const headController = new AbortController();
    const headTimer = setTimeout(() => headController.abort(), Math.min(timeoutMs, 15000));
    try {
      const res = await fetcher(currentUrl, {
        method: 'HEAD',
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AP-Vibe/1.0'
        },
        signal: headController.signal
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        return { reuse: false, reason: 'redirect' };
      }
      if (![200, 204].includes(res.status)) {
        return { reuse: false, reason: 'head_status' };
      }
      const etag = res.headers.get('etag');
      const lastModified = res.headers.get('last-modified');
      const cl = res.headers.get('content-length');
      if (etag || meta.etag) {
        return etag && meta.etag && etag === meta.etag
          ? { reuse: true, reason: 'etag' }
          : { reuse: false, reason: 'etag_mismatch' };
      }
      if (lastModified || meta.lastModified) {
        return lastModified && meta.lastModified && lastModified === meta.lastModified
          ? { reuse: true, reason: 'last-modified' }
          : { reuse: false, reason: 'last_modified_mismatch' };
      }
      if (cl && Number(cl) !== Number(size)) return { reuse: false, reason: 'size' };
      return { reuse: false, reason: 'no_validator' };
    } catch {
      return { reuse: false, reason: 'head_failed' };
    } finally {
      clearTimeout(headTimer);
    }
  }

  // Cache reuse requires bound meta (url + sha). Orphan files without meta cannot be claimed.
  if (fs.existsSync(targetPath)) {
    const existingSize = fs.statSync(targetPath).size;
    const meta = readJsonFile(metaPath);
    if (existingSize > 0 && meta && meta.url === url && meta.sha256) {
      const actualSha = await sha256File(targetPath);
      if (actualSha === meta.sha256 && (!expectedSha256 || actualSha === expectedSha256)) {
        const decision = await revalidateCachedIdentity({ ...meta, sha256: actualSha }, existingSize);
        if (decision.reuse) {
          onProgress({ stage: 'cache_reused', bytes: existingSize, total_bytes: existingSize });
          return {
            reused: true,
            bytes: existingSize,
            sha256: actualSha,
            path: targetPath,
            content_type: meta.content_type || 'application/octet-stream'
          };
        }
      }
    }
  }

  // Resume .part only when bound to the same URL and a representation validator.
  let offset = 0;
  let partMeta = readJsonFile(partMetaPath);
  if (fs.existsSync(partPath)) {
    const partSize = fs.statSync(partPath).size;
    const canResume = Boolean(
      partMeta &&
      partMeta.url === url &&
      partSize > 0 &&
      (partMeta.etag || partMeta.lastModified)
    );
    if (canResume) {
      offset = partSize;
    } else {
      unlinkQuiet(partPath);
      unlinkQuiet(partMetaPath);
      partMeta = null;
      offset = 0;
    }
  }

  const controller = new AbortController();
  let idleTimer;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 45000));
  };
  resetIdle();

  try {
    let response;
    for (let hop = 0; hop < 6; hop++) {
      const headers = {
        'Accept-Encoding': 'identity',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AP-Vibe/1.0'
      };
      if (offset > 0) {
        headers.Range = `bytes=${offset}-`;
        if (partMeta?.etag) headers['If-Range'] = partMeta.etag;
        else if (partMeta?.lastModified) headers['If-Range'] = partMeta.lastModified;
      }

      response = await fetcher(currentUrl, {
        redirect: 'manual',
        headers,
        signal: controller.signal
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const loc = response.headers.get('location');
        if (!loc) throw fail('REDIRECT_MISSING_LOCATION', '重定向响应未附带 Location 头');
        await response.body?.cancel();
        currentUrl = validateUrl(new URL(loc, currentUrl).href, { allowLoopback, allowedHosts });
        continue;
      }
      break;
    }

    // 416 Range Not Satisfiable: offset might be stale or larger than remote
    if (response.status === 416 && offset > 0) {
      await response.body?.cancel();
      try { fs.unlinkSync(partPath); } catch {}
      return downloadDirect(url, targetPath, { ...options, fetcher });
    }

    if (![200, 206].includes(response.status) || !response.body) {
      throw fail('DOWNLOAD_HTTP_ERROR', `下载响应状态码异常: HTTP ${response.status}`, { status: response.status });
    }

    let totalBytes = null;
    const isPartial = response.status === 206;

    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');

    if (isPartial) {
      const contentRange = response.headers.get('content-range') || '';
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
      if (!match || Number(match[1]) !== offset) {
        await response.body.cancel();
        throw fail('INVALID_CONTENT_RANGE', `服务端断点区间不匹配: 期望起始 ${offset}，实际收到 ${contentRange}`);
      }
      const identityMismatch = (
        (partMeta?.etag && etag && partMeta.etag !== etag) ||
        (partMeta?.lastModified && lastModified && partMeta.lastModified !== lastModified)
      );
      if (identityMismatch) {
        await response.body.cancel();
        unlinkQuiet(partPath);
        unlinkQuiet(partMetaPath);
        return downloadDirect(url, targetPath, { ...options, fetcher });
      }
      totalBytes = Number(match[3]);
    } else {
      offset = 0;
      unlinkQuiet(partPath);
      const cl = response.headers.get('content-length');
      if (cl) totalBytes = Number(cl);
    }

    if (totalBytes && totalBytes > maxBytes) {
      await response.body.cancel();
      throw fail('DOWNLOAD_SIZE_EXCEEDED', `文件大小 (${totalBytes} 字节) 超过设定的上限 (${maxBytes} 字节)`);
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    try {
      fs.writeFileSync(partMetaPath, JSON.stringify({
        url,
        etag,
        lastModified,
        totalBytes,
        started_at: new Date().toISOString()
      }, null, 2), 'utf8');
    } catch {}

    let writtenBytes = offset;
    let lastReport = Date.now();

    const meter = new Transform({
      transform(chunk, encoding, cb) {
        resetIdle();
        writtenBytes += chunk.length;
        if (writtenBytes > maxBytes || (totalBytes && writtenBytes > totalBytes)) {
          return cb(fail('DOWNLOAD_SIZE_EXCEEDED', `传输字节 (${writtenBytes}) 超过上限 (${maxBytes})`));
        }
        if (Date.now() - lastReport > 250) {
          lastReport = Date.now();
          onProgress({
            stage: 'downloading',
            bytes: writtenBytes,
            total_bytes: totalBytes,
            percent: totalBytes ? Math.round((writtenBytes / totalBytes) * 100) : null
          });
        }
        cb(null, chunk);
      }
    });

    const fileStream = fs.createWriteStream(partPath, { flags: offset ? 'a' : 'w' });
    await pipeline(Readable.fromWeb(response.body), meter, fileStream);

    if (totalBytes && writtenBytes !== totalBytes) {
      throw fail('INCOMPLETE_DOWNLOAD', `下载尚未完整 (已获取 ${writtenBytes}/${totalBytes})，已保存断点`);
    }

    const actualSha = await sha256File(partPath);
    if (expectedSha256 && actualSha !== expectedSha256) {
      fs.unlinkSync(partPath);
      throw fail('SHA256_MISMATCH', `文件 SHA-256 校验不匹配: 预期 ${expectedSha256}，实际 ${actualSha}`);
    }

    // Atomic move to final targetPath
    if (fs.existsSync(targetPath)) {
      try { fs.unlinkSync(targetPath); } catch {}
    }
    fs.renameSync(partPath, targetPath);
    unlinkQuiet(partMetaPath);

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    try {
      fs.writeFileSync(metaPath, JSON.stringify({
        url,
        sha256: actualSha,
        bytes: writtenBytes,
        etag,
        lastModified,
        content_type: contentType,
        downloaded_at: new Date().toISOString()
      }, null, 2), 'utf8');
    } catch {}

    return {
      reused: false,
      bytes: writtenBytes,
      sha256: actualSha,
      path: targetPath,
      content_type: contentType
    };
  } finally {
    clearTimeout(idleTimer);
  }
}

/**
 * Downloads web video / audio via yt-dlp binary with bounded arguments and progress callback.
 */
async function downloadViaYtDlp(ytdlpExecutable, item, outputDir, options = {}) {
  const {
    maxBytes = 500 * 1024 * 1024,
    maxDuration = 1800,
    timeoutMs = 120000,
    ffmpegBin = null,
    ffprobeBin = null,
    onProgress = () => {}
  } = options;

  fs.mkdirSync(outputDir, { recursive: true });

  const safeUrl = item.url.trim();
  const baseName = crypto.createHash('sha256').update(safeUrl).digest('hex').slice(0, 16);
  const outputTemplate = path.join(outputDir, `${baseName}.%(ext)s`);

  // Verify outputTemplate strictly resolves inside outputDir
  const realOutputDir = fs.realpathSync(outputDir);
  const resolvedTemplate = path.resolve(outputTemplate);
  if (!resolvedTemplate.startsWith(realOutputDir + path.sep)) {
    throw fail('PATH_ESCAPE', 'yt-dlp 输出模板越出授权媒体目录');
  }

  // First extract metadata JSON without downloading media
  onProgress({ stage: 'extracting_info', message: '正在解析站点公开媒体信息' });
  const infoFile = path.join(outputDir, `${baseName}.info.json`);
  const infoArgs = [
    '--no-playlist',
    '--dump-single-json',
    '--prefer-free-formats',
    safeUrl
  ];

  let meta;
  try {
    await runProcessToFile(ytdlpExecutable, infoArgs, infoFile, {
      timeout: Math.min(timeoutMs, 45000),
      maxStdoutBytes: 32 * 1024 * 1024
    });
    meta = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  } catch (err) {
    throw fail('YTDLP_EXTRACT_FAILED', `站点信息解析失败: ${err.message}`);
  } finally {
    unlinkQuiet(infoFile);
  }

  const duration = Number(meta.duration || 0);
  if (duration > maxDuration) {
    throw fail('DURATION_EXCEEDED', `媒体时长 (${duration} 秒) 超过允许上限 (${maxDuration} 秒)`);
  }

  const estimatedSize = Number(meta.filesize || meta.filesize_approx || 0);
  if (estimatedSize > maxBytes) {
    throw fail('SIZE_EXCEEDED', `媒体预估大小 (${estimatedSize} 字节) 超过允许上限 (${maxBytes} 字节)`);
  }

  // Bounded download arguments
  const dlArgs = [
    '--no-playlist',
    '--no-continue',
    '--max-filesize', `${maxBytes}`,
    '-o', outputTemplate
  ];

  if (ffmpegBin) {
    dlArgs.push('--ffmpeg-location', path.dirname(ffmpegBin));
  }

  dlArgs.push(safeUrl);

  onProgress({ stage: 'downloading_ytdlp', message: `正在下载 ${meta.title || safeUrl}` });
  await runProcess(ytdlpExecutable, dlArgs, {
    timeout: timeoutMs,
    onOutput: msg => {
      const match = /(\d+\.\d+)%/.exec(msg);
      if (match) {
        onProgress({ stage: 'downloading_ytdlp', percent: parseFloat(match[1]) });
      }
    }
  });

  // Locate the materialized file matching baseName
  const matching = fs.readdirSync(outputDir).filter(f => f.startsWith(baseName + '.') && !f.endsWith('.part') && !f.endsWith('.meta.json'));
  if (!matching.length) {
    throw fail('YTDLP_OUTPUT_MISSING', 'yt-dlp 执行完成但未找到生成的媒体文件');
  }

  const finalPath = path.join(outputDir, matching[0]);
  const stat = fs.statSync(finalPath);

  // Hard check actual size
  if (stat.size > maxBytes) {
    try { fs.unlinkSync(finalPath); } catch {}
    throw fail('SIZE_EXCEEDED', `实际下载媒体文件大小 (${stat.size} 字节) 超过上限 (${maxBytes} 字节)`);
  }

  // Probe actual duration with ffprobe if available
  let actualDuration = duration;
  if (ffprobeBin && fs.existsSync(ffprobeBin)) {
    try {
      const probeRes = await runProcess(ffprobeBin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', finalPath], { timeout: 15000 });
      const probeData = JSON.parse(probeRes.stdout);
      if (probeData.format?.duration) {
        actualDuration = Number(probeData.format.duration);
        if (actualDuration > maxDuration) {
          try { fs.unlinkSync(finalPath); } catch {}
          throw fail('DURATION_EXCEEDED', `实际媒体时长 (${actualDuration} 秒) 超过允许上限 (${maxDuration} 秒)`);
        }
      }
    } catch (probeErr) {
      if (probeErr.code === 'DURATION_EXCEEDED') throw probeErr;
    }
  }

  const sha = await sha256File(finalPath);

  return {
    path: finalPath,
    filename: matching[0],
    bytes: stat.size,
    sha256: sha,
    title: meta.title || null,
    uploader: meta.uploader || meta.channel || null,
    duration_seconds: actualDuration,
    format: meta.ext || path.extname(finalPath).slice(1),
    webpage_url: meta.webpage_url || safeUrl,
    license: meta.license || null
  };
}

/**
 * Main executor contract function for local.media.download.
 * Conforms to executeNative({ inputPath, outputPath, parameters, components, report, sources })
 */
async function executeDownload({
  inputPath,
  outputPath,
  parameters = {},
  components = {},
  report = () => {},
  allowLoopback = false,
  allowedHosts = [],
  sharp = null,
  ensureComponent = null
}) {
  if (!inputPath || !fs.existsSync(inputPath)) {
    throw fail('INPUT_MISSING', '下载来源清单文件不存在');
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(inputPath, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    throw fail('INVALID_MANIFEST_JSON', `清单 JSON 解析失败: ${err.message}`);
  }

  const items = Array.isArray(manifest) ? manifest : manifest.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw fail('EMPTY_MANIFEST', '下载清单必须包含至少 1 项有效来源');
  }

  const maxItems = Math.max(1, Math.min(parameters.max_items || 10, 100));
  if (items.length > maxItems) {
    throw fail('ITEM_COUNT_EXCEEDED', `下载项目数 (${items.length}) 超过上限 (${maxItems})`);
  }

  const maxBytesPerFile = Number(parameters.max_bytes_per_file || 500 * 1024 * 1024);
  const maxTotalBytes = Number(parameters.max_total_bytes || 2 * 1024 * 1024 * 1024);
  const maxDuration = Number(parameters.max_duration_seconds || 1800);
  const timeoutMs = Number(parameters.timeout_ms || 90000);
  const preferDirect = parameters.prefer_direct !== false;
  const allowedFormats = Array.isArray(parameters.allowed_formats) && parameters.allowed_formats.length > 0
    ? parameters.allowed_formats
    : null;

  const outputDir = path.dirname(outputPath);
  const mediaDir = path.join(outputDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  const realOutputDir = fs.realpathSync(outputDir);
  const realMediaDir = fs.realpathSync(mediaDir);

  // Defend against overwriting the input manifest
  const realInputPath = path.resolve(inputPath);
  if (path.resolve(outputPath) === realInputPath) {
    throw fail('INPUT_OVERWRITE_CONFLICT', '输出结果文件不能覆盖输入清单文件');
  }

  let ytdlpBin = components['tool.yt-dlp']?.executables?.['yt-dlp'];
  let extractorPreparation = null;
  async function prepareExtractor() {
    if (!ytdlpBin && ensureComponent) {
      extractorPreparation ||= Promise.resolve().then(() => ensureComponent('tool.yt-dlp'));
      ytdlpBin = (await extractorPreparation).executables?.['yt-dlp'];
    }
    return ytdlpBin;
  }
  const ffmpegBin = components['media.ffmpeg']?.executables?.ffmpeg;
  const ffprobeBin = components['media.ffmpeg']?.executables?.ffprobe;

  const results = [];
  const assets = [];
  let totalDownloadedBytes = 0;

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx] && typeof items[idx] === 'object' ? items[idx] : {};
    const externalId = String(item.id || `item_${idx + 1}`);
    const url = item.url;

    report({ stage: 'processing_item', index: idx + 1, total: items.length, url });

    if (!url || typeof url !== 'string' || !url.trim()) {
      results.push({
        id: externalId,
        url: String(url),
        status: 'failed',
        error_code: 'INVALID_URL',
        error_message: '未提供有效 URL'
      });
      continue;
    }

    // URL validation upfront
    try {
      validateUrl(url, { allowLoopback, allowedHosts });
    } catch (urlErr) {
      results.push({
        id: externalId,
        url: String(url),
        status: 'failed',
        error_code: urlErr.code || 'DISALLOWED_URL',
        error_message: urlErr.message
      });
      continue;
    }

    // Construct strictly safe internal filename (no path traversal from item.id!)
    // item.id is kept strictly in metadata. Local filename uses safe index + url hash
    const safePrefix = externalId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24) || 'asset';
    const urlHash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 10);
    const safeBase = `${safePrefix}_${urlHash}`;

    let parsedUrlPath = '';
    try {
      parsedUrlPath = new URL(url).pathname;
    } catch {
      parsedUrlPath = '';
    }
    const rawExt = path.extname(parsedUrlPath).slice(1).toLowerCase();

    let succeeded = false;
    let fileInfo = null;
    let directFailure = null;

    // Direct HTTP download attempt
    if (preferDirect) {
      // Temporary initial filename before content inspection
      const initialExt = rawExt || 'download';
      const targetFilename = `${safeBase}.${initialExt}`;
      const targetPath = path.resolve(mediaDir, targetFilename);

      // Verify boundary strictly
      if (!targetPath.startsWith(realMediaDir + path.sep)) {
        results.push({
          id: externalId,
          url,
          status: 'failed',
          error_code: 'PATH_ESCAPE',
          error_message: '计算目标路径越界'
        });
        continue;
      }

      try {
        const dlResult = await downloadDirect(url, targetPath, {
          maxBytes: Math.min(maxBytesPerFile, maxTotalBytes - totalDownloadedBytes),
          timeoutMs,
          allowLoopback,
          allowedHosts,
          expectedSha256: item.expected_sha256 || null,
          onProgress: p => report({ item: externalId, ...p })
        });

        // Read first 4KB to sniff actual media type and check for JSON/HTML error responses
        const fd = fs.openSync(dlResult.path, 'r');
        const headerBuf = Buffer.alloc(4096);
        const bytesRead = fs.readSync(fd, headerBuf, 0, 4096, 0);
        fs.closeSync(fd);

        const sniffed = sniffMediaType(headerBuf.subarray(0, bytesRead), dlResult.content_type);

        // 1. Check if response is error text / JSON / HTML disguised with 200 and .mp4 extension
        if (sniffed.isErrorText) {
          // Clean up downloaded error file
          try { fs.unlinkSync(dlResult.path); } catch {}
          try { fs.unlinkSync(dlResult.path + '.meta.json'); } catch {}

          if (sniffed.format === 'html' && (!rawExt || ['html','htm','php','asp','aspx'].includes(rawExt))) {
            throw fail('SITE_EXTRACTION_REQUIRED', '该地址返回网页，需要解析网页中的公开媒体');
          }

          results.push({
            id: externalId,
            url,
            status: 'failed',
            method: 'direct_http',
            error_code: 'UPSTREAM_ERROR_PAYLOAD',
            error_message: `服务响应为文本/错误格式 (${sniffed.mime})，无法作为有效媒体使用`,
            sniffed_type: sniffed.category
          });
          continue;
        }

        // 2. Decode probe: truncated ftyp / broken images fail here even if magic matches
        try {
          await verifyDecodedMedia(dlResult.path, sniffed, { ffprobeBin, sharp, maxDuration });
        } catch (probeErr) {
          unlinkQuiet(dlResult.path);
          unlinkQuiet(dlResult.path + '.meta.json');
          results.push({
            id: externalId,
            url,
            status: 'failed',
            method: 'direct_http',
            error_code: probeErr.code || 'MEDIA_UNDECODABLE',
            error_message: probeErr.message,
            sniffed_type: sniffed.category,
            actual_format: sniffed.format
          });
          continue;
        }

        // 3. Check allowed_formats constraint
        if (!isFormatAllowed(sniffed, allowedFormats)) {
          unlinkQuiet(dlResult.path);
          unlinkQuiet(dlResult.path + '.meta.json');

          results.push({
            id: externalId,
            url,
            status: 'failed',
            method: 'direct_http',
            error_code: 'FORMAT_DISALLOWED',
            error_message: `实际素材格式 (${sniffed.category}/${sniffed.format || rawExt}) 不在授权格式白名单 (${allowedFormats.join(', ')}) 中`,
            sniffed_type: sniffed.category,
            actual_format: sniffed.format
          });
          continue;
        }

        // 4. If file was downloaded without an extension or with mismatched extension, normalize to sniffed extension
        let finalPath = dlResult.path;
        let finalExt = rawExt;
        if ((!rawExt || rawExt === 'download') && sniffed.format) {
          finalExt = sniffed.format;
          const normalizedTarget = path.join(mediaDir, `${safeBase}.${finalExt}`);
          if (finalPath !== normalizedTarget) {
            fs.renameSync(finalPath, normalizedTarget);
            try { fs.unlinkSync(finalPath + '.meta.json'); } catch {}
            finalPath = normalizedTarget;
          }
        }

        totalDownloadedBytes += dlResult.bytes;

        const relPath = path.relative(outputDir, finalPath).replaceAll('\\', '/');

        fileInfo = {
          id: externalId,
          url,
          status: 'succeeded',
          method: 'direct_http',
          path: relPath,
          bytes: dlResult.bytes,
          sha256: dlResult.sha256,
          title: item.title || path.basename(parsedUrlPath) || `${safeBase}.${finalExt}`,
          author: item.author || null,
          license_clue: item.license_clue || null,
          content_type: sniffed.mime,
          media_type: sniffed.category,
          format: sniffed.format || finalExt,
          downloaded_at: new Date().toISOString()
        };

        assets.push({
          file: relPath,
          type: sniffed.category,
          title: fileInfo.title,
          role: 'downloaded_asset',
          bytes: dlResult.bytes,
          sha256: dlResult.sha256
        });

        results.push(fileInfo);
        succeeded = true;
      } catch (directErr) {
        directFailure = { code: directErr.code || 'DIRECT_DOWNLOAD_FAILED', message: directErr.message };
        // Failed constraints, interrupted downloads and corrupt media retain their own recovery path.
        // Only an actual page response or a page-shaped HTTP failure needs the optional extractor.
        if (directErr.code !== 'SITE_EXTRACTION_REQUIRED' && !(directErr.code === 'DOWNLOAD_HTTP_ERROR' && (!rawExt || ['html','htm','php','asp','aspx'].includes(rawExt)))) {
          results.push({
            id: externalId,
            url,
            status: 'failed',
            method: 'direct_http',
            error_code: directErr.code || 'DIRECT_DOWNLOAD_FAILED',
            error_message: directErr.message
          });
          continue;
        }
      }
    }

    // Fallback or explicit site extraction via yt-dlp
    if (!succeeded) {
      try { await prepareExtractor(); }
      catch (installErr) {
        results.push({ id:externalId, url, status:'failed', method:'yt_dlp', error_code:installErr.code || 'YTDLP_INSTALL_FAILED',
          error_message:installErr.message, direct_error:directFailure });
        continue;
      }
      if (!ytdlpBin) {
        results.push({
          id: externalId,
          url,
          status: 'failed',
          error_code: 'YTDLP_NOT_AVAILABLE',
          error_message: '该链接需站点解析，但 tool.yt-dlp 组件尚未准备完成',
          direct_error: directFailure
        });
        continue;
      }

      try {
        const ytdlpResult = await downloadViaYtDlp(ytdlpBin, item, mediaDir, {
          maxBytes: Math.min(maxBytesPerFile, maxTotalBytes - totalDownloadedBytes),
          maxDuration,
          timeoutMs,
          ffmpegBin,
          ffprobeBin,
          onProgress: p => report({ item: externalId, ...p })
        });

        // Verify sniffed type and allowed_formats on yt-dlp output
        const fd = fs.openSync(ytdlpResult.path, 'r');
        const headerBuf = Buffer.alloc(4096);
        const bytesRead = fs.readSync(fd, headerBuf, 0, 4096, 0);
        fs.closeSync(fd);

        const sniffed = sniffMediaType(headerBuf.subarray(0, bytesRead));

        if (sniffed.isErrorText) {
          try { fs.unlinkSync(ytdlpResult.path); } catch {}
          results.push({
            id: externalId,
            url,
            status: 'failed',
            method: 'yt_dlp',
            error_code: 'UPSTREAM_ERROR_PAYLOAD',
            error_message: `解析内容为文本/错误格式 (${sniffed.mime})`
          });
          continue;
        }

        try {
          await verifyDecodedMedia(ytdlpResult.path, sniffed, { ffprobeBin, sharp, maxDuration });
        } catch (probeErr) {
          unlinkQuiet(ytdlpResult.path);
          results.push({
            id: externalId,
            url,
            status: 'failed',
            method: 'yt_dlp',
            error_code: probeErr.code || 'MEDIA_UNDECODABLE',
            error_message: probeErr.message,
            sniffed_type: sniffed.category
          });
          continue;
        }

        if (!isFormatAllowed(sniffed, allowedFormats)) {
          unlinkQuiet(ytdlpResult.path);
          results.push({
            id: externalId,
            url,
            status: 'failed',
            method: 'yt_dlp',
            error_code: 'FORMAT_DISALLOWED',
            error_message: `实际素材格式 (${sniffed.category}/${sniffed.format}) 不在授权格式白名单 (${allowedFormats.join(', ')}) 中`,
            sniffed_type: sniffed.category
          });
          continue;
        }

        totalDownloadedBytes += ytdlpResult.bytes;
        const relPath = path.relative(outputDir, ytdlpResult.path).replaceAll('\\', '/');

        fileInfo = {
          id: externalId,
          url,
          status: 'succeeded',
          method: 'yt_dlp',
          path: relPath,
          bytes: ytdlpResult.bytes,
          sha256: ytdlpResult.sha256,
          title: ytdlpResult.title || item.title || null,
          author: ytdlpResult.uploader || item.author || null,
          license_clue: ytdlpResult.license || item.license_clue || null,
          duration_seconds: ytdlpResult.duration_seconds,
          media_type: sniffed.category,
          format: ytdlpResult.format,
          downloaded_at: new Date().toISOString()
        };

        assets.push({
          file: relPath,
          type: sniffed.category,
          title: fileInfo.title || ytdlpResult.filename,
          role: 'downloaded_asset',
          bytes: ytdlpResult.bytes,
          sha256: ytdlpResult.sha256
        });

        results.push(fileInfo);
      } catch (ytdlpErr) {
        results.push({
          id: externalId,
          url,
          status: 'failed',
          method: 'yt_dlp',
          error_code: ytdlpErr.code || 'YTDLP_FAILED',
          error_message: ytdlpErr.message,
          direct_error: directFailure
        });
      }
    }
  }

  const summary = {
    schema_version: 1,
    total_requested: items.length,
    succeeded_count: results.filter(r => r.status === 'succeeded').length,
    failed_count: results.filter(r => r.status === 'failed').length,
    total_downloaded_bytes: totalDownloadedBytes,
    items: results,
    completed_at: new Date().toISOString()
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), 'utf8');

  const technicalStatus = summary.total_requested > 0 && summary.succeeded_count > 0 ? 'passed' : (summary.failed_count === summary.total_requested ? 'failed' : 'passed');
  const qualityStatus = summary.failed_count === 0 ? 'passed' : (summary.succeeded_count > 0 ? 'review_required' : 'failed');

  return {
    summary,
    assets,
    technical_status: technicalStatus,
    quality_status: qualityStatus,
    quality_note: summary.failed_count === 0
      ? `已下载 ${summary.succeeded_count} 项，完成类型识别、解码抽查与哈希记录；完整内容仍可按任务检查。`
      : `部分素材未下载或不合规 (${summary.succeeded_count} 成功, ${summary.failed_count} 失败)，错误已结构化留痕供恢复。`
  };
}

module.exports = {
  id: 'local.media.download',
  title: '可恢复公开素材安全下载',
  kind: 'document',
  component_id: 'tool.yt-dlp',
  additional_components: ['media.ffmpeg'],
  output_extension: 'json',
  defaults: {
    max_items: 10,
    max_bytes_per_file: 500 * 1024 * 1024,
    max_total_bytes: 2 * 1024 * 1024 * 1024,
    max_duration_seconds: 1800,
    timeout_ms: 90000,
    prefer_direct: true,
    allowed_formats: null
  },
  executeNative: executeDownload,
  downloadDirect,
  downloadViaYtDlp,
  validateUrl,
  sniffMediaType,
  isFormatAllowed,
  verifyDecodedMedia,
  sha256File,
  runProcessToFile
};