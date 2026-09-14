const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const sharp=require('sharp');
const {parametersFor,applyMasks,decodeYuNet,faceMaskOperation,faceDetectOperation,chooseFaces}=require('../src/services/faceImageOperations');
test('face parameters reject ambiguous coordinates, invalid indices and unbounded inference',()=>{
 for(const p of [{target_index:0.5},{detection_size:641},{detection_size:320},{detection_size:1280},{max_pixels:Infinity},{score_threshold:'0.6'},{force_user_rect:true},{force_user_rect:'false'},{user_rect:{x:0.9,y:0,width:0.2,height:1}}])assert.throws(()=>parametersFor(p),{code:'INVALID_PARAMETERS'});
 assert.throws(()=>chooseFaces([],parametersFor({face_selection:'index'}),20,20),{code:'FACE_INDEX_OUT_OF_RANGE'});
});
test('YuNet BGR output uses network stride and remaps source geometry without inferred faces',()=>{
 const size=320,outputs={};for(const s of [8,16,32])for(const [name,n]of [['cls',1],['obj',1],['bbox',4],['kps',10]])outputs[`${name}_${s}`]={data:new Float32Array((size/s)**2*n)};
 assert.equal(decodeYuNet(outputs,{size,width:640,height:320,resizedWidth:320,resizedHeight:160,parameters:parametersFor()}).length,0);
 const i=10*40+10;outputs.cls_8.data[i]=0.9;outputs.obj_8.data[i]=0.9;outputs.bbox_8.data.set([0.5,0.5,Math.log(4),Math.log(6)],i*4);
 const faces=decodeYuNet(outputs,{size,width:640,height:320,resizedWidth:320,resizedHeight:160,parameters:parametersFor()});
 assert.equal(faces.length,1);assert.ok(Math.abs(faces[0].box.x-136)<0.001);assert.ok(Math.abs(faces[0].box.height-96)<0.001);
 delete outputs.kps_16;assert.throws(()=>decodeYuNet(outputs,{size,width:640,height:320,resizedWidth:320,resizedHeight:160,parameters:parametersFor()}),{code:'FACE_MODEL_OUTPUT_INVALID'});
});
test('all local mask styles retain alpha and every pixel outside target areas',async()=>{
 const width=48,height=32,raw=Buffer.alloc(width*height*4);for(let i=0;i<raw.length;i++)raw[i]=(i*19+i%7)%256;
 for(const mask_mode of ['blur','pixelate','eyes','grid']){
  const {output,regions}=await applyMasks(sharp,raw,width,height,[{box:{x:8,y:5,width:20,height:20},source:'user_rect'}],parametersFor({mask_mode,expand_ratio:0}));
  let changed=0;for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4;assert.equal(output[i+3],raw[i+3]);if(x<8||x>=28||y<5||y>=25)assert.deepEqual(output.subarray(i,i+4),raw.subarray(i,i+4));else if(output[i]!==raw[i])changed++;}
  assert.ok(changed,mask_mode);assert.equal(regions[0].source,'user_rect');
 }
});
test('manual region is not a detected face; orientation and transparent PNG survive real processor',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-face-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const input=path.join(root,'source.png'),output=path.join(root,'out.png');
 await sharp({create:{width:50,height:30,channels:4,background:{r:100,g:120,b:130,alpha:0.4}}}).png().toFile(input);
 const before=fs.readFileSync(input),ctx={inputPath:input,outputPath:output,parameters:{force_user_rect:true,user_rect:{x:0.2,y:0.2,width:0.5,height:0.5},mask_mode:'grid'},requireComponent:name=>{assert.equal(name,'sharp');return sharp;}};
 const r=await faceMaskOperation.processFile(ctx);assert.equal(r.detected_count,0);assert.equal(r.manual_region_count,1);assert.equal(r.applied_count,1);assert.deepEqual(r.faces,[]);assert.ok(fs.readFileSync(input).equals(before));
 const a=await sharp(input).raw().toBuffer(),b=await sharp(output).raw().toBuffer();for(let i=3;i<a.length;i+=4)assert.equal(a[i],b[i]);
 await assert.rejects(faceMaskOperation.processFile({...ctx,outputPath:input}),{code:'FACE_OUTPUT_OVERWRITES_INPUT'});
 const rotated=path.join(root,'oriented.jpg');await sharp({create:{width:60,height:30,channels:3,background:'red'}}).jpeg().withMetadata({orientation:6}).toFile(rotated);
 const oriented=await faceMaskOperation.processFile({...ctx,inputPath:rotated});assert.deepEqual(oriented.dimensions,{width:30,height:60});
 await assert.rejects(faceMaskOperation.processFile({...ctx,parameters:{...ctx.parameters,max_pixels:1024}}),/pixel limit/);
 fs.writeFileSync(path.join(root,'broken.png'),'invalid');await assert.rejects(faceMaskOperation.processFile({...ctx,inputPath:path.join(root,'broken.png')}),/unsupported image/);
});
test('component and local contracts are visible and fixed CPU manifest is installable',()=>{
 const {registry}=require('../src/services/componentRuntime');
 const m=registry().find(c=>c.component_id==='vision.face-detector');assert.ok(m);assert.ok(m.sha256);assert.equal(m.kind,'npm');assert.equal(m.artifacts.length,1);assert.match(m.artifacts[0].urls[0],/f12e12798e8314f7c074a6656816c048dcc95b7a/);
 const {getOperation}=require('../src/services/localMediaOperations');assert.equal(getOperation(faceMaskOperation.id),faceMaskOperation);assert.equal(getOperation(faceDetectOperation.id),faceDetectOperation);
});