"""Portable configuration, provenance and hardware helpers; no GPU imports."""
import contextlib
import ctypes
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import time

GIB = 1024**3
HERE = Path(__file__).resolve().parent


def manifest():
    return json.loads((HERE/'h3-manifest.json').read_text('utf-8'))


def atomic_json(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=file.name+'.', suffix='.tmp', dir=file.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
        os.replace(tmp, file)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def read_json(file):
    return json.loads(Path(file).read_text('utf-8-sig'))


def digest(file):
    h = hashlib.sha256()
    with Path(file).open('rb') as stream:
        for block in iter(lambda: stream.read(8*1024**2), b''):
            h.update(block)
    return h.hexdigest()


def disk_free(path):
    path = Path(path).resolve()
    while not path.exists():
        path = path.parent
    return shutil.disk_usage(path).free


def memory():
    if os.name == 'nt':
        class Status(ctypes.Structure):
            _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong)] + [(n, ctypes.c_ulonglong) for n in ('total', 'available', 'page', 'free_page', 'virtual', 'free_virtual', 'extended')]
        status = Status()
        status.length = ctypes.sizeof(status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return status.total, status.available
    elif Path('/proc/meminfo').exists():
        info = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
        return int(info['MemTotal'].split()[0])*1024, int(info['MemAvailable'].split()[0])*1024
    return None, None


def hardware(root, device=0):
    total, free = memory()
    result = dict(platform=platform.system(), architecture=platform.machine(), cpu_count=os.cpu_count(),
                  ram_total_gib=round(total/GIB, 2) if total else None, ram_available_gib=round(free/GIB, 2) if free else None,
                  disk_free_gib=round(disk_free(root)/GIB, 2), selected_device=device, gpus=[])
    try:
        raw = subprocess.run(['nvidia-smi', '--query-gpu=index,name,memory.total,memory.free,driver_version', '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=15, check=True)
        for idx, name, size, available, driver in csv.reader(io.StringIO(raw.stdout)):
            result['gpus'].append(dict(index=int(idx), name=name.strip(), total_gib=round(float(size)/1024, 2), free_gib=round(float(available)/1024, 2), driver=driver.strip()))
    except (OSError, ValueError, subprocess.SubprocessError):
        result['gpu_probe_note'] = 'No NVIDIA GPU detected; CUDA generation is not ready. CPU/AMD/Apple adapters have not been validated.'
    return result


def recommend(profile, task='preview', deadline_minutes=None):
    gpu = next((g for g in profile.get('gpus', []) if g['index']==profile.get('selected_device', 0)), None)
    notes = ['Measured on Windows RTX 2070 SUPER 8GB / 48GB RAM: H3 Turbo8 832x480, 107 frames takes about 23 minutes, excluding download/text preparation. Other hardware timings are unknown.',
             'No video API fee; electricity, storage and time remain. Do a short trial before relying on generated footage.']
    status = 'local_trial_candidate'
    if not gpu:
        status = 'cuda_backend_unavailable'
    elif gpu['free_gib'] < 6 or (profile.get('ram_available_gib') is not None and profile['ram_available_gib'] < 30):
        status = 'resource_pressure_review'
        notes.append('Free resources or choose a smaller backend; measured peak process memory is approximately 28 GiB plus the operating system. These are advisory observations, not a fixed GPU allowlist.')
    if task in ('exact_text', 'transition', 'title', 'diagram'):
        status = 'procedural_edit_preferred'
        notes.append('Use AE/FFmpeg/SVG for precise text, timing and simple motion. Generative video adds uncertainty here.')
    if task in ('product_identity', 'contact', 'choreography'):
        notes.append('Exact products, grips and action order require visual acceptance; do not assume prompt compliance or usable final material.')
    if deadline_minutes is not None and deadline_minutes < 25:
        notes.append('This deadline is shorter than the measured single-clip run. Prefer existing assets/editing, or an explicitly authorized online route.')
    if profile.get('disk_free_gib', 0) < 50:
        notes.append('Fresh setup needs about 32 GiB of weights plus CUDA environment, source, intermediates and reserve; choose another disk or reuse verified files.')
    return dict(status=status, notes=notes, automatic_cloud_fallback=False)


def safe_child(root, name):
    relative = Path(name)
    if relative.is_absolute() or any(p in ('.', '..') or ':' in p for p in relative.parts) or '\\' in name or not relative.parts:
        raise ValueError('Invalid manifest relative path')
    root = Path(root).resolve()
    target = (root/relative).resolve()
    if not target.is_relative_to(root):
        raise ValueError('Manifest path escapes configured model directory')
    return target


def weights_status(directory, verify=False):
    rows = []
    for item in manifest()['files']:
        file = safe_child(directory, item['path'])
        present = file.is_file()
        size_ok = present and file.stat().st_size == item['size']
        sha = digest(file) if verify and size_ok else None
        rows.append(dict(name=item['path'], present=present, valid=size_ok and (not verify or sha==item['sha256']), hash_verified=(sha==item['sha256']) if verify else None, bytes=file.stat().st_size if present else 0, expected_bytes=item['size']))
    return dict(ready=all(r['valid'] for r in rows), hash_verified=verify and all(r['hash_verified'] for r in rows), files=rows)


def source_revision(directory):
    directory = Path(directory)
    if not (directory/'models/minimax_h3/pipeline.py').is_file():
        return None
    if (directory/'.git').exists():
        try:
            return subprocess.run(['git', '-C', str(directory), 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True, timeout=15).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return None
    marker = directory/'.yinzi-local-video-source.json'
    return read_json(marker).get('revision') if marker.is_file() else None


def validate_config(config, verify=False):
    if not isinstance(config, dict):
        raise ValueError('Local video configuration must be an object')
    for key in ('python', 'source_dir', 'weights_dir'):
        if not isinstance(config.get(key), str) or not Path(config[key]).exists():
            raise ValueError('Missing configured '+key+'; run setup-local-video.py --inspect')
    if source_revision(config['source_dir']) != manifest()['source']['revision']:
        raise ValueError('Source revision mismatch; preserve this source and install/adopt the pinned revision in another directory')
    status = weights_status(config['weights_dir'], verify)
    if not status['ready']:
        raise ValueError('Missing/damaged model files: '+', '.join(r['name'] for r in status['files'] if not r['valid']))
    for key, low, high in [('device', 0, 15), ('threads', 1, 32), ('offload_profile', 1, 5), ('vae_tile', 64, 2048)]:
        value = config.get(key, {'device':0,'threads':4,'offload_profile':5,'vae_tile':256}[key])
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            raise ValueError('Invalid config '+key)
    for key in ('minimum_free_ram_gib', 'minimum_disk_reserve_gib'):
        v = config.get(key, 2 if 'ram' in key else 5)
        if isinstance(v, bool) or not isinstance(v,(int,float)) or not 0 <= v <= 1024:
            raise ValueError('Invalid config '+key)
    if config.get('runtime_dir') and not Path(config['runtime_dir']).is_dir():
        raise ValueError('Dependency overlay not found')
    budgets = config.get('budgets', manifest()['defaults']['budgets'])
    if not isinstance(budgets, dict) or any(k not in ('*','transformer','vae','audio_vae','text_encoder','vision_encoder','video_encoder') or isinstance(v,bool) or not isinstance(v,(int,float)) or not 64<=v<=65536 for k,v in budgets.items()):
        raise ValueError('Invalid model memory budgets')
    return status


def fingerprint(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def emit(stage, message, **fields):
    print(json.dumps(dict(stage=stage, message=message, **fields), ensure_ascii=False), flush=True)


@contextlib.contextmanager
def gpu_lock(directory, device, event=emit):
    """Exclusive lock with real PID/create-time ownership; never stop another task."""
    import psutil
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    lock = directory/f'gpu-{device}.lock'
    owner = dict(pid=os.getpid(), created=psutil.Process().create_time())
    while True:
        try:
            lock.mkdir()
            atomic_json(lock/'owner.json', owner)
            break
        except FileExistsError:
            try:
                old = read_json(lock/'owner.json')
                active = psutil.Process(old['pid']).create_time() == old['created']
            except psutil.NoSuchProcess:
                active = False
            except (OSError, ValueError, KeyError, psutil.AccessDenied):
                active = time.time()-lock.stat().st_mtime < 60
            if active:
                raise RuntimeError('LOCAL_GPU_BUSY: another local video job owns this GPU; wait for its completion and resume this job')
            stale = lock.with_name(lock.name+'.stale-'+str(time.time_ns()))
            try:
                lock.rename(stale)
            except OSError:
                continue
    try:
        yield
    finally:
        if lock.exists() and read_json(lock/'owner.json') == owner:
            (lock/'owner.json').unlink()
            lock.rmdir()
