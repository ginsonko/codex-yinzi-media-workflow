'use strict';
const express=require('express');
const {localRequest}=require('./researchPlatformSessions');
const {createResearchJobs}=require('../services/productResearchJobs');
module.exports=function routes(options={}) {
  const service=options.service||createResearchJobs(options), r=express.Router();
  r.use((req,res,next)=>localRequest(req)?next():res.status(403).json({success:false,error:{code:'LOCAL_ORIGIN_REQUIRED',message:'请从本机工作台操作研究任务'}}));
  const handle=fn=>(req,res)=>{try{res.json({success:true,data:fn(req)});}catch(error){res.status(error.code==='RESEARCH_NOT_FOUND'?404:error.code==='RESEARCH_BUSY'||error.code==='REQUEST_KEY_CONFLICT'?409:400).json({success:false,error:{code:error.code||'RESEARCH_ERROR',message:error.message}});}};
  r.get('/',handle(()=>({items:service.list()})));
  r.post('/',handle(req=>service.create(req.body)));
  r.get('/:id',handle(req=>({job:service.get(req.params.id)})));
  r.get('/:id/records',handle(req=>service.records(req.params.id,req.query)));
  r.get('/:id/download',(req,res)=>{try{const buffer=service.download(req.params.id,req.query.v);res.type('application/zip').attachment('video-research-'+req.params.id+'.zip').send(buffer);}catch(error){res.status(404).json({success:false,error:{code:error.code||'RESEARCH_NOT_FOUND',message:error.message}});}});
  r.patch('/:id',handle(req=>({job:service.update(req.params.id,req.body)})));
  for(const action of ['resume','cancel'])r.post('/:id/'+action,handle(req=>({job:service[action](req.params.id,req.body)})));
  r.post('/:id/handoff',handle(req=>service.handoff(req.params.id)));
  r.get('/:id/files/:name',(req,res)=>{try{const file=service.artifact(req.params.id,req.params.name,req.query.v);res.setHeader('X-Content-Type-Options','nosniff');if(req.params.name==='report.html')res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; frame-ancestors 'self'");res.sendFile(file);}catch(error){res.status(404).json({success:false,error:{code:error.code||'RESEARCH_NOT_FOUND',message:error.message}});}});
  r.service=service;return r;
};
