"""Tests for download module with resumable and mirror support."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

# Import the module under test
import sys
sys.path.insert(0, str(Path(__file__).parent.parent / 'scripts'))
from local_video import download, support


class TestDownloadModule(unittest.TestCase):
    """Test download functionality with fixtures and mocks."""

    def setUp(self):
        """Create temporary directory for test files."""
        self.temp_dir = tempfile.mkdtemp(prefix='test-download-')
        self.temp_path = Path(self.temp_dir)

    def tearDown(self):
        """Clean up temporary files."""
        import shutil
        if self.temp_path.exists():
            shutil.rmtree(self.temp_path)

    def test_small_file_download(self):
        """Test downloading a small file from a real URL."""
        # Use a small, stable test file (GitHub README or similar)
        test_item = {
            'path': 'test-readme.txt',
            'size': 100,  # Approximate
            'sha256': None,  # Will compute after download
            'urls': ['https://raw.githubusercontent.com/python/cpython/main/README.rst']
        }

        # Download without hash verification for this test
        with mock.patch.object(support, 'digest', return_value=test_item['sha256'] or 'mock-hash'):
            # We'll just verify the download mechanism works
            # Skip actual hash verification since we don't know the hash
            pass

        # For unit test, we'll mock the network call
        mock_content = b'# Test README\n' * 10  # 140 bytes
        test_item['size'] = len(mock_content)
        test_item['sha256'] = hashlib.sha256(mock_content).hexdigest()

        with mock.patch('urllib.request.urlopen') as mock_urlopen:
            mock_response = mock.MagicMock()
            mock_response.read.side_effect = [mock_content, b'']
            mock_response.headers.get.return_value = None
            mock_urlopen.return_value.__enter__.return_value = mock_response

            result = download.download_file(test_item, self.temp_path)

            self.assertEqual(result['status'], 'completed')
            self.assertGreater(result['bytes_downloaded'], 0)

    def test_resume_from_partial(self):
        """Test resuming download from partial file."""
        mock_content = b'0123456789' * 100  # 1000 bytes
        test_item = {
            'path': 'resume-test.bin',
            'size': len(mock_content),
            'sha256': hashlib.sha256(mock_content).hexdigest(),
            'urls': ['http://example.com/file.bin']
        }

        # Create partial file with first 500 bytes
        target_dir = self.temp_path / 'weights'
        target_dir.mkdir(parents=True, exist_ok=True)
        partial_file = target_dir / 'resume-test.bin.partial'
        partial_file.write_bytes(mock_content[:500])

        # Mock urlopen to return remaining bytes with Range support
        with mock.patch('urllib.request.urlopen') as mock_urlopen:
            mock_response = mock.MagicMock()
            mock_response.read.side_effect = [mock_content[500:], b'']
            mock_response.headers.get.return_value = 'bytes 500-999/1000'
            mock_urlopen.return_value.__enter__.return_value = mock_response

            result = download.download_file(test_item, target_dir)

            # Verify Range header was requested
            call_args = mock_urlopen.call_args
            request = call_args[0][0]
            self.assertIn('Range', request.headers)
            self.assertEqual(request.headers['Range'], 'bytes=500-')

            self.assertEqual(result['status'], 'completed')
            self.assertTrue(result.get('resumed'))

    def test_hash_verification_failure(self):
        """Test that incorrect hash prevents file commit."""
        mock_content = b'correct content'
        wrong_hash = hashlib.sha256(b'wrong content').hexdigest()

        test_item = {
            'path': 'hash-fail.bin',
            'size': len(mock_content),
            'sha256': wrong_hash,
            'urls': ['http://example.com/file.bin']
        }

        target_dir = self.temp_path / 'weights'
        target_dir.mkdir(parents=True, exist_ok=True)

        with mock.patch('urllib.request.urlopen') as mock_urlopen:
            mock_response = mock.MagicMock()
            mock_response.read.side_effect = [mock_content, b'']
            mock_response.headers.get.return_value = None
            mock_urlopen.return_value.__enter__.return_value = mock_response

            result = download.download_file(test_item, target_dir)

            self.assertEqual(result['status'], 'failed')
            self.assertIn('Hash mismatch', result.get('error', ''))

            # Verify final file was not created
            final_file = target_dir / 'hash-fail.bin'
            self.assertFalse(final_file.exists())

    def test_mirror_fallback(self):
        """Test that download tries multiple mirrors on failure."""
        test_item = {
            'path': 'mirror-test.bin',
            'size': 100,
            'sha256': hashlib.sha256(b'x' * 100).hexdigest(),
            'urls': ['http://mirror1.com/file', 'http://mirror2.com/file']
        }

        target_dir = self.temp_path / 'weights'
        target_dir.mkdir(parents=True, exist_ok=True)

        call_count = 0

        def mock_urlopen_side_effect(request, timeout=None):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # First mirror fails
                import urllib.error
                raise urllib.error.URLError("Mirror 1 failed")
            else:
                # Second mirror succeeds
                mock_response = mock.MagicMock()
                mock_response.read.side_effect = [b'x' * 100, b'']
                mock_response.headers.get.return_value = None
                return mock.MagicMock(__enter__=lambda s: mock_response, __exit__=lambda *args: None)

        with mock.patch('urllib.request.urlopen', side_effect=mock_urlopen_side_effect):
            result = download.download_file(test_item, target_dir)

            self.assertEqual(result['status'], 'completed')
            self.assertEqual(call_count, 2)  # Tried both mirrors

    def test_hash_mismatch_restarts_next_mirror_from_zero(self):
        """A bad resumed response must not be concatenated with the next mirror."""
        import io

        expected = b'abcdefghij'
        item = {
            'path': 'reset-test.bin',
            'size': len(expected),
            'sha256': hashlib.sha256(expected).hexdigest(),
            'urls': ['http://mirror1.example/file', 'http://mirror2.example/file'],
        }
        target_dir = self.temp_path / 'weights'
        target_dir.mkdir(parents=True, exist_ok=True)
        (target_dir / 'reset-test.bin.partial').write_bytes(expected[:4])

        calls = []

        def response(data, content_range=None):
            result = mock.MagicMock()
            stream = io.BytesIO(data)
            result.read.side_effect = lambda size=-1: stream.read(size)
            result.headers.get.side_effect = lambda key, default='': content_range if key == 'Content-Range' else default
            return result

        def open_url(request, timeout=None):
            calls.append(request)
            if len(calls) == 1:
                return mock.MagicMock(__enter__=lambda _: response(b'XXXXXX', 'bytes 4-9/10'), __exit__=lambda *args: None)
            return mock.MagicMock(__enter__=lambda _: response(expected), __exit__=lambda *args: None)

        with mock.patch('urllib.request.urlopen', side_effect=open_url):
            result = download.download_file(item, target_dir)

        self.assertEqual(result['status'], 'completed')
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0].headers['Range'], 'bytes=4-')
        self.assertNotIn('Range', calls[1].headers)
        self.assertEqual((target_dir / 'reset-test.bin').read_bytes(), expected)

    def test_path_traversal_prevention(self):
        """Test that path traversal attempts are blocked."""
        test_item = {
            'path': '../../../etc/passwd',
            'size': 100,
            'sha256': 'dummy',
            'urls': ['http://example.com/file']
        }

        target_dir = self.temp_path / 'weights'
        target_dir.mkdir(parents=True, exist_ok=True)

        # This should raise ValueError from support.safe_child
        with self.assertRaises(ValueError):
            download.download_file(test_item, target_dir)

    def test_already_present_file(self):
        """Test that existing valid files are skipped."""
        mock_content = b'existing content'
        test_item = {
            'path': 'existing.bin',
            'size': len(mock_content),
            'sha256': hashlib.sha256(mock_content).hexdigest(),
            'urls': ['http://example.com/file']
        }

        target_dir = self.temp_path / 'weights'
        target_dir.mkdir(parents=True, exist_ok=True)

        # Create the file with correct content
        final_file = target_dir / 'existing.bin'
        final_file.write_bytes(mock_content)

        result = download.download_file(test_item, target_dir)

        self.assertEqual(result['status'], 'completed')
        self.assertTrue(result.get('already_present'))
        self.assertEqual(result['bytes_downloaded'], 0)

    def test_manifest_download(self):
        """Test downloading multiple files from manifest."""
        mock_files_data = [
            (b'file1', 'file1.bin'),
            (b'file2content', 'file2.bin'),
        ]

        manifest = {
            'files': [
                {
                    'path': name,
                    'size': len(data),
                    'sha256': hashlib.sha256(data).hexdigest(),
                    'urls': [f'http://example.com/{name}']
                }
                for data, name in mock_files_data
            ]
        }

        target_dir = self.temp_path / 'weights'
        target_dir.mkdir(parents=True, exist_ok=True)

        # Mock download_file to simulate successful downloads
        with mock.patch.object(download, 'download_file') as mock_download:
            mock_download.return_value = {'status': 'completed', 'bytes_downloaded': 100}

            result = download.download_manifest(manifest, target_dir)

            self.assertEqual(result['total_files'], 2)
            self.assertEqual(result['completed'], 2)
            self.assertEqual(result['failed'], 0)
            self.assertEqual(mock_download.call_count, 2)


class TestDownloadBoundaries(unittest.TestCase):
    """Test edge cases and parameter boundaries."""

    def test_zero_byte_file(self):
        """Test handling of zero-byte files."""
        test_item = {
            'path': 'empty.txt',
            'size': 0,
            'sha256': hashlib.sha256(b'').hexdigest(),
            'urls': ['http://example.com/empty']
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            with mock.patch('urllib.request.urlopen') as mock_urlopen:
                mock_response = mock.MagicMock()
                mock_response.read.return_value = b''
                mock_response.headers.get.return_value = None
                mock_urlopen.return_value.__enter__.return_value = mock_response

                result = download.download_file(test_item, temp_dir)

                self.assertEqual(result['status'], 'completed')

    def test_invalid_manifest_structure(self):
        """Test handling of malformed manifest."""
        invalid_manifest = {'files': None}

        with tempfile.TemporaryDirectory() as temp_dir:
            # Should handle gracefully with empty files list
            result = download.download_manifest(invalid_manifest, temp_dir)
            self.assertEqual(result['total_files'], 0)

    def test_partial_larger_than_expected(self):
        """Test handling when partial file is larger than expected size."""
        test_item = {
            'path': 'oversized.bin',
            'size': 100,
            'sha256': hashlib.sha256(b'x' * 100).hexdigest(),
            'urls': ['http://example.com/file']
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            target_dir = temp_path / 'weights'
            target_dir.mkdir(parents=True)

            # Create oversized partial
            partial = target_dir / 'oversized.bin.partial'
            partial.write_bytes(b'x' * 150)  # Larger than expected

            # The code should treat this as complete and validate
            # Since hash won't match, it will restart download
            with mock.patch('urllib.request.urlopen') as mock_urlopen:
                mock_response = mock.MagicMock()
                mock_response.read.side_effect = [b'x' * 100, b'']
                mock_response.headers.get.return_value = None
                mock_urlopen.return_value.__enter__.return_value = mock_response

                result = download.download_file(test_item, target_dir)

                # Should succeed after restarting from scratch
                self.assertEqual(result['status'], 'completed')


if __name__ == '__main__':
    unittest.main()
