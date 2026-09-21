"""CPU export and full-decode validation, separate from model inference."""
import json
from pathlib import Path
import shutil
import subprocess
import numpy as np
from PIL import Image, ImageDraw
import soundfile as sf
from .support import atomic_json, digest, emit


def export_video(work, output, parameters, ffmpeg='ffmpeg', ffprobe='ffprobe'):
    work, output = Path(work), Path(output)
    if output.exists():
        raise ValueError('Output exists; preserve it and use a new attempt directory')
    for binary in (ffmpeg,ffprobe):
        if not shutil.which(binary):
            raise ValueError('Missing FFmpeg/ffprobe before export')
    pixels=np.load(work/'decoded-pixels.npy',allow_pickle=False,mmap_mode='r')
    expected=(parameters['frames'],parameters['height'],parameters['width'],3)
    if pixels.dtype!=np.uint8 or pixels.shape!=expected:
        raise ValueError('Saved pixels do not match requested dimensions: '+str(pixels.shape))
    audio_file=work/'decoded-audio.npy'
    audio_status='not_requested' if parameters.get('audio','none')=='none' else 'unavailable_in_saved_checkpoint'
    audio=[]
    if audio_file.is_file():
        samples=np.load(audio_file,allow_pickle=False,mmap_mode='r')
        if samples.ndim!=2 or samples.shape[1]!=2 or not np.isfinite(samples).all():
            raise ValueError('Saved audio is not finite stereo')
        expected_samples=round(parameters['frames']/parameters['fps']*32000)
        if len(samples)!=expected_samples:
            raise ValueError('Saved audio duration does not match video')
        wav=work/'audio.wav'
        sf.write(wav,samples,32000)
        audio=['-i',str(wav),'-map','0:v:0','-map','1:a:0','-c:a','aac','-b:a','192k','-shortest']
        audio_status='generated_not_listening_accepted'
    temporary=output.with_name(output.stem+'.encoding.mp4')
    if temporary.exists():
        raise ValueError('Incomplete export already exists; use a new attempt')
    emit('exporting', '正在编码 MP4；原像素文件会保留以便失败后重试')
    args=[ffmpeg,'-nostdin','-v','error','-n','-f','rawvideo','-pix_fmt','rgb24','-s',f'{parameters["width"]}x{parameters["height"]}','-r',str(parameters['fps']),'-i','-',*audio,'-c:v','libx264','-threads','2','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',str(temporary)]
    with (work/'encode.log').open('wb') as log:
        process=subprocess.Popen(args,stdin=subprocess.PIPE,stderr=log)
        try:
            for frame in pixels:
                process.stdin.write(np.ascontiguousarray(frame).tobytes())
        finally:
            process.stdin.close()
            code=process.wait()
        if code:
            raise RuntimeError('FFmpeg export failed; decoded pixels retained in '+str(work))
    emit('verifying', '正在逐帧解码检查视频、时长与音轨')
    subprocess.run([ffmpeg,'-nostdin','-v','error','-i',str(temporary),'-f','null','-'],capture_output=True,check=True,timeout=180)
    probe=json.loads(subprocess.check_output([ffprobe,'-v','error','-count_frames','-show_streams','-show_format','-of','json',str(temporary)],timeout=60))
    video=next(s for s in probe['streams'] if s['codec_type']=='video')
    count=int(video['nb_read_frames'])
    duration=float(probe['format']['duration'])
    if (video['width'],video['height'],count)!=(parameters['width'],parameters['height'],parameters['frames']) or abs(duration-count/parameters['fps'])>0.15:
        raise ValueError('Export frame count/dimensions/duration mismatch')
    if audio and not any(s['codec_type']=='audio' for s in probe['streams']):
        raise ValueError('Audio stream was lost during export')
    # Contact sheet is an aid for review, never an automated quality pass.
    tw=320; th=round(parameters['height']*tw/parameters['width'])
    sheet=Image.new('RGB',(tw*4,(th+24)*2),'#151820'); draw=ImageDraw.Draw(sheet)
    for n,index in enumerate(np.linspace(0,len(pixels)-1,8,dtype=int)):
        x,y=(n%4)*tw,(n//4)*(th+24)
        sheet.paste(Image.fromarray(pixels[index]).resize((tw,th)),(x,y))
        draw.text((x+6,y+th+4),f'{index/parameters["fps"]:.2f}s',fill='white')
    sheet.save(work/'contact-sheet.jpg',quality=92)
    temporary.rename(output)
    return dict(output_path=str(output),output_sha256=digest(output),frames=count,duration_seconds=duration,width=video['width'],height=video['height'],audio_status=audio_status,technical_status='passed',quality_status='review_required')
