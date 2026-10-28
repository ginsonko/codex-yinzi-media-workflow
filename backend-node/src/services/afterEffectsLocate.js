// Where AfterFX.exe is on Windows when it is not in Program Files: App Paths, a running AE, the Adobe
// uninstall entries, then one level below each fixed drive (E:\Adobe After Effects 2026, E:\AE\Adobe After Effects 2026).
// The last find is cached in the runtime dir so the drive scan runs once.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const AE_DIR = /^Adobe After Effects(?: |$)/i;
const SKIP = /^(\$recycle\.bin|system volume information|windows|recovery|config\.msi|perflogs|\$winreagent|programdata)$/i;
const UNINSTALL = ['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'];
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const dirs = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; } };
const newest = names => [...names].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
const inFolder = dir => [path.join(dir, 'Support Files', 'AfterFX.exe'), path.join(dir, 'AfterFX.exe')].find(isFile) || null;
const run = (exec, file, args) => { try { return String(exec(file, args, { encoding: 'utf8', windowsHide: true, timeout: 8000 }) || ''); } catch { return ''; } };

function appPaths(exec) {
  for (const root of ['HKLM', 'HKCU']) {
    const out = run(exec, 'reg.exe', ['query', `${root}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\AfterFX.exe`, '/ve']);
    const value = out.split(/\r?\n/).map(line => line.match(/REG_SZ\s+(.+)$/)?.[1]?.trim().replace(/^"|"$/g, '')).find(Boolean);
    if (value && isFile(value)) return value;
  }
  return null;
}

function running(exec) {
  const out = run(exec, 'powershell.exe', ['-NoProfile', '-Command', '@(Get-Process -Name AfterFX -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique) | ConvertTo-Json -Compress']);
  try {
    const paths = JSON.parse(out || '[]');
    const found = (Array.isArray(paths) ? paths : [paths]).filter(x => typeof x === 'string' && isFile(x));
    return found.length === 1 ? found[0] : null;
  } catch { return null; }
}

/** `reg query` text → [{key, values: {name: data}}]. */
function regBlocks(text) {
  const blocks = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) blocks.push({ key: line.trim(), values: {} });
    else {
      const m = line.match(/^\s+(\S.*?)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/);
      if (m && blocks.length) blocks.at(-1).values[m[1]] = m[2].trim();
    }
  }
  return blocks;
}

function uninstallEntries(exec) {
  const found = [];
  for (const root of UNINSTALL) {
    for (const hit of regBlocks(run(exec, 'reg.exe', ['query', root, '/s', '/f', 'After Effects', '/d']))) {
      const entry = regBlocks(run(exec, 'reg.exe', ['query', hit.key]))[0] || hit;
      const v = entry.values;
      if (!/after effects/i.test(v.DisplayName || '') || /render engine/i.test(v.DisplayName || '')) continue;
      const icon = String(v.DisplayIcon || '').replace(/^"|"$/g, '').replace(/,\s*-?\d+$/, '');
      const exe = (/afterfx\.exe$/i.test(icon) && isFile(icon) && icon) || (v.InstallLocation && inFolder(v.InstallLocation.replace(/^"|"$/g, '')));
      if (exe) found.push({ name: v.DisplayName, exe });
    }
  }
  return found.sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }))[0]?.exe || null;
}

function fixedDrives(exec) {
  const out = run(exec, 'powershell.exe', ['-NoProfile', '-Command', "@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object -ExpandProperty DeviceID) | ConvertTo-Json -Compress"]);
  try {
    const ids = JSON.parse(out || '[]');
    const list = (Array.isArray(ids) ? ids : [ids]).filter(x => /^[A-Z]:$/i.test(x)).map(x => `${x}\\`);
    if (list.length) return list;
  } catch {}
  return [process.env.SystemDrive ? `${process.env.SystemDrive}\\` : 'C:\\'];
}

/** <root>\Adobe After Effects *, <root>\*\Adobe After Effects * and <root>\*\Adobe\Adobe After Effects *. */
function scanRoot(root) {
  const top = dirs(root).filter(n => !SKIP.test(n));
  const hits = newest(top.filter(n => AE_DIR.test(n))).map(n => path.join(root, n));
  for (const n of top.filter(n => !AE_DIR.test(n))) {
    const sub = path.join(root, n);
    const names = dirs(sub);
    hits.push(...newest(names.filter(x => AE_DIR.test(x))).map(x => path.join(sub, x)));
    if (names.some(x => /^adobe$/i.test(x))) hits.push(...newest(dirs(path.join(sub, 'Adobe')).filter(x => AE_DIR.test(x))).map(x => path.join(sub, 'Adobe', x)));
  }
  for (const dir of hits) { const exe = inFolder(dir); if (exe) return exe; }
  return null;
}

const cacheFile = env => path.join(env.YINZI_WORKFLOW_RUNTIME_DIR || path.join(os.homedir(), '.yinzi-media'), 'after-effects.json');
function readCache(env) {
  try { const v = JSON.parse(fs.readFileSync(cacheFile(env), 'utf8')).executable; return typeof v === 'string' && isFile(v) ? v : null; } catch { return null; }
}
function writeCache(env, executable, source) {
  try { fs.mkdirSync(path.dirname(cacheFile(env)), { recursive: true }); fs.writeFileSync(cacheFile(env), JSON.stringify({ executable, source, found_at: new Date().toISOString() }, null, 2)); } catch {}
}

/** @param {{exec?: typeof execFileSync, drives?: () => string[]}} deps */
function locateWindows(env = process.env, { exec = execFileSync, drives } = {}) {
  const quick = appPaths(exec) || running(exec);
  if (quick) return quick;
  const cached = readCache(env);
  if (cached) return cached;
  let exe = uninstallEntries(exec);
  let source = 'uninstall_registry';
  if (!exe) {
    source = 'drive_scan';
    for (const root of (drives ? drives() : fixedDrives(exec))) if ((exe = scanRoot(root))) break;
  }
  if (exe) writeCache(env, exe, source);
  return exe || null;
}

module.exports = { locateWindows, regBlocks, scanRoot, cacheFile };
