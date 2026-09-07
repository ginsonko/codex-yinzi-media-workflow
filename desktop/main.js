'use strict';

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const {
  PRODUCT_NAME,
  USER_DATA_DIR_NAME,
  buildMacApplicationMenuTemplate,
  closeRuntimeResources,
  copyVerifiedExecutable,
  isSafeExternalUrl,
  isMachOExecutableForArch,
  migrateLegacyUserData,
  normalizeLocalOrigin,
  reserveLocalHttpServer,
  resolveAcceptanceAppData,
  resolveAcceptanceRoot,
} = require('./runtime');

const defaultAppDataRoot = app.getPath('appData');
const acceptanceRoot = resolveAcceptanceRoot({
  packaged: app.isPackaged,
  execPath: process.execPath,
  appDir: __dirname,
  portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR,
});
const appDataRoot = resolveAcceptanceAppData({
  requested: process.env.YINZI_ACCEPTANCE_APPDATA,
  allowedRoot: acceptanceRoot,
  fallback: defaultAppDataRoot,
});
const userDataDir = path.join(appDataRoot, USER_DATA_DIR_NAME);
app.setName(PRODUCT_NAME);
app.setPath('userData', userDataDir);

const startupLog = path.join(userDataDir, 'logs', 'desktop-startup.log');
const defaultPort = 5679;
const backendAppPath = path.join(__dirname, 'backend-app');
const backendNodePath = path.join(__dirname, '..', 'backend-node');
let mainWindow = null;
let serverInstance = null;
let productionAutonomyRunner = null;
let closeDatabase = null;
let quitting = false;
let runtimeOrigin = null;

function writeMainLog(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(startupLog), { recursive: true });
    fs.appendFileSync(startupLog, line, 'utf8');
  } catch (_) {}
}

function formatError(error) {
  return error?.stack || error?.message || String(error || '未知错误');
}

process.on('uncaughtException', (error) => writeMainLog(`uncaughtException: ${formatError(error)}`));
process.on('unhandledRejection', (error) => writeMainLog(`unhandledRejection: ${formatError(error)}`));

writeMainLog(`main loaded packaged=${app.isPackaged} exec=${process.execPath}`);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function getBackendModulePath() {
  if (app.isPackaged) return backendAppPath;
  if (process.versions.electron && fs.existsSync(path.join(backendAppPath, 'src', 'app.js'))) return backendAppPath;
  return fs.existsSync(backendNodePath) ? backendNodePath : backendAppPath;
}

function getBackendCwd() {
  return app.isPackaged ? path.join(userDataDir, 'backend') : getBackendModulePath();
}

function migrateLegacyData() {
  const result = migrateLegacyUserData({
    targetDir: userDataDir,
    legacyDirs: [
      path.join(appDataRoot, 'localminidrama-desktop'),
      path.join(appDataRoot, 'LocalMiniDrama'),
    ],
  });
  writeMainLog(`legacy migration status=${result.status} reason=${result.reason || '-'} source=${result.source || '-'}`);
}

function ensureBackendCwd(backendCwd) {
  const configsDir = path.join(backendCwd, 'configs');
  const dataDir = path.join(backendCwd, 'data');
  const logsDir = path.join(backendCwd, 'logs');
  fs.mkdirSync(configsDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  const configPath = path.join(configsDir, 'config.yaml');
  const bundledConfig = path.join(getBackendModulePath(), 'configs', 'config.yaml');
  if (!fs.existsSync(configPath)) fs.copyFileSync(bundledConfig, configPath);

  try {
    const yaml = require('js-yaml');
    const userConfig = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
    const bundled = yaml.load(fs.readFileSync(bundledConfig, 'utf8')) || {};
    if (bundled.vendor_lock !== undefined) userConfig.vendor_lock = bundled.vendor_lock;
    fs.writeFileSync(configPath, yaml.dump(userConfig, { lineWidth: -1 }), 'utf8');
  } catch (error) {
    throw new Error(`初始化本地配置失败：${error.message}`);
  }
}

function ensureBundledMediaTools(backendCwd) {
  if (!app.isPackaged) return;
  const names = process.platform === 'win32'
    ? ['ffmpeg.exe', 'ffprobe.exe']
    : ['ffmpeg', 'ffprobe'];
  const sourceDir = path.join(process.resourcesPath, 'ffmpeg');
  const targetDir = path.join(backendCwd, 'tools', 'ffmpeg');
  for (const name of names) {
    const darwinOptions = process.platform === 'darwin'
      ? {
          sourceValidator: (filePath) => isMachOExecutableForArch(filePath, process.arch),
          prepareCopy: (filePath) => fs.chmodSync(filePath, 0o755),
        }
      : {};
    const result = copyVerifiedExecutable({
      source: path.join(sourceDir, name),
      destination: path.join(targetDir, name),
      ...darwinOptions,
    });
    writeMainLog(`${name} ${result.status} path=${result.path}`);
  }
}

function getWebDistPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'frontweb', 'dist')
    : path.join(__dirname, '..', 'frontweb', 'dist');
}

