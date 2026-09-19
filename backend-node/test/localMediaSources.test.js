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
test('song recovery includes the optional ABC score and detects changes',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'song-sources-'));
 try{
  const lyrics=path.join(root,'lyrics.txt'),score=path.join(root,'score.abc');
  fs.writeFileSync(lyrics,'An original verse');fs.writeFileSync(score,'X:1\nK:C\nC D E F|');
  const request={module_id:'local.audio.neural-song',input_path:lyrics,parameters:{score_file:score}};
  const sources=snapshot(request);assert.equal(sources.length,2);assert.equal(sources[1].role,'song_score');verify(sources);
  assert.equal(sourcesFor({...request,sources:[{role:'score',path:score}]}).length,2);
  fs.writeFileSync(score,'X:2\nK:G\nG A B c|');assert.throws(()=>verify(sources),{code:'INPUT_CHANGED'});
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
