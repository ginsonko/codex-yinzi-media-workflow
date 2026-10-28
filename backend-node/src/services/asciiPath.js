// Some desktop tools (After Effects' -r, ExtendScript without a BOM) mangle non-ASCII paths on Chinese Windows.
// Work files stay where the user keeps them; only what such a tool must read gets an ASCII-only name.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const isAscii = s => /^[\x20-\x7e]*$/.test(String(s));
const escapeNonAscii = text => String(text).replace(/[\u0080-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

// 8.3 name; returns the input when the volume has short names turned off (common on non-system drives).
function shortPath(p, { platform = process.platform, run = execFileSync } = {}) {
  if (platform !== 'win32' || isAscii(p) || !fs.existsSync(p) || /["%^&|<>]/.test(p)) return p;
  try {
    const out = String(run('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`], { windowsHide: true, windowsVerbatimArguments: true, timeout: 10000 })).trim().split(/\r?\n/).pop();
    return out && isAscii(out) && fs.existsSync(out) ? out : p;
  } catch { return p; }
}

function asciiTempDir(env = process.env, opts = {}) {
  const tmp = os.tmpdir();
  const candidates = [tmp, shortPath(tmp, opts), path.join(env.PUBLIC || 'C:\\Users\\Public', 'Documents'), env.SystemDrive ? env.SystemDrive + '\\' : ''];
  for (const base of candidates.filter(b => b && isAscii(b))) {
    const dir = path.join(base, 'yinzi-ascii');
    try { fs.mkdirSync(dir, { recursive: true }); return dir; } catch {}
  }
  return null;
}

// An ASCII path a tool can open for `file`: itself, its 8.3 name, or a copy in an ASCII temp folder
// (only for self-contained files such as a generated script). Copies older than a day are removed.
function asciiFile(file, { env = process.env, now = Date.now(), ...opts } = {}) {
  if (isAscii(file)) return file;
  const short = shortPath(file, opts);
  if (isAscii(short)) return short;
  const dir = asciiTempDir(env, opts);
  if (!dir) return file;
  for (const n of fs.readdirSync(dir)) {
    try { const f = path.join(dir, n); if (now - fs.statSync(f).mtimeMs > 86400000) fs.unlinkSync(f); } catch {}
  }
  const ext = isAscii(path.extname(file)) ? path.extname(file) : '';
  const copy = path.join(dir, crypto.createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 16) + ext);
  fs.copyFileSync(file, copy);
  return copy;
}

module.exports = { isAscii, escapeNonAscii, shortPath, asciiTempDir, asciiFile };
