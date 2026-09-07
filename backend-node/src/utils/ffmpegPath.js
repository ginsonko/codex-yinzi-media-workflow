/**
 * 解析 ffmpeg / ffprobe 可执行路径。查找优先级：
 * 1. 环境变量 FFMPEG_PATH / FFPROBE_PATH
 * 2. process.cwd()/tools/ffmpeg/  ← 打包后 cwd = userData/backend，用户可在此放置 ffmpeg
 * 3. exe 同级目录/tools/ffmpeg/   ← 用户把 ffmpeg 放在 exe 旁边的 tools/ffmpeg 目录
 * 4. exe 同级目录（直接放在 exe 旁边）
 * 5. 源码目录 backend-node/tools/ffmpeg/（开发时）
 * 6. 系统 PATH 中的 ffmpeg（兜底）
 */
const path = require('path');
const fs = require('fs');

const isWin = process.platform === 'win32';
const ffmpegName = isWin ? 'ffmpeg.exe' : 'ffmpeg';
const ffprobeName = isWin ? 'ffprobe.exe' : 'ffprobe';

/** backend-node 根目录（源码开发时有效；打包后指向 asar 内部，仅作兜底） */
const backendRoot = path.resolve(__dirname, '..', '..');
const toolsFfmpegDir = path.join(backendRoot, 'tools', 'ffmpeg');

function discoverProgramFilesBins(name, roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
  const candidates = [];
  for (const root of [...new Set(roots.filter(Boolean))]) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^ffmpeg(?:[-_].*)?$/i.test(entry.name)) continue;
        candidates.push(path.join(root, entry.name, 'bin', name));
      }
    } catch (_) {}
  }
  return candidates;
}

/**
 * 返回所有候选查找路径（按优先级排列，不含环境变量）。
 * 打包后 process.cwd() = userData/backend；process.execPath = 实际 exe 路径。
 */
function getCandidatePaths(name) {
  const candidates = [];
  // cwd/tools/ffmpeg — 打包后为 userData/backend/tools/ffmpeg，用户可在此放置 ffmpeg
  candidates.push(path.join(process.cwd(), 'tools', 'ffmpeg', name));
  // exe 同级/tools/ffmpeg — 用户把 ffmpeg 放在 exe 旁边的 tools/ffmpeg 目录
  try {
    const exeDir = path.dirname(process.execPath);
    candidates.push(path.join(exeDir, 'tools', 'ffmpeg', name));
    // exe 同级直接放
    candidates.push(path.join(exeDir, name));
  } catch (_) {}
  // 源码目录（开发时）
  candidates.push(path.join(toolsFfmpegDir, name));
  if (isWin) candidates.push(...discoverProgramFilesBins(name));
  return candidates;
}

function resolveFfmpegBin(name) {
  const fromEnv = process.env[name === ffmpegName ? 'FFMPEG_PATH' : 'FFPROBE_PATH'];
  if (fromEnv && isPlausibleBinaryFile(fromEnv)) return fromEnv;
  for (const p of getCandidatePaths(name)) {
    if (isPlausibleBinaryFile(p)) return p;
  }
  return name; // 兜底：依赖系统 PATH
}

function isPlausibleBinaryFile(filePath, minBytes = 1024 * 1024) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile() && fs.statSync(filePath).size >= minBytes;
  } catch (_) {
    return false;
  }
}

function canExecuteVersion(filePath) {
  try {
    const { spawnSync } = require('child_process');
    const res = spawnSync(filePath, ['-version'], { windowsHide: true, timeout: 10000 });
    return res.status === 0;
  } catch (_) {
    return false;
  }
}

/**
 * 返回 ffmpeg 可执行路径（用于 spawn/exec）。
 */
function getFfmpegPath() {
  return resolveFfmpegBin(ffmpegName);
}

/**
 * 返回 ffprobe 可执行路径。
 */
function getFfprobePath() {
  return resolveFfmpegBin(ffprobeName);
}

/**
 * 是否能找到本地 ffmpeg（找到任意候选路径、环境变量或系统 PATH 中存在即为 true）。
 */
function hasLocalFfmpeg() {
  return canExecuteVersion(getFfmpegPath());
}

function hasLocalFfprobe() {
  return canExecuteVersion(getFfprobePath());
}

module.exports = {
  getFfmpegPath,
  getFfprobePath,
  hasLocalFfmpeg,
  hasLocalFfprobe,
  toolsFfmpegDir,
  discoverProgramFilesBins,
  isPlausibleBinaryFile,
};
