const fs=require('node:fs'),path=require('node:path');
const express=require('express'),Database=require('better-sqlite3');
const {runMigrationsAndEnsure}=require('../src/db/migrate');
const {createOrchestrationService}=require('../src/services/orchestrationService');
const routesFactory=require('../src/routes/orchestration');
const {buildRuntimeIdentity}=require('../src/services/runtimeIdentity');
const root=path.resolve(process.argv[2]);fs.mkdirSync(root,{recursive:true});
const db=new Database(path.join(root,'acceptance.sqlite'));runMigrationsAndEnsure(db);
const cfg={database:{path:path.join(root,'acceptance.sqlite')},storage:{local_path:path.join(root,'storage')},media_components:{root:path.resolve(process.argv[3]||path.join(root,'components'))}};
const routes=routesFactory(db,console,cfg),orchestration=createOrchestrationService(db);
const session=orchestration.createSession({idempotency_key:'local-media-browser-acceptance',user_goal:'本地组件自动安装与媒体处理实测',title:'本地组件自动安装实测'}).session;
const app=express();app.use(express.json());
for(const prefix of ['/api','/api/v1']){
 app.post(prefix+'/orchestration-sessions',routes.createSession);app.put(prefix+'/orchestration-sessions/:id/plan',routes.submitPlan);
 app.post(prefix+'/orchestration-sessions/:id/nodes/:nodeId/actions/:action',routes.actOnNode);
 app.get(prefix+'/runtime-identity',(_q,res)=>res.json({success:true,data:buildRuntimeIdentity(cfg)}));
 app.get(prefix+'/orchestration-modules',routes.listModules);app.get(prefix+'/media-components/profile',routes.componentProfile);app.get(prefix+'/media-components/:componentId',routes.componentState);
 app.get(prefix+'/local-media/jobs',routes.listLocalMediaJobs);app.post(prefix+'/local-media/jobs',routes.createLocalMediaJob);app.get(prefix+'/local-media/jobs/:jobId',routes.getLocalMediaJob);app.post(prefix+'/local-media/jobs/:jobId/resume',routes.resumeLocalMediaJob);
 app.get(prefix+'/orchestration-sessions/:id',routes.getSession);app.get(prefix+'/orchestration-sessions',routes.listSessions);app.get(prefix+'/orchestration-onboarding',routes.onboarding);
 app.get(prefix+'/orchestration-sessions/:id/artifacts',routes.artifacts);app.get(prefix+'/orchestration-sessions/:id/delivery',routes.delivery);app.get(prefix+'/orchestration-sessions/:id/feedback',routes.feedback);
 app.get(prefix+'/creative-preferences',(_q,res)=>res.json({success:true,data:{unattended_mode:false}}));
}
app.get('/health',(_q,res)=>res.json({status:'ok'}));app.use('/static',express.static(cfg.storage.local_path));
const web=path.resolve(__dirname,'../../frontweb/dist');app.use(express.static(web));app.get('*',(_q,res)=>res.sendFile(path.join(web,'index.html')));
routes.localMediaService.recover();
const server=app.listen(0,'127.0.0.1',()=>{const url='http://127.0.0.1:'+server.address().port;const receipt={url,session_id:session.id,root,pid:process.pid};fs.writeFileSync(path.join(root,'server.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));});
process.on('SIGTERM',async()=>{await routes.localMediaService.close();server.close(()=>{db.close();process.exit();});});
