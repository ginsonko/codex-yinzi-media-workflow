const {test}=require('node:test'), assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const sharp=require('sharp');
const {execute}=require('../src/services/localMediaExecutor');
const {sha256}=require('../src/services/componentRuntime');
const manager={ensureComponent:async()=>({component_id:'media.sharp',version:sharp.versions.sharp,directory:path.resolve(__dirname,'..'),reused:true})};
const pixel=async(file,x,y)=>[...(await sharp(file).extract({left:x,top:y,width:1,height:1}).ensureAlpha().raw().toBuffer())];
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-layers-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const base=path.join(root,'蓝色画布.png'),red=path.join(root,'red.png'),mask=path.join(root,'mask.png');
 await sharp({create:{width:80,height:60,channels:4,background:'blue'}}).png().toFile(base);
 await sharp({create:{width:40,height:20,channels:4,background:'red'}}).png().toFile(red);
 const gray=Buffer.alloc(40*20);for(let y=0;y<20;y++)for(let x=0;x<20;x++)gray[y*40+x]=255;
 await sharp(gray,{raw:{width:40,height:20,channels:1}}).png().toFile(mask);
 return {root,base,red,mask,run:async(layers,name='out')=>execute({module_id:'local.image.composite-layers',input_path:base,sources:[{path:red},{path:mask},{path:base}],parameters:{layers}},{manager,outputDir:path.join(root,name)})};
}
test('real multi-input image composition respects a grayscale mask, opacity and source identity',async t=>{
 const f=await fixture(t), before=await Promise.all([f.base,f.red,f.mask].map(sha256));
 const result=await f.run([{source:0,x:10,y:10,mask_source:1,opacity:0.5}]);
 const mixed=await pixel(result.output_path,15,15);assert.ok(mixed[0]>=127&&mixed[0]<=128);assert.ok(mixed[2]>=127&&mixed[2]<=128);assert.equal(mixed[3],255);
 assert.deepEqual(await pixel(result.output_path,40,15),[0,0,255,255]);
 assert.deepEqual(await Promise.all([f.base,f.red,f.mask].map(sha256)),before);
 assert.equal(result.sources.length,3);assert.equal(result.details.quality_status,'review_required');
});
test('layers clip negative positions, keep single-dimension aspect and render in order',async t=>{
 const f=await fixture(t);
 const result=await f.run([{source:0,x:-10,y:-5},{source:2,width:10,x:0,y:0}]);
 assert.deepEqual(await pixel(result.output_path,0,0),[0,0,255,255]);
 assert.deepEqual(await pixel(result.output_path,12,4),[255,0,0,255]);
 assert.deepEqual(await pixel(result.output_path,30,4),[0,0,255,255]);
 assert.deepEqual([result.details.layers[1].width,result.details.layers[1].height],[10,8]);
 const off=await f.run([{source:0,x:100,y:100}],'off');assert.equal(off.details.layers[0].visible,false);
 assert.deepEqual(await pixel(off.output_path,0,0),[0,0,255,255]);
});
test('invalid indices and modes fail clearly without replacing source files',async t=>{
 const f=await fixture(t);
 for(const layers of [[{source:99}],[{source:0,mask_source:99}],[{source:0,blend:'invalid'}],[{source:0,width:-1}],[]])await assert.rejects(f.run(layers),{code:'IMAGE_LAYERS_INPUT'});
});
