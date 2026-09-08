const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),sharp=require('sharp');
const {operations}=require('../src/services/localMediaOperations');
const {execute}=require('../src/services/localMediaExecutor');
(async()=>{
 const root=path.join(os.tmpdir(),'yinzi-new-image-ops'); fs.rmSync(root,{recursive:true,force:true}); fs.mkdirSync(root,{recursive:true});
 const input=path.join(root,'fixture.png'); await sharp({create:{width:120,height:80,channels:4,background:{r:20,g:120,b:220,alpha:1}}}).png().toFile(input);
 const added=operations.filter(o=>o.kind==='image').slice(36),results=[];
 for(const op of added){try{const rec=await execute({module_id:op.id,input_path:input,parameters:op.defaults},{outputDir:path.join(root,op.id.replaceAll('.','_')),manager:{ensureComponent:async()=>({component_id:'media.sharp',version:'0.35.3',directory:path.resolve('.')})}}); results.push({id:op.id,status:rec.status,bytes:rec.bytes});}catch(e){results.push({id:op.id,status:'failed',error:e.message});}}
 console.log(JSON.stringify({count:added.length,passed:results.filter(x=>x.status==='succeeded').length,failed:results.filter(x=>x.status==='failed').length,results},null,2));
})();
