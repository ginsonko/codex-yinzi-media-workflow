'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ARCHES = Object.freeze(['x64', 'arm64']);
const MACHO_CPU_TYPES = Object.freeze({ x64: 0x01000007, arm64: 0x0100000c });
const SECRET_PATTERNS = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/gi,
]);
const OPTIONAL_MAC_SIGNING_ENV = Object.freeze([
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_NAME',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
]);

const MAC_VARIANTS = Object.freeze({
  yinzi: Object.freeze({
    id: 'yinzi',
    config: 'electron-builder-mac-v012.json',
    output: 'release-mac',
    productName: '银子AI视频工作流',
    appId: 'top.yinziapi.ai-video-workflow',
  }),
  universal: Object.freeze({
    id: 'universal',
    config: 'electron-builder-mac-universal.json',
    output: 'release-mac-universal',
    productName: '银子AI视频工作流-通用版-老李兼容',
    appId: 'top.yinziapi.ai-video-workflow.universal',
  }),
});

function resolveMacVariant(value = process.env.AI_VIDEO_MAC_VARIANT || 'yinzi') {
  const variant = MAC_VARIANTS[value];
  if (!variant) throw new Error(`不支持的 Mac 发行版：${value || '(empty)'}`);
  return variant;
}

function assertArch(value) {
  if (!ARCHES.includes(value)) throw new Error(`不支持的 Mac 架构：${value || '(empty)'}`);
  return value;
}

function npmExecutable(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function normalizeMacSigningEnvironment(source = {}) {
  const environment = { ...source };
  for (const key of OPTIONAL_MAC_SIGNING_ENV) {
    if (typeof environment[key] === 'string' && environment[key].trim() === '') {
      delete environment[key];
    }
  }
  const hasSigningIdentity = Boolean(environment.CSC_LINK || environment.CSC_NAME);
  environment.CSC_IDENTITY_AUTO_DISCOVERY = hasSigningIdentity
    ? (environment.CSC_IDENTITY_AUTO_DISCOVERY || 'true')
    : 'false';
  return environment;
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function readMachO(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(32);
    const bytes = fs.readSync(descriptor, header, 0, header.length, 0);
    if (bytes < 8) throw new Error(`Mach-O 文件头过短：${filePath}`);
    const magic = header.readUInt32LE(0);
    if (magic !== 0xfeedfacf && magic !== 0xfeedface) {
      throw new Error(`不是 thin Mach-O 可执行文件：${filePath}`);
    }
    const cpuType = header.readUInt32LE(4);
    const arch = Object.entries(MACHO_CPU_TYPES).find(([, value]) => value === cpuType)?.[0] || 'unknown';
    return { magic, cpuType, arch };
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertMachOArch(filePath, arch) {
  const actual = readMachO(filePath).arch;
  if (actual !== arch) throw new Error(`Mach-O 架构错误：${filePath}，期望 ${arch}，实际 ${actual}`);
  return actual;
}

function binaryContains(filePath, needle) {
  return fs.readFileSync(filePath).indexOf(Buffer.from(needle, 'latin1')) >= 0;
}

function copyFile(source, destination, mode = null) {
  ensureDirectory(path.dirname(destination));
  fs.copyFileSync(source, destination);
  if (mode != null) fs.chmodSync(destination, mode);
  return destination;
}

function walkFiles(target) {
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => (
    walkFiles(path.join(target, entry.name))
  ));
}

function assertNoSecrets(targets, extensions = null) {
  for (const filePath of targets.flatMap(walkFiles)) {
    if (extensions && !extensions.has(path.extname(filePath).toLowerCase())) continue;
    const value = fs.readFileSync(filePath, 'utf8');
    for (const pattern of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(value)) throw new Error(`疑似凭据进入 Mac 构建输入：${filePath}`);
    }
  }
}

module.exports = {
  ARCHES,
  MAC_VARIANTS,
  SECRET_PATTERNS,
  assertArch,
  assertMachOArch,
  assertNoSecrets,
  binaryContains,
  copyFile,
  ensureDirectory,
  normalizeMacSigningEnvironment,
  npmExecutable,
  readMachO,
  resolveMacVariant,
  sha256,
  walkFiles,
};
