const PptxGenJS=require('pptxgenjs');
(async()=>{const p=new PptxGenJS();p.addSlide().addText('可编辑课件',{x:1,y:1,w:6,h:1});const b=await p.write({outputType:'nodebuffer'});if(b[0]!==80||b[1]!==75)throw Error('PPTX container invalid');console.log(JSON.stringify({engine:'pptxgenjs',version:'4.0.1',bytes:b.length}));})().catch(e=>{console.error(e.message);process.exitCode=1;});
