const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const service = require('../src/services/desktopShortcutService');

describe('desktop shortcut contract', () => {
  const saved = {};
  beforeEach(() => {
    for (const key of ['YINZI_DESKTOP_DIR', 'YINZI_WORKFLOW_PROJECT_ROOT', 'YINZI_WORKFLOW_SHORTCUT_TARGET', 'YINZI_WORKFLOW_SHORTCUT_ARGS', 'WEB_DIST_PATH']) saved[key] = process.env[key];
  });
  afterEach(() => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('resolves an installed source launcher without accepting caller paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-shortcut-'));
    fs.writeFileSync(path.join(root, 'start-ai-video-demo.cmd'), '@echo off\n', 'utf8');
    process.env.YINZI_WORKFLOW_PROJECT_ROOT = root;
    delete process.env.YINZI_WORKFLOW_SHORTCUT_TARGET;
    const target = service.resolveShortcutTarget();
    assert.equal(target.target, process.env.ComSpec || 'cmd.exe');
    assert.match(target.arguments, /start-ai-video-demo\.cmd/);
    assert.equal(target.workingDirectory, root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('uses the packaged executable target when the desktop runtime provides one', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-shortcut-exe-'));
    const executable = path.join(root, 'YinziWorkflow.exe');
    fs.writeFileSync(executable, 'stub', 'utf8');
    process.env.YINZI_WORKFLOW_SHORTCUT_TARGET = executable;
    process.env.YINZI_WORKFLOW_SHORTCUT_ARGS = '--yinzi-open';
    const target = service.resolveShortcutTarget();
    assert.equal(target.target, executable);
    assert.equal(target.arguments, '--yinzi-open');
    assert.equal(target.workingDirectory, root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports a clear non-Windows fallback without touching the filesystem', () => {
    assert.throws(() => service.createWindowsShortcut({ platform: 'linux', desktopDir: path.join(os.tmpdir(), 'should-not-exist') }), (error) => error.code === 'SHORTCUT_WINDOWS_ONLY');
  });
});
