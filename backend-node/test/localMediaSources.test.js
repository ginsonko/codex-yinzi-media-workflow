const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {snapshot,sourcesFor,verify}=require('../src/services/localMediaSources');
test('all source identities and legacy narration are checked without changing source indices',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'media-sources-'));
 try{
  const first=path.join(root,'first.png'),second=path.join(root,'中文 配音.wav');fs.writeFileSync(first,'first');fs.writeFileSync(second,'second');
  const req={module_id:'local.video.edit-timeline',input_path:first,parameters:{narration_path:second}};
  const sources=snapshot(req);assert.equal(sources.length,2);assert.equal(sources[1].role,'narration');verify(sources);
  const reversed=sourcesFor({...req,sources:[{role:'audio',path:second},{role:'video',path:first}]});assert.equal(reversed[0].path,second);assert.equal(reversed.length,2);
  fs.writeFileSync(second,'new content');assert.throws(()=>verify(sources),{code:'INPUT_CHANGED'});
  assert.throws(()=>snapshot({...req,sources:[]}),{code:'INVALID_SOURCES'});
  assert.throws(()=>snapshot({...req,sources:[{}]}),{code:'INVALID_SOURCES'});
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
