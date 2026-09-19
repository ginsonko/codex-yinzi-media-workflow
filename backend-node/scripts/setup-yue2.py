"""Inspect, install or adopt the pinned WanGP YuE2 singing backend without global pip."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import venv
import zipfile

spec = importlib.util.spec_from_file_location('yue2_support', Path(__file__).with_name('yue2-support.py'))
support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(support)

# The same major runtime used by the accepted local singing pilot. Extra WanGP
# video backends, FlashAttention and its browser application are not installed.
PACKAGES = ['mmgp==3.8.0', 'optimum-quanto==0.2.7', 'transformers==4.54.0', 'tokenizers==0.21.4',
            'tiktoken==0.14.0', 'numpy==2.4.6', 'psutil==7.2.2', 'soundfile==0.14.0',
            'accelerate==1.15.0', 'einops==0.8.2', 'safetensors==0.8.0',
            'huggingface_hub==0.36.2', 'tqdm==4.70.1', 'xxhash==4.0.1']


def run(args):
    subprocess.run([str(x) for x in args], check=True)


def install_source(destination):
    if destination.exists():
        if support.source_revision(destination) == support.WANGP_REVISION:
            return
        raise RuntimeError('Source directory already exists with another/unknown revision; choose a new --source-dir. No checkout or overwrite was performed.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='yue2-source-', dir=destination.parent) as temp:
        archive = Path(temp) / 'source.zip'
        urllib.request.urlretrieve('https://codeload.github.com/deepbeepmeep/Wan2GP/zip/' + support.WANGP_REVISION, archive)
        staging = Path(temp) / 'tree'
        staging.mkdir()
        prefix = 'Wan2GP-' + support.WANGP_REVISION + '/'
        with zipfile.ZipFile(archive) as package:
            for entry in package.infolist():
                if not entry.filename.startswith(prefix):
                    raise RuntimeError('Unexpected upstream archive root')
                relative = entry.filename[len(prefix):]
                if not relative or entry.is_dir():
                    continue
                parts = Path(relative).parts
                if Path(relative).is_absolute() or any(x in ('..', '.') or ':' in x for x in parts) or ((entry.external_attr >> 16) & 0o170000) == 0o120000:
                    raise RuntimeError('Unsafe source archive entry')
                target = staging / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                with package.open(entry) as src, target.open('wb') as dst:
                    shutil.copyfileobj(src, dst)
        support.atomic_json(staging / '.yinzi-yue2-source.json', {'repository': 'https://github.com/deepbeepmeep/Wan2GP', 'revision': support.WANGP_REVISION})
        staging.rename(destination)


def health(interpreter, source, runtime):
    # Import only the isolated YuE2 package. Never import the complete TTS/video UI.
    code = """import sys,json,importlib.util,importlib.metadata as md
