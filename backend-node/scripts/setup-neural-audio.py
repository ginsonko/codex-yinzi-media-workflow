"""Prepare optional official CPU models in isolated environments, never global Python."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import venv

MUSIC_REV = '4c8334b02c6ec4e8664a91979669a501ec497792'
F5_REV = '84e5a410d9cead4de2f847e7c9369a6440bdfaca'
VOCOS_REV = '0feb3fdd929bcd6649e0e7c5a688cf7dd012ef21'


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--backend', choices=['music','voice'], required=True)
    p.add_argument('--root', type=Path, default=Path.home()/'.yinzi-media'/'neural-audio')
    p.add_argument('--config', type=Path, default=Path(os.environ.get('YINZI_NEURAL_AUDIO_CONFIG',str(Path.home()/'.yinzi-media'/'neural-audio.json'))))
    p.add_argument('--python', type=Path, help='Reuse an already isolated, compatible interpreter instead of installing packages')
    p.add_argument('--model-dir', type=Path)
    p.add_argument('--checkpoint', type=Path)
    p.add_argument('--vocoder', type=Path)
    p.add_argument('--minimum-free-ram-gib',type=float,default=4)
    p.add_argument('--inspect', action='store_true', help='Report installation plan without downloading or changing files')
    a=p.parse_args()
    if not 0 < a.minimum_free_ram_gib <= 128: raise ValueError('Invalid free RAM setting')
    root=a.root.resolve()
    probe=root
    while not probe.exists(): probe=probe.parent
    free=shutil.disk_usage(probe).free
    plan={'backend':a.backend,'root':str(root),'config':str(a.config.resolve()),'disk_free_gib':round(free/1024**3,2),
          'download':'official PyTorch CPU wheels and pinned Hugging Face model; never user audio',
          'model_weights_license':'CC-BY-NC-4.0','python_required':'3.10–3.12','cloud_fallback':'none'}
    print(json.dumps(plan,ensure_ascii=False),flush=True)
    if a.inspect:return
    if not (3,10)<=sys.version_info[:2]<(3,13):raise RuntimeError('Run setup with Python 3.10–3.12')
    if not a.python and free<8*1024**3:raise RuntimeError('Allow 8 GiB free disk for isolated packages and model; choose another --root')
    root.mkdir(parents=True,exist_ok=True)
    interpreter=a.python.resolve() if a.python else root/a.backend/'venv'/('Scripts/python.exe' if os.name=='nt' else 'bin/python')
    if not a.python:
        if not interpreter.exists():venv.EnvBuilder(with_pip=True).create(interpreter.parent.parent)
        subprocess.run([str(interpreter),'-m','pip','install','torch==2.7.1','torchaudio==2.7.1','--index-url','https://download.pytorch.org/whl/cpu'],check=True)
        packages=['psutil==7.0.0','soundfile==0.14.0','huggingface_hub==0.35.3']
        packages+=['transformers==4.52.4','sentencepiece==0.2.1'] if a.backend=='music' else ['f5-tts==1.1.22']
        constraints=root/'cpu-constraints.txt'
        constraints.write_text('torch==2.7.1+cpu\ntorchaudio==2.7.1+cpu\n','utf-8')
        subprocess.run([str(interpreter),'-m','pip','install','-c',str(constraints),*packages],check=True)
    health="import torch,torchaudio,soundfile,psutil; assert torch.__version__.split('+')[0]==torchaudio.__version__.split('+')[0]; import "+('transformers' if a.backend=='music' else 'f5_tts')
    subprocess.run([str(interpreter),'-c',health],check=True)
    def snapshot(repo, revision, destination, patterns):
        payload=root/f'{a.backend}-download.json'
        payload.write_text(json.dumps(dict(repo_id=repo,revision=revision,local_dir=str(destination),allow_patterns=patterns,max_workers=1)),'utf-8')
        subprocess.run([str(interpreter),'-c',"import json,sys; from huggingface_hub import snapshot_download; snapshot_download(**json.load(open(sys.argv[1],encoding='utf-8')))",str(payload)],check=True)
    cfg={'python':str(interpreter),'minimum_free_ram_gib':a.minimum_free_ram_gib,'weights_license':'CC-BY-NC-4.0'}
    if a.backend=='music':
        model=a.model_dir.resolve() if a.model_dir else root/'models'/'musicgen-small'
        if not a.model_dir:snapshot('facebook/musicgen-small',MUSIC_REV,model,['*.json','*.model','model.safetensors','README.md'])
        if not (model/'model.safetensors').is_file():raise FileNotFoundError(model/'model.safetensors')
        cfg.update(model_dir=str(model),revision=MUSIC_REV)
    else:
        # HF cache files may be symlinks to extensionless blobs. Keep the model
        # filename: F5 selects the safetensors loader using this extension.
        checkpoint=a.checkpoint.absolute() if a.checkpoint else root/'models'/'f5'/'F5TTS_v1_Base'/'model_1250000.safetensors'
        vocoder=a.vocoder.resolve() if a.vocoder else root/'models'/'vocos'
        if not a.checkpoint:snapshot('SWivid/F5-TTS',F5_REV,checkpoint.parent.parent,['F5TTS_v1_Base/model_1250000.safetensors','F5TTS_v1_Base/vocab.txt','README.md'])
        if not a.vocoder:snapshot('charactr/vocos-mel-24khz',VOCOS_REV,vocoder,['config.yaml','pytorch_model.bin','README.md'])
        if not checkpoint.is_file() or not (vocoder/'config.yaml').is_file():raise FileNotFoundError('Checkpoint or vocoder missing')
        cfg.update(checkpoint=str(checkpoint),vocoder=str(vocoder),revision=F5_REV)
    previous=json.loads(a.config.read_text('utf-8-sig')) if a.config.exists() else {'schema':1}
    previous[a.backend]=cfg
    previous.setdefault('cache_root',str(root/'cache'))
    a.config.parent.mkdir(parents=True,exist_ok=True)
    temp=a.config.with_suffix('.tmp')
    temp.write_text(json.dumps(previous,ensure_ascii=False,indent=2),'utf-8')
    temp.replace(a.config)
    print(json.dumps({'status':'ready','backend':a.backend,'config':str(a.config),'next':'resume the same local-media job'},ensure_ascii=False))


if __name__=='__main__':main()
