"""Technical media evidence only. No claim of subject, aesthetic, or listening QA."""
import argparse,json,subprocess,hashlib,re
from pathlib import Path

def check(path):
    p=subprocess.run(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(path)],capture_output=True,text=True,encoding='utf-8',errors='replace',check=True)
    meta=json.loads(p.stdout);streams=meta['streams'];videos=[x for x in streams if x['codec_type']=='video'];audios=[x for x in streams if x['codec_type']=='audio']
    result={'path':str(path.resolve()),'size_bytes':path.stat().st_size,'duration_seconds':float(meta['format']['duration']),'video':[{'codec':x['codec_name'],'width':x['width'],'height':x['height'],'fps':x['avg_frame_rate'],'duration':x.get('duration')} for x in videos],'audio':[{'codec':x['codec_name'],'channels':x['channels'],'sample_rate':x['sample_rate'],'duration':x.get('duration')} for x in audios]}
    proc=subprocess.run(['ffmpeg','-v','error','-xerror','-err_detect','explode','-threads','2','-i',str(path),'-map','0:v:0','-map','0:a?','-f','null','-'],capture_output=True,text=True,errors='replace')
    result['strict_decode']={'passed':proc.returncode==0,'returncode':proc.returncode,'stderr':proc.stderr[-3000:]}
    if audios:
        proc=subprocess.run(['ffmpeg','-hide_banner','-nostats','-threads','2','-i',str(path),'-vn','-af','loudnorm=I=-16:TP=-1.5:LRA=9:print_format=json','-f','null','-'],capture_output=True,text=True,errors='replace')
        found=re.findall(r'\{\s*"input_i".*?\}',proc.stderr,re.S);result['audio_measurement']=json.loads(found[-1]) if found else {'error':proc.stderr[-1000:]}
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    result['sha256']=h.hexdigest();result['subjective_review']='not_performed_by_this_script';return result

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('media',nargs='+',type=Path);p.add_argument('--output',type=Path,required=True);a=p.parse_args();reports=[]
    for path in a.media:
        reports.append(check(path));print(path.name,reports[-1]['strict_decode']['passed'],flush=True)
    a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(reports,ensure_ascii=False,indent=2),encoding='utf-8')
    if any(not r['strict_decode']['passed'] or not r['video'] for r in reports):raise SystemExit(1)
