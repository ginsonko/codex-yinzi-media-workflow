'use strict';

/**
 * Prepare and verify the native macOS media tools used by both test packages.
 * The script intentionally keeps source archives outside the release tree and
 * records provenance in each architecture's resource directory.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const tar = require('tar');
const {
  ARCHES,
  assertArch,
  assertMachOArch,
  binaryContains,
  copyFile,
  ensureDirectory,
  npmExecutable,
  sha256,
} = require('./mac-build-utils');

const desktopDir = path.join(__dirname, '..');
const cacheDir = path.join(desktopDir, 'mac-build-cache');
const workDir = path.join(desktopDir, 'mac-build-work', 'resource-extract');
const outputDir = path.join(desktopDir, 'mac-resources');
const ffmpegLicense = path.join(desktopDir, '..', 'backend-node', 'tools', 'ffmpeg', 'LICENSE-FFMPEG-GPLv3.txt');
const releaseVersion = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8')).version;
const lgplLicense = path.join(desktopDir, 'licenses', 'LICENSE-LGPL-2.1.txt');

const packages = {
  x64: {
    ffmpeg: {
      archive: 'ffmpeg-static-electron-v5-darwin-x64-5.2.5.tgz',
      binary: ['package', 'bin', 'darwin', 'x64', 'ffmpeg'],
      source: 'ffmpeg-static-electron-v5-darwin-x64@5.2.5',
      registry: 'https://registry.npmmirror.com/ffmpeg-static-electron-v5-darwin-x64/-/ffmpeg-static-electron-v5-darwin-x64-5.2.5.tgz',
    },
    ffprobe: {
      archive: 'ffprobe-installer-darwin-x64-5.1.0.tgz',
      binary: ['package', 'ffprobe'],
      source: '@ffprobe-installer/darwin-x64@5.1.0',
      registry: 'https://registry.npmmirror.com/@ffprobe-installer/darwin-x64/-/darwin-x64-5.1.0.tgz',
    },
    ffprobeLicense: 'GPL-3.0',
  },
  arm64: {
    ffmpeg: {
      archive: 'ffmpeg-static-electron-v5-darwin-arm64-5.2.5.tgz',
      binary: ['package', 'bin', 'darwin', 'arm64', 'ffmpeg'],
      source: 'ffmpeg-static-electron-v5-darwin-arm64@5.2.5',
      registry: 'https://registry.npmmirror.com/ffmpeg-static-electron-v5-darwin-arm64/-/ffmpeg-static-electron-v5-darwin-arm64-5.2.5.tgz',
    },
    ffprobe: {
      archive: 'ffprobe-installer-darwin-arm64-5.0.1.tgz',
      binary: ['package', 'ffprobe'],
      source: '@ffprobe-installer/darwin-arm64@5.0.1',
      registry: 'https://registry.npmmirror.com/@ffprobe-installer/darwin-arm64/-/darwin-arm64-5.0.1.tgz',
    },
    ffprobeLicense: 'LGPL-2.1',
  },
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: desktopDir,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    timeout: options.timeout || 180000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 失败：${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  return result.stdout || '';
}

function ensureArchive(spec) {
  const archive = path.join(cacheDir, spec.archive);
  if (fs.existsSync(archive) && fs.statSync(archive).size > 1000) return archive;
  ensureDirectory(cacheDir);
  run(npmExecutable(), ['pack', spec.source, '--pack-destination', cacheDir], { timeout: 180000 });
  if (!fs.existsSync(archive)) throw new Error(`npm pack 未生成预期资源：${archive}`);
  return archive;
}

async function extractMember(archive, member, label) {
  const destination = path.join(workDir, label);
  fs.rmSync(destination, { recursive: true, force: true });
  ensureDirectory(destination);
  await tar.x({ file: archive, cwd: destination });
  const memberPath = path.join(destination, ...member);
  if (!fs.existsSync(memberPath)) throw new Error(`归档中缺少 ${member.join('/')}：${archive}`);
  return memberPath;
}

function checkFfmpegCapabilities(filePath, label) {
  const required = ['--enable-gpl', '--enable-libx264', '--enable-libmp3lame', 'drawtext', 'subtitles', 'amix', 'atempo'];
  const binary = fs.readFileSync(filePath).toString('latin1');
  if (binary.includes('--enable-nonfree')) throw new Error(`${label} 含 nonfree 构建标记，不允许进入发行包`);
  for (const token of required) {
    if (!binary.includes(token)) throw new Error(`${label} 缺少能力标记：${token}`);
  }
}

function checkFfprobeCapabilities(filePath, label) {
  const required = ['ffprobe', 'show_streams', 'show_format', 'print_format'];
  const binary = fs.readFileSync(filePath).toString('latin1');
  if (binary.includes('--enable-nonfree')) throw new Error(`${label} 含 nonfree 构建标记，不允许进入发行包`);
  for (const token of required) {
    if (!binary.includes(token)) throw new Error(`${label} 缺少探测能力标记：${token}`);
  }
}

function copyLicense(output, arch, licenseName) {
  if (!fs.existsSync(ffmpegLicense)) throw new Error(`缺少 FFmpeg GPL 许可证：${ffmpegLicense}`);
  copyFile(ffmpegLicense, path.join(output, 'LICENSE-FFMPEG-GPLv3.txt'));
  if (licenseName === 'LGPL-2.1') {
    if (!fs.existsSync(lgplLicense)) throw new Error(`缺少 LGPL 许可证：${lgplLicense}`);
    copyFile(lgplLicense, path.join(output, 'LICENSE-FFPROBE-LGPL-2.1.txt'));
  } else {
    copyFile(ffmpegLicense, path.join(output, 'LICENSE-FFPROBE-GPLv3.txt'));
  }
  fs.writeFileSync(path.join(output, 'README-MEDIA-TOOLS.txt'), [
    '银子AI视频工作流 macOS 媒体工具',
    `目标架构：${arch}`,
    'FFmpeg/FFprobe 均为独立的 macOS Mach-O 原生二进制。',
    '首次启动时复制到用户数据目录并设置 0755 执行权限。',
    '请同时阅读本目录中的许可证与项目发行说明。',
    '',
  ].join('\n'), 'utf8');
}

async function prepareArch(arch) {
  const spec = packages[assertArch(arch)];
  const ffmpegArchive = ensureArchive(spec.ffmpeg);
  const ffprobeArchive = ensureArchive(spec.ffprobe);
  const ffmpeg = await extractMember(ffmpegArchive, spec.ffmpeg.binary, `${arch}-ffmpeg`);
  const ffprobe = await extractMember(ffprobeArchive, spec.ffprobe.binary, `${arch}-ffprobe`);
  const output = path.join(outputDir, arch, 'ffmpeg');
  fs.rmSync(output, { recursive: true, force: true });
  ensureDirectory(output);
  assertMachOArch(ffmpeg, arch);
  assertMachOArch(ffprobe, arch);
  checkFfmpegCapabilities(ffmpeg, `FFmpeg ${arch}`);
  checkFfprobeCapabilities(ffprobe, `FFprobe ${arch}`);
  copyFile(ffmpeg, path.join(output, 'ffmpeg'), 0o755);
  copyFile(ffprobe, path.join(output, 'ffprobe'), 0o755);
  copyLicense(output, arch, spec.ffprobeLicense);
  const manifest = {
    schema_version: 1,
    product: '银子AI视频工作流',
    version: releaseVersion,
    platform: 'darwin',
    arch,
    generated_at: new Date().toISOString(),
    tools: {
      ffmpeg: {
        source: spec.ffmpeg.source,
        registry: spec.ffmpeg.registry,
        archive_sha256: sha256(ffmpegArchive),
        binary_sha256: sha256(path.join(output, 'ffmpeg')),
        mach_o_arch: arch,
        license: 'GPL-3.0-or-later (binary build; see included license)',
      },
      ffprobe: {
        source: spec.ffprobe.source,
        registry: spec.ffprobe.registry,
        archive_sha256: sha256(ffprobeArchive),
        binary_sha256: sha256(path.join(output, 'ffprobe')),
        mach_o_arch: arch,
        package_license: spec.ffprobeLicense,
      },
    },
  };
  fs.writeFileSync(path.join(output, 'MEDIA-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

(async () => {
  const requested = process.argv.slice(2);
  const arches = requested.length ? requested.map(assertArch) : ARCHES;
  const manifests = [];
  for (const arch of arches) manifests.push(await prepareArch(arch));
  fs.writeFileSync(path.join(outputDir, 'MEDIA-MANIFEST.json'), `${JSON.stringify({ schema_version: 1, manifests }, null, 2)}\n`, 'utf8');
  console.log(`[mac-media] 已准备：${arches.join(', ')}`);
})().catch((error) => {
  console.error(`[mac-media] ${error.stack || error.message}`);
  process.exit(1);
});
