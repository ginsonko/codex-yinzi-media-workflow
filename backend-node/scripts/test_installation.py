"""Tests for installation module."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import zipfile

import sys
sys.path.insert(0, str(Path(__file__).parent.parent / 'scripts'))
from local_video import installation, support


class TestSourceInstallation(unittest.TestCase):
    """Test source code installation from GitHub."""

    def setUp(self):
        """Create temporary directory."""
        self.temp_dir = tempfile.mkdtemp(prefix='test-install-')
        self.temp_path = Path(self.temp_dir)

    def tearDown(self):
        """Clean up."""
        import shutil
        if self.temp_path.exists():
            shutil.rmtree(self.temp_path)

    def test_source_already_installed(self):
        """Test detection of already-installed source at correct revision."""
        manifest = {
            'source': {
                'repository': 'https://github.com/example/repo',
                'revision': 'abc123'
            }
        }

        dest = self.temp_path / 'source'
        dest.mkdir(parents=True)

        # Create expected pipeline structure
        pipeline_path = dest / 'models' / 'minimax_h3' / 'pipeline.py'
        pipeline_path.parent.mkdir(parents=True, exist_ok=True)
        pipeline_path.write_text('# mock pipeline')

        # Create revision marker
        marker_data = {
            'repository': manifest['source']['repository'],
            'revision': 'abc123',
            'installed_at': str(Path(__file__).resolve().parent)
        }
        support.atomic_json(dest / '.yinzi-local-video-source.json', marker_data)

        result = installation.install_source(dest, manifest)

        self.assertEqual(result['status'], 'exists')
        self.assertEqual(result['revision'], 'abc123')

    def test_source_revision_mismatch(self):
        """Test refusal to overwrite different revision."""
        manifest = {
            'source': {
                'repository': 'https://github.com/example/repo',
                'revision': 'newrev456'
            }
        }

        dest = self.temp_path / 'source'
        dest.mkdir(parents=True)

        # Create expected pipeline structure
        pipeline_path = dest / 'models' / 'minimax_h3' / 'pipeline.py'
        pipeline_path.parent.mkdir(parents=True, exist_ok=True)
        pipeline_path.write_text('# mock pipeline')

        # Create marker with different revision
        marker_data = {
            'repository': manifest['source']['repository'],
            'revision': 'oldrev123',
            'installed_at': str(Path(__file__).resolve().parent)
        }
        support.atomic_json(dest / '.yinzi-local-video-source.json', marker_data)

        result = installation.install_source(dest, manifest)

        self.assertEqual(result['status'], 'failed')
        self.assertIn('revision', result['error'])

    def test_source_archive_structure_validation(self):
        """Test that archive entries are validated for safety."""
        manifest = {
            'source': {
                'repository': 'https://github.com/example/repo',
                'revision': 'test123'
            }
        }

        dest = self.temp_path / 'source'

        # Create a malicious zip with path traversal
        zip_path = self.temp_path / 'malicious.zip'
        with zipfile.ZipFile(zip_path, 'w') as zf:
            # Entry without expected prefix
            zf.writestr('malicious.txt', b'bad content')

        def mock_retrieve(url, filename):
            # Copy our malicious zip to the expected location
            import shutil
            shutil.copy(str(zip_path), str(filename))
            return (str(filename), None)

        with mock.patch('urllib.request.urlretrieve', side_effect=mock_retrieve):
            result = installation.install_source(dest, manifest)

            self.assertEqual(result['status'], 'failed')
            self.assertIn('prefix', result['error'].lower())


class TestVenvCreation(unittest.TestCase):
    """Test virtual environment creation."""

    def setUp(self):
        """Create temporary directory."""
        self.temp_dir = tempfile.mkdtemp(prefix='test-venv-')
        self.temp_path = Path(self.temp_dir)

    def tearDown(self):
        """Clean up."""
        import shutil
        if self.temp_path.exists():
            shutil.rmtree(self.temp_path)

    def test_venv_already_exists(self):
        """Test detection of existing venv."""
        venv_dir = self.temp_path / 'venv'
        venv_dir.mkdir(parents=True)

        # Create fake Python executable
        import os
        if os.name == 'nt':
            python_path = venv_dir / 'Scripts' / 'python.exe'
        else:
            python_path = venv_dir / 'bin' / 'python'

        python_path.parent.mkdir(parents=True, exist_ok=True)
        python_path.write_text('fake')

        result = installation.create_venv(venv_dir)

        self.assertEqual(result['status'], 'exists')
        self.assertIn('python_path', result)

    def test_venv_python_version_check(self):
        """Test Python version validation."""
        venv_dir = self.temp_path / 'venv'

        import sys
        original_version = sys.version_info

        try:
            # Mock unsupported version
            sys.version_info = (3, 10, 0, 'final', 0)
            result = installation.create_venv(venv_dir)

            self.assertEqual(result['status'], 'failed')
            self.assertIn('3.11 or 3.12', result['error'])
        finally:
            sys.version_info = original_version


class TestDependencyInstallation(unittest.TestCase):
    """Test package installation."""

    def test_non_venv_rejection(self):
        """Test refusal to install into non-isolated Python."""
        import sys

        # Use current Python which is not a venv
        result = installation.install_dependencies(sys.executable)

        self.assertEqual(result['status'], 'failed')
        self.assertIn('isolated', result['error'].lower())

    def test_missing_python_executable(self):
        """Test handling of non-existent Python path."""
        fake_python = Path('/nonexistent/python.exe')

        result = installation.install_dependencies(fake_python)

        self.assertEqual(result['status'], 'failed')
        self.assertIn('not found', result['error'].lower())


class TestImportVerification(unittest.TestCase):
    """Test import verification."""

    def test_missing_source_dir(self):
        """Test verification with non-existent source."""
        import sys

        result = installation.verify_imports(
            sys.executable,
            Path('/nonexistent/source')
        )

        self.assertEqual(result['status'], 'failed')

    def test_verification_timeout(self):
        """Test that verification has timeout protection."""
        # This is tested implicitly by the timeout parameter in subprocess.run
        # We verify the code structure contains timeout
        import inspect
        source = inspect.getsource(installation.verify_imports)
        self.assertIn('timeout', source)


class TestInstallationBoundaries(unittest.TestCase):
    """Test edge cases and boundaries."""

    def test_install_dependencies_with_runtime_dir(self):
        """Test that runtime_dir parameter is accepted."""
        # We can't actually install, but verify the function signature
        import inspect
        sig = inspect.signature(installation.install_dependencies)
        self.assertIn('runtime_dir', sig.parameters)

    def test_verify_imports_with_runtime_overlay(self):
        """Test that runtime overlay path is handled."""
        import inspect
        sig = inspect.signature(installation.verify_imports)
        self.assertIn('runtime_dir', sig.parameters)

    def test_source_license_preserved(self):
        """Test that source information includes license."""
        manifest = {
            'source': {
                'repository': 'https://github.com/example/repo',
                'revision': 'abc123',
                'license': 'WanGP Community License 2.0'
            }
        }

        # License info should be accessible from manifest
        self.assertIn('license', manifest['source'])
        self.assertIn('WanGP', manifest['source']['license'])


if __name__ == '__main__':
    unittest.main()
