const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const PRODUCT_NAME = '银子AI视频工作流';
const USER_DATA_DIR_NAME = '银子AI视频工作流';
const MACHO_CPU_TYPES = Object.freeze({
  x64: 0x01000007,
  arm64: 0x0100000c,
});

function resolveAcceptanceRoot({ packaged, execPath, appDir, portableExecutableDir }) {
  const portableDir = String(portableExecutableDir || '').trim();
  if (packaged && portableDir && path.isAbsolute(portableDir)) {
    return path.resolve(portableDir, '..', 'release-acceptance');
  }
  return packaged
    ? path.resolve(path.dirname(execPath), '..', '..', 'release-acceptance')
    : path.resolve(appDir, 'release-acceptance');
}

function resolveAcceptanceAppData({ requested, allowedRoot, fallback }) {
  const value = String(requested || '').trim();
  if (!value || !path.isAbsolute(value)) return fallback;
  const resolved = path.resolve(value);
  const root = path.resolve(allowedRoot || '');
  const prefix = `${root}${path.sep}`;
  return resolved.startsWith(prefix) ? resolved : fallback;
}

function normalizeLocalOrigin(value) {
  try {
    const url = new URL(String(value || '').trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host)) return '';
    if (url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash) return '';
    return url.origin;
  } catch (_) {
    return '';
  }
}

function isSafeExternalUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch (_) {
    return false;
  }
}

function backendHasUserData(rootDir, fileSystem = fs) {
  const backendDir = path.join(rootDir, 'backend');
  const databaseDir = path.join(backendDir, 'data');
  const configPath = path.join(backendDir, 'configs', 'config.yaml');
  try {
    if (fileSystem.existsSync(configPath) && fileSystem.statSync(configPath).size > 0) return true;
    if (!fileSystem.existsSync(databaseDir)) return false;
    return fileSystem.readdirSync(databaseDir, { withFileTypes: true }).some((entry) => (
      entry.isDirectory() || (!entry.name.endsWith('-shm') && !entry.name.endsWith('-wal'))
    ));
  } catch (_) {
    return false;
  }
}

