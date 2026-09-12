const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {uploadMetadata,appendReferenceFile}=require('../src/utils/uploadMetadata');
const {localImageDataUrl}=require('../src/services/videoClient');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1kAAAAASUVORK5CYII=','base64');
test('multipart names are ASCII and bytes/MIME survive spaces, Unicode, quotes and CRLF',async()=>{
 for(const name of ['威廉明娜.jpg','a b #兽设.png','bad"\r\nContent-Type: text/plain\r\n.png','C:/媒体/@参考 ?.png']){
  const form=new FormData();form.append('purpose','user_data');const metadata=appendReferenceFile(form,'file',png,name,'image/jpeg');
  const response=new Response(form),parsed=await response.formData(),file=parsed.get('file');
  assert.match(file.name,/^reference-[0-9a-f]{20}\.png$/);assert.equal(file.type,'image/png');assert.deepEqual(Buffer.from(await file.arrayBuffer()),png);assert.equal(parsed.get('purpose'),'user_data');assert.equal(metadata.detected,true);
 }
});
test('unknown formats keep valid extension/type; known MP4, WAV and WebP use bytes',()=>{
 const unknown=uploadMetadata(Buffer.from('unknown'),'custom.reference','video/x-vendor');assert.equal(unknown.mime,'video/x-vendor');assert.ok(unknown.filename.endsWith('.reference'));assert.equal(unknown.detected,false);
 assert.equal(uploadMetadata(Buffer.from('unknown'),'bad.\r\nx','text/plain\r\nInjected:x').mime,'application/octet-stream');
 const mp4=Buffer.from([0,0,0,24,...Buffer.from('ftypisom')]);assert.equal(uploadMetadata(mp4,'video weird name.bin').mime,'video/mp4');
 assert.equal(uploadMetadata(Buffer.from('RIFF1234WAVE'),'music.mp4').mime,'audio/wav');
 assert.equal(uploadMetadata(Buffer.from('RIFF1234WEBP'),'x.jpg').mime,'image/webp');
});
test('inline local image corrects a misleading extension without changing the source',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-upload-mime-')),file=path.join(root,'portrait.jpg');
 try{fs.writeFileSync(file,png);const result=localImageDataUrl(file);assert.equal(result.mime,'image/png');assert.ok(result.data_url.startsWith('data:image/png;base64,'));assert.deepEqual(fs.readFileSync(file),png);}
 finally{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}
});
