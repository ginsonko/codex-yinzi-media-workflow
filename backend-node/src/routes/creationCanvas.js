'use strict';
const express = require('express');
const { createCanvasService } = require('../services/creationCanvas/service');
const { createCanvasAgent } = require('../services/creationCanvas/agent');
const { inspectMedia } = require('../services/creationCanvas/analysis');
const { extractFrame } = require('../services/creationCanvas/frameExtract');
const { localRequest } = require('./researchPlatformSessions');

module.exports = function routes(db, cfg, log, mediaBatch, injected = {}) {
  const service = createCanvasService(db, cfg, log, mediaBatch, injected);
  const agent = createCanvasAgent(service, injected.agent);
  const router = express.Router();
  router.use((req, res, next) => localRequest(req) ? next() : res.status(403).json({ success: false, error: { code: 'LOCAL_ORIGIN_REQUIRED', message: '请从本机工作台使用画布' } }));
  const handle = fn => async (req, res) => {
    try { res.json({ success: true, data: await fn(req) }); }
    catch (error) { res.status(error.status || 400).json({ success: false, error: { code: error.code || 'CANVAS_ERROR', message: service.clean(error.message) } }); }
  };
  router.get('/', handle(() => ({ items: service.list() })));
  router.post('/', handle(req => service.create(req.body)));
  router.get('/tools', handle(() => ({ tools: agent.tools })));
  router.get('/models', handle(() => ({ items: service.models() })));
  router.get('/:id', handle(req => service.get(req.params.id)));
  router.patch('/:id', handle(req => service.configure(req.params.id, req.body)));
  router.post('/:id/operations', handle(req => service.operate(req.params.id, req.body)));
  router.post('/:id/generate', handle(req => service.generate(req.params.id, req.body)));
  router.post('/:id/import-assets', handle(req => service.importAssets(req.params.id, req.body)));
  router.post('/:id/import-research', handle(req => service.importResearch(req.params.id, req.body)));
  router.post('/:id/export-video', handle(req => service.exportVideo(req.params.id, req.body)));
  router.get('/:id/jobs/:jobId', handle(req => service.store.read('job', req.params.jobId, req.params.id)));
  router.post('/:id/jobs/:jobId/:action', handle(req => service.controlJob(req.params.id, req.params.jobId, req.params.action)));
  router.get('/:id/messages', handle(req => ({ items: service.messages(req.params.id, req.query.after, req.query.limit) })));
  router.post('/:id/messages', handle(req => agent.send(req.params.id, req.body)));
  router.get('/:id/runs/:runId', handle(req => agent.get(req.params.id, req.params.runId)));
  router.post('/:id/runs/:runId/stop', handle(req => agent.stop(req.params.id, req.params.runId, req.body.pause_jobs !== false)));
  router.post('/:id/nodes/:nodeId/inspect', handle(req => inspectMedia(service, req.params.id, req.params.nodeId)));
  router.post('/:id/nodes/:nodeId/extract-frame', handle(req => extractFrame(service, req.params.id, req.params.nodeId, req.body || {})));
  router.get('/:id/nodes/:nodeId/media', (req, res) => {
    try { res.sendFile(service.mediaFile(req.params.id, req.params.nodeId).path); }
    catch (error) { res.status(error.status || 400).json({ success: false, error: { message: error.message } }); }
  });
  router.get('/:id/exports/:jobId/file', (req, res) => {
    try { res.sendFile(service.mediaFile(req.params.id, null, req.params.jobId).path); }
    catch (error) { res.status(error.status || 400).json({ success: false, error: { message: error.message } }); }
  });
  router.get('/:id/export.json', handle(req => ({ format: 'yinzi-creation-canvas', version: 1, canvas: service.get(req.params.id) })));
  router.service = service; router.agent = agent;
  router.close = async () => { await agent.close(); await service.stop(); };
  return router;
};
