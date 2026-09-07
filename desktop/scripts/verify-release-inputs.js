'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const desktopDir = path.join(__dirname, '..');
const repoRoot = path.join(desktopDir, '..');
const required = [
  'main.js',
  'runtime.js',
  'backend-app/src/app.js',
  'frontweb-dist/index.html',
  'build/icon.ico',
  'LICENSE.txt',
  'THIRD_PARTY_NOTICES.txt',
  'release-docs/小白使用说明.md',
  'release-docs/通用版-老李兼容小白说明.md',
  'release-docs/发布说明.md',
  'frontweb-dist/demo/director-preview.mp4',
  'frontweb-dist/demo/test-shot-1.mp4',
  'frontweb-dist/demo/test-shot-2.mp4',
  'frontweb-dist/demo/test-shot-3.mp4',
  'frontweb-dist/demo/test-final-film.mp4',
];

for (const relative of required) {
  const file = path.join(desktopDir, relative);
  if (!fs.existsSync(file)) throw new Error(`发布输入缺失：desktop/${relative}`);
  if (fs.statSync(file).isFile() && fs.statSync(file).size === 0) {
    throw new Error(`发布输入为空：desktop/${relative}`);
  }
}

for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
  const file = path.join(repoRoot, 'backend-node', 'tools', 'ffmpeg', name);
  const result = spawnSync(file, ['-version'], { windowsHide: true, timeout: 10000, stdio: 'ignore' });
  if (result.status !== 0) throw new Error(`发布输入不可执行：${file}`);
}

const scanRoots = [
  path.join(desktopDir, 'backend-app'),
  path.join(desktopDir, 'frontweb-dist'),
  path.join(desktopDir, 'release-docs'),
  path.join(desktopDir, 'main.js'),
  path.join(desktopDir, 'runtime.js'),
];
const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/gi,
];
const allowedExtensions = new Set(['.js', '.json', '.yaml', '.yml', '.html', '.css', '.md', '.txt', '.svg']);

function walk(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => (
    walk(path.join(target, entry.name))
  ));
}

for (const file of scanRoots.flatMap(walk)) {
  if (!allowedExtensions.has(path.extname(file).toLowerCase())) continue;
  const value = fs.readFileSync(file, 'utf8');
  for (const pattern of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) throw new Error(`发布输入疑似包含凭据：${file}`);
  }
}

console.log('[release] 发布输入、媒体工具、说明书与凭据扫描通过。');
