"""Source installation helpers for H3 video generation backend."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile

from . import support


def install_source(destination, manifest_data):
    """Download and extract source archive from GitHub at pinned revision.

    Args:
        destination: Target directory for source code
        manifest_data: Manifest dict containing source.repository and source.revision

    Returns:
        dict with status='completed'|'exists'|'failed', revision, error (if failed)

    The function validates archive structure and creates a revision marker
    for future verification. It refuses to overwrite existing directories
    with different revisions.
    """
    destination = Path(destination).resolve()
    source_info = manifest_data['source']
    expected_revision = source_info['revision']

    # Check if already installed at correct revision
    if destination.exists():
        # Check for pipeline.py marker file
        if (destination / 'models/minimax_h3/pipeline.py').is_file():
            existing_revision = support.source_revision(destination)
            if existing_revision == expected_revision:
                return dict(status='exists', revision=existing_revision,
                           message='Source already present at correct revision')
            else:
                return dict(status='failed',
                           error=f'Directory exists with revision {existing_revision}; expected {expected_revision}. '
                                 'Choose a different --source-dir or remove the existing directory.')
        else:
            # Directory exists but doesn't look like source
            return dict(status='failed',
                       error=f'Directory exists but does not contain expected source structure. '
                             'Choose a different --source-dir or remove the existing directory.')

    destination.parent.mkdir(parents=True, exist_ok=True)

    # Download and extract in temporary directory
    with tempfile.TemporaryDirectory(prefix='h3-source-', dir=destination.parent) as temp:
        temp_path = Path(temp)
        archive_path = temp_path / 'source.zip'

        # Construct GitHub archive URL
        repo_url = source_info['repository'].rstrip('/')
        if repo_url.startswith('https://github.com/'):
            archive_url = f'https://codeload.github.com/{repo_url[19:]}/zip/{expected_revision}'
        else:
            return dict(status='failed', error=f'Unsupported repository URL format: {repo_url}')

        try:
            urllib.request.urlretrieve(archive_url, archive_path)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            return dict(status='failed', error=f'Failed to download source: {e}')

        # Extract with security validation
        staging = temp_path / 'tree'
        staging.mkdir()

        # Expected archive prefix from GitHub: repo-name-revision/
        repo_name = repo_url.split('/')[-1]
        prefix = f'{repo_name}-{expected_revision}/'

        try:
            with zipfile.ZipFile(archive_path) as package:
                for entry in package.infolist():
                    if not entry.filename.startswith(prefix):
                        return dict(status='failed',
                                   error=f'Archive entry {entry.filename} does not match expected prefix {prefix}')

                    relative = entry.filename[len(prefix):]
                    if not relative or entry.is_dir():
                        continue

                    # Security checks
                    parts = Path(relative).parts
                    if (Path(relative).is_absolute() or
                        any(x in ('..', '.') or ':' in x for x in parts) or
                        ((entry.external_attr >> 16) & 0o170000) == 0o120000):
                        return dict(status='failed', error=f'Unsafe archive entry: {entry.filename}')

                    target = staging / relative
                    target.parent.mkdir(parents=True, exist_ok=True)

                    with package.open(entry) as src, target.open('wb') as dst:
                        shutil.copyfileobj(src, dst)

        except (zipfile.BadZipFile, OSError) as e:
            return dict(status='failed', error=f'Failed to extract archive: {e}')

        # Verify critical files exist
        if not (staging / 'models/minimax_h3/pipeline.py').is_file():
            return dict(status='failed',
                       error='Downloaded source does not contain expected models/minimax_h3/pipeline.py')

        # Write revision marker
        marker_data = {
            'repository': source_info['repository'],
            'revision': expected_revision,
            'installed_at': str(Path(__file__).resolve().parent)
        }
        support.atomic_json(staging / '.yinzi-local-video-source.json', marker_data)

        # Atomic move to final location
        staging.rename(destination)

    return dict(status='completed', revision=expected_revision,
               message=f'Source installed at {destination}')


def create_venv(destination, base_python=None):
    """Create an isolated virtual environment for local video.

    Args:
        destination: Target directory for venv (e.g., ~/.yinzi-media/local-video/venv)
        base_python: Optional path to specific Python interpreter (default: sys.executable)

    Returns:
        dict with status='completed'|'exists'|'failed', python_path, error (if failed)
    """
    import sys
    import venv

    destination = Path(destination).resolve()

    # Determine Python executable path in venv
    if os.name == 'nt':
        python_path = destination / 'Scripts' / 'python.exe'
    else:
        python_path = destination / 'bin' / 'python'

    # Check if already exists
    if python_path.exists():
        return dict(status='exists', python_path=str(python_path),
                   message='Virtual environment already exists')

    # Verify base Python version
    if sys.version_info < (3, 11) or sys.version_info >= (3, 13):
        return dict(status='failed',
                   error=f'Python 3.11 or 3.12 required; found {sys.version_info[0]}.{sys.version_info[1]}')

    destination.parent.mkdir(parents=True, exist_ok=True)

    try:
        venv.EnvBuilder(with_pip=True).create(destination)
    except Exception as e:
        return dict(status='failed', error=f'Failed to create venv: {e}')

    if not python_path.exists():
        return dict(status='failed', error='Virtual environment created but Python executable not found')

    return dict(status='completed', python_path=str(python_path),
               message=f'Virtual environment created at {destination}')


def install_dependencies(python_path, runtime_dir=None):
    """Install PyTorch and required packages into isolated environment.

    Args:
        python_path: Path to venv Python executable
        runtime_dir: Optional directory to install packages (None = use venv)

    Returns:
        dict with status='completed'|'failed', packages_installed, error (if failed)

    This installs fixed PyTorch 2.7.1+cu128 and minimal dependencies for H3.
    Does not install FlashAttention, Triton, or full WanGP browser dependencies.
    """
    python_path = Path(python_path).resolve()

    if not python_path.exists():
        return dict(status='failed', error=f'Python executable not found: {python_path}')

    # Verify it's an isolated environment
    try:
        check_code = "import sys; assert sys.prefix != sys.base_prefix, 'Not a venv'"
        subprocess.run([str(python_path), '-s', '-c', check_code],
                      check=True, capture_output=True, timeout=10)
    except subprocess.CalledProcessError:
        return dict(status='failed',
                   error='Target Python is not an isolated venv; refusing to modify global Python')
    except (OSError, subprocess.TimeoutExpired) as e:
        return dict(status='failed', error=f'Failed to verify Python: {e}')

    # Read tested environment for exact package versions
    tested_env = support.read_json(support.HERE / 'tested-environment.json')
    packages = tested_env['packages']

    # Install PyTorch first
    torch_version = packages['torch'].split('+')[0]
    cuda_variant = packages['torch'].split('+')[1] if '+' in packages['torch'] else 'cu128'

    try:
        subprocess.run([
            str(python_path), '-s', '-m', 'pip', 'install', '--no-cache-dir',
            f'torch=={torch_version}',
            f'torchvision=={packages["torchvision"].split("+")[0]}',
            f'torchaudio=={packages["torchaudio"].split("+")[0]}',
            '--index-url', f'https://download.pytorch.org/whl/{cuda_variant}'
        ], check=True, capture_output=True, timeout=600)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        return dict(status='failed', error=f'Failed to install PyTorch: {e}')

    # Create constraints file with CUDA-specific torch versions
    constraints_content = f'torch=={packages["torch"]}\ntorchvision=={packages["torchvision"]}\ntorchaudio=={packages["torchaudio"]}\n'
    constraints_path = python_path.parent.parent / 'h3-constraints.txt'
    constraints_path.write_text(constraints_content, encoding='utf-8')

    # Install remaining packages (excluding torch family which is already installed)
    remaining = [
        f'{pkg}=={ver}' for pkg, ver in packages.items()
        if pkg not in ('torch', 'torchvision', 'torchaudio')
    ]

    try:
        subprocess.run([
            str(python_path), '-s', '-m', 'pip', 'install', '--no-cache-dir',
            '-c', str(constraints_path),
            *remaining
        ], check=True, capture_output=True, timeout=600)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        return dict(status='failed', error=f'Failed to install dependencies: {e}')

    return dict(status='completed', packages_installed=len(packages),
               message=f'Installed {len(packages)} packages with PyTorch {torch_version}+{cuda_variant}')


def verify_imports(python_path, source_dir, runtime_dir=None):
    """Verify isolated environment can import H3 pipeline without loading models.

    Args:
        python_path: Path to venv Python executable
        source_dir: Path to installed source code
        runtime_dir: Optional runtime overlay directory

    Returns:
        dict with status='ready'|'failed', torch_version, cuda_version, error (if failed)
    """
    python_path = Path(python_path).resolve()
    source_dir = Path(source_dir).resolve()

    # Python code to test imports
    test_code = """
