'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const express = require('express'), Database = require('better-sqlite3'), sharp = require('sharp');
const { spawnSync } = require('node:child_process');
const { getFfmpegPath } = require('../../src/utils/ffmpegPath');

async function startCanvasHarness(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-canvas-'));
  const storage = path.join(root, 'storage'); fs.mkdirSync(storage);
  const cfg = { app: { name: 'canvas-test', version: 'local' }, database: { path: path.join(root, 'canvas.db') }, server: {}, storage: { local_path: storage, base_url: '' } };
  const configPath = path.join(root, 'config.json'), previous = process.env.YINZI_WORKFLOW_CONFIG;
  fs.writeFileSync(configPath, JSON.stringify(cfg)); process.env.YINZI_WORKFLOW_CONFIG = configPath;
  const db = new Database(cfg.database.path); db.pragma('journal_mode=WAL');
  const log = { info() {}, warn() {}, error() {}, infow() {}, errorw() {}, warnw() {} };
  const savedLog = console.log, savedWarn = console.warn;
  try { console.log = () => {}; console.warn = () => {}; require('../../src/db/migrate').runMigrationsAndEnsure(db); } finally { console.log = savedLog; console.warn = savedWarn; }
  const app = express(); app.use(express.json({ limit: '24mb' }));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/v1/runtime-identity', (_req, res) => res.json({ data: { schema: 'canvas-isolated-fixture', orchestration_router: true } }));
  app.post('/api/v1/orchestration-sessions/__codex_capability_probe__/nodes/__probe__/actions/start', (_req, res) => res.status(404).json({ error: { code: 'ORCHESTRATION_NOT_FOUND' } }));
  const image = await sharp({ create: { width: 256, height: 144, channels: 3, background: '#417bb6' } }).png().toBuffer();
  const videoPath = path.join(root, 'fixture.mp4');
  if (options.video !== false) {
    const result = spawnSync(getFfmpegPath(), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-y', videoPath], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
    if (result.status !== 0) throw new Error('Fixture FFmpeg failed: ' + result.stderr);
  }
  const submissions = [], completions = [], fileUploads = []; let base;
  app.post('/provider/v1/chat/completions', async (req, res) => {
    completions.push({ request: req.body, authorization: req.headers.authorization });
    try { const reply = await (options.completion || (() => ({ content: '本地模拟模型：已收到。' })))(req.body, completions.length, req);
      if (reply?.httpStatus) res.status(reply.httpStatus).json(reply.body); else res.json({ choices: [{ message: { role: 'assistant', ...reply } }] });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
  });
  app.post('/provider/v1/images/generations', (req, res) => { submissions.push({ kind: 'image', body: req.body }); res.json({ data: [{ b64_json: image.toString('base64') }] }); });
  app.post('/provider/v1/images/edits', require('multer')({ storage: require('multer').memoryStorage() }).any(), (req, res) => {
    submissions.push({ kind: 'image', body: req.body, files: req.files.map(f => ({ field: f.fieldname, bytes: f.size })) }); res.json({ data: [{ b64_json: image.toString('base64') }] });
  });
  app.post('/provider/v1/videos', (req, res) => { submissions.push({ kind: 'video', body: req.body }); res.json({ status: 'completed', video_url: base + '/fixture.mp4' }); });
  app.get('/fixture.mp4', (_req, res) => res.sendFile(videoPath));
  app.post('/provider/v1/files', require('multer')({ storage: require('multer').memoryStorage() }).single('file'), (req, res) => { fileUploads.push(req.file); res.json({ id: 'fixture-' + fileUploads.length }); });
  const service = require('../../src/services/mediaBatchService').createMediaBatchService(db, log, { config: cfg, dispatchVideo: body => require('../../src/routes/videos').createGeneration(db, log, body) });
  const canvas = require('../../src/routes/creationCanvas')(db, cfg, log, service, { pollMs: 30, ...(options.injected || {}) });
  app.use('/api/v1/creation-canvases', canvas);
  const upload = require('../../src/routes/upload');
  app.post('/api/v1/upload/reference-media', upload.multerReferenceMediaSingle, upload.routes(cfg, log, db).uploadReferenceMedia);
  const ai = require('../../src/routes/aiConfig')(db, log, cfg);
  app.get('/api/v1/ai-configs', ai.list); app.post('/api/v1/ai-configs', ai.create);
  app.get('/api/v1/ai-configs/:id/model-capabilities', ai.modelCapabilities);
  app.get('/api/v1/ai-configs/yinzi/catalog', (_req,res) => res.json({data:{video:[]}}));
  const batch = require('../../src/routes/mediaBatch')(service, log);
  app.get('/api/v1/media-batches', batch.list); app.get('/api/v1/media-batches/:id', batch.get); app.post('/api/v1/media-batches', batch.create);
  app.get('/api/v1/assets', (req, res) => res.json({ data: require('../../src/services/assetService').list(db, req.query, cfg) }));
  app.get('/api/v1/research/jobs', (_req, res) => res.json({ data: { items: [] } }));
  app.get('/__evidence', (_req, res) => res.json({ root, submissions, completion_count: completions.length }));
  app.use('/static', express.static(storage));
  app.get('/api/v1/*', (_req, res) => res.json({ data: { items: [], sessions: [], quality_profile: 'quality', orchestration_router: true, runtime_id: 'canvas-isolated-test' } }));
  if (options.frontend) { app.use(express.static(options.frontend)); app.get('*', (_req, res) => res.sendFile(path.join(options.frontend, 'index.html'))); }
  app.use((error, _req, res, _next) => res.status(400).json({ success: false, error: { message: error.message } }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = 'http://127.0.0.1:' + server.address().port;
  cfg.storage.base_url = base + '/static'; fs.writeFileSync(configPath, JSON.stringify(cfg));
  const configs = {};
  for (const type of ['text', 'image', 'video']) configs[type] = require('../../src/services/aiConfigService').createConfig(db, log, { service_type: type,
    provider: type === 'text' ? 'openai' : 'yinzi', api_protocol: type === 'text' ? 'openai' : 'yinzi', name: '本地验收 ' + type,
    base_url: base + '/provider/v1', api_key: 'fixture-secret-never-export', model: [type === 'image' ? 'gpt-image-2' : 'canvas-fixture-' + type],
    default_model: type === 'image' ? 'gpt-image-2' : 'canvas-fixture-' + type, endpoint: type === 'text' ? '/chat/completions' : type === 'image' ? '/images/generations' : '/videos', is_default: true });
  return { app, base, root, storage, db, cfg, log, configs, submissions, completions, image, videoPath, service, canvas,
    async close() { await canvas.close(); service.stop(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); db.close();
      if (previous == null) delete process.env.YINZI_WORKFLOW_CONFIG; else process.env.YINZI_WORKFLOW_CONFIG = previous;
      if (!options.keep) { if (path.dirname(root) !== path.resolve(os.tmpdir())) throw Error('Fixture directory mismatch'); fs.rmSync(root, { recursive: true, force: true }); } } };
}
module.exports = { startCanvasHarness };
