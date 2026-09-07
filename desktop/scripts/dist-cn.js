process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://cdn.npmmirror.com/binaries/electron-builder-binaries/';

const { spawnSync } = require('child_process');
const path = require('path');
const isWin = process.platform === 'win32';
const cwd = path.join(__dirname, '..');

console.log('\n========== 构建银子AI视频工作流 Windows x64 安装版与便携版 ==========\n');
const full = spawnSync(isWin ? 'npm.cmd' : 'npm', ['run', 'dist'], {
  stdio: 'inherit',
  shell: isWin,
  cwd,
});
if (full.status !== 0) {
  console.error('Windows 发布包构建失败，终止。');
  process.exit(full.status || 1);
}

console.log('\n========== 构建完成 ==========');
console.log('输出目录：release/');
console.log('  安装版：银子AI视频工作流-Setup-x.x.x-x64.exe');
console.log('  便携版：银子AI视频工作流-Portable-x.x.x-x64.exe\n');
process.exit(0);
