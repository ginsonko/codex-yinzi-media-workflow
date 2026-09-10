const response = require('../response');
const moduleCatalog = require('../services/orchestrationModuleCatalog');
const { createOrchestrationService } = require('../services/orchestrationService');
const { createOrchestrationBlenderService } = require('../services/orchestrationBlenderService');
const componentManager = require('../services/mediaComponentManager');
const { createLocalMediaJobs } = require('../services/localMediaJobs');

function sendError(res, log, label, error) {
  log.error?.(label, { error: error.message, code: error.code });
  const code = error.code || 'BAD_REQUEST';
  if (['VERSION_CONFLICT', 'PLAN_REVISION_CONFLICT', 'NODE_RUNNING', 'NODE_ALREADY_SUCCEEDED', 'NODE_NOT_READY', 'PLAN_RUNNING_NODE_CONFLICT', 'REQUEST_HASH_CONFLICT'].includes(code)) {
    return response.error(res, 409, code, error.message, error.details);
  }
  if (['ORCHESTRATION_NOT_FOUND', 'ORCHESTRATION_NODE_NOT_FOUND', 'BLENDER_JOB_NOT_FOUND'].includes(code)) {
    return response.error(res, 404, code, error.message, error.details);
  }
  if (['BLENDER_PROCESS_STILL_ACTIVE', 'BLENDER_RECOVERY_INPUT_MISSING'].includes(code)) {
    return response.error(res, 409, code, error.message, error.details);
  }
  return response.error(res, 400, code, error.message, error.details);
}

