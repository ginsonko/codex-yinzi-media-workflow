# Local Video Setup Integration Guide

## Overview

This document describes the portable local video installation and download system for MiniMax H3 Turbo8. The implementation provides on-demand installation with resumable downloads, isolated environments, and configuration merging that preserves user customizations.

## Architecture

### Components

1. **setup-local-video.py** - Main entry point for installation/adoption/inspection
2. **local_video/download.py** - Resumable verified downloads with mirror fallback
3. **local_video/installation.py** - Source installation, venv creation, dependency management
4. **local_video/support.py** - Configuration, hardware detection, manifest handling (provided by main session)

### Key Design Decisions

- **Isolated environments**: Fresh venv with pinned PyTorch 2.7.1+cu128, no global pip modifications
- **Atomic operations**: Downloads verify hash before committing, config writes are atomic
- **Resume support**: Partial downloads preserved on failure, validated on resume
- **Configuration merging**: User-configured tuning parameters preserved across updates
- **No automatic downloads**: Explicit --prepare or --adopt required, inspect is read-only
- **Mirror fallback**: Multiple URLs tried in order, signed URLs never logged

## Usage

### Inspection (Default)
```bash
python setup-local-video.py --inspect
python setup-local-video.py --inspect --verify-hashes  # Hash-check existing weights
```

Returns JSON report with:
- Hardware profile (GPU, RAM, disk)
- Installation status
- Source/weights readiness
- Hardware recommendations
- License information

### Fresh Installation
```bash
python setup-local-video.py --prepare
python setup-local-video.py --prepare --root /path/to/install
python setup-local-video.py --prepare --device 1  # Use GPU 1
```

Steps:
1. Downloads source from GitHub at pinned revision
2. Creates isolated venv
3. Installs PyTorch 2.7.1+cu128 and dependencies
4. Downloads 34GB of model weights with hash verification
5. Verifies imports without loading models
6. Writes configuration to ~/.yinzi-media/local-video.json

### Adopt Existing Installation
```bash
python setup-local-video.py --adopt \
  --python /path/to/venv/bin/python \
  --source-dir /path/to/wangp \
  --weights-dir /path/to/weights
```

Validates:
- Source revision matches pinned version
- All weights present with correct hashes
- Python environment can import H3 pipeline
- Does NOT modify pip packages in existing venv

## Configuration Format

```json
{
  "schema": 1,
  "h3": {
    "python": "/path/to/venv/bin/python",
    "source_dir": "/path/to/wangp",
    "weights_dir": "/path/to/weights",
    "runtime_dir": null,
    "revision": "5b9bc5c1158074458ab0eb62bf18015a517d39c7",
    "model_revision": "7b61c8edb895aaf25b248f064e9726ffdcc7ec46",
    "device": 0,
    "threads": 4,
    "offload_profile": 5,
    "budgets": {
      "*": 2000,
      "transformer": 1200
    },
    "vae_tile": 256,
    "minimum_free_ram_gib": 2,
    "minimum_disk_reserve_gib": 5
  },
  "cache_root": "~/.yinzi-media/local-video/cache"
}
```

### Configuration Merge Behavior

- New installations write all fields
- Existing config preserves unknown top-level fields
- User-modified tuning parameters (threads, budgets, etc.) are preserved
- Path fields (python, source_dir, weights_dir) are updated on prepare/adopt
- Schema version and revision fields always updated to current values

## Download Module (local_video/download.py)

### Features

- **Resume support**: Detects partial downloads, validates size, requests byte range
- **Hash verification**: SHA256 check before atomic commit
- **Mirror fallback**: Tries multiple URLs in order
- **Error preservation**: Failed partials saved with .bad-{timestamp} suffix for inspection
- **Progress callbacks**: Optional progress reporting for UI integration
- **Path safety**: Uses support.safe_child to prevent traversal attacks
- **Signed URL protection**: Never logs full URLs that may contain signatures

### API

