const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {pathToFileURL} = require('node:url');
const sharp = require('sharp');
const {localReferencePath, importGenerationReferences} = require('../src/services/localMediaReference');
const {resolveImageRef} = require('../src/services/imageClient');
const {callYinziVideoApi} = require('../src/services/videoClient');
const log={info(){},warn(){},error(){}};

test('explicit external paths and file URLs import without changing originals; media URLs stay scoped',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-reference-'));
  try {
    const storage=path.join(root,'storage'); fs.mkdirSync(storage);
    const source=path.join(root,'用户 素材 #100%.png');
    await sharp({create:{width:128,height:128,channels:3,background:'#24636b'}}).png().toFile(source);
    const bytes=fs.readFileSync(source);
    const imported=importGenerationReferences({storage_local_path:storage,first_frame_url:source,last_frame_url:pathToFileURL(source).href,reference_video_urls:['https://media.example/test.mp4']});
    assert.equal(imported.first_frame_url,imported.last_frame_url);
    assert.match(imported.first_frame_url,/^imports\/[a-f0-9]{64}\.png$/);
    assert.deepEqual(fs.readFileSync(path.join(storage,imported.first_frame_url)),bytes);
    assert.deepEqual(fs.readFileSync(source),bytes);
    assert.equal(importGenerationReferences({...imported,first_frame_url:source}).first_frame_url,imported.first_frame_url);
    assert.equal(fs.readdirSync(path.join(storage,'imports')).length,1);
    assert.equal(localReferencePath(source,storage),source);
    assert.equal(localReferencePath(pathToFileURL(source).href,storage),source);
    assert.equal(localReferencePath(`http://127.0.0.1:5683/static/${imported.first_frame_url}`,storage),fs.realpathSync(path.join(storage,imported.first_frame_url)));
    assert.equal(localReferencePath('../'+path.basename(source),storage),null);
    assert.equal(localReferencePath('/static/%2e%2e/'+encodeURIComponent(path.basename(source)),storage),null);
    assert.equal(localReferencePath('https://external.example/static/'+imported.first_frame_url,storage),null);
    assert.match(resolveImageRef(source,'http://127.0.0.1/static',storage),/^data:image\/png;base64,/);
    assert.throws(()=>importGenerationReferences({storage_local_path:storage,first_frame_url:path.join(root,'missing.png')}),{code:'ENOENT'});
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('first/last frame continuation reaches a local provider using files outside media storage',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-continuation-'));
  const submissions=[];
  const server=http.createServer(async(req,res)=>{
    const chunks=[]; for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString());
    submissions.push(body);
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({id:`clip-${submissions.length}`,status:'queued'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const storage=path.join(root,'storage');fs.mkdirSync(storage);
    const first=path.join(root,'首帧.png'),end=path.join(root,'尾帧.png');
    for (const [filename,color] of [[first,'#245ab0'],[end,'#b05524']]) await sharp({create:{width:320,height:240,channels:3,background:color}}).png().toFile(filename);
    const config={base_url:`http://127.0.0.1:${server.address().port}/v1`,endpoint:'/videos'};
    const input={model:'user-selected-model',prompt:'continue motion',duration:6,storage_local_path:storage,contract_validation_mode:'strict'};
    const one=await callYinziVideoApi(null,config,log,{...input,first_frame_url:first,last_frame_url:pathToFileURL(end).href});
    assert.equal(one.submission_status,'accepted');
    // The preceding clip's extracted frame is just another user-owned file.
    const extracted=path.join(root,'上一段 已抽尾帧.png');fs.copyFileSync(end,extracted);
    const next=await callYinziVideoApi(null,config,log,{...input,first_frame_url:extracted,last_frame_url:first});
    assert.equal(next.submission_status,'accepted');
    assert.equal(submissions.length,2);
    assert.deepEqual(submissions[0].references.map(r=>r.role),['first_frame','last_frame']);
    assert.ok(submissions.every(s=>s.duration===6 && s.references.every(r=>r.data_url.startsWith('data:image/'))));
    assert.equal(submissions[1].references[0].data_url,submissions[0].references[1].data_url);
    assert.equal(JSON.stringify(submissions).includes(root),false);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});
