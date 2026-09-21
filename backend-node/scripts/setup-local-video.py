#!/usr/bin/env python3
"""Inspect, install or adopt the pinned H3 video backend without global pip.

This script manages portable local video generation using MiniMax H3 with
trained Turbo8 adapter. It creates isolated environments, downloads verified
models, and writes configuration for the Node service to discover.

Usage:
  python setup-local-video.py --inspect              # Read-only report (default)
  python setup-local-video.py --prepare              # Fresh install with downloads
  python setup-local-video.py --adopt --python PATH  # Validate existing setup
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys

# Load support module without importing GPU dependencies
spec = importlib.util.spec_from_file_location(
    'local_video.support',
    Path(__file__).parent / 'local_video' / 'support.py'
)
support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(support)

# Load installation helpers
spec = importlib.util.spec_from_file_location(
    'local_video.installation',
    Path(__file__).parent / 'local_video' / 'installation.py'
)
installation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installation)

# Load download helpers
spec = importlib.util.spec_from_file_location(
    'local_video.download',
    Path(__file__).parent / 'local_video' / 'download.py'
)
download = importlib.util.module_from_spec(spec)
spec.loader.exec_module(download)


def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--inspect', action='store_true',
                      help='Read-only hardware and installation report (default, no network/torch)')
    modes.add_argument('--prepare', action='store_true',
                      help='Download source, create isolated venv, install packages and weights')
    modes.add_argument('--adopt', action='store_true',
                      help='Validate and reuse existing venv/source/weights without pip modifications')

    parser.add_argument('--root', type=Path,
                       default=Path.home() / '.yinzi-media/local-video',
                       help='Base directory for installation (default: ~/.yinzi-media/local-video)')
    parser.add_argument('--config', type=Path,
                       default=Path(os.environ.get('YINZI_LOCAL_VIDEO_CONFIG',
                                                   str(Path.home() / '.yinzi-media/local-video.json'))),
                       help='Configuration file path')
    parser.add_argument('--python', type=Path,
                       help='Existing isolated Python interpreter (adopt only)')
    parser.add_argument('--source-dir', type=Path,
                       help='Directory for Wan2GP source code')
    parser.add_argument('--weights-dir', type=Path,
                       help='Directory for model weights')
    parser.add_argument('--runtime-dir', type=Path,
                       help='Optional overlay for shared dependencies from another WanGP setup')
    parser.add_argument('--device', type=int, default=0,
                       help='CUDA device index (default: 0)')
    parser.add_argument('--verify-hashes', action='store_true',
                       help='Hash-verify existing weights during inspection')

    args = parser.parse_args()

    # Default to inspect mode
    if not args.prepare and not args.adopt:
        args.inspect = True

    root = args.root.resolve()

    # Load existing config if present
    saved_config = {}
    if args.config.is_file():
        full_config = support.read_json(args.config)
        saved_config = full_config.get('h3', {})

    # Determine paths (prefer CLI args, then saved config, then defaults)
    use_saved = args.inspect and saved_config

    if args.source_dir:
        source_dir = args.source_dir.resolve()
    elif use_saved and 'source_dir' in saved_config:
        source_dir = Path(saved_config['source_dir']).resolve()
    else:
        source_dir = (root / 'wangp').resolve()

    if args.weights_dir:
        weights_dir = args.weights_dir.resolve()
    elif use_saved and 'weights_dir' in saved_config:
        weights_dir = Path(saved_config['weights_dir']).resolve()
    else:
        weights_dir = (root / 'weights').resolve()

    if args.python:
        python_path = args.python.resolve()
    elif use_saved and 'python' in saved_config:
        python_path = Path(saved_config['python']).resolve()
    else:
        if os.name == 'nt':
            python_path = (root / 'venv' / 'Scripts' / 'python.exe').resolve()
        else:
            python_path = (root / 'venv' / 'bin' / 'python').resolve()

    runtime_dir = None
    if args.runtime_dir:
        runtime_dir = args.runtime_dir.resolve()
    elif use_saved and saved_config.get('runtime_dir'):
        runtime_dir = Path(saved_config['runtime_dir']).resolve()

    if args.device < 0:
        parser.error('--device must be non-negative')

    # Load manifest
    manifest_data = support.manifest()

    # Gather hardware profile
    profile = support.hardware(root, args.device)

    # Check weights status
    weights = support.weights_status(weights_dir, args.verify_hashes)

    # Check source revision
    current_source_rev = support.source_revision(source_dir)
    expected_source_rev = manifest_data['source']['revision']

    # Build inspection report
    plan = {
        'backend': 'local-video-h3',
        'model': 'MiniMax H3 Turbo8 INT8',
        'hardware': profile,
        'root': str(root),
        'config': str(args.config.resolve()),
        'python': str(python_path),
        'python_exists': python_path.exists(),
        'source_dir': str(source_dir),
        'source_revision': current_source_rev,
        'expected_source_revision': expected_source_rev,
        'source_license': manifest_data['source']['license'],
        'weights_dir': str(weights_dir),
        'weights_disk_free_gib': round(support.disk_free(weights_dir) / support.GIB, 2),
        'weights': weights,
        'model_license': manifest_data['model_license'],
        'runtime_dir': str(runtime_dir) if runtime_dir else None,
        'installation_status': 'configured' if saved_config else 'not_configured',
        'recommendation': support.recommend(profile) if profile.get('gpus') else None,
        'python_required': '3.11 or 3.12, 64-bit; NVIDIA CUDA, Windows/Linux',
        'fresh_install_estimate_gib': '34–40 (models + CUDA environment)',
        'measured_performance': manifest_data.get('measured_host', {})
    }

    print(json.dumps(plan, ensure_ascii=False, indent=2), flush=True)

    # Inspection only - exit here
    if args.inspect:
        return

    # Validate mode-specific requirements
    if args.prepare:
        if args.python or args.runtime_dir:
            parser.error('--prepare creates its own venv; use --adopt to reuse existing Python/runtime')

        if sys.version_info < (3, 11) or sys.version_info >= (3, 13):
            raise RuntimeError(
                f'Prepare requires Python 3.11 or 3.12; found {sys.version_info.major}.{sys.version_info.minor}'
            )

        if sys.platform not in ('win32', 'linux'):
            raise RuntimeError('Prepare supports Windows and Linux only')

        if not profile.get('gpus'):
            raise RuntimeError(
                'No NVIDIA GPU detected. Install on a machine with CUDA support or use cloud video service.'
            )

        if support.disk_free(root) < 35 * support.GIB:
            raise RuntimeError(
                f'Fresh installation needs at least 35 GiB free at {root}; choose a different --root'
            )

    if args.adopt:
        if not args.python or not args.source_dir or not args.weights_dir:
            parser.error('--adopt requires --python, --source-dir and --weights-dir')

    # Execute preparation steps
    if args.prepare:
        print('\n=== Installing source code ===', flush=True)
        root.mkdir(parents=True, exist_ok=True)

        source_result = installation.install_source(source_dir, manifest_data)
        print(json.dumps(source_result, ensure_ascii=False, indent=2), flush=True)
        if source_result['status'] == 'failed':
            raise RuntimeError(f"Source installation failed: {source_result['error']}")

        print('\n=== Creating isolated virtual environment ===', flush=True)
        venv_result = installation.create_venv(python_path.parent.parent)
        print(json.dumps(venv_result, ensure_ascii=False, indent=2), flush=True)
        if venv_result['status'] == 'failed':
            raise RuntimeError(f"Venv creation failed: {venv_result['error']}")

        print('\n=== Installing PyTorch and dependencies ===', flush=True)
        deps_result = installation.install_dependencies(python_path, runtime_dir)
        print(json.dumps(deps_result, ensure_ascii=False, indent=2), flush=True)
        if deps_result['status'] == 'failed':
            raise RuntimeError(f"Dependency installation failed: {deps_result['error']}")

        print('\n=== Downloading model weights ===', flush=True)

        def download_progress(stage, current, total, message):
            """Simple progress callback for downloads."""
            if stage in ('already_present', 'completed', 'file_start'):
                print(f'  {message}', flush=True)

        # Calculate missing weights
        missing_bytes = sum(
            item['size'] for item in manifest_data['files']
            if not (weights_dir / item['path']).is_file()
            or (weights_dir / item['path']).stat().st_size != item['size']
        )

        if support.disk_free(weights_dir) < missing_bytes + 5 * support.GIB:
            raise RuntimeError(
                f'Insufficient disk space for weights; need {missing_bytes / support.GIB:.1f} GiB + 5 GiB reserve'
            )

        dl_result = download.download_manifest(
            manifest_data,
            weights_dir,
            mirrors=None,  # Could add mirror support here
            progress_callback=download_progress
        )

        print(json.dumps(dl_result, ensure_ascii=False, indent=2), flush=True)
        if dl_result['failed'] > 0:
            raise RuntimeError(
                f"Failed to download {dl_result['failed']} files: {dl_result['failures']}"
            )

    # Verify installation (both prepare and adopt modes)
    print('\n=== Verifying source revision ===', flush=True)
    actual_revision = support.source_revision(source_dir)
    if actual_revision != expected_source_rev:
        raise RuntimeError(
            f'Source revision mismatch: found {actual_revision}, expected {expected_source_rev}. '
            'Preserve existing source and install the correct revision to a different directory.'
        )

    print('\n=== Verifying model weights ===', flush=True)
    verified_weights = support.weights_status(weights_dir, verify=True)
    if not verified_weights['ready']:
        missing = [f['name'] for f in verified_weights['files'] if not f['valid']]
        raise RuntimeError(f'Missing or damaged model files: {", ".join(missing)}')

    print('\n=== Verifying Python environment ===', flush=True)
    import_result = installation.verify_imports(python_path, source_dir, runtime_dir)
    print(json.dumps(import_result, ensure_ascii=False, indent=2), flush=True)

    if import_result['status'] != 'ready':
        raise RuntimeError(f"Import verification failed: {import_result.get('error', 'Unknown error')}")

    # Write configuration
    print('\n=== Writing configuration ===', flush=True)

    new_h3_config = {
        'python': str(python_path),
        'source_dir': str(source_dir),
        'weights_dir': str(weights_dir),
        'runtime_dir': str(runtime_dir) if runtime_dir else None,
        'revision': expected_source_rev,
        'model_revision': manifest_data['model_revision'],
        'device': args.device,
        'threads': 4,
        'offload_profile': 5,
        'budgets': manifest_data['defaults']['budgets'],
        'vae_tile': manifest_data['defaults']['vae_tile'],
        'minimum_free_ram_gib': 2,
        'minimum_disk_reserve_gib': 5
    }

    # Merge with existing config, preserving unknown fields and user customizations.
    # Paths and pinned provenance are refreshed; unrelated user keys remain intact.
    full_config = {}
    if args.config.is_file():
        full_config = support.read_json(args.config)

    # Preserve every existing H3 key first, then update only fields owned by
    # this installer. This keeps future tuning knobs and user annotations.
    old_h3 = full_config.get('h3')
    if isinstance(old_h3, dict):
        merged_h3 = {**old_h3, **new_h3_config}
        for key in ('threads', 'offload_profile', 'budgets', 'vae_tile',
                    'minimum_free_ram_gib', 'minimum_disk_reserve_gib'):
            if key in old_h3:
                merged_h3[key] = old_h3[key]
        new_h3_config = merged_h3

    full_config['schema'] = full_config.get('schema', 1)
    full_config['h3'] = new_h3_config

    # Preserve cache_root if present
    if 'cache_root' not in full_config:
        full_config['cache_root'] = str(root / 'cache')

    support.atomic_json(args.config, full_config)

    print(json.dumps({
        'status': 'ready',
        'backend': 'local-video-h3',
        'config': str(args.config),
        'torch': import_result['torch'],
        'cuda': import_result['cuda'],
        'next': 'Use local.video.generate operation with a UTF-8 prompt file and frame/dimension parameters'
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
