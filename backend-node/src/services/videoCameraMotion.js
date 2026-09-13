const fs = require('node:fs');
const path = require('node:path');
const { filterGraphArgs } = require('./mediaFilterGraph');

const fail = (message, code = 'CAMERA_MOTION_INVALID_INPUT') =>
  Object.assign(new Error(message), { code });

function number(value, name, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw fail(`${name} 应在 ${min} 到 ${max} 之间`);
  }
  return n;
}

const RESOURCE_LIMITS = {
  MIN_DIMENSION: 16,
  MAX_DIMENSION: 7680,
  MIN_FPS: 1,
  MAX_FPS: 120,
  MAX_DURATION: 600,
  MAX_KEYFRAMES: 100,
  MIN_ZOOM: 1.0,  // zoompan不支持zoom<1，最小为1.0（原始尺寸）
  MAX_ZOOM: 10.0
};

const EASING_FUNCTIONS = {
  linear: t => t,
  'ease-in-out': t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
  hold: t => 0
};

/**
 * Validates and normalizes keyframe array
 */
function validateKeyframes(keyframes, duration) {
  if (!Array.isArray(keyframes) || keyframes.length === 0) {
    throw fail('keyframes 必须为非空关键帧数组');
  }
  if (keyframes.length > RESOURCE_LIMITS.MAX_KEYFRAMES) {
    throw fail(`关键帧数量超过系统资源上限 (${RESOURCE_LIMITS.MAX_KEYFRAMES})`);
  }

  const normalized = [];
  for (let i = 0; i < keyframes.length; i++) {
    const kf = keyframes[i];
    if (!kf || typeof kf !== 'object') {
      throw fail(`第 ${i} 个关键帧配置无效`);
    }

    const time = number(kf.time, `关键帧 [${i}] time`, 0, duration);
    const centerX = number(kf.center_x ?? 0.5, `关键帧 [${i}] center_x`, 0, 1);
    const centerY = number(kf.center_y ?? 0.5, `关键帧 [${i}] center_y`, 0, 1);
    const zoom = number(kf.zoom ?? 1.0, `关键帧 [${i}] zoom`, RESOURCE_LIMITS.MIN_ZOOM, RESOURCE_LIMITS.MAX_ZOOM);
    const easing = kf.easing ?? 'linear';

    if (!EASING_FUNCTIONS[easing]) {
      throw fail(`关键帧 [${i}] easing '${easing}' 不受支持，仅支持: ${Object.keys(EASING_FUNCTIONS).join(', ')}`);
    }

    if (i > 0 && time <= normalized[i - 1].time) {
      throw fail(`关键帧 [${i}] 时间 (${time}s) 必须严格晚于前一关键帧 (${normalized[i - 1].time}s)`);
    }

    normalized.push({
      index: i,
      time,
      center_x: centerX,
      center_y: centerY,
      zoom,
      easing
    });
  }

  return normalized;
}

/**
 * Interpolate camera parameters at given time
 */
function interpolateAtTime(keyframes, time) {
  if (keyframes.length === 1 || time <= keyframes[0].time) {
    return { ...keyframes[0] };
  }
  if (time >= keyframes[keyframes.length - 1].time) {
    return { ...keyframes[keyframes.length - 1] };
  }

  // Find the segment
  let i = 0;
  while (i < keyframes.length - 1 && keyframes[i + 1].time <= time) {
    i++;
  }

  const kf0 = keyframes[i];
  const kf1 = keyframes[i + 1];

  if (kf0.easing === 'hold') {
    return { ...kf0 };
  }

  const segmentDuration = kf1.time - kf0.time;
  const t = (time - kf0.time) / segmentDuration;
  const easedT = EASING_FUNCTIONS[kf0.easing](t);

  return {
    time,
    center_x: kf0.center_x + (kf1.center_x - kf0.center_x) * easedT,
    center_y: kf0.center_y + (kf1.center_y - kf0.center_y) * easedT,
    zoom: kf0.zoom + (kf1.zoom - kf0.zoom) * easedT,
    easing: kf0.easing
  };
}