```python
from local_video import download

# Download single file
result = download.download_file(
    item={
        'path': 'model.safetensors',
        'size': 21057674787,
        'sha256': '30ff400f974b11a1...',
        'urls': ['https://huggingface.co/...', 'https://hf-mirror.com/...']
    },
    directory='/path/to/weights',
    mirrors=['https://custom-mirror.com'],  # Optional
    progress_callback=lambda stage, cur, total, msg: print(msg)
)
# Returns: {'status': 'completed'|'failed', 'bytes_downloaded': ..., 'error': ...}

# Download manifest
result = download.download_manifest(
    manifest_data={'files': [...]},
    directory='/path/to/weights',
    progress_callback=callback
)
# Returns: {'total_files': 10, 'completed': 10, 'failed': 0, 'failures': [...]}
```

## Installation Module (local_video/installation.py)

### install_source(destination, manifest_data)

Downloads and extracts GitHub source archive:
- Validates archive structure (prefix, no symlinks, no path traversal)
- Creates `.yinzi-local-video-source.json` revision marker
- Verifies expected pipeline.py exists
- Refuses to overwrite different revisions

### create_venv(destination)

Creates isolated Python 3.11/3.12 venv:
- Validates Python version
- Creates with pip included
- Returns python executable path

### install_dependencies(python_path)

Installs packages into isolated environment:
- Verifies target is isolated venv (sys.prefix != sys.base_prefix)
- Installs PyTorch 2.7.1+cu128 from CUDA index
- Installs remaining packages with constraints file
- Does NOT install FlashAttention, Triton (Windows-only), or full WanGP browser deps

### verify_imports(python_path, source_dir, runtime_dir=None)

Verifies installation without GPU work:
- Tests core imports (torch, numpy, safetensors, etc.)
- Verifies CUDA available
- Tests mmgp quantization registration
- Imports H3 pipeline module (does NOT load weights)
- Returns torch/cuda versions

## Integration with Node Service

The Node service should:

1. **Discovery**: Check for `~/.yinzi-media/local-video.json` or `YINZI_LOCAL_VIDEO_CONFIG`
2. **Validation**: Call `support.validate_config(config, verify=False)` on load
3. **Hardware check**: Call `support.hardware(root, device)` and `support.recommend(profile, task, deadline)`
4. **Worker launch**: Use `config['h3']['python']` to spawn worker process
5. **GPU locking**: Use `support.gpu_lock(directory, device)` context manager
6. **Progress**: Parse JSON progress from worker stdout

## Contract Compliance

### From LOCAL-VIDEO-CONTRACT.md

✅ **Inspect no network/torch import**: Inspection mode uses only support.py, no GPU dependencies
✅ **Manifest SHA/size/HTTPS sources**: All files have sha256, size, urls in h3-manifest.json
✅ **Preserve partials, verify ranges+full hash**: Partial files kept, range requests used, SHA before atomic rename
✅ **Don't log signed redirects**: URL splitting on '?' before logging
✅ **Config merge preserves unknown fields**: Full config read, h3 section merged, unknown keys preserved
✅ **No hardcoded H drive/old source**: All paths from args/config/defaults
✅ **Setup coordinate imports by support**: download.py and installation.py import from local_video.support
✅ **Separate preflight before inference**: setup only validates imports, never loads weights
✅ **No model download during generation**: setup-local-video.py is separate from generation worker

### Differences from Contract

- **Installation helpers**: Added `local_video/installation.py` for source/venv/deps management (contract allowed if needed)
- **Tested environment source**: Uses `tested-environment.json` for exact package versions (contract specified tested-environment exists)
- **Mirror parameter**: download_manifest accepts optional mirrors list (enhancement, backward compatible)

## Testing

### Unit Tests

```bash
# Test download module
python -m pytest test_download.py -v

# Test installation module
python -m pytest test_installation.py -v

# Run all tests
python -m pytest test_*.py -v
```

