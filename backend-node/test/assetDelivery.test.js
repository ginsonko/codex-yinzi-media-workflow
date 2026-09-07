const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const Database=require('better-sqlite3');
const {runMigrationsAndEnsure}=require('../src/db/migrate');
const assets=require('../src/services/assetService');
test('local original is imported once, renamed without changing references, and measured from configured storage',()=>{
 const db=new Database(':memory:');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-assets-'));const cfg={storage:{local_path:dir}};
 const quiet=console.log;console.log=()=>{};try{runMigrationsAndEnsure(db)}finally{console.log=quiet}
 try {
  fs.mkdirSync(path.join(dir,'videos'));fs.writeFileSync(path.join(dir,'videos','original.mp4'),Buffer.alloc(4096,1));
  const id=db.prepare("INSERT INTO video_generations (drama_id,provider,prompt,status,local_path,created_at,updated_at) VALUES (0,'test','original','completed','videos/original.mp4',datetime('now'),datetime('now'))").run().lastInsertRowid;
  const first=assets.importFromVideo(db,{},id,cfg);
  assets.update(db,{},first.id,{name:'我的原版视频'},cfg);
  const second=assets.importFromVideo(db,{},id,cfg);
  assert.equal(second.id,first.id);assert.equal(second.name,'我的原版视频');assert.equal(second.local_path,'videos/original.mp4');assert.equal(second.file_size,4096);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assets').get().n,1);
  assert.equal(second.download_url,`/api/v1/assets/${first.id}/download`);
  assert.equal(assets.localFileMetadata('../outside.mp4',cfg),null);
  fs.unlinkSync(path.join(dir,'videos','original.mp4'));
  assert.equal(assets.getById(db,first.id,cfg).available,false);
  assert.throws(()=>assets.importFromVideo(db,{},id,cfg),/尚未保存/);
 } finally {db.close();fs.rmSync(dir,{recursive:true,force:true})}
});