/**
 * Generate zoompan filter expression
 * 修复：使用互斥时间区间避免关键帧边界重复累加；T表达式整体括号；支持首帧前的初始值
 */
function buildZoompanFilter(keyframes, width, height, fps) {
  const build = key => {
    // A balanced tree keeps FFmpeg's expression parser depth logarithmic.
    const segment = i => {
      const a=keyframes[i], b=keyframes[i+1];
      if (!b || a.easing==='hold' || a[key]===b[key]) return String(a[key]);
      const t=`((on/${fps}-${a.time})/(${b.time-a.time}))`;
      const eased=a.easing==='ease-in-out' ? `if(lt(${t},0.5),2*${t}*${t},1-pow(-2*${t}+2,2)/2)` : t;
      return `(${a[key]}+(${b[key]-a[key]})*(${eased}))`;
    };
    const range = (lo, hi) => {
      if (lo===hi) return segment(lo);
      const mid=Math.floor((lo+hi)/2);
      return `if(lt(on/${fps},${keyframes[mid+1].time}),${range(lo,mid)},${range(mid+1,hi)})`;
    };
    return `if(lt(on/${fps},${keyframes[0].time}),${keyframes[0][key]},${range(0,keyframes.length-1)})`;
  };
  return `zoompan=z='${build('zoom')}':x='iw*(${build('center_x')})-iw/(2*zoom)':y='ih*(${build('center_y')})-ih/(2*zoom)':d=1:s=${width}x${height}:fps=${fps}`;
}

