const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn, spawnSync} = require('node:child_process');
const {writeJson} = require('./componentRuntime');
const fail = (code,message) => Object.assign(new Error(message),{code});
const defaults = {profile:'h3-turbo8',frames:107,width:832,height:480,fps:24,seed:42,threads:4,timeout_seconds:7200,audio:'none'};
const properties = {
  audio:{type:'string',enum:['none','native'],default:'none',description:'默认静音素材：采样退出后独立解码以降低内存。native 联合生成音频占用更多内存，需另行听审'},
  profile:{type:'string',enum:['h3-turbo8'],default:'h3-turbo8',description:'经实测的 H3 INT8 + 已训练 Turbo8；其它模型暂仅作选型参考'},
  frames:{type:'integer',minimum:11,maximum:363,default:107,description:'帧数为 3+8*n；107 帧约 4.46 秒，较长设置尚未在本机验证'},
  width:{type:'integer',minimum:256,maximum:1920,default:832,description:'32 的整数倍；实测横屏 832×480'},
  height:{type:'integer',minimum:256,maximum:1920,default:480,description:'32 的整数倍；增大画幅会增加内存和时间'},
  fps:{type:'integer',enum:[24],default:24},
  seed:{type:'integer',minimum:0,maximum:2147483647,default:42},
  threads:{type:'integer',minimum:1,maximum:32,default:4},
  device:{type:'integer',minimum:0,maximum:15,description:'可选 NVIDIA GPU 编号，默认读取本地配置'},
  timeout_seconds:{type:'integer',minimum:60,maximum:28800,default:7200,description:'真实运行时限；超时停止本任务进程并保留中间结果'}
};
function validate(raw={},recover=false) {
  if(!raw || typeof raw!=='object' || Array.isArray(raw))throw fail('INVALID_PARAMETERS','本地视频参数应为对象');
  const allowed=recover?['timeout_seconds','device']:Object.keys(properties);
  for(const key of Object.keys(raw))if(!allowed.includes(key))throw fail('INVALID_PARAMETERS',`未支持的本地视频参数：${key}`);
  const p={...(recover?{timeout_seconds:7200}:defaults),...raw};
  for(const [key,value] of Object.entries(p)){
    const s=properties[key];
    if(s.enum&&!s.enum.includes(value) || s.type==='integer'&&(!Number.isInteger(value)||value<(s.minimum??-Infinity)||value>(s.maximum??Infinity)))throw fail('INVALID_PARAMETERS',`本地视频参数 ${key} 无效`);
  }
  if(!recover&&((p.frames-3)%8||p.width%32||p.height%32))throw fail('INVALID_PARAMETERS','帧数必须是 3+8*n，宽高必须是 32 的整数倍');
  return p;
}
function configuration(){
  const file=path.resolve(process.env.YINZI_LOCAL_VIDEO_CONFIG||path.join(os.homedir(),'.yinzi-media/local-video.json'));
  let cfg;
  try {cfg=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}
  catch {throw fail('LOCAL_VIDEO_SETUP_REQUIRED',`本地视频尚未配置。请让 Agent 运行 backend-node/scripts/setup-local-video.py --inspect，按方案准备隔离环境和模型后恢复原任务。配置位置：${file}`);}
  if(!cfg.h3||typeof cfg.h3.python!=='string'||!fs.existsSync(cfg.h3.python))throw fail('LOCAL_VIDEO_SETUP_REQUIRED','本地 H3 Python 不可用；运行 setup-local-video.py --inspect 修复配置，原任务保留。');
  return {...cfg.h3,cache_root:cfg.cache_root};
}
function runOwned(executable,args,{timeout,onEvent}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{windowsHide:true,shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    let pending='',error='',timedOut=false;
    const stop=()=>{
      if(!child.pid||child.exitCode!==null)return;
      if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:15000});
      else try{process.kill(-child.pid,'SIGTERM');}catch{}
    };
    process.once('exit',stop);
    const timer=setTimeout(()=>{timedOut=true;stop();},timeout);
    const cleanup=()=>{clearTimeout(timer);process.removeListener('exit',stop);};
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',bytes=>{
      pending+=bytes;const lines=pending.split(/\r?\n/);pending=lines.pop();
      for(const line of lines)try{const e=JSON.parse(line);if(e.stage)onEvent(e);}catch{}
      if(pending.length>65536)pending=pending.slice(-65536);
    });
    child.stderr.on('data',b=>{error=(error+b).slice(-5000);});
    child.on('error',e=>{cleanup();reject(e);});
    child.on('close',code=>{
      cleanup();
      if(timedOut)reject(fail('LOCAL_VIDEO_TIMEOUT','本地视频超过运行时限，已停止本任务进程；请查看 local-video/recovery.json 恢复已保存的结果。'));
      else if(code)reject(fail('LOCAL_VIDEO_FAILED',`本地视频未完成 (${code})：${error.slice(-1800)}`));
      else resolve();
    });
  });
}
function operation(recover=false){
  return {
    id:recover?'local.video.recover':'local.video.generate',
    title:recover?'恢复本地视频解码与导出':'用本机 H3 生成视频素材',
    description:recover?'从已保存的像素或有限 latent 恢复视频，不重新采样；保留原失败记录。':'可选的本地 H3 Turbo8 视频生成，无视频 API 费用。按电脑、时限和素材要求选择，先检查硬件并按需安装；Windows NVIDIA 已实测，画面必须另行审片。',
    kind:'video',phase:'generate',component_id:'media.ffmpeg',resource_group:'local-video-gpu',
    defaults:recover?{timeout_seconds:7200}:defaults,
    source:'https://huggingface.co/MiniMaxAI/MiniMax-H3',
    parameter_schema:{type:'object',additionalProperties:false,properties:recover?{timeout_seconds:properties.timeout_seconds,device:properties.device}:properties},
    validateParameters:p=>validate(p,recover),
    async executeNative({inputPath,outputPath,parameters,components,report=()=>{}}){
      const p=validate(parameters,recover),cfg=configuration();
      if(fs.statSync(inputPath).size>(recover?256*1024:64*1024))throw fail('LOCAL_VIDEO_INPUT_TOO_LARGE','输入应是简短 UTF-8 提示词或本工具生成的 recovery.json');
      const dir=path.dirname(outputPath),request=path.join(dir,'local-video-request.json'),receipt=path.join(dir,'local-video-result.json');
      const binaries=components['media.ffmpeg'].executables;
      writeJson(request,{mode:recover?'recover':'generate',input_path:inputPath,output_path:outputPath,receipt_path:receipt,config:cfg,parameters:p,ffmpeg:binaries.ffmpeg,ffprobe:binaries.ffprobe});
      report({stage:'local_video_preflight',message:recover?'正在核对原任务的恢复文件':'准备本地生成；模型不会在采样阶段临时下载',output_directory:dir});
      await runOwned(cfg.python,['-s','-X','utf8',path.resolve(__dirname,'../../scripts/local-video.py'),'--request',request],{
        timeout:(p.timeout_seconds+180)*1000,onEvent:event=>report(event)
      });
      const result=JSON.parse(fs.readFileSync(receipt,'utf8'));
      if(result.output_path!==path.resolve(outputPath)||result.technical_status!=='passed'||!fs.statSync(outputPath).size)throw fail('LOCAL_VIDEO_RESULT_INVALID','本地视频未返回有效的输出验证记录');
      return {...result,quality_status:'review_required',assets:[
        {file:'local-video-result.json',type:'document',title:'本地视频生成记录'},
        {file:'local-video/recovery.json',type:'document',title:'可复用的解码与导出恢复清单'},
        {file:'local-video/contact-sheet.jpg',type:'image',title:'本地视频关键帧检查图'}
      ]};
    }
  };
}
function recoverySources(input){
  if(fs.statSync(input).size>256*1024)throw fail('LOCAL_VIDEO_INPUT_TOO_LARGE','恢复清单过大');
  const record=JSON.parse(fs.readFileSync(input,'utf8').replace(/^\uFEFF/,''));
  if(record.schema!==1||!record.files||typeof record.files!=='object')throw fail('LOCAL_VIDEO_RECOVERY_INVALID','请使用本工具生成的 recovery.json');
  const root=fs.realpathSync(path.dirname(input)),allowed=new Set(['video-latent.pt','audio-latent.pt','decoded-pixels.npy','decoded-audio.npy']);
  return Object.entries(record.files).map(([name,item])=>{
    if(!allowed.has(name)||item.path!==name)throw fail('LOCAL_VIDEO_RECOVERY_INVALID','恢复清单包含无效路径');
    const file=fs.realpathSync(path.join(root,name));
    if(path.dirname(file)!==root)throw fail('LOCAL_VIDEO_RECOVERY_INVALID','恢复文件越出原任务目录');
    return{role:'local_video_checkpoint',path:file};
  });
}
module.exports={operations:[operation(),operation(true)],validateParameters:validate,configuration,runOwned,recoverySources};
