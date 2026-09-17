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
  catch{throw fail('NEURAL_AUDIO_SETUP_REQUIRED','本地音频模型尚未配置。请让 Agent 运行 backend-node/scripts/setup-neural-audio.py，准备独立环境与所选官方模型后恢复此任务。');}
  const c=cfg[mode];
  if(!c||!c.python||!fs.existsSync(c.python)) throw fail('NEURAL_AUDIO_SETUP_REQUIRED',`尚未准备 ${mode} 环境，请按本地音频指南安装后恢复原任务。`);
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
module.exports={operations:[operation('music'),operation('voice')],validateParameters,readConfiguration,configPath};
