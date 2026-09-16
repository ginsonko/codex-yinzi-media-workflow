const express = require('express');
const response = require('../response');
const {createStyleSupervisors} = require('../services/styleSupervisors');

module.exports = function styleSupervisorRoutes(db) {
  const router=express.Router(), service=createStyleSupervisors(db);
  const handle = fn => (req,res) => {
    try { const value=fn(req); if(value===null) return response.error(res,404,'SUPERVISOR_NOT_FOUND','监督不存在'); return response.success(res,value); }
    catch(error) { const status=error.code==='SUPERVISOR_REVISION_CONFLICT'?409:error.code==='SUPERVISOR_BUNDLE_TOO_LARGE'?413:/NOT_FOUND/.test(error.code || '')?404:400; return response.error(res,status,error.code || 'SUPERVISOR_INVALID',error.message,error.details); }
  };
  router.get('/media-supervisors',handle(req=>service.list(req.query)));
  router.post('/media-supervisors',handle(req=>service.create(req.body)));
  router.get('/media-supervisors/export',handle(req=>service.exportProfiles(req.query)));
  router.post('/media-supervisors/import',handle(req=>service.importProfiles(req.body)));
  router.post('/media-supervisors/recommend',handle(req=>service.recommend(req.body)));
  router.get('/media-supervisors/:id',handle(req=>service.get(req.params.id)));
  router.put('/media-supervisors/:id',handle(req=>service.update(req.params.id,req.body)));
  router.delete('/media-supervisors/:id',handle(req=>service.remove(req.params.id,req.body)));
  router.post('/media-supervisors/:id/restore',handle(req=>service.restore(req.params.id,req.body)));
  router.get('/orchestration-sessions/:id/supervisor',handle(req=>({selection:service.context(req.params.id),history:service.history(req.params.id).items,reviews:service.reviews(req.params.id)})));
  router.put('/orchestration-sessions/:id/supervisor',handle(req=>service.choose(req.params.id,req.body)));
  router.post('/orchestration-sessions/:id/supervisor/reviews',handle(req=>service.recordReview(req.params.id,req.body)));
  return router;
};