import sys
import json
import importlib
import importlib.metadata as md

source_dir, runtime_dir = sys.argv[1], sys.argv[2]

# Verify isolated
assert sys.prefix != sys.base_prefix, 'Not an isolated venv'

# Setup paths
if runtime_dir:
    sys.path.insert(0, runtime_dir)
sys.path.insert(0, source_dir)

# Test core imports
import torch
import torchvision
import torchaudio
import numpy
import safetensors
import einops
import psutil
import av

# Verify CUDA
assert torch.cuda.is_available(), 'CUDA not available'

# Test mmgp quantization
from mmgp import quant_router
quant_router.register_handler('shared.qtypes.int8_convrot')

# Test H3 pipeline import (without loading models)
from pathlib import Path
pipeline_path = Path(source_dir) / 'models' / 'minimax_h3' / 'pipeline.py'
assert pipeline_path.is_file(), f'Pipeline not found: {pipeline_path}'

# The pipeline uses relative imports; import it with its real package identity.
importlib.import_module('models.minimax_h3.pipeline')

result = {
    'status': 'ready',
    'torch': torch.__version__,
    'cuda': torch.version.cuda,
    'python': sys.version.split()[0],
    'mmgp': md.version('mmgp')
}
print('YINZI_LOCAL_VIDEO_IMPORT_RESULT=' + json.dumps(result))
"""

    try:
        result = subprocess.run([
            str(python_path), '-s', '-X', 'utf8', '-c', test_code,
            str(source_dir), str(runtime_dir.resolve()) if runtime_dir else ''
        ], check=True, capture_output=True, text=True, timeout=30)

        prefix = 'YINZI_LOCAL_VIDEO_IMPORT_RESULT='
        report = next((line[len(prefix):] for line in reversed(result.stdout.splitlines())
                       if line.startswith(prefix)), None)
        if report is None:
            raise ValueError('Import probe produced no completion record')
        data = json.loads(report)
        return data

    except subprocess.CalledProcessError as e:
        error_msg = e.stderr if e.stderr else str(e)
        return dict(status='failed', error=f'Import verification failed: {error_msg}')
    except (subprocess.TimeoutExpired, ValueError, OSError) as e:
        return dict(status='failed', error=f'Verification error: {e}')