assert sys.prefix != sys.base_prefix, 'Reuse requires an isolated venv; global Python was not modified'
source,runtime=sys.argv[1:3]
if runtime: sys.path.insert(0,runtime)
sys.path.insert(0,source)
import torch,torchaudio,numpy,soundfile,psutil,tiktoken,einops,xxhash
assert torch.__version__.split('+')[0] == torchaudio.__version__.split('+')[0]
assert torch.cuda.is_available(), 'CUDA unavailable: check NVIDIA driver and CUDA PyTorch wheel'
from mmgp import quant_router
quant_router.register_handler('shared.qtypes.int8_convrot')
from pathlib import Path
folder=Path(source)/'models/TTS/yue2'
spec=importlib.util.spec_from_file_location('isolated_yue2',folder/'__init__.py',submodule_search_locations=[str(folder)])
module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
from isolated_yue2.pipeline import YuE2Pipeline
print(json.dumps({'status':'imports_ready','torch':torch.__version__,'cuda':torch.version.cuda,'python':sys.version.split()[0],'mmgp':md.version('mmgp')}))
"""
    run([interpreter, '-s', '-X', 'utf8', '-c', code, source, runtime or ''])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--inspect', action='store_true', help='Read-only hardware, installation and disk report (default)')
    modes.add_argument('--install', action='store_true', help='Download the pinned source, isolated CUDA environment and official weights')
    modes.add_argument('--adopt', action='store_true', help='Validate/reuse existing venv, source and weights; downloads nothing')
    parser.add_argument('--root', type=Path, default=Path.home() / '.yinzi-media/yue2')
    parser.add_argument('--config', type=Path, default=Path(os.environ.get('YINZI_NEURAL_AUDIO_CONFIG', str(Path.home() / '.yinzi-media/neural-audio.json'))))
    parser.add_argument('--python', type=Path, help='Existing isolated Python (adopt only)')
    parser.add_argument('--source-dir', type=Path)
    parser.add_argument('--weights-dir', type=Path)
    parser.add_argument('--runtime-dir', type=Path, help='Optional separate dependency target from an existing WanGP setup')
    parser.add_argument('--device', type=int)
    parser.add_argument('--verify-hashes', action='store_true', help='Hash existing weights even during read-only inspection')
    args = parser.parse_args()
    root = args.root.resolve()
    saved = {}
    if args.config.is_file():
        saved = json.loads(args.config.read_text('utf-8-sig')).get('song', {})
    reuse_saved = not args.install and not args.adopt
    args.device = args.device if args.device is not None else saved.get('device', 0) if reuse_saved else 0
    source = (args.source_dir or Path(saved.get('source_dir', root / 'wangp') if reuse_saved else root / 'wangp')).resolve()
    weights = (args.weights_dir or Path(saved.get('weights_dir', root / 'weights') if reuse_saved else root / 'weights')).resolve()
    interpreter = (args.python or Path(saved.get('python', root / 'venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')) if reuse_saved else root / 'venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python'))).resolve()
    runtime = args.runtime_dir or (Path(saved['runtime_dir']) if reuse_saved and saved.get('runtime_dir') else None)
    if args.device < 0:
        parser.error('--device must be nonnegative')
    profile = support.hardware(root, args.device)
    plan = dict(backend='song', model='WanGP YuE2 INT8', hardware=profile, root=str(root), config=str(args.config.resolve()),
                python=str(interpreter), source_dir=str(source), weights_dir=str(weights), weights_disk_free_gib=round(support.disk_free(weights) / support.GIB, 2),
                source_revision=support.source_revision(source), expected_source_revision=support.WANGP_REVISION,
                weights=support.weights_status(weights, args.verify_hashes), model_weights_license='CC-BY-NC-4.0',
                installation_status='configured' if saved else 'not_configured', cloud_fallback='none',
                python_required='3.11 or 3.12, 64-bit; NVIDIA CUDA, Windows/Linux', fresh_disk_estimate_gib='15–20')
    print(json.dumps(plan, ensure_ascii=False, indent=2), flush=True)
    if not args.install and not args.adopt:
        return
    if args.install:
        if args.python or args.runtime_dir:
            parser.error('--install creates its own venv; use --adopt to reuse Python/runtime without pip changes')
        if sys.platform not in ('win32', 'linux') or not (3, 11) <= sys.version_info[:2] <= (3, 12):
            raise RuntimeError('Install with 64-bit Python 3.11 or 3.12 on Windows/Linux and an NVIDIA CUDA GPU')
        if not profile['gpus']:
            raise RuntimeError('Inspect detected no NVIDIA GPU. No packages were downloaded; use a suitable machine or online song service.')
        if not interpreter.exists() and support.disk_free(root) < 10 * support.GIB:
            raise RuntimeError('Select a --root with at least 10 GiB free for the isolated CUDA runtime')
        root.mkdir(parents=True, exist_ok=True)
        install_source(source)
        if not interpreter.exists():
            venv.EnvBuilder(with_pip=True).create(interpreter.parent.parent)
        # Never run pip in a supplied/global interpreter.
        run([interpreter, '-s', '-c', "import sys;assert sys.prefix != sys.base_prefix, 'Refusing to install into global Python'"])
        run([interpreter, '-s', '-m', 'pip', 'install', '--no-cache-dir', 'torch==2.7.1', 'torchaudio==2.7.1', '--index-url', 'https://download.pytorch.org/whl/cu128'])
        constraints = root / 'yue2-constraints.txt'
        constraints.write_text('torch==2.7.1+cu128\ntorchaudio==2.7.1+cu128\n', encoding='utf-8')
        run([interpreter, '-s', '-m', 'pip', 'install', '--no-cache-dir', '-c', constraints, *PACKAGES, 'triton-windows==3.2.0.post21' if os.name == 'nt' else 'triton==3.3.1'])
        missing_bytes = sum(size for name, (size, _) in support.WEIGHTS.items() if not (weights / name).is_file() or (weights / name).stat().st_size != size)
        if support.disk_free(weights) < missing_bytes + support.GIB:
            raise RuntimeError('Choose --weights-dir on a drive with enough free space; existing files are preserved')
        payload = root / 'yue2-download.json'
        support.atomic_json(payload, dict(repo_id=support.WEIGHTS_REPO, revision=support.WEIGHTS_REVISION, local_dir=str(weights), allow_patterns=list(support.WEIGHTS), max_workers=1))
        run([interpreter, '-s', '-X', 'utf8', '-c', "import json,sys;from huggingface_hub import snapshot_download;snapshot_download(**json.load(open(sys.argv[1],encoding='utf-8')))", payload])
        # Existing Hugging Face metadata can consider a damaged same-size file
        # current. Repair only those specific files after hash verification.
        broken = [entry['name'] for entry in support.weights_status(weights, verify=True)['files'] if not entry['valid']]
        if broken:
            support.atomic_json(root / 'yue2-repair.json', dict(repo_id=support.WEIGHTS_REPO, revision=support.WEIGHTS_REVISION, local_dir=str(weights), files=broken))
            run([interpreter, '-s', '-X', 'utf8', '-c', "import json,sys;from huggingface_hub import hf_hub_download;p=json.load(open(sys.argv[1],encoding='utf-8'));files=p.pop('files');[hf_hub_download(filename=f,force_download=True,**p) for f in files]", root / 'yue2-repair.json'])
    else:
        if not args.python or not args.source_dir or not args.weights_dir:
            parser.error('--adopt requires --python, --source-dir and --weights-dir')
    if support.source_revision(source) != support.WANGP_REVISION:
        raise RuntimeError('WanGP source does not match the pinned supported revision; existing files were preserved')
    verified = support.weights_status(weights, verify=True)
    if not verified['ready']:
        raise RuntimeError('Missing or damaged YuE2 model files: ' + ', '.join(x['name'] for x in verified['files'] if not x['valid']))
    health(interpreter, source, runtime.resolve() if runtime else None)
    config = dict(python=str(interpreter), source_dir=str(source), weights_dir=str(weights), runtime_dir=str(runtime.resolve()) if runtime else None,
                  revision=support.WANGP_REVISION, weights_revision=support.WEIGHTS_REVISION, weights_license='CC-BY-NC-4.0',
                  device=args.device, minimum_free_ram_gib=4, minimum_free_vram_gib=0, offload_profile=5,
                  budgets={'text_encoder': 3000, 'transformer': 1700, 'vae': 600, '*': 600}, vae_tile=64)
    for key in ('minimum_free_ram_gib', 'minimum_free_vram_gib', 'offload_profile', 'budgets', 'vae_tile', 'gpu_fraction'):
        if key in saved:
            config[key] = saved[key]
    support.merge_configuration(args.config, config, root / 'cache')
    print(json.dumps({'status': 'ready', 'backend': 'song', 'config': str(args.config.resolve()), 'next': 'Run local.audio.neural-song with a short lyrics text file, then listen and check lyrics.'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
