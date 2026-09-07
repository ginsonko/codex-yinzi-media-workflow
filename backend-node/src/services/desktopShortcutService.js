'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SHORTCUT_NAME = '银子媒体工作流.lnk';
const SHORTCUT_DESCRIPTION = '启动银子媒体工作流并打开当前工作台';

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function resolveDesktopDir() {
  const configured = process.env.YINZI_DESKTOP_DIR;
  if (configured) return path.resolve(configured);
  const profile = process.env.USERPROFILE || os.homedir();
  return path.join(profile, 'Desktop');
}

function resolveSourceRoot() {
  const explicit = process.env.YINZI_WORKFLOW_PROJECT_ROOT;
  if (explicit) return path.resolve(explicit);
  const dist = process.env.WEB_DIST_PATH;
  if (dist) return path.resolve(dist, '..', '..');
  return null;
}

function resolveShortcutTarget() {
  const explicit = process.env.YINZI_WORKFLOW_SHORTCUT_TARGET;
  if (explicit) {
    const target = path.resolve(explicit);
    if (!fs.existsSync(target)) throw Object.assign(new Error('桌面快捷方式目标不存在'), { code: 'SHORTCUT_TARGET_MISSING' });
    return {
      target,
      arguments: process.env.YINZI_WORKFLOW_SHORTCUT_ARGS || '--yinzi-open',
      workingDirectory: path.dirname(target),
    };
  }

  const sourceRoot = resolveSourceRoot();
  const launcher = sourceRoot && path.join(sourceRoot, 'start-ai-video-demo.cmd');
  if (!launcher || !fs.existsSync(launcher)) {
    throw Object.assign(new Error('未找到工作流启动器，请重新运行安装脚本'), { code: 'SHORTCUT_LAUNCHER_MISSING' });
  }
  return {
    target: process.env.ComSpec || 'cmd.exe',
    arguments: `/d /c "${launcher.replace(/"/g, '""')}"`,
    workingDirectory: sourceRoot,
  };
}

function resolveIconPath(target) {
  const sourceRoot = resolveSourceRoot();
  const candidates = [
    process.env.YINZI_WORKFLOW_SHORTCUT_ICON,
    sourceRoot && path.join(sourceRoot, 'desktop', 'assets', 'yinzi-workflow.ico'),
    sourceRoot && path.join(sourceRoot, 'desktop', 'build', 'icon.ico'),
  ].filter(Boolean).map((item) => path.resolve(item));
  return candidates.find((item) => fs.existsSync(item)) || (target && fs.existsSync(target) ? target : null);
}

function createWindowsShortcut({ desktopDir = resolveDesktopDir(), platform = process.platform } = {}) {
  if (platform !== 'win32') {
    throw Object.assign(new Error('桌面快捷方式目前只支持 Windows'), { code: 'SHORTCUT_WINDOWS_ONLY' });
  }
  const destination = path.resolve(desktopDir, SHORTCUT_NAME);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const target = resolveShortcutTarget();
  const icon = resolveIconPath(target.target);
  const script = [
    '$shell = New-Object -ComObject WScript.Shell',
    `$shortcut = $shell.CreateShortcut(${psQuote(destination)})`,
    `$shortcut.TargetPath = ${psQuote(target.target)}`,
    `$shortcut.Arguments = ${psQuote(target.arguments)}`,
    `$shortcut.WorkingDirectory = ${psQuote(target.workingDirectory)}`,
    `$shortcut.Description = ${psQuote(SHORTCUT_DESCRIPTION)}`,
    icon ? `$shortcut.IconLocation = ${psQuote(`${icon},0`)}` : '',
    '$shortcut.Save()',
  ].filter(Boolean).join('; ');

  try {
    execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw Object.assign(new Error(`创建桌面快捷方式失败：${error.message}`), { code: 'SHORTCUT_CREATE_FAILED', cause: error });
  }
  return {
    created: true,
    path: destination,
    target: target.target,
    arguments: target.arguments,
    icon: icon || null,
  };
}

module.exports = {
  SHORTCUT_NAME,
  resolveDesktopDir,
  resolveSourceRoot,
  resolveShortcutTarget,
  createWindowsShortcut,
};
