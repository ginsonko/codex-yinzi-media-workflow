"""Orchestrate isolated phases and recover checkpoints inside the existing job."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import traceback
from .support import atomic_json, digest, emit, fingerprint, gpu_lock, manifest, memory, disk_free, read_json, validate_config, GIB

DEFAULTS=dict(frames=107,width=832,height=480,fps=24,seed=42,profile='h3-turbo8',timeout_seconds=7200,threads=4,audio='none')


def parameters(raw):
    if not isinstance(raw,dict) or set(raw)-set(DEFAULTS)-{'device'}:
        raise ValueError('Unknown local video parameters')
    p={**DEFAULTS,**raw}
    for key,lo,hi in [('frames',11,363),('width',256,1920),('height',256,1920),('seed',0,2147483647),('threads',1,32),('device',0,15),('timeout_seconds',60,28800)]:
        value=p.get(key,0)
        if isinstance(value,bool) or not isinstance(value,int) or not lo<=value<=hi:
            raise ValueError('Invalid '+key)
    if (p['frames']-3)%8 or p['width']%32 or p['height']%32 or p['fps']!=24 or p['profile']!='h3-turbo8' or p['audio'] not in ('none','native'):
        raise ValueError('H3 profile requires frames=3+8*n, dimensions divisible by 32, fps=24 and trained h3-turbo8 profile')
    return p


def stop_tree(process):
    import psutil
    try:
        root=psutil.Process(process.pid)
        children=root.children(recursive=True)
        for child in [*children,root]:
            try: child.terminate()
            except psutil.NoSuchProcess: pass
        _,alive=psutil.wait_procs([*children,root],timeout=8)
        for child in alive:
            try: child.kill()
            except psutil.NoSuchProcess: pass
    except psutil.NoSuchProcess:
        pass


def worker(request_file,phase,cfg,p,started,work):
    import psutil
    parent=psutil.Process(os.getppid())
    parent_created=parent.create_time()
    env={**os.environ,'PYTHONUNBUFFERED':'1','PYTHONUTF8':'1'}
    # Parent forwarding streams progress immediately; durable events live beside output.
    command=[cfg['python'],'-s','-X','utf8','-m','local_video.h3_worker','--request',str(request_file),'--phase',phase]
    log_path=work/(phase+'.log')
    with log_path.open('wb') as log:
        process=subprocess.Popen(command,cwd=Path(__file__).resolve().parents[1],stdout=log,stderr=subprocess.STDOUT,env=env,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        atomic_json(work/'process.json',dict(pid=process.pid,created=psutil.Process(process.pid).create_time(),phase=phase,owner_pid=os.getpid()))
        offset=0; pending=b''; last_resource=0
        try:
            while True:
                with log_path.open('rb') as read:
                    read.seek(offset); chunk=read.read(); offset=read.tell()
                pending+=chunk
                lines=pending.split(b'\n'); pending=lines.pop()
                for line in lines:
                    try:
                        event=json.loads(line)
                        if isinstance(event,dict) and event.get('stage'):
                            event['elapsed_seconds']=round(time.monotonic()-started,2)
                            atomic_json(work/'status.json',event)
                            with (work/'events.jsonl').open('a',encoding='utf-8') as events:
                                events.write(json.dumps(event,ensure_ascii=False)+'\n')
                            print(json.dumps(event,ensure_ascii=False),flush=True)
                    except (ValueError,UnicodeError): pass
                if process.poll() is not None:
                    break
                if not parent.is_running() or parent.create_time()!=parent_created:
                    stop_tree(process)
                    raise RuntimeError('Parent executor exited; stopped only the owned inference process')
                total,free=memory()
                if free is not None and free < cfg.get('minimum_free_ram_gib',2)*GIB:
                    raise RuntimeError('System free RAM below configured reserve; checkpoints retained')
                if disk_free(work)<cfg.get('minimum_disk_reserve_gib',5)*GIB:
                    raise RuntimeError('Disk free space below configured reserve; checkpoints retained')
                if time.monotonic()-started>p['timeout_seconds']:
                    raise TimeoutError('Local generation deadline reached; checkpoints retained')
                if time.monotonic()-last_resource>15:
                    try:
                        child=psutil.Process(process.pid)
                        rss=sum(q.memory_info().rss for q in [child,*child.children(recursive=True)] if q.is_running())
                    except psutil.NoSuchProcess: rss=None
                    with (work/'resources.jsonl').open('a') as resources:
                        resources.write(json.dumps(dict(elapsed_seconds=time.monotonic()-started,rss_bytes=rss,free_ram_bytes=free))+'\n')
                    last_resource=time.monotonic()
                time.sleep(.5)
            if process.returncode:
                tail=log_path.read_text('utf-8',errors='replace')[-1800:]
                raise RuntimeError(f'{phase} failed; see {log_path}: {tail}')
        finally:
            if process.poll() is None:
                stop_tree(process)


def checkpoint(work,request):
    files={}
    for name in ('video-latent.pt','audio-latent.pt','decoded-pixels.npy','decoded-audio.npy'):
        file=work/name
        if file.is_file(): files[name]=dict(path=name,sha256=digest(file),bytes=file.stat().st_size)
    value=dict(schema=1,fingerprint=request['fingerprint'],parameters=request['parameters'],prompt=request['prompt'],source_revision=manifest()['source']['revision'],files=files,model_id=manifest()['id'],created_at=time.strftime('%Y-%m-%dT%H:%M:%S%z'))
    atomic_json(work/'recovery.json',value)
    return value


def verify_recovery(file,expected=None):
    file=Path(file).resolve(); value=read_json(file)
    if value.get('schema')!=1 or value.get('source_revision')!=manifest()['source']['revision'] or value.get('model_id')!=manifest()['id']:
        raise ValueError('Unknown recovery schema/model/source revision')
    if expected and value.get('fingerprint')!=expected:
        raise ValueError('Recovery fingerprint differs from this generation request')
    # Fingerprint is recomputed from semantic input, not accepted as an assertion.
    params=parameters(value['parameters'])
    if fingerprint(dict(prompt=value['prompt'],parameters=params,model=manifest()))!=value['fingerprint']:
        raise ValueError('Recovery configuration fingerprint mismatch')
    allowed={'video-latent.pt','audio-latent.pt','decoded-pixels.npy','decoded-audio.npy'}
    for name,entry in value['files'].items():
        if name not in allowed or entry.get('path')!=name:
            raise ValueError('Invalid recovery file path')
        target=(file.parent/name).resolve()
        if target.parent!=file.parent or not target.is_file() or target.stat().st_size!=entry['bytes'] or digest(target)!=entry['sha256']:
            raise ValueError('Recovery file missing or changed: '+name)
    if not {'video-latent.pt','decoded-pixels.npy'} & set(value['files']):
        raise ValueError('No complete video latent or pixels available; recovery never starts new sampling')
    return value


def run(request):
    cfg=request['config']; mode=request['mode']; started=time.monotonic()
    output=Path(request['output_path']).resolve(); work=output.parent/'local-video'
    work.mkdir(parents=True,exist_ok=True)
    if (work/'recovery.json').exists():
        raise ValueError('Attempt directory already used; create a fresh attempt and recover')
    emit('preflight','正在核对本地模型、源码版本与可用资源')
    ffmpeg=request.get('ffmpeg') or shutil.which('ffmpeg'); ffprobe=request.get('ffprobe') or shutil.which('ffprobe')
    if not ffmpeg or not ffprobe:
        raise ValueError('FFmpeg/ffprobe required before expensive inference')
    source=None; recovered=None
    if mode=='recover':
        source=Path(request['input_path']).resolve()
        recovered=verify_recovery(source)
        # Recovery retains the original generation parameters/fingerprint.
        p=recovered['parameters']; prompt=recovered['prompt']; key=recovered['fingerprint']
    elif mode=='generate':
        p=parameters(request.get('parameters',{}))
        raw=Path(request['input_path']).read_text('utf-8-sig').strip()
        if not raw or len(raw)>12000 or '\x00' in raw or '\ufffd' in raw:
            raise ValueError('Provide a nonempty UTF-8 prompt up to 12000 characters')
        prompt=raw if raw.startswith('integrated_multimodal_description:') else 'integrated_multimodal_description: [Shot 1] '+raw+'\noverall_soundscape: Natural quiet ambience matching the visible action. No speech.\nnon_diegetic_music: None.'
        key=fingerprint(dict(prompt=prompt,parameters=p,model=manifest()))
        # Only inspect previous attempts of the same existing local-media job.
        if output.parent.name.startswith('attempt-'):
            candidates=list(output.parent.parent.glob('attempt-*/local-video/recovery.json'))
            for prior in sorted(candidates,key=lambda f:f.stat().st_mtime,reverse=True):
                if prior.parent==work: continue
                try:
                    recovered=verify_recovery(prior,key); source=prior; break
                except (ValueError,KeyError,OSError): continue
    else:
        raise ValueError('Unknown local video mode')
    if not recovered:
        validate_config(cfg,verify=True)
    elif 'decoded-pixels.npy' not in recovered['files']:
        # Decoder recovery only needs the pinned source and applicable VAEs.
        from .support import source_revision, safe_child
        if source_revision(cfg['source_dir'])!=manifest()['source']['revision']:
            raise ValueError('Recovery decoder source revision mismatch')
        needed=['minimax_h3/minimax_h3_video_vae_int8_convrot.safetensors']
        if 'audio-latent.pt' in recovered['files']:
            needed.append('MiniMax-H3-audio_vae_fp32.safetensors')
        for item in manifest()['files']:
            if item['path'] in needed:
                file=safe_child(cfg['weights_dir'],item['path'])
                if not file.is_file() or file.stat().st_size!=item['size'] or digest(file)!=item['sha256']:
                    raise ValueError('Recovery decoder model missing or changed: '+item['path'])
    recovery_hashes = ({name: entry['sha256'] for name, entry in recovered.get('files', {}).items()} if recovered else {})
    payload=dict(config=cfg,parameters=p,prompt=prompt,fingerprint=key,work_dir=str(work),recovery_hashes=recovery_hashes)
    payload_file=work/'request.json'; atomic_json(payload_file,payload)
    stage='starting'
    limits={**p,**{k:v for k,v in request.get('parameters',{}).items() if k in ('timeout_seconds','device')}}
    # Device selection is operational; recovery must retain its original fingerprint.
    payload['execution_device']=limits.get('device',cfg.get('device',0))
    atomic_json(payload_file,payload)
    try:
        if recovered:
            emit('recovering','找到已保存的结果，将继续解码/导出，不重新采样',source=str(source),path=str(work))
            for name in recovered['files']:
                if name.startswith('decoded-'):
                    shutil.copyfile(source.parent/name,work/name)
            payload['recover_dir']=str(source.parent);atomic_json(payload_file,payload)
        if not (work/'decoded-pixels.npy').exists():
            locks=Path(cfg.get('lock_dir') or Path.home()/'.yinzi-media/local-video-locks')
            with gpu_lock(locks,payload['execution_device']):
                if recovered:
                    stage='decode';worker(payload_file,'decode',cfg,limits,started,work)
                else:
                    encoder_hash=next(item['sha256'] for item in manifest()['files'] if item['path'].endswith('qwen3vl-32B-MiniMax-H3-Q2_K.gguf'))
                    cache=Path(cfg.get('cache_root') or work/'cache')/'text'/fingerprint(dict(prompt=prompt,revision=manifest()['source']['revision'],text_variant='Q2_K',encoder_hash=encoder_hash))
                    conditioning=cache/'conditioning.pt'; cache_receipt=cache/'receipt.json'
                    valid_cache=conditioning.is_file() and cache_receipt.is_file() and read_json(cache_receipt).get('sha256')==digest(conditioning)
                    if not valid_cache:
                        stage='text';worker(payload_file,'text',cfg,limits,started,work)
                        cache.mkdir(parents=True,exist_ok=True)
                        shutil.copyfile(work/'conditioning.pt',conditioning)
                        atomic_json(cache_receipt,dict(sha256=digest(conditioning)))
                    else:emit('text_cache_reused','复用本条提示词的已验证文字编码')
                    payload['conditioning']=str(conditioning);atomic_json(payload_file,payload)
                    stage='sample';worker(payload_file,'sample',cfg,limits,started,work)
                    if not (work/'decoded-pixels.npy').exists():
                        saved=checkpoint(work,payload)
                        payload['recovery_hashes']={name: entry['sha256'] for name,entry in saved['files'].items()}
                        payload['recover_dir']=str(work);atomic_json(payload_file,payload)
                        stage='decode';worker(payload_file,'decode',cfg,limits,started,work)
        checkpoint(work,payload)
        stage='export'
        from .media import export_video
        result=export_video(work,output,p,ffmpeg,ffprobe)
        result.update(model_id=manifest()['id'],source_revision=manifest()['source']['revision'],recovered_from=str(source) if source else None,api_fee=0,cost_boundary='No video API fee; excludes electricity, storage and time',wall_seconds=round(time.monotonic()-started,3),fingerprint=key)
        atomic_json(request['receipt_path'],result)
        emit('complete','视频已生成并通过技术检查；动作、表情和用途仍需审片',output_path=str(output),quality_status='review_required')
        return result
    except BaseException as error:
        checkpoint(work,payload)
        atomic_json(work/'failure.json',dict(stage=stage,error=str(error),recovery_manifest=str(work/'recovery.json')))
        emit('failed','本阶段未完成，已保留日志和可恢复结果',phase=stage,error=str(error)[-1800:],recovery_manifest=str(work/'recovery.json'))
        raise