async function executeCameraMotion({inputPath,outputPath,parameters:p={},components,report=()=>{},sources=[],integrityManaged=false}) {
  const {run,sha256}=require('./componentRuntime');
  const {streamDuration}=require('./mediaStreamTiming');
  const runner=components?.runner||run, hash=components?.sha256||sha256;
  const {ffmpeg,ffprobe}=components?.['media.ffmpeg']?.executables||{};
  if(!ffmpeg||!ffprobe)throw fail('缺少准备好的 FFmpeg 组件');
  const canonical=file=>process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file);
  const source=inputPath ? (sources.find(s=>canonical(s.path)===canonical(inputPath))||{path:inputPath}) : sources[0];
  if(!source?.path)throw fail('缺少输入源文件');
  const resolvedPath=path.resolve(source.path);
  if([source,...sources].some(s=>canonical(s.path)===canonical(outputPath)))throw fail('输出路径必须与所有源素材不同');
  const stat=fs.statSync(resolvedPath);if(!stat.isFile()||!stat.size)throw fail('素材不是可读的非空文件');
  const identity=source.identity;
  if(identity && [['size','size'],['mtime_ms','mtimeMs'],['ctime_ms','ctimeMs'],['ino','ino']].some(([a,b])=>identity[a]!=null&&identity[a]!==stat[b]))throw Object.assign(Error('源素材在排队期间发生变化'),{code:'INPUT_CHANGED'});
  const beforeHash=integrityManaged?null:await hash(resolvedPath);
  if(beforeHash&&source.sha256&&beforeHash!==source.sha256)throw fail('源素材 SHA-256 不匹配');
  const probe=async file=>JSON.parse((await runner(ffprobe,['-v','error','-show_streams','-show_format','-of','json',file])).stdout);
  report({stage:'probing',message:'正在读取镜头素材与时间轴'});
  const before=await probe(resolvedPath),v=before.streams?.find(s=>s.codec_type==='video'),a=before.streams?.find(s=>s.codec_type==='audio');
  if(!v)throw fail('素材没有视频或图片流');
  const isImage=/(?:^|,)(?:image2|image2pipe|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|tiff_pipe)(?:,|$)/.test(before.format?.format_name||'');
  const sourceDuration=isImage?0:await streamDuration({stream:v,inputPath:resolvedPath,ffprobe,runner});
  if(!isImage&&!(sourceDuration>0))throw fail('无法读取素材实际视频时长');
  const sourceIn=number(p.source_in??0,'source_in',0,isImage?0:sourceDuration);
  const sourceOut=isImage?0:number(p.source_out??sourceDuration,'source_out',sourceIn,sourceDuration);
  const requestedDuration=isImage?number(p.duration??5,'duration',.01,RESOURCE_LIMITS.MAX_DURATION):sourceOut-sourceIn;
  if(!(requestedDuration>0)||requestedDuration>RESOURCE_LIMITS.MAX_DURATION)throw fail('输出选段时长无效或超过10分钟');
  const parts=String(v.avg_frame_rate||v.r_frame_rate||'24/1').split('/').map(Number);
  const sourceFps=parts[0]>0&&parts[1]>0?parts[0]/parts[1]:24;
  const fps=number(p.fps??(isImage?24:sourceFps),'fps',1,120),totalFrames=Math.round(requestedDuration*fps),duration=totalFrames/fps;
  if(totalFrames<1)throw fail('选段不足一输出帧，请增加时长或帧率');
  const width=number(p.width??v.width,'width',16,4096),height=number(p.height??v.height,'height',16,4096);
  if(width%2||height%2)throw fail('H.264 输出宽高必须为偶数整数');
  const keyframes=validateKeyframes(p.keyframes??[{time:0}],requestedDuration);
  const origin=Number(v.start_time)||0,absoluteIn=origin+sourceIn;
  const args=['-nostdin','-y','-copyts','-v','error','-threads','2','-filter_complex_threads','2'];
  if(isImage)args.push('-loop','1','-framerate',String(fps));
  args.push('-protocol_whitelist','file,pipe','-i',resolvedPath);
  const camera=buildZoompanFilter(keyframes,width,height,fps);
  const chain=[isImage?'setpts=PTS-STARTPTS':`trim=start=${absoluteIn}:end=${origin+sourceOut},setpts=PTS-(${absoluteIn})/TB`,
    `fps=${fps}:start_time=0`,`scale=${width*2}:${height*2}:force_original_aspect_ratio=decrease`,
    `pad=${width*2}:${height*2}:(ow-iw)/2:(oh-ih)/2,setsar=1`,camera,
    `tpad=stop_mode=clone:stop_duration=${1/fps}`,`trim=end_frame=${totalFrames}`,'setpts=PTS-STARTPTS','format=yuv420p'];
  const filters=[`[0:v:0]${chain.join(',')}[v]`];let audioMode='none';
  if(a&&!isImage){
    const audioDuration=await streamDuration({stream:a,inputPath:resolvedPath,ffprobe,runner});
    const relativeStart=(Number(a.start_time)||0)-origin;
    if(relativeStart<sourceOut&&(!Number.isFinite(audioDuration)||relativeStart+audioDuration>sourceIn)){
      filters.push(`[0:a:0]asetpts=PTS-(${origin})/TB,atrim=start=${sourceIn}:end=${sourceOut},asetpts=PTS-(${sourceIn})/TB,aresample=48000:async=1:first_pts=0,apad,atrim=duration=${duration}[a]`);audioMode='source_timeline';
    }else{filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[a]`);audioMode='silent_source_interval';}
  }
  args.push(...filterGraphArgs(outputPath,filters),'-map','[v]');
  if(audioMode!=='none')args.push('-map','[a]','-c:a','aac','-b:a','192k');
  args.push('-t',String(duration),'-c:v','libx264','-threads','2','-preset','fast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',outputPath);
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});report({stage:'executing',message:`正在制作 ${totalFrames} 帧镜头动画`});
  await runner(ffmpeg,args,{timeout:600000});
  report({stage:'validating',message:'正在核对镜头帧数、时长与音轨'});
  await runner(ffmpeg,['-v','error','-i',outputPath,'-f','null','-'],{timeout:120000});
  const after=await probe(outputPath),ov=after.streams?.find(s=>s.codec_type==='video'),oa=after.streams?.find(s=>s.codec_type==='audio');
  if(!ov||ov.width!==width||ov.height!==height||Math.abs(Number(after.format?.duration)-duration)>Math.max(1/fps,.03)+.03)throw fail('输出画幅或时长与计划不符');
  if(ov.nb_frames&&Number(ov.nb_frames)!==totalFrames)throw fail('输出帧数与镜头计划不符');
  if((audioMode!=='none')!==Boolean(oa))throw fail('输出音轨与计划不符');
  if(beforeHash&&beforeHash!==await hash(resolvedPath))throw fail('处理期间源素材发生变化');
  return {before:{width:v.width,height:v.height,duration:sourceDuration,is_image:isImage},after:{width:ov.width,height:ov.height,duration:Number(after.format.duration),has_audio:!!oa},keyframes,segment:{type:isImage?'image':'video',source_in:sourceIn,source_out:sourceOut},requested_duration:requestedDuration,total_duration:duration,total_frames:totalFrames,output_fps:fps,audio_handling:{mode:audioMode,delay_seconds:a?(Number(a.start_time)||0)-origin:null},coordinate_space:'contain_canvas',quality_status:'review_required',quality_note:'时长、帧数、画幅与音轨技术检查完成；构图与运动观感需检查成片。'};
}

module.exports = {
  id: 'local.video.camera-motion',
  title: '视频镜头关键帧运动动画',
  description: '支持视频与单张图片素材的镜头平移、缩放关键帧动画，归一化中心坐标与缩放参数，支持 linear/ease-in-out/hold 缓动函数。',
  kind: 'video',
  component_id: 'media.ffmpeg',
  source: 'https://ffmpeg.org/ffmpeg-filters.html#zoompan',
  inputs: ['input_path', 'sources', 'parameters'],
  defaults: {
    keyframes: [{time:0}]
  },
  executeNative: executeCameraMotion,
  buildZoompanFilter,
  validateKeyframes,
  interpolateAtTime,
  RESOURCE_LIMITS,
  EASING_FUNCTIONS,
  parameter_schema: {
    type: 'object',
    properties: {
      keyframes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            time: { type: 'number', minimum: 0, title: '关键帧时间秒数' },
            center_x: { type: 'number', minimum: 0, maximum: 1, default: 0.5, title: '中心点 X 坐标 (0-1 归一化)' },
            center_y: { type: 'number', minimum: 0, maximum: 1, default: 0.5, title: '中心点 Y 坐标 (0-1 归一化)' },
            zoom: { type: 'number', minimum: 1.0, maximum: 10, default: 1.0, title: '缩放倍数 (1.0=原始尺寸, >1放大)' },
            easing: { type: 'string', enum: ['linear', 'ease-in-out', 'hold'], default: 'linear', title: '缓动函数' }
          },
          required: ['time']
        },
        title: '镜头运动关键帧序列'
      },
      source_in: { type: 'number', minimum: 0, title: '视频源入点秒数 (图片时不适用)' },
      source_out: { type: 'number', minimum: 0, title: '视频源出点秒数 (图片时不适用)' },
      duration: { type: 'number', minimum: 0.01, maximum: 600, title: '图片动画时长秒数 (仅图片)' },
      width: { type: 'integer', minimum: 16, maximum: 4096, title: '输出宽度 (偶数，默认源宽度)' },
      height: { type: 'integer', minimum: 16, maximum: 4096, title: '输出高度 (偶数，默认源高度)' },
      fps: { type: 'number', minimum: 1, maximum: 120, title: '输出帧率 (默认源帧率或 24)' }
    },
    required: ['keyframes']
  }
};
