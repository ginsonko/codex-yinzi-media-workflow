const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {run, writeJson} = require('./componentRuntime');
const fail = (code, message) => Object.assign(new Error(message), {code});
const configPath = () => path.resolve(process.env.YINZI_NEURAL_AUDIO_CONFIG || path.join(os.homedir(), '.yinzi-media', 'neural-audio.json'));
const defaults = {threads:4, seed:42, seconds:12, language:'auto', purpose:'personal', timeout_seconds:3600,segment_characters:130};
function validateParameters(raw={}) {
  const allowed=new Set([...Object.keys(defaults),'reference_path','reference_text']);
  for(const key of Object.keys(raw))if(!allowed.has(key))throw fail('INVALID_PARAMETERS',`未支持的音频参数：${key}`);
  const p={...defaults,...raw};
  for(const [key,min,max] of [['threads',1,16],['seed',0,2147483647],['timeout_seconds',60,14400],['segment_characters',30,240]])
    if(!Number.isInteger(p[key]) || p[key]<min || p[key]>max) throw fail('INVALID_PARAMETERS', `${key} 应为 ${min}–${max} 的整数`);
  if(typeof p.seconds!=='number'||!Number.isFinite(p.seconds)||p.seconds<1||p.seconds>30) throw fail('INVALID_PARAMETERS','当前 MusicGen 短配乐支持 1–30 秒');
  if(!['personal','research','commercial'].includes(p.purpose)) throw fail('INVALID_PARAMETERS','purpose 应为 personal、research 或 commercial');
  if(typeof p.language!=='string'||p.language.length>40) throw fail('INVALID_PARAMETERS','language 应为简短语言代码');
  if(p.reference_text!=null && (typeof p.reference_text!=='string'||p.reference_text.length>4000)) throw fail('INVALID_PARAMETERS','参考音转写文本无效');
  if(p.reference_path!=null && (typeof p.reference_path!=='string'||!p.reference_path.trim())) throw fail('INVALID_PARAMETERS','参考录音路径无效');
  return p;
}
function readConfiguration(mode) {
  let cfg;try{cfg=JSON.parse(fs.readFileSync(configPath(),'utf8').replace(/^\uFEFF/,''));}
  catch{throw fail('NEURAL_AUDIO_SETUP_REQUIRED',`本地音频模型尚未配置。请让 Agent 运行 backend-node/scripts/${mode==='song'?'setup-yue2.py --inspect':'setup-neural-audio.py'}，检查硬件并准备独立环境与所选官方模型后恢复此任务。`);}
  const c=cfg[mode];
  if(!c||!c.python||!fs.existsSync(c.python)) throw fail('NEURAL_AUDIO_SETUP_REQUIRED',`尚未准备 ${mode} 环境，请按${mode==='song'?' docs/LOCAL-SONG-YUE2.md':'本地音频指南'}安装后恢复原任务。`);
  if(mode==='song'&&(!c.source_dir||!c.weights_dir||!fs.existsSync(c.source_dir)||!fs.existsSync(c.weights_dir)))throw fail('NEURAL_AUDIO_SETUP_REQUIRED','YuE2 代码或模型目录不可用，请运行 setup-yue2.py --inspect 并修复路径后重试。');
  return {...c,cache_root:cfg.cache_root};
}
function operation(mode) {
  return {
    id:mode==='music'?'local.audio.neural-music':'local.audio.clone-voice',
    title:mode==='music'?'生成本地神经配乐':'用参考声音朗读新文本',
    description:mode==='music'?'MusicGen 短纯音乐，独立CPU环境，权重为非商用许可。':'F5-TTS 参考条件配音，使用本人或已获授权的录音；权重为非商用许可。',
    kind:'audio',component_id:'media.ffmpeg',resource_group:'neural-audio',defaults,
    source:mode==='music'?'https://huggingface.co/facebook/musicgen-small':'https://github.com/SWivid/F5-TTS',
    parameter_schema:{type:'object',properties:{
      threads:{type:'integer',minimum:1,maximum:16,default:4,description:'CPU线程数'},
      seconds:{type:'number',minimum:1,maximum:30,default:12,description:'音乐时长；声音按文本长度生成'},
      seed:{type:'integer',minimum:0,maximum:2147483647,default:42},
      segment_characters:{type:'integer',minimum:30,maximum:240,default:130,description:'配音每段最多字符数'},
      purpose:{type:'string',enum:['personal','research','commercial'],default:'personal',description:'当前模型权重不支持商业用途'},
      ...(mode==='voice'?{reference_path:{type:'string',description:'有使用权限的参考录音路径'},reference_text:{type:'string',description:'参考录音的准确原文'}}:{}),
      timeout_seconds:{type:'integer',minimum:60,maximum:14400,default:3600}
    }},
    validateParameters,
    async executeNative({inputPath,outputPath,parameters,components,report=()=>{}}) {
      const p=validateParameters(parameters);
      if(p.purpose==='commercial') throw fail('MODEL_LICENSE_NOT_SUITABLE','当前 MusicGen/F5 预训练权重仅供非商用。商业项目请使用许可合适的模型或已获授权的在线服务，不会自动产生付费请求。');
      if(fs.statSync(inputPath).size>48003)throw fail('AUDIO_TEXT_TOO_LONG','文本过长，请按章节拆分后合成');
      const text=fs.readFileSync(inputPath,'utf8').replace(/^\uFEFF/,'').trim();
      if(!text||text.includes('\0')||text.includes('\uFFFD')) throw fail('AUDIO_TEXT_INVALID','请提供非空 UTF-8 文本文件');
      if(text.length>(mode==='music'?4000:12000)) throw fail('AUDIO_TEXT_TOO_LONG','文本过长，请按章节拆分后合成');
      if(mode==='voice'&&(!p.reference_path||!p.reference_text?.trim())) throw fail('VOICE_REFERENCE_REQUIRED','需要参考录音和该录音的准确原文');
      const cfg=readConfiguration(mode);
      const outputDir=path.dirname(outputPath), request=path.join(outputDir,'neural-request.json'),receipt=path.join(outputDir,'neural-result.json');
      writeJson(request,{mode,...cfg,text,reference_path:p.reference_path?path.resolve(p.reference_path):null,reference_text:p.reference_text,...p,output:outputPath,receipt});
      report({stage:'model_loading',message:'正在加载本地音频模型；模型已安装时不再下载'});
      let pending='';
      await run(cfg.python,['-X','utf8',path.resolve(__dirname,'../../scripts/neural-audio.py'),'--request',request],{
        timeout:p.timeout_seconds*1000,onOutput:chunk=>{
          pending+=chunk;const lines=pending.split(/\r?\n/);pending=lines.pop();
          for(const line of lines)try{const event=JSON.parse(line);if(event.stage)report({stage:event.stage,message:event.message,completed:event.completed,total:event.total});}catch{}
          if(pending.length>65536)pending=pending.slice(-65536);
        }
      });
      const result=JSON.parse(fs.readFileSync(receipt,'utf8'));
      const bins=components['media.ffmpeg'].executables;
      const probe=JSON.parse((await run(bins.ffprobe,['-v','error','-show_streams','-show_format','-of','json',outputPath])).stdout);
      if(!probe.streams.some(s=>s.codec_type==='audio')||!(Number(probe.format.duration)>0))throw fail('AUDIO_OUTPUT_INVALID','生成音频没有有效声音流');
      await run(bins.ffmpeg,['-nostdin','-v','error','-i',outputPath,'-f','null','-'],{timeout:120000});
      return {...result,quality_status:'review_required',duration_seconds:Number(probe.format.duration),license:'CC-BY-NC-4.0 weights',assets:[{file:'neural-result.json',type:'document',title:'音频生成参数与分段记录'}]};
    }
  };
}
const songDefaults={threads:4,seed:42,seconds:45,steps:32,guidance:1,temperature:1,top_k:100,top_p:.95,mode:0,purpose:'personal',timeout_seconds:3600,style:''};
const songProperties={
  lyrics:{type:'string',maxLength:12000,description:'可选的带 [Verse]/[Chorus] 标签的歌词；不填则读取 input_path UTF-8 文件'},
  text:{type:'string',maxLength:12000,description:'lyrics 的别名；不能与 lyrics 同时提供不同文本'},
  style:{type:'string',maxLength:4000,default:'',description:'语言、音乐风格、人声、情绪曲线、节拍与乐器；不要求所有歌词逐字准确'},
  seconds:{type:'number',minimum:5,maximum:360,default:45,description:'期望最长时长；模型可能提前结束。先做短样再制作整曲'},
  duration_seconds:{type:'number',minimum:5,maximum:360,description:'seconds 的兼容别名'},
  seed:{type:'integer',minimum:0,maximum:2147483647,default:42},
  steps:{type:'integer',minimum:4,maximum:100,default:32,description:'音频合成步数'},
  guidance:{type:'number',minimum:0,maximum:10,default:1},
  temperature:{type:'number',minimum:0,maximum:5,default:1},
  top_k:{type:'integer',minimum:0,maximum:1000,default:100},
  top_p:{type:'number',minimum:0,maximum:1,default:.95},
  mode:{type:'integer',enum:[0,1,2],default:0,description:'0 带和弦谱，1 旋律谱，2 无谱；外部 ABC 仅用于 0/1'},
  score_file:{type:'string',description:'可选的本地 UTF-8 ABC 乐谱，帮助复用旋律，不保证跨语言演唱一模一样'},
  threads:{type:'integer',minimum:1,maximum:32,default:4},
  device:{type:'integer',minimum:0,maximum:15,description:'NVIDIA GPU 编号'},
  gpu_fraction:{type:'number',minimum:.1,maximum:1,description:'单进程显存比例；默认按当前空闲显存预留显示余量'},
  offload_profile:{type:'integer',minimum:1,maximum:5,description:'MMGP 卸载配置，默认 5'},
  vae_tile:{type:'integer',minimum:32,maximum:2048,description:'VAE 分块帧数；低显存默认 64'},
  minimum_free_ram_gib:{type:'number',minimum:0,maximum:256,description:'自定义可用内存保留量，默认 4 GiB'},
  minimum_free_vram_gib:{type:'number',minimum:0,maximum:128,description:'可选的可用显存检查阈值，默认只建议，不以 4.5 GB 硬锁'},
  budgets:{type:'object',additionalProperties:false,description:'MMGP 各模块显存预算（MB）',properties:Object.fromEntries(['text_encoder','transformer','vae','*'].map(k=>[k,{type:'number',minimum:64,maximum:65536}]))},
  save_latents:{type:'boolean',description:'额外保存音频 latent；占用更多磁盘，默认不保存'},
  purpose:{type:'string',enum:['personal','research','commercial'],default:'personal',description:'当前 YuE2 权重为 CC-BY-NC-4.0，商业任务应换许可合适的模型'},
  timeout_seconds:{type:'integer',minimum:60,maximum:14400,default:3600}
};
function validateSongParameters(raw={}) {
  for(const key of Object.keys(raw))if(!Object.hasOwn(songProperties,key))throw fail('INVALID_PARAMETERS',`未支持的歌曲参数：${key}`);
  const p={...songDefaults,...raw};
  if(p.duration_seconds!=null){p.seconds=p.duration_seconds;delete p.duration_seconds;}
  for(const [key,schema] of Object.entries(songProperties)){
    if(p[key]==null)continue;
    const v=p[key];
    if(['number','integer'].includes(schema.type)&&(!Number.isFinite(v)||(schema.type==='integer'&&!Number.isInteger(v))||(schema.minimum!=null&&v<schema.minimum)||(schema.maximum!=null&&v>schema.maximum)))throw fail('INVALID_PARAMETERS',`歌曲参数 ${key} 超出允许范围`);
    if(schema.type==='string'&&(typeof v!=='string'||v.includes('\0')||(schema.maxLength&&v.length>schema.maxLength)))throw fail('INVALID_PARAMETERS',`歌曲参数 ${key} 应为有效文本`);
    if(schema.type==='boolean'&&typeof v!=='boolean')throw fail('INVALID_PARAMETERS',`歌曲参数 ${key} 应为布尔值`);
    if(schema.enum&&!schema.enum.includes(v))throw fail('INVALID_PARAMETERS',`歌曲参数 ${key} 无效`);
  }
  if(p.lyrics!=null&&p.text!=null&&p.lyrics!==p.text)throw fail('INVALID_PARAMETERS','lyrics 和 text 不能提供不同歌词');
  if(p.score_file!=null&&(!p.score_file.trim()||p.mode===2))throw fail('INVALID_PARAMETERS','ABC 乐谱需要有效路径且 mode 为 0 或 1');
  if(p.budgets!=null){
    if(typeof p.budgets!=='object'||Array.isArray(p.budgets))throw fail('INVALID_PARAMETERS','budgets 应为模块预算对象');
    for(const [key,value] of Object.entries(p.budgets))if(!['text_encoder','transformer','vae','*'].includes(key)||!Number.isFinite(value)||value<64||value>65536)throw fail('INVALID_PARAMETERS','MMGP 模块预算无效');
  }
  return p;
}
const songOperation={
  id:'local.audio.neural-song',title:'本地创作带歌词的歌曲',description:'WanGP YuE2 INT8 歌唱与伴奏生成，支持歌词、风格和可选 ABC 谱。运行前检查 NVIDIA 显存、内存与磁盘；约 4.5 GB 是低显存路线而非保证，权重仅供非商用。',
  kind:'audio',phase:'audio',component_id:'media.ffmpeg',resource_group:'neural-audio',defaults:songDefaults,
  source:'https://github.com/deepbeepmeep/Wan2GP',parameter_schema:{type:'object',additionalProperties:false,properties:songProperties},
  validateParameters:validateSongParameters,
  async executeNative({inputPath,outputPath,parameters={},components,report=()=>{}}){
    const p=validateSongParameters(parameters);
    if(p.purpose==='commercial')throw fail('MODEL_LICENSE_NOT_SUITABLE','当前 YuE2 权重采用 CC-BY-NC-4.0。商业歌曲请选许可合适的模型或在线服务；不会自动产生付费请求。');
    let lyrics=p.lyrics??p.text;
    if(lyrics==null){
      if(fs.statSync(inputPath).size>48003)throw fail('AUDIO_TEXT_TOO_LONG','歌词过长，请按歌曲段落拆分');
      lyrics=fs.readFileSync(inputPath,'utf8').replace(/^\uFEFF/,'');
    }
    lyrics=lyrics.trim();
    if(!lyrics||lyrics.includes('\0')||lyrics.includes('\uFFFD')||lyrics.length>12000)throw fail('AUDIO_TEXT_INVALID','请提供非空 UTF-8 歌词，最多 12000 字符；建议先生成一段副歌');
    if(p.score_file){
      const score=path.resolve(p.score_file),stat=fs.statSync(score);
      if(!stat.isFile()||!stat.size||stat.size>256000)throw fail('INVALID_PARAMETERS','ABC 乐谱必须是小于 256 KB 的非空文本文件');
      const text=fs.readFileSync(score,'utf8');
      if(text.includes('\0')||text.includes('\uFFFD')||!text.trim())throw fail('INVALID_PARAMETERS','ABC 乐谱不是有效 UTF-8 文本');
      p.score_file=score;
    }
    const cfg=readConfiguration('song'),dir=path.dirname(outputPath),request=path.join(dir,'yue2-request.json'),receipt=path.join(dir,'yue2-result.json');
    writeJson(request,{...cfg,...p,lyrics,text:lyrics,budgets:{text_encoder:3000,transformer:1700,vae:600,'*':600,...cfg.budgets,...p.budgets},output:outputPath,receipt});
    report({stage:'hardware_check',message:'正在检查本机显存、内存和磁盘，再加载本地歌曲模型'});
    let pending='';
    try{
      await run(cfg.python,['-s','-X','utf8',path.resolve(__dirname,'../../scripts/yue2-audio.py'),'--request',request],{
        timeout:(p.timeout_seconds+30)*1000,onOutput:chunk=>{
          pending+=chunk;const lines=pending.split(/\r?\n/);pending=lines.pop();
          for(const line of lines)try{const event=JSON.parse(line);if(event.stage)report({stage:event.stage,message:event.message,completed:event.completed,total:event.total});}catch{}
          if(pending.length>65536)pending=pending.slice(-65536);
        }
      });
    }catch(error){
      let detail;try{detail=JSON.parse(fs.readFileSync(receipt,'utf8'));}catch{}
      throw fail('SONG_GENERATION_FAILED',detail?.error||error.message);
    }
    const result=JSON.parse(fs.readFileSync(receipt,'utf8'));
    if(result.success!==true)throw fail('SONG_GENERATION_FAILED',result.error||'歌曲生成未完成，已保留阶段记录，可调整后重试');
    const bins=components['media.ffmpeg'].executables;
    const probe=JSON.parse((await run(bins.ffprobe,['-v','error','-show_streams','-show_format','-of','json',outputPath])).stdout);
    if(!probe.streams.some(s=>s.codec_type==='audio')||!(Number(probe.format.duration)>0))throw fail('AUDIO_OUTPUT_INVALID','歌曲没有有效声音流');
    await run(bins.ffmpeg,['-nostdin','-v','error','-i',outputPath,'-f','null','-'],{timeout:120000});
    const assets=[['yue2-result.json','document','歌曲生成参数与资源记录'],['yue2-plan.json','document','原生音乐结构计划'],['composition.abc','document','可复用 ABC 乐谱']].filter(([file])=>fs.existsSync(path.join(dir,file))).map(([file,type,title])=>({file,type,title}));
    return {...result,duration_seconds:Number(probe.format.duration),quality_status:'review_required',assets};
  }
};
module.exports={operations:[operation('music'),operation('voice'),songOperation],validateParameters,validateSongParameters,readConfiguration,configPath};
