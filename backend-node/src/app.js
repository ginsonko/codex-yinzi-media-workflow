const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { getDb } = require('./db/index.js');
const { loadConfig } = require('./config/index.js');
const logger = require('./logger.js');
const { setupRouter } = require('./routes/index.js');

function applyLocalRuntimeOrigin(config, value) {
  if (!value) return config;
  try {
    const origin = new URL(String(value).trim());
    const host = origin.hostname.toLowerCase();
    if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host)) return config;
    if (origin.username || origin.password || (origin.pathname && origin.pathname !== '/') || origin.search || origin.hash) return config;
    config.storage = { ...(config.storage || {}), base_url: `${origin.origin}/static` };
    config.files = { ...(config.files || {}), base_url: `${origin.origin}/static` };
  } catch (_) {}
  return config;
}

function isSpaNavigationRequest(req) {
  if (!['GET', 'HEAD'].includes(req.method)) return false;
  if (req.path.startsWith('/api')) return false;
  if (path.posix.extname(req.path)) return false;
  const accept = String(req.get('accept') || '');
  return !accept || accept.includes('text/html') || accept.includes('*/*');
}

function mountWebDist(app, webDist) {
  if (!fs.existsSync(webDist)) return false;
  app.use('/assets', express.static(path.join(webDist, 'assets')));
  app.use(express.static(webDist, { index: false }));
  app.get('/favicon.ico', (req, res) => {
    const fav = path.join(webDist, 'favicon.ico');
    if (fs.existsSync(fav)) res.sendFile(fav);
    else res.status(404).end();
  });
  app.get('*', (req, res, next) => {
    if (!isSpaNavigationRequest(req)) return next();
    const indexHtml = path.join(webDist, 'index.html');
    if (fs.existsSync(indexHtml)) return res.sendFile(indexHtml);
    return next();
  });
  return true;
}

function resolveWebDist(options = {}) {
  const configured = options.webDistPath || process.env.WEB_DIST_PATH;
  const candidates = [
    configured,
    // Source checkout started from its project root or a runtime data root.
    path.resolve(__dirname, '..', '..', 'frontweb', 'dist'),
    path.resolve(process.cwd(), 'frontweb', 'dist'),
    path.resolve(process.cwd(), '..', 'frontweb', 'dist'),
    path.resolve(process.cwd(), 'web', 'dist'),
  ].filter(Boolean).map((value) => path.resolve(String(value)));
  return [...new Set(candidates)].find((candidate) => fs.existsSync(path.join(candidate, 'index.html'))) || candidates[0];
}

function createApp(options = {}) {
  const config = applyLocalRuntimeOrigin(loadConfig(), options.localOrigin || process.env.LOCAL_APP_ORIGIN);
  const db = getDb(config.database);
  const { runMigrationsAndEnsure } = require('./db/migrate.js');
  runMigrationsAndEnsure(db);

  // 厂商锁定模式：在迁移完成后同步 vendor_lock 配置
  const { applyVendorLock } = require('./services/aiConfigService');
  applyVendorLock(db, logger, config);
  const log = logger;

  const taskService = require('./services/taskService');
  taskService.failOrphanedAsyncTasksOnStartup(db, log);

  // Staged browser uploads are recoverable for a bounded period. Startup
  // cleanup is best-effort and can never block the local application.
  try {
    const importService = require('./services/assetImportService');
    const cleanup = importService.cleanupExpiredStaging(db, config, log);
    if (cleanup.cleaned) log.info('asset import staging cleanup', cleanup);
  } catch (error) {
    log.warn('asset import staging cleanup failed', { error: error.message });
  }

  const { resumeProcessingVideoGenerations } = require('./services/videoService');
  resumeProcessingVideoGenerations(db, log);

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(
    cors({
      origin: config.server.cors_origins && config.server.cors_origins.length
        ? config.server.cors_origins
        : '*',
    })
  );

  app.use((req, res, next) => {
    log.info(req.method, req.path);
    next();
  });

  // 静态资源目录：统一转为绝对路径（打包 exe 下相对路径可能解析异常）
  const storageRoot = config.storage?.local_path
    ? (path.isAbsolute(config.storage.local_path)
        ? config.storage.local_path
        : path.join(process.cwd(), config.storage.local_path))
    : path.join(process.cwd(), 'data', 'storage');
  try {
    if (!fs.existsSync(storageRoot)) fs.mkdirSync(storageRoot, { recursive: true });
    app.use('/static', express.static(storageRoot));
  } catch (e) {
    console.warn('Static storage mount skipped:', e.message);
  }

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      app: config.app.name,
      version: config.app.version,
    });
  });

  const apiRouter = setupRouter(config, db, log);
  app.use('/api/v1', apiRouter);
  app.locals.blenderService = apiRouter.blenderService;

  // 前端静态资源（sxy：web/dist）；Electron 打包时可设 WEB_DIST_PATH
  const webDist = resolveWebDist(options);
  console.log('webDist', webDist);
  if (!mountWebDist(app, webDist)) {
    app.get('/', (req, res) => {
      res.send(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>银子AI视频工作流</title></head><body>' +
          '<h1>银子AI视频工作流 API</h1><p>后端已启动。请先构建前端：</p>' +
          '<pre>cd web &amp;&amp; pnpm install &amp;&amp; pnpm build</pre>' +
          '<p>然后将 <code>web/dist</code> 放到与 backend-node 同级的 <code>web/dist</code>，或访问 <a href="/health">/health</a> 检查接口。</p></body></html>'
      );
    });
  }

  app.use((req, res) => {
    if (req.path.startsWith('/api')) {
      return res.status(404).json({ error: 'API endpoint not found' });
    }
    res.status(404).type('text/plain').send('Not Found');
  });

  app.use((err, req, res, next) => {
    log.errorw('Unhandled error', { error: err.message, path: req.path });
    if (!res.headersSent) {
      const isFileTooLarge = err.code === 'LIMIT_FILE_SIZE' || (err.message && err.message.includes('File too large'));
      const status = isFileTooLarge ? 413 : 500;
      const message = isFileTooLarge ? '图片大小不能超过 16MB，请压缩后重试' : (err.message || '服务器错误');
      res.status(status).json({ success: false, error: { code: isFileTooLarge ? 'FILE_TOO_LARGE' : 'INTERNAL_ERROR', message }, timestamp: new Date().toISOString() });
    }
  });

  let productionAutonomyRunner = null;
  const autonomyDisabled = options.startProductionAutonomy === false
    || process.env.PRODUCTION_AUTONOMY_DISABLED === '1';
  if (!autonomyDisabled) {
    const { createProductionAutonomyRunner } = require('./services/productionAutonomyRunner');
    productionAutonomyRunner = createProductionAutonomyRunner(db, config, log, options.productionAutonomy || {});
    productionAutonomyRunner.start();
  }
  app.locals.productionAutonomyRunner = productionAutonomyRunner;

  return { app, config, db, productionAutonomyRunner };
}

module.exports = { applyLocalRuntimeOrigin, createApp, isSpaNavigationRequest, mountWebDist, resolveWebDist };
