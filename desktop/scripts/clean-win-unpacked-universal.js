'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const unpackedDir = path.join(__dirname, '..', 'release-universal', 'win-unpacked');

if (process.platform === 'win32') {
  for (const name of ['银子AI视频工作流-通用版-老李兼容.exe']) {
    spawnSync('taskkill', ['/F', '/IM', name, '/T'], { stdio: 'ignore', shell: true });
  }
  try {
    execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like \'*release-universal*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"', { stdio: 'ignore', timeout: 15000 });
  } catch (_) {}
}

if (!fs.existsSync(unpackedDir)) {
  console.log('[clean-universal] release-universal/win-unpacked not found, skip');
  process.exit(0);
}

try {
  fs.rmSync(unpackedDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  console.log('[clean-universal] release-universal/win-unpacked removed');
} catch (error) {
  const stale = `${unpackedDir}.stale-${Date.now()}`;
  try {
    fs.renameSync(unpackedDir, stale);
    console.log(`[clean-universal] locked directory preserved as ${path.basename(stale)}`);
  } catch (renameError) {
    console.error(`[clean-universal] failed: ${error.message}`);
    process.exit(1);
  }
}