function migrateLegacyUserData({ targetDir, legacyDirs, fileSystem = fs, now = () => new Date() }) {
  if (backendHasUserData(targetDir, fileSystem)) {
    return { status: 'skipped', reason: 'target_has_data', source: null };
  }

  const source = (legacyDirs || []).find((candidate) => (
    candidate
    && path.resolve(candidate) !== path.resolve(targetDir)
    && backendHasUserData(candidate, fileSystem)
  ));
  if (!source) return { status: 'skipped', reason: 'no_legacy_data', source: null };

  const sourceBackend = path.join(source, 'backend');
  const targetBackend = path.join(targetDir, 'backend');
  fileSystem.mkdirSync(targetDir, { recursive: true });
  fileSystem.cpSync(sourceBackend, targetBackend, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
  const receipt = {
    schema_version: 1,
    migrated_at: now().toISOString(),
    source,
    target: targetDir,
    source_retained: true,
  };
  fileSystem.writeFileSync(
    path.join(targetDir, 'legacy-data-migration.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
    'utf8'
  );
  return { status: 'migrated', reason: null, source };
}

function probeExecutable(filePath, args = ['-version'], options = {}) {
  const fileSystem = options.fileSystem || fs;
  const spawn = options.spawn || spawnSync;
  const minBytes = Number(options.minBytes) || 1024 * 1024;
  try {
    if (!fileSystem.existsSync(filePath) || !fileSystem.statSync(filePath).isFile()) return false;
    if (fileSystem.statSync(filePath).size < minBytes) return false;
    const result = spawn(filePath, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: Number(options.timeoutMs) || 10000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return result.status === 0;
  } catch (_) {
    return false;
  }
}

function isMachOExecutableForArch(filePath, arch, fileSystem = fs) {
  const expectedCpuType = MACHO_CPU_TYPES[arch];
  if (!expectedCpuType) return false;
  try {
    const descriptor = fileSystem.openSync(filePath, 'r');
    try {
      const header = Buffer.alloc(8);
      if (fileSystem.readSync(descriptor, header, 0, header.length, 0) !== header.length) return false;
      const magic = header.readUInt32LE(0);
      if (magic !== 0xfeedfacf && magic !== 0xfeedface) return false;
      return header.readUInt32LE(4) === expectedCpuType;
    } finally {
      fileSystem.closeSync(descriptor);
    }
  } catch (_) {
    return false;
  }
}

function copyVerifiedExecutable({
  source,
  destination,
  args = ['-version'],
  fileSystem = fs,
  probe = probeExecutable,
  sourceValidator = (filePath) => probe(filePath, args, { fileSystem }),
  prepareCopy = null,
  replaceExisting = false,
}) {
  if (!sourceValidator(source, { fileSystem, arch: process.arch })) {
    throw new Error(`内置工具不可执行：${source}`);
  }

  const destinationIsValid = probe(destination, args, { fileSystem });
  if (destinationIsValid && !replaceExisting) {
    return { status: 'kept', path: destination };
  }

  fileSystem.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.copying-${process.pid}-${Date.now()}`;
  let preservedExisting = null;
  try {
    fileSystem.copyFileSync(source, temporary);
    prepareCopy?.(temporary, { fileSystem });
    if (!probe(temporary, args, { fileSystem })) {
      throw new Error(`内置工具复制后校验失败：${path.basename(destination)}`);
    }
    if (fileSystem.existsSync(destination)) {
      const suffix = destinationIsValid ? 'previous' : 'invalid';
      preservedExisting = `${destination}.${suffix}-${process.pid}-${Date.now()}`;
      fileSystem.renameSync(destination, preservedExisting);
    }

    try {
      fileSystem.renameSync(temporary, destination);
    } catch (error) {
      if (preservedExisting && !fileSystem.existsSync(destination) && fileSystem.existsSync(preservedExisting)) {
        fileSystem.renameSync(preservedExisting, destination);
        preservedExisting = null;
      }
      throw error;
    }
  } finally {
    try {
      if (fileSystem.existsSync(temporary)) fileSystem.rmSync(temporary, { force: true });
    } catch (_) {}
  }
  return {
    status: preservedExisting ? (destinationIsValid ? 'updated' : 'replaced') : 'copied',
    path: destination,
    ...(preservedExisting && destinationIsValid ? { preservedPrevious: preservedExisting } : {}),
    ...(preservedExisting && !destinationIsValid ? { preservedInvalid: preservedExisting } : {}),
  };
}

function buildMacApplicationMenuTemplate({
  productName = PRODUCT_NAME,
  website = 'https://www.yinziapi.top',
  openExternal = () => {},
} = {}) {
  return [
    {
      label: productName,
      submenu: [
        { role: 'about', label: `关于${productName}` },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出${productName}` },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '显示',
      submenu: [
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏幕' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { role: 'front', label: '前置全部窗口' },
      ],
    },
    {
      role: 'help',
      label: '帮助',
      submenu: [
        { label: '银子 API 官网', click: () => openExternal(website) },
      ],
    },
  ];
}

function closeRuntimeResources({ server, productionAutonomyRunner, closeDatabase, timeoutMs = 5000 }) {
  try { productionAutonomyRunner?.stop?.(); } catch (_) {}
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { closeDatabase?.(); } catch (_) {}
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    if (!server?.close) {
      clearTimeout(timer);
      finish();
      return;
    }
    try {
      server.close(() => {
        clearTimeout(timer);
        finish();
      });
      server.closeIdleConnections?.();
    } catch (_) {
      clearTimeout(timer);
      finish();
    }
  });
}

function reserveLocalHttpServer(preferredPort, options = {}) {
  const createServer = options.createServer || (() => http.createServer());
  return new Promise((resolve, reject) => {
    const reserve = (port) => {
      const server = createServer();
      server.once('error', (error) => {
        if (port !== 0 && ['EADDRINUSE', 'EACCES'].includes(error?.code)) reserve(0);
        else reject(error);
      });
      server.listen(port, '127.0.0.1', () => resolve(server));
    };
    reserve(Number(preferredPort) || 0);
  });
}

module.exports = {
  PRODUCT_NAME,
  USER_DATA_DIR_NAME,
  backendHasUserData,
  buildMacApplicationMenuTemplate,
  closeRuntimeResources,
  copyVerifiedExecutable,
  isSafeExternalUrl,
  isMachOExecutableForArch,
  migrateLegacyUserData,
  normalizeLocalOrigin,
  probeExecutable,
  reserveLocalHttpServer,
  resolveAcceptanceAppData,
  resolveAcceptanceRoot,
};
