const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const {writeJson}=require('./componentRuntime');
const fail=message=>Object.assign(Error(message),{code:'PRESENTATION_INPUT_INVALID'});
const themes={night:{background:'111B2B',panel:'1B2A40',ink:'F4F7FB',muted:'B5C2D6',accent:'76DACB'},paper:{background:'F4F1EA',panel:'FFFFFF',ink:'162333',muted:'516477',accent:'087F83'}};
function validate(spec){
 if(!spec||typeof spec!=='object'||Array.isArray(spec))throw fail('课件输入应为 JSON 对象');
 if(!Array.isArray(spec.slides)||spec.slides.length<1||spec.slides.length>100)throw fail('课件需包含 1–100 页');
 if(spec.theme!=null&&!Object.hasOwn(themes,spec.theme))throw fail('theme 应为 night 或 paper');
 const string=(s,label,max)=>{if(typeof s!=='string'||!s.trim()||s.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s))throw fail(`${label} 需为 1–${max} 字的文本`);};
 string(spec.title,'标题',100);if(spec.font!=null)string(spec.font,'字体',80);
 for(const [key,value]of Object.entries(spec.colors||{}))if(!['background','panel','ink','muted','accent'].includes(key)||!/^[0-9A-F]{6}$/i.test(value))throw fail('colors 仅接受主题颜色名与六位 HEX 色值');
 for(const [i,s]of spec.slides.entries()){
  if(!s||typeof s!=='object')throw fail(`第 ${i+1} 页格式无效`);
  string(s.title,`第 ${i+1} 页标题`,90);
  if(s.subtitle!=null)string(s.subtitle,'副标题',220);
  if(s.notes!=null)string(s.notes,'讲者备注',12000);
  if(!Array.isArray(s.blocks)||s.blocks.length<1||s.blocks.length>2)throw fail('每页需 1–2 个内容块；更多内容请拆页');
  for(const b of s.blocks){
   if(!b||!['text','table','chart'].includes(b.type))throw fail('内容块支持 text、table、chart');
   if(b.heading!=null)string(b.heading,'内容标题',55);
   if(b.type==='text'){
    if(!Array.isArray(b.paragraphs)||b.paragraphs.length<1||b.paragraphs.length>8)throw fail('文字块需 1–8 段');
    b.paragraphs.forEach(t=>string(t,'正文段落',600));
   }else if(b.type==='table'){
    if(!Array.isArray(b.rows)||b.rows.length<1||b.rows.length>12||!Array.isArray(b.rows[0])||b.rows[0].length<1||b.rows[0].length>6)throw fail('表格支持 1–12 行、1–6 列');
    const cols=b.rows[0].length;
    for(const row of b.rows){if(!Array.isArray(row)||row.length!==cols)throw fail('表格每行列数必须一致');row.forEach(v=>{if(!['number','string'].includes(typeof v)||(typeof v==='number'&&!Number.isFinite(v))||String(v).length>120)throw fail('表格值无效或过长');});}
   }else{
    if(!Array.isArray(b.series)||b.series.length<1||b.series.length>6)throw fail('图表需 1–6 组数据');
    if(b.x_label!=null)string(b.x_label,'横轴名',60);if(b.y_label!=null)string(b.y_label,'纵轴名',60);
    for(const series of b.series){string(series.name,'数据组名',60);if(!Array.isArray(series.x)||!Array.isArray(series.y)||series.x.length!==series.y.length||series.x.length<2||series.x.length>400||[...series.x,...series.y].some(v=>typeof v!=='number'||!Number.isFinite(v)))throw fail('XY 数据需等长且为 2–400 个有限数值');}
    const first=b.series[0].x;if(b.series.some(s=>s.x.some((v,i)=>v!==first[i])||s.x.length!==first.length))throw fail('此 XY 图需要各数据组共用横坐标；请先插值到共同坐标或拆成不同图表');
   }
  }
 }
 return spec;
}
function layout(spec){
 validate(spec);const warnings=[],pages=[];
 for(const [i,s]of spec.slides.entries()){
  const columns=s.blocks.length,w=columns===1?11.89:5.79,gap=.3,x0=.72;
  const boxes=s.blocks.map((b,j)=>({block:b,x:x0+j*(w+gap),y:2.12,w,h:4.42}));
  for(const {block:b,w:width}of boxes){
   const capacity=Math.floor((width-.56)*72/19*.82),lines=b.type==='text'?b.paragraphs.reduce((sum,t)=>sum+Math.ceil([...t].reduce((n,c)=>n+(/[\u2E80-\uFFFF]/.test(c)?1:.55),0)/capacity)+.65,0):0;
   if(lines>11.5)warnings.push({slide:i+1,type:'text_density',message:'文字可能过密，请缩短或拆页后再渲染确认'});
   if(b.type==='table'&&b.rows.some(row=>row.some(v=>String(v).length>Math.floor(width/b.rows[0].length*6))))warnings.push({slide:i+1,type:'table_density',message:'表格长单元格需渲染检查'});
  }
  pages.push({slide:i+1,boxes});
 }
 return{pages,warnings};
}
async function build(spec,outputPath,{PptxGenJS,report=()=>{}}){
 validate(spec);if(fs.existsSync(outputPath))throw Object.assign(Error('输出已存在，请保留原稿并使用新版本路径'),{code:'OUTPUT_EXISTS'});
 const plan=layout(spec),colors={...themes[spec.theme||'night'],...spec.colors},font=spec.font||'Microsoft YaHei';
 const ppt=new PptxGenJS();ppt.layout='LAYOUT_WIDE';ppt.author=spec.author||'银子媒体工作流';ppt.subject=spec.title;ppt.title=spec.title;ppt.lang='zh-CN';ppt.theme={headFontFace:font,bodyFontFace:font,lang:'zh-CN'};
 const add=(slide,text,box,size,color=colors.ink,extra={})=>slide.addText(text,{...box,fontFace:font,fontSize:size,color,margin:0,breakLine:false,fit:'resize',...extra});
 for(const [i,s]of spec.slides.entries()){
  const slide=ppt.addSlide();slide.background={color:colors.background};
  slide.addShape(ppt.ShapeType.rect,{x:.72,y:.56,w:.4,h:.045,line:{color:colors.accent,transparency:100},fill:{color:colors.accent}});
  add(slide,s.title,{x:.72,y:.81,w:11.89,h:.66},30,colors.ink,{bold:true});
  if(s.subtitle)add(slide,s.subtitle,{x:.74,y:1.59,w:11.75,h:.34},13,colors.muted);
  for(const {block:b,x,y,w,h}of plan.pages[i].boxes){
   slide.addShape(ppt.ShapeType.roundRect,{x,y,w,h,rectRadius:.15,radius:.15,line:{color:colors.panel,transparency:100},fill:{color:colors.panel}});
   if(b.heading)add(slide,b.heading,{x:x+.28,y:y+.23,w:w-.56,h:.4},18,colors.accent,{bold:true});
   const contentY=y+(b.heading? .89:.3),contentH=h-(b.heading?1.15:.6);
   if(b.type==='text')add(slide,b.paragraphs.join('\n\n'),{x:x+.28,y:contentY,w:w-.56,h:contentH},19,colors.ink,{valign:'top',paraSpaceAfterPt:9,breakLine:false});
   if(b.type==='table')slide.addTable(b.rows.map((row,ri)=>row.map(value=>({text:String(value),options:{bold:ri===0,color:ri===0?colors.background:colors.ink,fill:ri===0?colors.accent:colors.panel}}))),{x:x+.28,y:contentY,w:w-.56,h:contentH,fontFace:font,fontSize:Math.min(17,150/b.rows.length),color:colors.ink,margin:.08,border:{type:'solid',pt:.7,color:colors.muted},autoPage:false});
   if(b.type==='chart'){
    const data=[{name:b.x_label||'x',values:b.series[0].x},...b.series.map(series=>({name:series.name,values:series.y}))];
    slide.addChart(ppt.ChartType.scatter,data,{x:x+.18,y:contentY,w:w-.36,h:contentH,
      showTitle:false,showLegend:b.series.length>1,legendColor:colors.muted,legendFontSize:11,
      chartColors:[colors.accent,'E6B56A','92A9EE'],showLine:true,lineSize:2,showMarker:false,
      catAxisLabelColor:colors.muted,valAxisLabelColor:colors.muted,catAxisLabelFontSize:11,valAxisLabelFontSize:11,
      catAxisTitle:b.x_label||'x',valAxisTitle:b.y_label||'y',showCatAxisTitle:true,showValAxisTitle:true,showCatName:false,showValue:false,
      catAxisTitleColor:colors.muted,valAxisTitleColor:colors.muted,
      chartArea:{fill:{color:colors.panel}},plotArea:{fill:{color:colors.panel}},showBorder:false});
   }
  }
  add(slide,spec.title,{x:.74,y:6.91,w:10.8,h:.2},9,colors.muted);add(slide,String(i+1).padStart(2,'0'),{x:11.96,y:6.87,w:.6,h:.26},11,colors.accent,{align:'right'});
  if(s.notes)slide.addNotes(s.notes);
  report({stage:'slide_built',message:`已组织第 ${i+1}/${spec.slides.length} 页`,completed:i+1,total:spec.slides.length});
 }
 const temp=path.join(path.dirname(outputPath),`.draft-${crypto.randomUUID()}.pptx`);fs.mkdirSync(path.dirname(outputPath),{recursive:true});
 try{await ppt.writeFile({fileName:temp,compression:true});fs.linkSync(temp,outputPath);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
 return{slides:spec.slides.length,native_objects:['text','tables','XY charts','speaker notes'],theme:spec.theme||'night',warnings:plan.warnings,quality_status:'review_required',animation:'none; native postprocessing is separate'};
}
const operation={id:'local.document.editable-pptx',title:'制作可编辑课件与演示文稿',description:'按 JSON 内容与主题生成原生文字、表格、XY 图表和备注，输出 PPTX；布局需查看实际渲染。',kind:'document',output_extension:'pptx',component_id:'document.pptx',defaults:{},source:'https://github.com/gitbrent/PptxGenJS',parameter_schema:{type:'object',properties:{}},
 async executeNative({inputPath,outputPath,components,report}){
  if(fs.statSync(inputPath).size>5*1024**2)throw fail('JSON 内容过大，请拆分课件');
  const spec=JSON.parse(fs.readFileSync(inputPath,'utf8').replace(/^\uFEFF/,''));
  const PptxGenJS=createRequire(path.join(components['document.pptx'].directory,'package.json'))('pptxgenjs');
  const result=await build(spec,outputPath,{PptxGenJS,report});writeJson(path.join(path.dirname(outputPath),'presentation-review.json'),result);
  return{...result,assets:[{file:'presentation-review.json',type:'document',title:'课件结构与排版提示'}]};
 }};
module.exports={operation,validate,layout,build};
