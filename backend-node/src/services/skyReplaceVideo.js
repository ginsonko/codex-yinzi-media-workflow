const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const {run}=require('./componentRuntime');
const {streamDuration}=require('./mediaStreamTiming');
const {transformFrames}=require('./skyVideoStream');
const {createRefinementSession}=require('./skyMaskRefinement');
const {parametersFor,findSkyClassIds,loadLabelMap,resolveModelDir,modelCandidates,maskStats,classifyMask,luminanceMask,compositeSky,runOnnxMask,prepareMask,temporalSmooth,fail,upsampleGray}=require('./skyReplaceCore');
async function probe(binary,file){return JSON.parse((await run(binary,['-v','error','-show_streams','-show_format','-of','json',file])).stdout)}
function sourceAt(sources,index,role){if(!Number.isInteger(index)||!sources[index])throw fail('INVALID_SOURCES',role+'需要有效sources索引');return sources[index].path}
async function executeNative({inputPath,outputPath,parameters:raw={},components,sources=[],report=()=>{},signal}){
  const p=parametersFor(raw),ffmpeg=components['media.ffmpeg'].executables.ffmpeg,ffprobe=components['media.ffmpeg'].executables.ffprobe;
  const sharp=createRequire(path.join(components['media.sharp'].directory,'package.json'))('sharp');sharp.cache(false);sharp.concurrency(2);
  const before=await probe(ffprobe,inputPath),video=before.streams.find(s=>s.codec_type==='video'),audio=before.streams.find(s=>s.codec_type==='audio');
  if(!video)throw fail('INPUT_MISSING','输入没有视频轨');
  const duration=await streamDuration({stream:video,inputPath,ffprobe,runner:run});
  if(!(duration>0))throw fail('INPUT_MISSING','无法读取视频时长');
  const rate=String(video.avg_frame_rate||video.r_frame_rate).split('/').map(Number),fps=rate[0]/rate[1];
  if(!Number.isFinite(fps)||fps<=0)throw fail('INPUT_TIMING','无法确定帧率');
  const list=sources.length?sources:[{path:inputPath}],skyPath=sourceAt(list,p.sky_source,'sky_source');
  const work=path.join(path.dirname(outputPath),'sky-stream');fs.mkdirSync(work,{recursive:true});
  let session,ort,skyIds,model=null,previous,mask,totalCoverage=0,firstCoverage,lastCoverage,sawSky=false,sawMalformed;
  const started=Date.now();
  const refinement=p.refine_edges?createRefinementSession({...p.edge_options,temporalMaxMix:p.temporal_smooth}):null;
  try{
    // Read one auto-oriented frame to establish the decoder's actual geometry.
    const sample=path.join(work,'geometry.png');
    await run(ffmpeg,['-nostdin','-y','-v','error','-i',inputPath,'-frames:v','1',sample]);
    const meta=await sharp(sample).metadata(),width=meta.width,height=meta.height;fs.unlinkSync(sample);
    const skyRgba=await sharp(skyPath,{failOn:'error',limitInputPixels:40000000}).rotate().resize(width,height,{fit:'cover'}).ensureAlpha().toColourspace('srgb').raw().toBuffer();
    if(p.route==='auto'){
      ort=createRequire(path.join(components['vision.sky-seg'].directory,'package.json'))('onnxruntime-node');
      const located=resolveModelDir(modelCandidates(components['vision.sky-seg'].directory,p));if(!located)throw fail('SKY_MODEL_MISSING','未找到已安装的天空分割模型');
      skyIds=findSkyClassIds(loadLabelMap(located.directory).id2label);
      session=await ort.InferenceSession.create(located.onnx,{executionProviders:['cpu'],intraOpNumThreads:2,interOpNumThreads:1});
      model={onnx:located.onnx,sky_class_ids:skyIds};
    }else{
      const rgba=await sharp(sourceAt(list,p.mask_source,'mask_source')).rotate().resize(width,height,{fit:'fill'}).ensureAlpha().raw().toBuffer();
      mask=luminanceMask(rgba,width,height);
    }
    const encoded=path.join(work,'processed.mp4');
    const stream=await transformFrames({ffmpeg,inputPath,outputPath:encoded,width,height,fps,duration,signal,transform:async(base,index)=>{
      let rawMask=mask;
      if(session){
        const size=p.inference_size,rgb=await sharp(base,{raw:{width,height,channels:4}}).resize(size,size,{fit:'fill'}).removeAlpha().toColourspace('srgb').raw().toBuffer();
        const inferred=await runOnnxMask({session,rgb,width:size,height:size,skyIds,ort});
        const hard=await upsampleGray(sharp,inferred.mask,inferred.width,inferred.height,width,height);
        const soft=await upsampleGray(sharp,inferred.probability,inferred.width,inferred.height,width,height);
        rawMask=Buffer.alloc(hard.length);for(let i=0;i<hard.length;i++)rawMask[i]=Math.max(hard[i],soft[i]>=64?soft[i]:0);
      }
      previous=refinement?refinement.next(base,rawMask,width,height).mask:temporalSmooth(previous,rawMask,p.temporal_smooth);
      const prepared=prepareMask(previous,width,height,p),stats=maskStats(prepared),verdict=classifyMask(stats,p);
      totalCoverage+=stats.mean;firstCoverage??=stats.mean;lastCoverage=stats.mean;
      if(verdict.code==='SKY_MASK_INVALID')sawMalformed=verdict;
      if(verdict.usable)sawSky=true;
      if(index===0)await sharp(prepared,{raw:{width,height,channels:1}}).png().toFile(path.join(path.dirname(outputPath),'sky-mask.png'));
      if(index%Math.max(1,Math.round(fps/2))===0)report({stage:'executing',message:'连续处理天空帧 '+(index+1),completed:index+1});
      return verdict.usable?compositeSky({baseRgba:base,skyRgba,mask:prepared,width,height,ambientStrength:p.ambient_strength}):base;
    }});
    if(!sawSky&&sawMalformed)throw fail(sawMalformed.code,sawMalformed.message);
    const videoStart=Number(video.start_time)||0,audioStart=Number(audio?.start_time)||0,offset=audioStart-videoStart;
    if(!sawSky){
      // Remux exact streams when possible; retains their relative timestamps.
      try{await run(ffmpeg,['-nostdin','-y','-v','error','-i',inputPath,'-map','0:v:0','-map','0:a:0?','-c','copy',outputPath])}
      catch{await mux(encoded)}
    }else await mux(encoded);
    async function mux(file){
      const args=['-nostdin','-y','-v','error','-i',file];
      if(audio){
        args.push('-i',inputPath,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac');
        const filters=['asetpts=PTS-STARTPTS'];
        if(offset>0)filters.push('adelay='+Math.round(offset*1000)+':all=1');
        else if(offset<0)filters.push('atrim=start='+(-offset),'asetpts=PTS-STARTPTS');
        filters.push('apad','atrim=duration='+duration);
        args.push('-af',filters.join(','));
      }else args.push('-map','0:v:0','-c:v','copy');
      args.push('-t',String(duration),'-movflags','+faststart',outputPath);await run(ffmpeg,args,{timeout:180000});
    }
    const after=await probe(ffprobe,outputPath),outVideo=after.streams.find(s=>s.codec_type==='video');
    if(!outVideo||(audio&&!after.streams.some(s=>s.codec_type==='audio')))throw fail('OUTPUT_UNPLAYABLE','输出缺少预期声画轨道');
    const outputDuration=await streamDuration({stream:outVideo,inputPath:outputPath,ffprobe,runner:run});
    if(Math.abs(outputDuration-duration)>Math.max(1/fps+0.01,0.04))throw fail('OUTPUT_TIMING','输出视频时长与输入不匹配');
    return{status:sawSky?'succeeded':'unchanged',no_sky:!sawSky,quality_status:sawSky?'review_required':'unchanged',
      before:{width,height,duration,fps,has_audio:Boolean(audio)},after:{duration:outputDuration,has_audio:Boolean(audio)},
      ...stream,route:p.route,model,edge_refinement:Boolean(refinement),processing_seconds:(Date.now()-started)/1000,
      mask_coverage:{mean:totalCoverage/stream.frame_count,first:firstCoverage,last:lastCoverage},
      audio_handling:audio?[{mode:sawSky?'encode_aac':'copy_or_aac',offset_seconds:offset}]:[],
      assets:[{file:'sky-mask.png',type:'image',role:'sky_mask',title:'首帧天空蒙版'}],
      quality_note:!sawSky?'未检测到可替换天空，原样保留，不是分割失败。':p.route==='auto'?'自动分割与蒙版时域平滑；需检查边缘、镜头移动及天空遮挡。':'使用用户蒙版，不代表自动识别效果。'};
  }finally{refinement?.reset();await session?.release?.();fs.rmSync(work,{recursive:true,force:true})}
}
module.exports={id:'local.video.sky-replace',title:'视频天空分割与换天',kind:'video',
  description:'Streaming CPU sky segmentation, compositing and soundtrack preservation.',
  description_zh:'连续解码、逐帧天空分割与融合，保留音视频相对时序；内存占用不随视频时长增长。',
  component_id:'vision.sky-seg',additional_components:['media.sharp','media.ffmpeg'],output_extension:'mp4',
  executeNative,validateParameters:parametersFor,
  defaults:{feather_px:0,ambient_strength:0.18,temporal_smooth:0.25,route:'auto',horizon_blend_px:0},
  inputs:['input_path','sources','parameters'],source:'https://huggingface.co/Xenova/segformer-b0-finetuned-ade-512-512',
  parameter_schema:require('./skyReplaceImage').parameter_schema};
