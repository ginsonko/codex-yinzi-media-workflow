'use strict';
const express=require('express');
const sessions=require('../services/researchBrowserSessions');
function localRequest(req) {
  const address=(req.socket.remoteAddress || '').replace(/^::ffff:/,'');
  if(!['127.0.0.1','::1'].includes(address))return false;
  const host=req.get('host');
  try{const destination=new URL('http://'+host);if(!['127.0.0.1','localhost','[::1]'].includes(destination.hostname))return false;
    const origin=req.get('origin');if(origin&&new URL(origin).host!==host)return false;
  }catch{return false;}
  return req.get('sec-fetch-site')!=='cross-site';
}
module.exports=function routes(manager=sessions.getManager()) {
  const r=express.Router();
  r.use((req,res,next)=>localRequest(req)?next():res.status(403).json({success:false,error:{code:'LOCAL_ORIGIN_REQUIRED',message:'平台连接仅限本机工作台'}}));
  r.get('/',(req,res)=>res.json({success:true,data:{platforms:manager.list()}}));
  for(const action of ['open','check','disconnect'])r.post('/:platform/'+action,async(req,res)=>{
    try{await manager[action](req.params.platform);res.json({success:true,data:{platforms:manager.list()}});}
    catch(error){res.status(error.code==='UNKNOWN_PLATFORM'?400:409).json({success:false,error:{code:error.code || 'PLATFORM_SESSION_ERROR',message:error.code?error.message:'平台连接检查失败，请重试'}});}
  });
  return r;
};
module.exports.localRequest=localRequest;
