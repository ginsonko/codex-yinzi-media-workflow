const fs=require('node:fs');
const path=require('node:path');
const {run,sha256}=require('./componentRuntime');
function number(value,name,min,max){const n=Number(value);if(!Number.isFinite(n)||n<min||n>max)throw Error(`${name} 应在 ${min} 到 ${max} 之间`);return n;}
function validateCuts(cuts,duration){
 if(!Array.isArray(cuts)||!cuts.length||cuts.length>120)throw Error('需要 1–120 个按交付顺序排列的 cuts');
 return cuts.map(c=>{const start=number(c.start,'镜头起点',0,duration),end=number(c.end,'镜头终点',0,duration);if(end<=start)throw Error('镜头终点必须晚于起点');return{start,end};});
}
async function edit({inputPath,outputPath,parameters:p,components,report}){
 const {ffmpeg,ffprobe}=components['media.ffmpeg'].executables;
 const probe=async file=>JSON.parse((await run(ffprobe,['-v','error','-show_format','-show_streams','-of','json',file])).stdout);
 const before=await probe(inputPath),video=before.streams.find(s=>s.codec_type==='video');if(!video)throw Error('输入需要包含视频');
 const cuts=validateCuts(p.cuts,Number(before.format.duration));
 const duration=cuts.reduce((sum,c)=>sum+c.end-c.start,0);if(duration>600)throw Error('单条输出超过10分钟，请分段处理');
 const width=number(p.width??video.width,'输出宽度',16,4096),height=number(p.height??video.height,'输出高度',16,4096);
 if(width%2||height%2)throw Error('H264 输出宽高需要为偶数');
 const args=['-nostdin','-y','-v','error','-threads','2','-filter_complex_threads','2','-protocol_whitelist','file,pipe','-i',inputPath],chains=[];
 let narration,voiceHash,audioMode='none';
 if(p.narration_path){
  narration=path.resolve(String(p.narration_path));if(!fs.statSync(narration).isFile())throw Error('配音文件不可读取');
  voiceHash=await sha256(narration);const voice=await probe(narration);if(!voice.streams.some(s=>s.codec_type==='audio'))throw Error('配音文件没有音轨');
  if(Number(voice.format.duration)>duration+.05)throw Error('旁白长于成片，请缩短文案或明确调整语速，不能静默截断');
  args.push('-protocol_whitelist','file,pipe','-i',narration);audioMode='narration';
 }else if(before.streams.some(s=>s.codec_type==='audio'))audioMode='source';
 for(const [i,c] of cuts.entries()){
  chains.push(`[0:v:0]trim=start=${c.start}:end=${c.end},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`);
  if(audioMode==='source')chains.push(`[0:a:0]atrim=start=${c.start}:end=${c.end},asetpts=PTS-STARTPTS[a${i}]`);
 }
 chains.push(cuts.map((_,i)=>`[v${i}]${audioMode==='source'?`[a${i}]`:''}`).join('')+`concat=n=${cuts.length}:v=1:a=${audioMode==='source'?1:0}[v]${audioMode==='source'?'[a]':''}`);
 if(audioMode==='narration')chains.push(`[1:a:0]apad,atrim=duration=${duration},loudnorm=I=-16:TP=-1.5:LRA=11[a]`);
 args.push('-filter_complex',chains.join(';'),'-map','[v]');if(audioMode!=='none')args.push('-map','[a]');
 args.push('-t',String(duration),'-r',String(number(p.fps??24,'帧率',1,120)),'-c:v','libx264','-threads','2','-preset','fast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-b:a','160k','-movflags','+faststart',outputPath);
 report({stage:'executing',message:`正在把 ${cuts.length} 个镜头合成为 ${duration.toFixed(2)} 秒成片`});
 await run(ffmpeg,args,{timeout:600000});
 await run(ffmpeg,['-nostdin','-v','error','-i',outputPath,'-f','null','-'],{timeout:120000});
 const after=await probe(outputPath);if(Math.abs(Number(after.format.duration)-duration)>.15)throw Error('输出时长与剪辑计划不一致');
 if(narration&&voiceHash!==await sha256(narration))throw Error('处理期间配音文件发生变化');
 return{before,after,cuts,narration_sha256:voiceHash,audio_mode:audioMode,quality_status:'review_required',quality_note:'剪辑、时长与解码已检查；商品、字幕和口播内容由 Codex 核对。'};
}
module.exports={id:'local.video.edit-timeline',title:'按镜头重剪视频并匹配配音',description:'复用已有合格视频，按起止秒数拼接镜头，可替换旁白；自动保持画幅和检查时长，不重复调用视频模型。',kind:'video',component_id:'media.ffmpeg',source:'https://ffmpeg.org/ffmpeg-filters.html#concat',defaults:{cuts:[{start:0,end:.5}],fps:24},executeNative:edit,validateCuts,parameter_schema:{type:'object',properties:{cuts:{type:'array',items:{type:'object'},title:'镜头起止秒数'},narration_path:{type:'string',title:'配音文件（可选）'},width:{type:'integer',minimum:16,maximum:4096},height:{type:'integer',minimum:16,maximum:4096},fps:{type:'number',minimum:1,maximum:120}}}};
