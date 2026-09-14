const {spawn}=require('node:child_process');
const {once}=require('node:events');
const fs=require('node:fs');

// One decoder and encoder, with stream backpressure: memory is bounded by a
// frame and pipe buffers, independently of source duration. No PNG frame cache.
async function transformFrames({ffmpeg,inputPath,outputPath,width,height,fps,duration,transform,signal,idleMs=180000}){
  const frameBytes=width*height*4;
  if(!Number.isSafeInteger(frameBytes)||frameBytes<=0||frameBytes>160000000)throw Error('Invalid decoded frame dimensions');
  let stderr='',lastActivity=Date.now();
  function launch(args,stdio){
    const child=spawn(ffmpeg,args,{stdio,windowsHide:true,shell:false});
    child.stderr.on('data',data=>{stderr=(stderr+data).slice(-3000)});
    child.done=new Promise(resolve=>{child.once('error',error=>resolve({error}));child.once('close',code=>resolve({code}))});
    return child;
  }
  const decoder=launch(['-nostdin','-v','error','-threads','2','-filter_threads','2','-i',inputPath,
    '-map','0:v:0','-vf',`setpts=PTS-STARTPTS,fps=${fps},scale=${width}:${height},setsar=1`,
    '-t',String(duration),'-pix_fmt','rgba','-f','rawvideo','pipe:1'],['ignore','pipe','pipe']);
  const encoder=launch(['-nostdin','-y','-v','error','-threads','2','-filter_threads','2',
    '-f','rawvideo','-pix_fmt','rgba','-s',`${width}x${height}`,'-r',String(fps),'-i','pipe:0',
    '-an','-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',outputPath],['pipe','ignore','pipe']);
  let pipeError;encoder.stdin.on('error',error=>{pipeError=error;decoder.kill()});
  const abort=()=>{decoder.kill();encoder.kill()};
  signal?.addEventListener('abort',abort,{once:true});
  const timer=setInterval(()=>{if(Date.now()-lastActivity>idleMs)abort()},1000);timer.unref();
  let frame=Buffer.allocUnsafe(frameBytes),filled=0,count=0;
  try{
    if(signal?.aborted)throw Error('Sky processing cancelled');
    for await(const chunk of decoder.stdout){
      let offset=0;
      while(offset<chunk.length){
        const n=Math.min(chunk.length-offset,frameBytes-filled);chunk.copy(frame,filled,offset,offset+n);filled+=n;offset+=n;
        if(filled===frameBytes){
          if(signal?.aborted)throw Error('Sky processing cancelled');
          lastActivity=Date.now();
          const output=await transform(frame,count++);
          if(!Buffer.isBuffer(output)||output.length!==frameBytes)throw Error('Frame transform returned incorrect dimensions');
          if(pipeError)throw pipeError;
          if(!encoder.stdin.write(output))await once(encoder.stdin,'drain');
          frame=Buffer.allocUnsafe(frameBytes);filled=0;lastActivity=Date.now();
        }
      }
    }
    encoder.stdin.end();
    const results=await Promise.all([decoder.done,encoder.done]);
    if(filled||!count||results.some(r=>r.error||r.code!==0))throw Error('Sky video process failed: '+stderr);
    return{frame_count:count,processing:'streaming',max_frame_buffer_bytes:frameBytes*2};
  }catch(error){abort();await Promise.all([decoder.done,encoder.done]);fs.rmSync(outputPath,{force:true});throw error;}
  finally{clearInterval(timer);signal?.removeEventListener('abort',abort)}
}
module.exports={transformFrames};