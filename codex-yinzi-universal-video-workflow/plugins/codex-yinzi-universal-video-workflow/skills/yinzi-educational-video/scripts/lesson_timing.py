"""Build portable frame-aligned scene timings from existing narration files."""
import argparse,json,math,subprocess
from pathlib import Path

def build(data,audio_dir,fps=30,tail=1.0):
    if fps<=0 or tail<0:raise ValueError('fps must be positive and tail nonnegative')
    used=set()
    for lesson in data.values():
        start=0
        for seg in lesson['segments']:
            name=seg['id']
            if name in used or Path(name).name!=name or name in ('.','..'):raise ValueError('segment IDs must be unique simple names')
            used.add(name)
            matches=[p for ext in ('.wav','.mp3','.m4a','.ogg') if (p:=audio_dir/(name+ext)).is_file()]
            if len(matches)!=1:raise ValueError(f'Expected one narration file for {name}; found {len(matches)}')
            seconds=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',str(matches[0])],text=True))
            if not math.isfinite(seconds) or seconds<=0:raise ValueError('invalid narration duration')
            seg.update(audio_seconds=seconds,duration=math.ceil((seconds+tail)*fps)/fps,start=start)
            start+=seg['duration']
        lesson['duration']=start
    return data

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('lessons',type=Path);p.add_argument('--audio-dir',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--fps',type=float,default=30);p.add_argument('--tail',type=float,default=1)
    a=p.parse_args();data=build(json.loads(a.lessons.read_text(encoding='utf-8')),a.audio_dir,a.fps,a.tail)
    a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8');print(a.output)