module.exports = function orchestrationRoutes(db, log = console, cfg = {}, injected = {}) {
  const service = createOrchestrationService(db);
  const blender = createOrchestrationBlenderService(db, cfg, log, { ...injected, orchestration: service });
  const localMedia = createLocalMediaJobs(db, cfg, service, injected.localMedia || {});
  return {
    blenderService: blender,
    localMediaService: localMedia,
    createLocalMediaJob(req,res) { try { response.created(res,localMedia.create(req.body||{})); } catch(e) { sendError(res,log,'local media submit',e); } },
    getLocalMediaJob(req,res) { try { const job=localMedia.get(req.params.jobId); if(!job)return response.error(res,404,'LOCAL_JOB_MISSING','本地任务不存在'); response.success(res,job); } catch(e) { sendError(res,log,'local media read',e); } },
    listLocalMediaJobs(req,res) { try { response.success(res,{items:localMedia.list(req.query.session_id)}); } catch(e) { sendError(res,log,'local media list',e); } },
    resumeLocalMediaJob(req,res) { try { response.success(res,localMedia.resume(req.params.jobId)); } catch(e) { sendError(res,log,'local media resume',e); } },
    searchArtifacts(req, res) {
      try { response.success(res, service.searchArtifacts(req.query || {})); }
      catch (error) { sendError(res, log, 'search orchestration artifacts', error); }
    },
    listModules(req, res) {
      try { response.success(res, moduleCatalog.listModules(req.query || {})); }
      catch (error) { sendError(res, log, 'orchestration modules list', error); }
    },
    registerModule(req, res) {
      try { response.success(res, moduleCatalog.registerModule(req.body || {})); }
      catch (error) { sendError(res, log, 'register module', error); }
    },
    importModules(req, res) {
      try { response.success(res, moduleCatalog.importModules(req.body || {})); }
      catch (error) { sendError(res, log, 'import modules', error); }
    },
    exportModules(req, res) {
      try { response.success(res, moduleCatalog.exportModules(req.query || {})); }
      catch (error) { sendError(res, log, 'export modules', error); }
    },
    updateModule(req, res) {
      try { response.success(res, moduleCatalog.updateModule(req.params.moduleId, req.body || {})); }
      catch (error) { sendError(res, log, 'update module', error); }
    },
    deleteModule(req, res) {
      try {
        const ok = moduleCatalog.deleteModule(req.params.moduleId);
        if (!ok) return response.error(res, 404, 'MODULE_NOT_FOUND', '自定义工具不存在');
        return response.success(res, { deleted: true, module_id: req.params.moduleId });
      } catch (error) { sendError(res, log, 'delete module', error); }
    },
    getModule(req, res) {
      const item = moduleCatalog.getModule(req.params.moduleId);
      if (!item) return response.error(res, 404, 'MODULE_CONTRACT_MISSING', '本地尚未登记该模块合同；它仍可作为未知模块写入计划并由 Codex 或人工执行');
      return response.success(res, item);
    },
    componentProfile(req, res) {
      return response.success(res, { schema_version: 1, machine: componentManager.machineProfile(), components: localMedia.manager.runtimeComponents() });
    },
    componentState(req, res) {
      try { const current=localMedia.manager.readState(req.params.componentId); const summary=localMedia.manager.runtimeComponents().find(item=>item.component_id===req.params.componentId); return response.success(res, { ...current, ...summary }); }
      catch (error) { return sendError(res, log, 'component state', error); }
    },
    ensureComponent(req, res) {
      try { const pending=localMedia.manager.ensureComponent(req.body||{}); pending.catch(error=>log.error?.('component install',{code:error.code,message:error.message})); response.success(res,{component_id:req.body.component_id,status:'preparing'}); }
      catch(error) { sendError(res,log,'component ensure',error); }
    },
    listSessions(req, res) {
      try { response.success(res, service.listSessions(req.query || {})); }
      catch (error) { sendError(res, log, 'orchestration session list', error); }
    },
    onboarding(req, res) {
      try { response.success(res, service.onboarding()); }
      catch (error) { sendError(res, log, 'orchestration onboarding', error); }
    },
    beginWork(req, res) {
      try { response.success(res, service.beginWork(req.body || {})); }
      catch (error) { sendError(res, log, 'begin media work', error); }
    },
    reportActivity(req, res) {
      try { response.success(res, service.reportActivity(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'report media activity', error); }
    },
    createSession(req, res) {
      try {
        const result = service.createSession(req.body || {});
        if (result.reused) return response.success(res, result);
        return response.created(res, result);
      } catch (error) { sendError(res, log, 'orchestration session create', error); }
    },
    getSession(req, res) {
      try {
        const result = service.getBundle(req.params.id, req.query || {});
        if (!result) return response.error(res, 404, 'ORCHESTRATION_NOT_FOUND', '编排任务不存在');
        return response.success(res, result);
      } catch (error) { sendError(res, log, 'orchestration session get', error); }
    },
    blenderJobs(req, res) {
      try { response.success(res, { schema_version: 1, items: blender.listJobs(req.params.id) }); }
      catch (error) { sendError(res, log, 'orchestration Blender jobs list', error); }
    },
    blenderJob(req, res) {
      try {
        const item = blender.getJob(req.params.jobId);
        if (!item || item.session_id !== req.params.id) return response.error(res, 404, 'BLENDER_JOB_NOT_FOUND', 'Blender 作业不存在');
        response.success(res, item);
      } catch (error) { sendError(res, log, 'orchestration Blender job get', error); }
    },
    renderBlender(req, res) {
      Promise.resolve()
        .then(() => blender.createJob(req.params.id, { ...(req.body || {}), node_key: req.params.nodeId }))
        .then((result) => response.created(res, result))
        .catch((error) => sendError(res, log, 'orchestration Blender render', error));
    },
    resumeBlender(req, res) {
      Promise.resolve()
        .then(() => {
          const item = blender.getJob(req.params.jobId);
          if (!item || item.session_id !== req.params.id) throw Object.assign(new Error('Blender 作业不存在'), { code: 'BLENDER_JOB_NOT_FOUND' });
          return blender.resumeJob(req.params.jobId);
        })
        .then((result) => response.success(res, result))
        .catch((error) => sendError(res, log, 'orchestration Blender resume', error));
    },
    cancelBlender(req, res) {
      try {
        const item = blender.getJob(req.params.jobId);
        if (!item || item.session_id !== req.params.id) return response.error(res, 404, 'BLENDER_JOB_NOT_FOUND', 'Blender 作业不存在');
        response.success(res, blender.cancelJob(req.params.jobId, req.body || {}));
      }
      catch (error) { sendError(res, log, 'orchestration Blender cancel', error); }
    },
    updateSession(req, res) {
      try { response.success(res, service.updateSession(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration session update', error); }
    },
    archiveSession(req, res) {
      try { response.success(res, service.archiveSession(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration session archive', error); }
    },
    submitPlan(req, res) {
      try { response.success(res, service.submitPlan(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration plan submit', error); }
    },
    confirmPlan(req, res) {
      try { response.success(res, service.confirmPlan(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration plan confirm', error); }
    },
    startSession(req, res) {
      try { response.success(res, service.startSession(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration session start', error); }
    },
    updateNode(req, res) {
      try { response.success(res, service.updateNode(req.params.id, req.params.nodeId, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration node update', error); }
    },
    retryNode(req, res) {
      try { response.success(res, service.retryNode(req.params.id, req.params.nodeId, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration node retry', error); }
    },
    actOnNode(req, res) {
      try { response.success(res, service.actOnNode(req.params.id, req.params.nodeId, req.params.action, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration node action', error); }
    },
    reserveExternalRequest(req, res) {
      try { response.success(res, service.reserveExternalRequest(req.params.id, req.params.nodeId, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration external request reserve', error); }
    },
    pauseSession(req, res) {
      try { response.success(res, service.pauseSession(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration session pause', error); }
    },
    resumeSession(req, res) {
      try { response.success(res, service.resumeSession(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration session resume', error); }
    },
    saveCheckpoint(req, res) {
      try { response.success(res, service.saveCheckpoint(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration checkpoint save', error); }
    },
    exportSession(req, res) {
      try { response.success(res, service.exportSession(req.params.id)); }
      catch (error) { sendError(res, log, 'orchestration session export', error); }
    },
    artifacts(req, res) {
      try { response.success(res, { schema_version: 1, items: service.listArtifacts(req.params.id, req.query || {}) }); }
      catch (error) { sendError(res, log, 'orchestration artifacts list', error); }
    },
    registerArtifact(req, res) {
      try { response.created(res, service.recordArtifact(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration artifact register', error); }
    },
    feedback(req, res) {
      try { response.success(res, { schema_version: 1, items: service.listFeedback(req.params.id) }); }
      catch (error) { sendError(res, log, 'orchestration feedback list', error); }
    },
    recordFeedback(req, res) {
      try { response.created(res, service.recordFeedback(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration feedback record', error); }
    },
    delivery(req, res) {
      try { response.success(res, service.latestDelivery(req.params.id) || { status: 'not_prepared', items: [] }); }
      catch (error) { sendError(res, log, 'orchestration delivery get', error); }
    },
    completeSession(req,res) {
      try { response.success(res,service.completeSession(req.params.id,req.body || {})); }
      catch(error) { sendError(res,log,'orchestration completion',error); }
    },
    prepareDelivery(req, res) {
      try { response.created(res, service.deliverSession(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration delivery prepare', error); }
    },
    events(req, res) {
      try { response.success(res, service.listEvents(req.params.id, req.query || {})); }
      catch (error) { sendError(res, log, 'orchestration events list', error); }
    },
    recordEvent(req, res) {
      try {
        const result = service.recordEvent(req.params.id, req.body || {});
        return response.success(res, result);
      } catch (error) { return sendError(res, log, 'orchestration event record', error); }
    },
  };
};
