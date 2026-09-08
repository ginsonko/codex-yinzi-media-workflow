// Legacy `npm start` / direct node entry points join the same installation.
// Development fixtures can explicitly opt into a separate data instance.
if (process.env.YINZI_WORKFLOW_CANONICAL !== '1' && process.env.YINZI_WORKFLOW_ISOLATED !== '1') {
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const source = path.resolve(__dirname, '../..');
  const launcher = path.join(source, 'codex-yinzi-universal-video-workflow/plugins/codex-yinzi-universal-video-workflow/scripts/runtime-launcher.mjs');
  const result = spawnSync(process.execPath, [launcher, 'ensure', '--project-root', source], { stdio: 'inherit', windowsHide: true });
  process.exit(result.status ?? 3);
}
const { loadConfig } = require('./config/index.js');

const preConfig = loadConfig();
const { acquireRuntimeLease } = require('./services/runtimeLease');
let runtimeLease;
try {
  runtimeLease = acquireRuntimeLease(preConfig.database.path, {
    api_base: `http://127.0.0.1:${Number(process.env.PORT) || preConfig.server?.port || 5679}`,
    runtime_root: process.cwd(), source_root: process.env.YINZI_WORKFLOW_PROJECT_ROOT || null,
    source_digest: process.env.YINZI_WORKFLOW_SOURCE_DIGEST || null,
    launch_token: process.env.YINZI_WORKFLOW_LAUNCH_TOKEN || null,
  });
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error.code || 'RUNTIME_LOCK_FAILED', error: error.message,
    frontend_url: error.runtime?.api_base ? error.runtime.api_base + '/' : null }));
  process.exit(3);
}
process.on('exit', () => runtimeLease.release());
const tlsFlag = preConfig.server?.insecure_tls ?? preConfig.server?.INSECURE_TLS;
const insecureTlsOn =
  tlsFlag === true ||
  tlsFlag === 1 ||
  tlsFlag === '1' ||
  String(tlsFlag).toLowerCase() === 'true';
if (insecureTlsOn) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[config] server.insecure_tls 已启用：全局跳过 TLS 证书校验，仅用于测试');
}

const { createApp } = require('./app.js');
const { closeDb } = require('./db/index.js');
const logger = require('./logger.js');

const { app, config, productionAutonomyRunner } = createApp();
const port = Number(process.env.PORT) || config.server?.port || 5679;
const host = process.env.HOST || config.server?.host || '0.0.0.0';

const server = app.listen(port, host, () => {
  logger.info('Server starting', { port, host });
  logger.info('Frontend:  http://localhost:' + port);
  logger.info('API:       http://localhost:' + port + '/api/v1');
  logger.info('Health:    http://localhost:' + port + '/health');
  logger.info('Server is ready!');
});

async function shutdown() {
  logger.info('Shutting down server...');
  productionAutonomyRunner?.stop();
  await app.locals.blenderService?.stop();
  server.close(() => {
    closeDb();
    logger.info('Server exited');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
