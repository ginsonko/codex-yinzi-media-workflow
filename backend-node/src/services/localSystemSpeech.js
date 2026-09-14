const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./componentRuntime');
const fail = (code, message, details) => Object.assign(new Error(message), { code, details });
const defaults = { voice: '', language: '', rate: 0, volume: 100, sample_rate: 48000, max_characters: 12000 };
function validateParameters(raw = {}) {
  const p = { ...defaults, ...raw };
  for (const [key, min, max] of [['rate',-10,10],['volume',0,100],['sample_rate',8000,96000],['max_characters',1,200000]]) {
    if (!Number.isInteger(p[key]) || p[key] < min || p[key] > max) throw fail('INVALID_PARAMETERS', `${key} 需为 ${min}–${max} 的整数`);
  }
  if (typeof p.voice !== 'string' || p.voice.length > 200 || /[\x00-\x1f]/.test(p.voice)) throw fail('INVALID_PARAMETERS', 'voice 需为系统声音的完整名称');
  if (typeof p.language !== 'string' || p.language.length > 40 || (p.language && !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(p.language))) throw fail('INVALID_PARAMETERS', 'language 需为 zh-CN、en-US 等语言代码，留空使用系统默认声音');
  return p;
}
async function executeNative({ inputPath, outputPath, parameters = {}, components, report = () => {} }) {
  const p = validateParameters(parameters);
  if (process.platform !== 'win32') throw fail('SPEECH_PLATFORM_UNAVAILABLE', '此执行器使用 Windows 系统语音。请在当前系统选择可用的离线配音引擎或已有音轨。');
  if (path.resolve(inputPath).toLowerCase() === path.resolve(outputPath).toLowerCase()) throw fail('SPEECH_OUTPUT_OVERWRITES_INPUT', '配音输出不能覆盖原文');
  if (fs.statSync(inputPath).size > p.max_characters * 4 + 3) throw fail('SPEECH_TEXT_LIMIT', '文本超过本次配音长度上限，请分段或提高 max_characters');
  let text;
  try { text = new TextDecoder('utf-8', { fatal:true }).decode(fs.readFileSync(inputPath)).replace(/^\uFEFF/, ''); }
  catch { throw fail('SPEECH_TEXT_ENCODING', '请提供 UTF-8 编码的纯文本文件'); }
  if (!text.trim()) throw fail('SPEECH_TEXT_EMPTY', '原文为空，请提供需要朗读的内容');
  if (Array.from(text).length > p.max_characters || text.includes('\0')) throw fail('SPEECH_TEXT_LIMIT', '文本超过上限或含有无效空字符');
  const bins = components?.['media.ffmpeg']?.executables;
  if (!bins?.ffmpeg || !bins?.ffprobe) throw fail('SPEECH_FFMPEG_MISSING', '需要 FFmpeg 组件将配音整理为标准音频');
  const outputDir = path.dirname(outputPath);fs.mkdirSync(outputDir,{recursive:true});
  const temporary = fs.mkdtempSync(path.join(outputDir,'.speech-'));
  const requestPath = path.join(temporary,'request.json'), responsePath = path.join(temporary,'response.json'), wavePath = path.join(temporary,'speech.wav');
  try {
    fs.writeFileSync(requestPath,JSON.stringify({...p,text,wave_path:wavePath,response_path:responsePath}));
    report({stage:'synthesizing_speech',message:'正在使用电脑上的离线声音朗读文本'});
    let processError;
    try { await run('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'systemSpeech.ps1'),'-RequestPath',requestPath],{timeout:600000}); }
    catch (error) { processError=error; }
    let response;try { response=JSON.parse(fs.readFileSync(responsePath,'utf8')); } catch {}
    if (!response?.ok || processError) {
      const code=['SPEECH_VOICE_UNAVAILABLE','SPEECH_LANGUAGE_UNAVAILABLE'].includes(response?.code)?response.code:'SPEECH_ENGINE_FAILED';
      const voices=response?.voices||[];
      const help=voices.length?`可用声音：${voices.map(v=>`${v.name} (${v.language})`).join('、')}`:'请检查当前 Windows 是否安装了桌面语音声音及 System.Speech。';
      throw fail(code,`本地配音未完成。${help}`,{voices,cause:response?.code||processError?.code});
    }
    await run(bins.ffmpeg,['-nostdin','-y','-v','error','-threads','2','-i',wavePath,'-map','0:a:0','-ac','1','-ar',String(p.sample_rate),'-c:a','pcm_s16le',outputPath],{timeout:120000});
    const probe=JSON.parse((await run(bins.ffprobe,['-v','error','-show_streams','-show_format','-of','json',outputPath])).stdout);
    const audio=probe.streams?.find(s=>s.codec_type==='audio'),duration=Number(probe.format?.duration);
    if (!audio || !(duration>0) || Number(audio.sample_rate)!==p.sample_rate) throw fail('SPEECH_OUTPUT_INVALID','配音输出未通过音频格式检查');
    await run(bins.ffmpeg,['-nostdin','-v','error','-i',outputPath,'-f','null','-'],{timeout:120000});
    const stem=path.basename(outputPath,path.extname(outputPath)),transcript=stem+'-text.txt',metadata=stem+'-voice.json';
    fs.writeFileSync(path.join(outputDir,transcript),text,'utf8');
    const details={engine:response.engine,voice:response.voice,language:response.language,available_voices:response.voices,characters:Array.from(text).length,rate:p.rate,volume:p.volume,duration_seconds:duration,sample_rate:Number(audio.sample_rate),channels:audio.channels,quality_status:'review_required',quality_note:'配音已在本地生成；实际发音、语气和与画面的节奏仍需检查。'};
    fs.writeFileSync(path.join(outputDir,metadata),JSON.stringify(details,null,2));
    return {...details,before:{text_characters:details.characters},after:{format:'wav',duration,sample_rate:p.sample_rate,channels:1},assets:[{file:transcript,type:'document',title:'配音原文',role:'speech_text'},{file:metadata,type:'document',title:'配音声音与参数',role:'speech_metadata'}]};
  } finally { fs.rmSync(temporary,{recursive:true,force:true}); }
}
module.exports = {
  id:'local.audio.synthesize-speech',title:'本地系统语音配音',kind:'audio',phase:'audio',component_id:'media.ffmpeg',output_extension:'wav',
  description:'读取UTF-8原文，使用Windows已安装声音离线配音；可选声线、语言、语速和音量，保留原文与可复核声音记录。',
  source:'https://learn.microsoft.com/dotnet/api/system.speech.synthesis.speechsynthesizer',defaults,validateParameters,executeNative,
  parameter_schema:{type:'object',properties:{voice:{type:'string',default:'',description:'系统声音完整名称；留空按language或系统默认选择'},language:{type:'string',default:'',description:'例如zh-CN或en-US；留空使用系统默认声音'},rate:{type:'integer',minimum:-10,maximum:10,default:0},volume:{type:'integer',minimum:0,maximum:100,default:100},sample_rate:{type:'integer',minimum:8000,maximum:96000,default:48000},max_characters:{type:'integer',minimum:1,maximum:200000,default:12000}}}
};