// Isolated local-only provider harness. No saved credentials or installed runtime.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const express = require('express');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const multer = require('multer');
const crypto = require('node:crypto');
const { getFfmpegPath } = require('../../src/utils/ffmpegPath');

async function startHarness(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-manual-batch-'));
  const storage = path.join(root, 'storage'); fs.mkdirSync(storage);
  const configPath = path.join(root, 'config.json');
  const previousConfig = process.env.YINZI_WORKFLOW_CONFIG;
  process.env.YINZI_WORKFLOW_CONFIG = configPath;
  fs.writeFileSync(configPath, JSON.stringify({ app: { name: 'manual-test' }, storage: { local_path: storage, base_url: '' } }));
  const { runMigrationsAndEnsure } = require('../../src/db/migrate');
  const aiConfig = require('../../src/services/aiConfigService');
  const upload = require('../../src/routes/upload');
  const { createGeneration } = require('../../src/routes/videos');
  const { createMediaBatchService } = require('../../src/services/mediaBatchService');
  const routes = require('../../src/routes/mediaBatch');
  const db = new Database(':memory:');
  const oldLog = console.log, oldWarn = console.warn;
  try { console.log = () => {}; console.warn = () => {}; runMigrationsAndEnsure(db); } finally { console.log = oldLog; console.warn = oldWarn; }
  const errors = [], submissions = [], uploads = [], providerFiles = [];
  const log = { info() {}, warn() {}, error(message, detail) { errors.push({ message, detail }); } };
  const app = express(); app.use(express.json({ limit: '16mb' }));
  let base;
  const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#336699' } }).png().toBuffer();
  const imageB = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#993355' } }).png().toBuffer();
  const video = path.join(root, 'clip.mp4');
  const made = spawnSync(getFfmpegPath(), ['-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=24:d=0.25','-c:v','libx264','-pix_fmt','yuv420p','-an','-y',video], { encoding:'utf8', windowsHide:true });
  if (made.status !== 0) throw new Error('Local FFmpeg fixture failed: ' + made.stderr);
  const audio = Buffer.alloc(1644); audio.write('RIFF'); audio.writeUInt32LE(1636,4); audio.write('WAVEfmt ',8); audio.writeUInt32LE(16,16); audio.writeUInt16LE(1,20); audio.writeUInt16LE(1,22); audio.writeUInt32LE(8000,24); audio.writeUInt32LE(16000,28); audio.writeUInt16LE(2,32); audio.writeUInt16LE(16,34); audio.write('data',36); audio.writeUInt32LE(1600,40);
  const fixtures = { image, imageB, video: fs.readFileSync(video), audio };
  for (const [name, data] of [['a.png',image],['b.png',imageB],['clip.mp4',fixtures.video],['voice.wav',audio]]) fs.writeFileSync(path.join(root,name),data);
  app.post('/provider/v1/videos', (req,res) => { submissions.push(req.body); res.json({ status:'completed', video_url: base + '/sample.mp4' }); });
  app.post('/provider/v1/files', multer({storage:multer.memoryStorage()}).single('file'), (req,res) => {
    const id = 'fixture-' + crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    providerFiles.push({id,type:req.file.mimetype,bytes:req.file.size}); res.json({id});
  });
  app.get('/sample.mp4', (_req,res) => res.sendFile(video));
  const handlers = upload.routes({ storage: { local_path: storage } }, log, db);
  const failedOnce = new Set();
  app.post('/api/v1/upload/reference-media', upload.multerReferenceMediaSingle, (req,res,next) => {
    uploads.push({ filename:req.file?.originalname, type:req.file?.mimetype, bytes:req.file?.size });
    if (req.file?.originalname?.startsWith('retry-') && !failedOnce.has(req.file.originalname)) { failedOnce.add(req.file.originalname); return res.status(503).json({ success:false,error:{message:'本地模拟：首次上传失败，可重试'} }); }
    handlers.uploadReferenceMedia(req,res,next);
  });
  const service = createMediaBatchService(db,log,{ dispatchVideo: body => createGeneration(db,log,body),
    ...(options.dispatchImage ? { dispatchImage: options.dispatchImage } : {}) });
  const batchRoutes = routes(service,log);
  app.get('/api/v1/media-batches', batchRoutes.list); app.post('/api/v1/media-batches', batchRoutes.create);
  app.get('/api/v1/media-batches/:id', batchRoutes.get);
  app.post('/api/v1/media-batches/:id/pause',batchRoutes.pause); app.post('/api/v1/media-batches/:id/resume',batchRoutes.resume);
  app.post('/api/v1/media-batches/:id/items/:itemId/retry',batchRoutes.retry);
  app.post('/api/v1/media-batches/:id/items/:itemId/retry-download',batchRoutes.retryDownload);
  let configs = [];
  app.get('/api/v1/ai-configs', (req,res) => res.json({data:configs.filter(config => !req.query.service_type || config.service_type === req.query.service_type)}));
  app.get('/api/v1/ai-configs/:id/model-capabilities', require('../../src/routes/aiConfig')(db,log,{}).modelCapabilities);
  app.get('/api/v1/ai-configs/yinzi/catalog', (_req,res) => res.json({data:{video:[]}}));
  app.get('/__evidence', (_req,res) => res.json({ submissions, uploads, providerFiles, errors, batches:service.list({limit:100}), root }));
  app.use('/static',express.static(storage));
  app.get('/api/v1/*', (_req,res) => res.json({data:{items:[],sessions:[],pagination:{total:0},runtime_id:'manual-local-test'}}));
  if (options.frontend) { app.use(express.static(options.frontend)); app.get('*',(_req,res)=>res.sendFile(path.join(options.frontend,'index.html'))); }
  app.use((error,_req,res,_next)=>res.status(400).json({success:false,error:{message:error.message}}));
  const server = await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
  // Prevent idle keep-alive races under concurrent media-test CPU pressure.
  server.keepAliveTimeout = 60000; server.headersTimeout = 65000;
  base = 'http://127.0.0.1:' + server.address().port;
  configs = ['manual-fixture-a','manual-fixture-b'].map((model,index) => aiConfig.createConfig(db,log,{service_type:'video',provider:'yinzi',api_protocol:'yinzi',name:'本地验收 '+(index+1),base_url:base+'/provider/v1',api_key:'local-fixture-only',model:[model],default_model:model,endpoint:'/videos',is_default:index===0}));
  for (const config of configs) aiConfig.updateModelCapabilityOverride(db,log,config.id,config.default_model,{max_images:4,max_videos:2,max_audios:2,max_total_references:8,roles:{image:['reference','first_frame','last_frame'],video:['reference'],audio:['reference']},duration_mode:'range',duration_min:1,duration_max:15});
  if (options.imageModels) {
    for (const [index, model] of options.imageModels.entries()) {
      configs.push(aiConfig.createConfig(db,log,{service_type:'image',provider:'yinzi',api_protocol:'yinzi',name:'本地图片验收 '+(index+1),base_url:base+'/provider/v1',api_key:'local-fixture-only',model:[model],default_model:model,endpoint:'/images/generations',is_default:index===0}));
    }
  }
  configs = configs.map(c=>aiConfig.getConfig(db,c.id));
  return { root,storage,fixtures,base,configs,db,service,submissions,uploads,providerFiles,errors,
    async close() { service.stop(); await new Promise(resolve=>server.close(resolve)); db.close(); if(previousConfig===undefined) delete process.env.YINZI_WORKFLOW_CONFIG; else process.env.YINZI_WORKFLOW_CONFIG=previousConfig; if(!options.keep) { if(path.dirname(root)!==path.resolve(os.tmpdir())) throw new Error('Unexpected fixture root'); fs.rmSync(root,{recursive:true,force:true}); } } };
}
module.exports = { startHarness };
