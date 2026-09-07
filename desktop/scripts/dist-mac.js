'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  assertArch,
  ensureDirectory,
  normalizeMacSigningEnvironment,
  resolveMacVariant,
} = require('./mac-build-utils');

const desktopDir = path.join(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || desktopDir,
    env: normalizeMacSigningEnvironment({ ...process.env, ...options.env }),
    stdio: 'inherit',
    timeout: options.timeout || 45 * 60 * 1000,
  });
  if (result.error || result.status !== 0) {
    throw result.error || new Error(`${command} ${args.join(' ')} 失败：exit ${result.status}`);
  }
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function artifactPath(variant, arch, extension) {
  return path.join(
    desktopDir,
    variant.output,
    `${variant.productName}-${packageJson.version}-mac-${arch}.${extension}`
  );
}

function assertNativeRunner(arch) {
  if (process.platform !== 'darwin') {
    throw new Error('正式 macOS 安装包必须在真实 macOS runner 或 Mac 设备上原生构建；Windows 手工重打包已停用。');
  }
  if (process.arch !== arch) {
    throw new Error(`当前 runner 是 ${process.arch}，不能冒充 ${arch} 原生构建。请使用对应架构的 macOS runner。`);
  }
}

function prepareInputs(arch, variant) {
  run('npm', ['run', 'prepare-backend']);
  run('npm', ['run', 'build:front']);
  run('npm', ['run', 'copy-front']);
  run('npm', ['run', 'prepare:icon']);
  run(process.execPath, ['scripts/prepare-mac-resources.js', arch]);
  run(process.execPath, ['scripts/verify-mac-inputs.js', arch], {
    env: { AI_VIDEO_MAC_VARIANT: variant.id },
  });
}

function rebuildAndProbe(arch) {
  run(process.execPath, [require.resolve('electron-builder/install-app-deps.js'), `--arch=${arch}`]);
  run(require('electron'), ['test/electron-native-probe.js'], { timeout: 5 * 60 * 1000 });
}

function build(arch, variant) {
  const builder = require.resolve('electron-builder/cli.js');
  run(process.execPath, [
    builder,
    '--mac',
    `--${arch}`,
    '--config',
    variant.config,
    '--publish',
    'never',
  ], { timeout: 90 * 60 * 1000 });
}

function writeReceipt(arch, variant) {
  const releaseDir = path.join(desktopDir, variant.output);
  const artifacts = ['dmg', 'zip'].map((extension) => {
    const filePath = artifactPath(variant, arch, extension);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 20 * 1024 * 1024) {
      throw new Error(`${variant.id} macOS ${arch} ${extension.toUpperCase()} 缺失或异常过小：${filePath}`);
    }
    return {
      artifact: path.basename(filePath),
      bytes: fs.statSync(filePath).size,
      sha256: sha256(filePath),
    };
  });
  ensureDirectory(releaseDir);
  const receipt = {
    schema_version: 1,
    variant: variant.id,
    product: variant.productName,
    app_id: variant.appId,
    version: packageJson.version,
    platform: 'darwin',
    arch,
    native_runner: true,
    signing_requested: Boolean(process.env.CSC_LINK || process.env.CSC_NAME),
    notarization_credentials_present: Boolean(
      process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID
    ),
    generated_at: new Date().toISOString(),
    artifacts,
  };
  fs.writeFileSync(
    path.join(releaseDir, `native-mac-build-${arch}.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
    'utf8'
  );
  console.log(`[mac-native] ${variant.id} ${arch} DMG/ZIP 构建完成：${artifacts.map((item) => item.artifact).join(', ')}`);
}

function main() {
  const requested = process.argv[2] || process.env.YINZI_MAC_ARCH || process.arch;
  const arch = assertArch(requested);
  const variant = resolveMacVariant();
  assertNativeRunner(arch);
  ensureDirectory(path.join(desktopDir, variant.output));
  prepareInputs(arch, variant);
  rebuildAndProbe(arch);
  build(arch, variant);
  writeReceipt(arch, variant);
}

try {
  main();
} catch (error) {
  console.error(`[mac-native] ${error.stack || error.message}`);
  process.exit(1);
}
