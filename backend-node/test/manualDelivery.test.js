const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const Database=require('better-sqlite3');const {runMigrationsAndEnsure}=require('../src/db/migrate');const {createMediaBatchService}=require('../src/services/mediaBatchService');
test('manual video remains recoverable until original downloads and restart never regenerates',async()=>{
 const db=new Database(':memory:');const root=fs.mkdtempSync(path.join(os.tmpdir(),'manual-delivery-'));let service;let calls=0;let retryCalls=0;
 const old=console.log;console.log=()=>{};try{runMigrationsAndEnsure(db)}finally{console.log=old}
 const cfg={storage:{local_path:root}};const log={info(){},warn(){},error(){}};
 try {
  const dispatchVideo=body=>{calls++;const r=db.prepare("INSERT INTO video_generations (drama_id,provider,prompt,status,generation_status,download_status,client_request_key,created_at,updated_at) VALUES (0,'test',?,'processing','processing','pending',?,datetime('now'),datetime('now'))").run(body.prompt,body.client_request_key);return {id:Number(r.lastInsertRowid)}};
  service=createMediaBatchService(db,log,{config:cfg,dispatchVideo});
  const body={kind:'video',idempotency_key:'manual-delivery',settings:{_origin:'manual'},concurrency:1,prompt:'fixture',items:[{}]};const batch=service.create(body);
  await service.pump(batch.id);const item=service.get(batch.id).items[0];assert.ok(item.video_id);
  db.prepare("UPDATE video_generations SET generation_status='completed',download_status='failed',download_error='HTTP 401' WHERE id=?").run(item.video_id);
  await service.pump(batch.id);const failed=service.get(batch.id).items[0];assert.equal(failed.status,'needs_review');assert.equal(failed.can_retry_download,true);assert.equal(failed.download_url,null);
  service.stop();
  service=createMediaBatchService(db,log,{config:cfg,dispatchVideo,retryDownload:async(_db,_log,id)=>{retryCalls++;fs.writeFileSync(path.join(root,'recovered.mp4'),Buffer.alloc(5000));db.prepare("UPDATE video_generations SET status='completed',download_status='completed',download_error=NULL,local_path='recovered.mp4' WHERE id=?").run(id)}});
  assert.equal(service.create(body).id,batch.id);assert.equal(service.list({origin:'manual'}).total,1);
  service.retryDownload(batch.id,item.id);await new Promise(resolve=>setImmediate(resolve));await service.pump(batch.id);
  const done=service.get(batch.id).items[0];assert.equal(done.status,'completed');assert.equal(done.file_size,5000);assert.ok(done.download_url);assert.ok(done.asset_id);assert.equal(calls,1);assert.equal(retryCalls,1);
 } finally {service?.stop();db.close();fs.rmSync(root,{recursive:true,force:true})}
});

test('adopts legacy standalone generation history without submitting again',async()=>{
 const db=new Database(':memory:');let service;const old=console.log;console.log=()=>{};try{runMigrationsAndEnsure(db)}finally{console.log=old}
 try {
  const r=db.prepare("INSERT INTO image_generations (drama_id,provider,prompt,status,image_url,created_at,updated_at) VALUES (0,'test','older standalone','completed','https://example.test/image.png',datetime('now'),datetime('now'))").run();
  let submitted=0;service=createMediaBatchService(db,{warn(){}},{dispatchImage:()=>{submitted++;throw new Error('must never resubmit')}});
  service.recoverStandaloneHistory();service.recoverStandaloneHistory();const list=service.list({origin:'manual'});assert.equal(list.total,1);
  await service.pump(list.items[0].id);const item=service.get(list.items[0].id).items[0];assert.equal(item.image_id,Number(r.lastInsertRowid));assert.equal(item.status,'completed');assert.equal(submitted,0);
 } finally {service?.stop();db.close()}
});
