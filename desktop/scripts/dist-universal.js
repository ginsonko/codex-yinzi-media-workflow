'use strict';

process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://cdn.npmmirror.com/binaries/electron-builder-binaries/';

const { spawnSync } = require('child_process');
const path = require('path');
const isWin = process.platform === 'win32';
const cwd = path.join(__dirname, '..');

const args = ['run', 'dist:universal:inner'];
const result = spawnSync(isWin ? 'npm.cmd' : 'npm', args, { stdio: 'inherit', shell: isWin, cwd });
if (result.status !== 0) process.exit(result.status || 1);
