"""Shared, dependency-free YuE2 installation and hardware inspection helpers."""
import csv
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile

GIB = 1024 ** 3
WANGP_REVISION = 'bfaff285463ef6124c2357136e8d36c6c93c0fb2'
WEIGHTS_REVISION = '5020589aa562cea206a25eea208d7cbb1f6efae7'
WEIGHTS_REPO = 'DeepBeepMeep/TTS'
WEIGHTS = {
    'YuE2_AR/YuE2_AR_int8_convrot.safetensors': (2925023698, '02ae63099e82496a6b61ea7ef15aa729bc5503a50ed2d64a1da328dcc40ea5cb'),
    'YuE2_Acoustic_int8_convrot.safetensors': (1522568148, '6e66f94fa7145fd2e28b491d14182cd51d72653b7965d80ec23ae3ff24a92755'),
    'YuE2_AR/qwen.tiktoken': (2561218, 'b2b1b8dfb5cc5f024bafc373121c6aba3f66f9a5a0269e243470a1de16a33186'),
    'yue2/YuE2_VAE_bf16.safetensors': (132731320, '499714f69404d378b19a6fcbba9a8f99b4babfaed3f706e52c6dfa4e9521db67'),
    'yue2/vae_config.json': (1378, 'f0191bb9694009956de44e0c361a6f1334760be4c8f848e599bde242a54a0970'),
    'yue2/MODEL_LICENSE': (20736, '387f085ba4a5cf247a479af5498df08f1d6a17ce67b75d0fdeb1a1988fc8e44b'),
    'yue2/README.md': (1919, '132834f3e3d1e5460efe1177f8fd3e4c0f161d23d91f0a2184da98b65c1d426e'),
}


def emit(stage, message, **fields):
    print(json.dumps(dict(stage=stage, message=message, **fields), ensure_ascii=False), flush=True)


def atomic_json(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=file.name + '.', suffix='.tmp', dir=file.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
        os.replace(name, file)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def digest(file):
    h = hashlib.sha256()
    with Path(file).open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 ** 2), b''):
            h.update(chunk)
    return h.hexdigest()


def disk_free(path):
    probe = Path(path).absolute()
    while not probe.exists():
        probe = probe.parent
    return shutil.disk_usage(probe).free


def memory():
    try:
        if os.name == 'nt':
            class Status(ctypes.Structure):
                _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong)] + [(name, ctypes.c_ulonglong) for name in ['total', 'available', 'total_page', 'available_page', 'total_virtual', 'available_virtual', 'extended']]
            status = Status()
            status.length = ctypes.sizeof(status)
            if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                raise OSError('GlobalMemoryStatusEx failed')
            return status.total, status.available
        if Path('/proc/meminfo').exists():
            info = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
            return int(info['MemTotal'].split()[0]) * 1024, int(info['MemAvailable'].split()[0]) * 1024
    except (OSError, ValueError, KeyError):
        pass
    return None, None


def hardware(root, device=0):
    total, available = memory()
    result = dict(platform=platform.system(), architecture=platform.machine(), cpu_count=os.cpu_count(),
                  ram_total_gib=round(total / GIB, 2) if total else None,
                  ram_available_gib=round(available / GIB, 2) if available else None,
                  disk_free_gib=round(disk_free(root) / GIB, 2), gpus=[], selected_device=device)
    try:
        probe = subprocess.run(['nvidia-smi', '--query-gpu=index,name,memory.total,memory.free,driver_version', '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=15, check=True)
        for index, name, total_mb, free_mb, driver in csv.reader(io.StringIO(probe.stdout)):
            result['gpus'].append(dict(index=int(index), name=name.strip(), total_gib=round(float(total_mb) / 1024, 2), free_gib=round(float(free_mb) / 1024, 2), driver=driver.strip()))
    except (OSError, ValueError, subprocess.SubprocessError):
        result['gpu_probe_note'] = 'NVIDIA CUDA GPU was not detected by nvidia-smi; this is not a CPU music backend.'
    result['recommendation'] = recommend(result)
    return result


def recommend(profile):
    gpu = next((g for g in profile.get('gpus', []) if g['index'] == profile.get('selected_device', 0)), None)
    notes = ['4.5 GB is an approximate low-VRAM route, not a guarantee. Start with a short sung excerpt and listen before rendering a full song.']
    if not gpu:
        status = 'online_recommended'
        notes.append('Use a licensed online song generator, or another supported NVIDIA machine. MusicGen CPU is an optional instrumental-only alternative.')
    elif gpu['free_gib'] < 4.5 or (profile.get('ram_available_gib') is not None and profile['ram_available_gib'] < 8):
        status = 'free_resources_or_online'
        notes.append('Close other GPU applications, use INT8 CPU offload and VAE tiling, or select an online song service. Do not start a large local job blindly.')
    else:
        status = 'local_short_sample_recommended'
        notes.append('Try the local INT8/offload route. A longer song can require more resources and may not follow every lyric or exact duration.')
    if profile.get('disk_free_gib', 0) < 15:
        notes.append('A fresh install can need 15–20 GiB including CUDA wheels, code, weights and cache. Reuse installed assets or choose a larger drive.')
    return dict(status=status, notes=notes, online_submission='never_automatic')


def weights_status(directory, verify=False):
    directory = Path(directory)
    entries = []
    for name, (size, sha) in WEIGHTS.items():
        file = directory / name
        ok = file.is_file() and file.stat().st_size == size
        checked_hash = digest(file) if ok and verify else None
        entries.append(dict(name=name, present=file.is_file(), valid=ok and (not verify or checked_hash == sha), hash_verified=checked_hash == sha if verify else None))
    return dict(ready=all(e['valid'] for e in entries), revision=WEIGHTS_REVISION, files=entries)


def source_revision(directory):
    directory = Path(directory)
    if not (directory / 'models/TTS/yue2/pipeline.py').is_file():
        return None
    if (directory / '.git').exists():
        try:
            return subprocess.run(['git', '-C', str(directory), 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True, timeout=15).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return None
    marker = directory / '.yinzi-yue2-source.json'
    return json.loads(marker.read_text('utf-8'))['revision'] if marker.exists() else None


def merge_configuration(file, song, cache_root):
    """Re-read at activation time and preserve all unrelated provider/user settings."""
    file = Path(file)
    previous = json.loads(file.read_text('utf-8-sig')) if file.exists() else {'schema': 1}
    if not isinstance(previous, dict):
        raise ValueError('Audio configuration must be a JSON object; original was preserved')
    previous['song'] = {**previous.get('song', {}), **song}
    previous.setdefault('cache_root', str(cache_root))
    atomic_json(file, previous)