Coverage:
- Download resumption from partial files
- Hash verification and failure handling
- Mirror fallback on errors
- Path traversal prevention
- Manifest structure validation
- Venv detection and creation
- Python version validation
- Import verification structure

### Manual Verification

```bash
# Compile check
python -m py_compile setup-local-video.py local_video/*.py

# Inspect without installation
python setup-local-video.py --inspect

# Small download test (use actual fixture if available)
# Full installation requires 35GB+ disk and CUDA GPU
```

## Hardware Requirements

### Measured Platform (from manifest)
- GPU: RTX 2070 SUPER, 8GB VRAM
- RAM: 48GB
- Platform: Windows x64
- Generation time: ~23 minutes for 832×480, 107 frames (warm text)

### Advisories (from support.recommend)
- Measured peak process memory: ~28 GiB + OS
- CUDA backend required (no CPU/AMD/Apple validation)
- Fresh install: 34-40 GiB (models + CUDA env)
- Not a fixed GPU allowlist: recommendations are advisory

## License Information

- **Source**: WanGP Community License 2.0 (see upstream LICENSE.txt)
- **Model**: MiniMax H3 Community License Agreement
  - URL: https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE
- **Integration code**: Follows main project license

## Limitations and未完成项

### Not Implemented in This Task
- **GPU execution**: Tests use mocks, no actual model loading or inference
- **Large downloads**: Tests use small fixtures, not 34GB model downloads
- **Full prepare**: --prepare mode tested only in unit tests with mocks
- **Node integration**: Node service operations not modified (main session owns)
- **Worker/runner**: Generation worker not in scope (main session owns)
- **License file verification**: Upstream LICENSE not fetched in tests (network-dependent)

### Known Constraints
- **Python 3.11/3.12 only**: Version check enforced
- **Windows/Linux only**: No macOS installation support in --prepare
- **NVIDIA CUDA only**: No CPU/AMD/Apple Metal support
- **Single device at a time**: GPU lock prevents concurrent use
- **Fixed source revision**: Must match pinned commit, no auto-update

### Future Enhancements
- Mirror configuration in config file
- Parallel download for multiple files
- Delta updates for source revisions
- Verification mode for existing installations
- Progress persistence for interrupted downloads
- Cloud fallback recommendations (contract specifies none by default)

## Troubleshooting

### Import Errors
- Verify venv isolation: `python -c "import sys; print(sys.prefix != sys.base_prefix)"`
- Check CUDA: `python -c "import torch; print(torch.cuda.is_available())"`
- Validate source revision: `python -c "from local_video import support; print(support.source_revision('/path'))"`

### Download Failures
- Check disk space: Inspect report shows disk_free_gib
- Verify connectivity: Try mirror URLs manually
- Resume: Partial files preserved, just retry same command
- Hash mismatch: Bad partials saved as .partial.bad-{timestamp}, check file integrity

### Configuration Issues
- Check location: `echo $YINZI_LOCAL_VIDEO_CONFIG` or default ~/.yinzi-media/local-video.json
- Validate: `python -c "from local_video import support; support.validate_config(support.read_json('path'))"`
- Reset: Remove config file and run --prepare again (or manually edit)

### GPU Lock Conflicts
- Check active processes: Lock files at {cache_root}/gpu-{device}.lock
- Stale lock: Auto-detected and cleaned after 60s idle
- Manual cleanup: Remove lock directory if process confirmed dead

## Example Workflow

```bash
# 1. Inspect current state
python setup-local-video.py --inspect | jq .

# 2. Check hardware recommendation
python setup-local-video.py --inspect | jq .recommendation

# 3. Fresh installation (requires 35GB+ free)
python setup-local-video.py --prepare --root ~/.yinzi-media/local-video

# 4. Verify configuration
cat ~/.yinzi-media/local-video.json | jq .h3

# 5. Node service discovers and validates
# (Node code calls support.validate_config)

# 6. Generate video through Node operation
# (Node launches worker with config['h3']['python'])
```
