const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discover } = require('../src/services/afterEffectsJob');
const { regBlocks, scanRoot, cacheFile } = require('../src/services/afterEffectsLocate');

function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-ae-locate-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function install(dir) { const exe = path.join(dir, 'Support Files', 'AfterFX.exe'); fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, 'fixture'); return exe; }
const UNINSTALL_KEY = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AEFT_26_0';

test('the Adobe uninstall entry finds AE in a custom folder and the find is cached', t => {
  const dir = temporary(t), runtime = path.join(dir, 'runtime');
  const exe = install(path.join(dir, 'AE', 'Adobe After Effects 2026'));
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, ...args].join(' '));
    if (file === 'reg.exe' && args.includes('/f') && args[1].startsWith('HKLM\\SOFTWARE\\Microsoft')) return `\r\n${UNINSTALL_KEY}\r\n    DisplayName    REG_SZ    Adobe After Effects 2026\r\n\r\nEnd of search: 1 match(es) found.\r\n`;
    if (file === 'reg.exe' && args[1] === UNINSTALL_KEY) return `\r\n${UNINSTALL_KEY}\r\n    DisplayName    REG_SZ    Adobe After Effects 2026\r\n    InstallLocation    REG_SZ    ${path.join(dir, 'AE', 'Adobe After Effects 2026')}\r\n    DisplayVersion    REG_SZ    26.0\r\n`;
    if (file === 'reg.exe') throw Object.assign(new Error('not found'), { status: 1 });
    return '';
  };
  assert.equal(discover({ YINZI_WORKFLOW_RUNTIME_DIR: runtime }, 'win32', { exec, drives: () => [] }), exe);
  assert.ok(calls.some(c => /App Paths/.test(c)), 'App Paths still asked first');
  assert.ok(calls.some(c => /Get-Process -Name AfterFX/.test(c)), 'a running AE still counts');
  const cached = JSON.parse(fs.readFileSync(cacheFile({ YINZI_WORKFLOW_RUNTIME_DIR: runtime }), 'utf8'));
  assert.deepEqual([cached.executable, cached.source], [exe, 'uninstall_registry']);
  assert.equal(discover({ YINZI_WORKFLOW_RUNTIME_DIR: runtime }, 'win32', { exec: () => '', drives: () => { throw new Error('no scan with a cache'); } }), exe);
});

test('one level below each fixed drive: E:\\AE\\Adobe After Effects 2026 and E:\\Adobe After Effects 2025', t => {
  const dir = temporary(t), runtime = path.join(dir, 'runtime'), drive = path.join(dir, 'E');
  const nested = install(path.join(drive, 'AE', 'Adobe After Effects 2026'));
  assert.equal(discover({ YINZI_WORKFLOW_RUNTIME_DIR: runtime }, 'win32', { exec: () => '', drives: () => [path.join(dir, 'D'), drive] }), nested);
  assert.equal(JSON.parse(fs.readFileSync(cacheFile({ YINZI_WORKFLOW_RUNTIME_DIR: runtime }), 'utf8')).source, 'drive_scan');
  const top = install(path.join(drive, 'Adobe After Effects 2025'));
  assert.equal(scanRoot(drive), top, 'a folder right at the drive root comes first');
  const other = path.join(dir, 'F');
  const deep = install(path.join(other, 'Software', 'Adobe', 'Adobe After Effects 2024'));
  assert.equal(scanRoot(other), deep);
  fs.mkdirSync(path.join(dir, 'G', 'Windows', 'Adobe After Effects 2023'), { recursive: true });
  assert.equal(scanRoot(path.join(dir, 'G')), null, 'system folders and folders without AfterFX.exe are skipped');
});

test('a running AE wins over the cache; a configured path wins over everything', t => {
  const dir = temporary(t), runtime = path.join(dir, 'runtime');
  const old = install(path.join(dir, 'old', 'Adobe After Effects 2024'));
  const live = install(path.join(dir, 'live', 'Adobe After Effects 2026'));
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(cacheFile({ YINZI_WORKFLOW_RUNTIME_DIR: runtime }), JSON.stringify({ executable: old }));
  const exec = (file, args) => (file === 'powershell.exe' && /Get-Process/.test(args.join(' ')) ? JSON.stringify(live) : '');
  assert.equal(discover({ YINZI_WORKFLOW_RUNTIME_DIR: runtime }, 'win32', { exec, drives: () => [] }), live);
  assert.equal(discover({ YINZI_WORKFLOW_RUNTIME_DIR: runtime }, 'win32', { exec: () => '', drives: () => [] }), old);
  assert.equal(discover({ YINZI_WORKFLOW_RUNTIME_DIR: runtime, YINZI_AFTERFX_PATH: live }, 'win32', { exec, drives: () => [] }), live);
  assert.equal(discover({ YINZI_WORKFLOW_RUNTIME_DIR: runtime, YINZI_AFTERFX_PATH: path.join(dir, 'missing.exe') }, 'win32', { exec, drives: () => [] }), null, 'a wrong manual path is reported, not guessed around');
});

test('reg query output is read into keys and values', () => {
  const blocks = regBlocks(`\r\n${UNINSTALL_KEY}\r\n    DisplayName    REG_SZ    Adobe After Effects 2026\r\n    DisplayIcon    REG_EXPAND_SZ    "E:\\AE\\Adobe After Effects 2026\\Support Files\\AfterFX.exe",0\r\n`);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].values.DisplayName, 'Adobe After Effects 2026');
  assert.match(blocks[0].values.DisplayIcon, /AfterFX\.exe",0$/);
});
