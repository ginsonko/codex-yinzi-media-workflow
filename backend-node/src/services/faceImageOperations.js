const fs = require('node:fs');
const path = require('node:path');
const { FACE_INFERENCE_SIZE } = require('./faceModelManifest');
const fail = (code,message) => Object.assign(new Error(message),{code});
const clamp = (v,min,max) => Math.max(min,Math.min(max,v));
const defaults = {score_threshold:0.6,nms_threshold:0.3,top_k:500,max_faces:100,max_pixels:24000000,detection_size:640,mask_mode:'blur',face_selection:'all',target_index:0,expand_ratio:0.15,blur_sigma:15,pixelate_block_size:16,grid_cells:3,grid_opacity:0.75,force_user_rect:false};
const bounds = {score_threshold:[0.1,0.99],nms_threshold:[0,1],top_k:[1,5000],max_faces:[1,100],max_pixels:[1024,40000000],detection_size:[FACE_INFERENCE_SIZE,FACE_INFERENCE_SIZE],target_index:[0,99],expand_ratio:[0,1],blur_sigma:[0.3,100],pixelate_block_size:[2,128],grid_cells:[2,12],grid_opacity:[0,1]};
const integerKeys = new Set(['top_k','max_faces','max_pixels','detection_size','target_index','pixelate_block_size','grid_cells']);
function parametersFor(raw={}) {
  const p={...defaults,...raw};
  for(const [key,[min,max]] of Object.entries(bounds)) if(typeof p[key]!=='number'||!Number.isFinite(p[key])||p[key]<min||p[key]>max||(integerKeys.has(key)&&!Number.isInteger(p[key]))) throw fail('INVALID_PARAMETERS',`${key} 需为 ${min}–${max} 的${integerKeys.has(key)?'整数':'数值'}`);
  if(p.detection_size!==FACE_INFERENCE_SIZE) throw fail('INVALID_PARAMETERS',`当前锁定YuNet模型使用固定 ${FACE_INFERENCE_SIZE} 像素输入`);
  if(!['blur','pixelate','eyes','grid'].includes(p.mask_mode)||!['all','largest','primary','index'].includes(p.face_selection)) throw fail('INVALID_PARAMETERS','遮罩模式或人脸选择无效');
  if(typeof p.force_user_rect!=='boolean') throw fail('INVALID_PARAMETERS','force_user_rect 需为布尔值');
  if(p.user_rect!==undefined) {
    const r=p.user_rect;
    if(!r||Array.isArray(r)||['x','y','width','height'].some(k=>typeof r[k]!=='number'||!Number.isFinite(r[k]))||r.x<0||r.y<0||r.width<=0||r.height<=0||r.x+r.width>1||r.y+r.height>1) throw fail('INVALID_PARAMETERS','user_rect 需为图内完整归一化矩形');
  }
  if(p.force_user_rect&&!p.user_rect) throw fail('INVALID_PARAMETERS','强制手动区域时需提供user_rect');
  return p;
}
function overlap(a,b) {
  const width=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x));
  const height=Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
  const intersection=width*height;
  return intersection/Math.max(1,a.width*a.height+b.width*b.height-intersection);
}
// YuNet uses BGR pixels without normalization. Decode in network coordinates,
// suppress overlap, then map boxes and landmarks back to the oriented source.
function decodeYuNet(outputs,{size,width,height,resizedWidth,resizedHeight,parameters:p}) {
  const candidates=[];
  const sx=width/resizedWidth,sy=height/resizedHeight;
  for(const stride of [8,16,32]) {
    const count=(size/stride)**2,cols=size/stride;
    const tensors=Object.fromEntries(['cls','obj','bbox','kps'].map(name=>[name,outputs[`${name}_${stride}`]?.data]));
    if(['cls','obj','bbox','kps'].some(name=>tensors[name]?.length!==count*({bbox:4,kps:10}[name]||1))) throw fail('FACE_MODEL_OUTPUT_INVALID','YuNet模型输出布局不匹配');
    for(let i=0;i<count;i++) {
      const confidence=Math.sqrt(clamp(tensors.cls[i],0,1)*clamp(tensors.obj[i],0,1));
      if(!Number.isFinite(confidence)||confidence<p.score_threshold) continue;
      const col=i%cols,row=Math.floor(i/cols),b=tensors.bbox;
      const cx=(col+b[i*4])*stride,cy=(row+b[i*4+1])*stride;
      const bw=Math.exp(b[i*4+2])*stride,bh=Math.exp(b[i*4+3])*stride;
      if(![cx,cy,bw,bh].every(Number.isFinite)) continue;
      const x=clamp((cx-bw/2)*sx,0,width),y=clamp((cy-bh/2)*sy,0,height);
      const right=clamp((cx+bw/2)*sx,0,width),bottom=clamp((cy+bh/2)*sy,0,height);
      if(right<=x||bottom<=y) continue;
      const names=['right_eye','left_eye','nose_tip','mouth_right','mouth_left'];
      const landmarks=Object.fromEntries(names.map((name,j)=>[name,[(col+tensors.kps[i*10+j*2])*stride*sx,(row+tensors.kps[i*10+j*2+1])*stride*sy]]));
      if(!Object.values(landmarks).flat().every(Number.isFinite)) continue;
      candidates.push({box:{x,y,width:right-x,height:bottom-y},confidence,landmarks,source:'yunet_cpu'});
    }
  }
  const selected=[];
  for(const face of candidates.sort((a,b)=>b.confidence-a.confidence).slice(0,p.top_k)) {
    if(selected.some(other=>overlap(face.box,other.box)>p.nms_threshold)) continue;
    selected.push({...face,index:selected.length,norm_box:{x:face.box.x/width,y:face.box.y/height,width:face.box.width/width,height:face.box.height/height}});
    if(selected.length>=p.max_faces) break;
  }
  return selected;
}
async function detectFaces({sharp,ort,rgba,width,height,componentDir,parameters:p}) {
  const size=p.detection_size,scale=Math.min(size/width,size/height);
  const rw=Math.max(1,Math.round(width*scale)),rh=Math.max(1,Math.round(height*scale));
  const rgb=await sharp(rgba,{raw:{width,height,channels:4}}).flatten({background:'#000000'}).resize(rw,rh,{fit:'fill'}).extend({right:size-rw,bottom:size-rh,top:0,left:0,background:'#000000'}).removeAlpha().raw().toBuffer();
  const pixels=size*size,input=new Float32Array(pixels*3);
  for(let i=0;i<pixels;i++){input[i]=rgb[i*3+2];input[pixels+i]=rgb[i*3+1];input[2*pixels+i]=rgb[i*3];}
  const session=await ort.InferenceSession.create(path.join(componentDir,'models/yunet.onnx'),{executionProviders:['cpu'],intraOpNumThreads:2,interOpNumThreads:1});
  try {
    const outputs=await session.run({[session.inputNames[0]]:new ort.Tensor('float32',input,[1,3,size,size])});
    return decodeYuNet(outputs,{size,width,height,resizedWidth:rw,resizedHeight:rh,parameters:p});
  } finally {await session.release();}
}
function chooseFaces(faces,p,width,height) {
  if(p.face_selection==='index') {
    if(p.target_index>=faces.length) throw fail('FACE_INDEX_OUT_OF_RANGE','target_index 超出本次真实检出人脸范围');
    return [faces[p.target_index]];
  }
  if(p.face_selection==='all') return faces;
  if(!faces.length) return [];
  const area=f=>f.box.width*f.box.height;
  return [[...faces].sort((a,b)=>p.face_selection==='largest'?area(b)-area(a):
    (Math.hypot(a.box.x+a.box.width/2-width/2,a.box.y+a.box.height/2-height/2)-Math.hypot(b.box.x+b.box.width/2-width/2,b.box.y+b.box.height/2-height/2)))[0]];
}
function regionFor(box,width,height,expand=0) {
  const left=clamp(Math.floor(box.x-box.width*expand/2),0,width-1),top=clamp(Math.floor(box.y-box.height*expand/2),0,height-1);
  const right=clamp(Math.ceil(box.x+box.width*(1+expand/2)),left+1,width),bottom=clamp(Math.ceil(box.y+box.height*(1+expand/2)),top+1,height);
  return {left,top,width:right-left,height:bottom-top};
}
async function applyMasks(sharp,original,width,height,targets,p) {
  const output=Buffer.from(original),regions=[];
  for(const face of targets) {
    const r=regionFor(face.box,width,height,p.expand_ratio);regions.push({...r,source:face.source,index:face.index??null});
    const crop=await sharp(original,{raw:{width,height,channels:4}}).extract(r).raw().toBuffer();
    let changed;
    if(p.mask_mode==='blur') changed=await sharp(crop,{raw:{width:r.width,height:r.height,channels:4}}).blur(p.blur_sigma).raw().toBuffer();
    if(p.mask_mode==='pixelate') changed=await sharp(crop,{raw:{width:r.width,height:r.height,channels:4}}).resize(Math.max(1,Math.ceil(r.width/p.pixelate_block_size)),Math.max(1,Math.ceil(r.height/p.pixelate_block_size)),{fit:'fill'}).raw().toBuffer({resolveWithObject:true}).then(({data,info})=>sharp(data,{raw:info}).resize(r.width,r.height,{kernel:'nearest',fit:'fill'}).raw().toBuffer());
    const eyes=face.landmarks;
    const ex=eyes?(eyes.right_eye[0]+eyes.left_eye[0])/2:r.left+r.width/2;
    const ey=eyes?(eyes.right_eye[1]+eyes.left_eye[1])/2:r.top+r.height*0.35;
    const angle=eyes?Math.atan2(eyes.left_eye[1]-eyes.right_eye[1],eyes.left_eye[0]-eyes.right_eye[0]):0;
    const distance=eyes?Math.max(face.box.width*0.3,Math.hypot(eyes.left_eye[0]-eyes.right_eye[0],eyes.left_eye[1]-eyes.right_eye[1])):r.width*0.4;
    for(let y=0;y<r.height;y++) for(let x=0;x<r.width;x++) {
      const target=((y+r.top)*width+x+r.left)*4,source=(y*r.width+x)*4;
      if(changed){for(let c=0;c<3;c++)output[target+c]=changed[source+c];continue;}
      let opacity=0;
      if(p.mask_mode==='grid') {
        const cellX=r.width/p.grid_cells,cellY=r.height/p.grid_cells,line=Math.max(1,Math.min(r.width,r.height)*0.025);
        if(x%cellX<line||y%cellY<line) opacity=p.grid_opacity;
      } else {
        const dx=x+r.left-ex,dy=y+r.top-ey;
        if(Math.abs(dx*Math.cos(angle)+dy*Math.sin(angle))<=distance*1.1&&Math.abs(-dx*Math.sin(angle)+dy*Math.cos(angle))<=Math.max(4,distance*0.3)) opacity=1;
      }
      for(let c=0;c<3;c++) output[target+c]=Math.round(output[target+c]*(1-opacity)+20*opacity);
    }
  }
  return {output,regions};
}
async function processImage({inputPath,outputPath,parameters:raw={},requireComponent,requireComponents,componentDir},detectOnly=false) {
  const p=parametersFor(raw);
  if(path.resolve(inputPath)===path.resolve(outputPath)) throw fail('FACE_OUTPUT_OVERWRITES_INPUT','输出不能覆盖原始素材');
  const sharp=(requireComponents?.['media.sharp']||requireComponent)('sharp');sharp.cache(false);sharp.concurrency(2);
  const started=Date.now();
  const {data:rgba,info}=await sharp(inputPath,{failOn:'error',limitInputPixels:p.max_pixels}).autoOrient().toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const {width,height}=info;
  const faces=p.force_user_rect?[]:await detectFaces({sharp,ort:requireComponent('onnxruntime-node'),rgba,width,height,componentDir,parameters:p});
  const manual=Boolean(p.user_rect&&(p.force_user_rect||!faces.length));
  const targets=manual?[{box:{x:p.user_rect.x*width,y:p.user_rect.y*height,width:p.user_rect.width*width,height:p.user_rect.height*height},source:'user_rect'}]:chooseFaces(faces,p,width,height);
  const result={status:'succeeded',dimensions:{width,height},before:{width,height},detected_count:faces.length,faces,detection_mode:p.force_user_rect?'skipped_manual':'yunet_cpu',manual_region_count:manual?1:0,processing_seconds:0,quality_status:'review_required',quality_note:'请核对真实检出位置。局部视觉遮罩不保证匿名化；图片检测不代表视频跟踪已完成。'};
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});
  if(detectOnly) {result.processing_seconds=(Date.now()-started)/1000;fs.writeFileSync(outputPath,JSON.stringify(result,null,2));return result;}
  const {output,regions}=await applyMasks(sharp,rgba,width,height,targets,p);
  await sharp(output,{raw:{width,height,channels:4}}).png().toFile(outputPath);
  Object.assign(result,{status:targets.length?'succeeded':'unchanged',applied_count:targets.length,applied_regions:regions,after:{width,height,format:'png'},processing_seconds:(Date.now()-started)/1000});
  if(!targets.length){result.quality_status='unchanged';result.quality_note='本次未检出人脸，已原样保留画面。';}
  const receiptFile=path.join(path.dirname(outputPath),path.basename(outputPath,path.extname(outputPath))+'-faces.json');
  fs.writeFileSync(receiptFile,JSON.stringify(result,null,2));
  result.assets=[{file:path.basename(receiptFile),type:'document',role:'face_detection',title:'人脸位置与遮罩区域'}];
  return result;
}
const parameter_schema={type:'object',properties:{...Object.fromEntries(Object.entries(bounds).map(([key,[minimum,maximum]])=>[key,{type:integerKeys.has(key)?'integer':'number',minimum,maximum,default:defaults[key]}])),mask_mode:{type:'string',enum:['blur','pixelate','eyes','grid'],default:'blur'},face_selection:{type:'string',enum:['all','largest','primary','index'],default:'all'},force_user_rect:{type:'boolean',default:false},user_rect:{type:'object',required:['x','y','width','height'],properties:Object.fromEntries(['x','y','width','height'].map(key=>[key,{type:'number',minimum:0,maximum:1}]))}}};
parameter_schema.properties.detection_size={type:'integer',enum:[FACE_INFERENCE_SIZE],default:FACE_INFERENCE_SIZE,description:'锁定ONNX模型的固定输入尺寸；原图按比例缩放并填充，定位映射回原尺寸'};
const common={kind:'image',component_id:'vision.face-detector',additional_components:['media.sharp'],worker_timeout_ms:180000,validateParameters:parametersFor,defaults,parameter_schema,source:'https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet'};
const faceDetectOperation={...common,kind:'document',id:'local.image.face-detect',title:'图片人脸与五点定位',description:'Local CPU YuNet face boxes and landmarks, with bounded inference size.',description_zh:'本地自动定位单脸、多脸与五点关键点，输出位置和置信度；无人脸如实返回零。',output_extension:'json',processFile:context=>processImage(context,true)};
const faceMaskOperation={...common,id:'local.image.face-mask',title:'图片人脸局部遮罩',description:'Face-local blur, pixelation, eye bar or grid while retaining source composition.',description_zh:'自动选择脸部后局部模糊、马赛克、眼部条带或网格，保留原尺寸与其余画面，支持手动区域退路。',output_extension:'png',processFile:context=>processImage(context,false)};
module.exports={faceDetectOperation,faceMaskOperation,parametersFor,decodeYuNet,applyMasks,chooseFaces,regionFor};