async function startBackend() {
  migrateLegacyData();
  const backendCwd = getBackendCwd();
  ensureBackendCwd(backendCwd);
  ensureBundledMediaTools(backendCwd);

  process.env.WEB_DIST_PATH = getWebDistPath();
  // The local settings page can create a desktop shortcut. In packaged mode
  // the executable itself is the dynamic launcher and the single-instance
  // lock brings an already running window to the foreground.
  process.env.YINZI_WORKFLOW_SHORTCUT_TARGET = process.execPath;
  process.env.YINZI_WORKFLOW_SHORTCUT_ARGS = '--yinzi-open';
  process.env.EXAMPLE_DRAMA_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'example_drama')
    : path.join(__dirname, '..', 'example_drama');
  process.env.LOG_FILE = path.join(backendCwd, 'logs', 'app.log');
  process.chdir(backendCwd);

  const backendModulePath = getBackendModulePath();
  const config = require(path.join(backendModulePath, 'src', 'config', 'index.js')).loadConfig();
  const reservedServer = await reserveLocalHttpServer(Number(config.server?.port) || defaultPort);
  const address = reservedServer.address();
  const port = Number(address?.port);
  const localOrigin = normalizeLocalOrigin(`http://127.0.0.1:${port}`);
  if (!localOrigin) {
    reservedServer.close();
    throw new Error('无法建立安全的本地服务地址');
  }

  try {
    const created = require(path.join(backendModulePath, 'src', 'app.js')).createApp({ localOrigin });
    serverInstance = reservedServer;
    productionAutonomyRunner = created.productionAutonomyRunner;
    closeDatabase = require(path.join(backendModulePath, 'src', 'db', 'index.js')).closeDb;
    serverInstance.on('request', created.app);
    writeMainLog(`backend ready origin=${localOrigin}`);
    return localOrigin;
  } catch (error) {
    reservedServer.close();
    throw error;
  }
}

function isInternalNavigation(target, localOrigin) {
  try {
    return new URL(target).origin === localOrigin;
  } catch (_) {
    return false;
  }
}

function openExternal(target) {
  if (!isSafeExternalUrl(target)) return;
  shell.openExternal(target).catch((error) => writeMainLog(`openExternal failed: ${formatError(error)}`));
}

function configureApplicationMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  const template = buildMacApplicationMenuTemplate({ openExternal });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(localOrigin) {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 980,
    minHeight: 680,
    title: PRODUCT_NAME,
    backgroundColor: '#f3f6f4',
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow = win;

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternalNavigation(url, localOrigin)) return { action: 'allow' };
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isInternalNavigation(url, localOrigin)) return;
    event.preventDefault();
    openExternal(url);
  });
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    writeMainLog(`did-fail-load code=${code} description=${description} url=${url}`);
  });
  win.once('ready-to-show', () => win.show());
  const showFallback = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  }, 8000);
  showFallback.unref?.();

  win.loadURL(localOrigin).catch((error) => writeMainLog(`loadURL failed: ${formatError(error)}`));
  win.on('closed', () => {
    clearTimeout(showFallback);
    mainWindow = null;
    if (!quitting) app.quit();
  });
  if (process.env.YINZI_AI_DEVTOOLS === '1') win.webContents.openDevTools();
}

async function showStartupFailure(error) {
  const detail = formatError(error);
  writeMainLog(`startup failed: ${detail}`);
  const result = await dialog.showMessageBox({
    type: 'error',
    title: `${PRODUCT_NAME}启动失败`,
    message: '本地服务未能启动，作品和配置没有被删除。',
    detail: `${detail}\n\n启动日志：${startupLog}`,
    buttons: ['打开数据目录', '退出'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (result.response === 0) await shell.openPath(userDataDir);
}

async function shutdownRuntime() {
  if (quitting) return;
  quitting = true;
  await closeRuntimeResources({
    server: serverInstance,
    productionAutonomyRunner,
    closeDatabase,
  });
  serverInstance = null;
  productionAutonomyRunner = null;
  closeDatabase = null;
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  try {
    runtimeOrigin = await startBackend();
    configureApplicationMenu();
    createWindow(runtimeOrigin);
  } catch (error) {
    await showStartupFailure(error);
    app.quit();
  }
});

app.on('activate', () => {
  if (process.platform === 'darwin' && runtimeOrigin && !mainWindow) createWindow(runtimeOrigin);
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  shutdownRuntime().finally(() => app.quit());
});
