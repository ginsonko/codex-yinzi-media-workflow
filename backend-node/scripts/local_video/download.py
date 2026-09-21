"""Resumable verified downloads with mirror fallback and atomic commit."""
import hashlib
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request

from . import support


def download_file(item, directory, mirrors=None, progress_callback=None):
    """Download a single manifest file with resume support and hash verification.

    Args:
        item: Manifest file entry with 'path', 'size', 'sha256', 'urls'
        directory: Target directory for completed file
        mirrors: Optional list of URL prefixes to try before manifest URLs
        progress_callback: Optional function(stage, bytes_downloaded, total_bytes, message)

    Returns:
        dict with status='completed'|'failed', bytes_downloaded, error (if failed)

    The function preserves partial downloads on failure and verifies ranges
    before committing. Signed URLs are never logged.
    """
    directory = Path(directory).resolve()
    target = support.safe_child(directory, item['path'])
    target.parent.mkdir(parents=True, exist_ok=True)

    expected_size = item['size']
    expected_hash = item['sha256']
    partial = target.with_suffix(target.suffix + '.partial')

    # Check if final file already exists and is valid
    if target.is_file() and target.stat().st_size == expected_size:
        actual_hash = support.digest(target)
        if actual_hash == expected_hash:
            if progress_callback:
                progress_callback('already_present', expected_size, expected_size, f'{item["path"]} already downloaded and verified')
            return dict(status='completed', bytes_downloaded=0, already_present=True)

    # Resume from partial if it exists and size is reasonable
    start_byte = 0
    if partial.is_file():
        partial_size = partial.stat().st_size
        if 0 < partial_size < expected_size:
            start_byte = partial_size
            if progress_callback:
                progress_callback('resuming', start_byte, expected_size, f'Resuming {item["path"]} from byte {start_byte}')
        elif partial_size >= expected_size:
            # Partial is complete size, validate and commit
            partial.rename(target)
            actual_hash = support.digest(target)
            if actual_hash == expected_hash:
                if progress_callback:
                    progress_callback('verified', expected_size, expected_size, f'{item["path"]} validated from previous partial')
                return dict(status='completed', bytes_downloaded=0, resumed=True)
            else:
                target.unlink()
                start_byte = 0

    # Build URL list: mirrors first, then manifest URLs
    urls = []
    if mirrors:
        for mirror in mirrors:
            urls.append(mirror.rstrip('/') + '/' + item['path'])
    urls.extend(item.get('urls', []))

    last_error = None
    for url_index, url in enumerate(urls):
        try:
            # Don't log URLs that might contain signatures
            safe_url = url.split('?')[0] if '?' in url else url
            if progress_callback:
                progress_callback('downloading', start_byte, expected_size,
                                f'Downloading {item["path"]} from mirror {url_index + 1}/{len(urls)}')

            request = urllib.request.Request(url)
            if start_byte > 0:
                request.add_header('Range', f'bytes={start_byte}-')

            with urllib.request.urlopen(request, timeout=60) as response:
                # Verify server supports range requests if resuming
                if start_byte > 0:
                    content_range = response.headers.get('Content-Range', '')
                    if not content_range.startswith(f'bytes {start_byte}-'):
                        # Server doesn't support resume, start over
                        if partial.is_file():
                            partial.unlink()
                        start_byte = 0
                        request = urllib.request.Request(url)
                        with urllib.request.urlopen(request, timeout=60) as full_response:
                            response = full_response
                            mode = 'wb'
                            bytes_written = 0
                            last_progress = time.time()
                            with partial.open(mode) as f:
                                while True:
                                    chunk = response.read(8 * 1024 * 1024)
                                    if not chunk:
                                        break
                                    f.write(chunk)
                                    bytes_written += len(chunk)
                                    now = time.time()
                                    if progress_callback and (now - last_progress >= 2.0 or bytes_written >= expected_size):
                                        progress_callback('downloading', bytes_written, expected_size,
                                                          f'Downloaded {bytes_written / (1024**3):.2f} GB / {expected_size / (1024**3):.2f} GB')
                                        last_progress = now
                        response = None

                # Stream to partial file
                if response is not None:
                    mode = 'ab' if start_byte > 0 else 'wb'
                    bytes_written = 0
                    last_progress = time.time()

                    with partial.open(mode) as f:
                        while True:
                            chunk = response.read(8 * 1024 * 1024)  # 8MB chunks
                            if not chunk:
                                break
                            f.write(chunk)
                            bytes_written += len(chunk)

                            # Progress callback every 2 seconds or on completion
                            now = time.time()
                            if progress_callback and (now - last_progress >= 2.0 or start_byte + bytes_written >= expected_size):
                                progress_callback('downloading', start_byte + bytes_written, expected_size,
                                                f'Downloaded {(start_byte + bytes_written) / (1024**3):.2f} GB / {expected_size / (1024**3):.2f} GB')
                                last_progress = now

            # Verify size matches
            final_size = partial.stat().st_size
            if final_size != expected_size:
                last_error = f'Size mismatch: got {final_size}, expected {expected_size}'
                continue

            # Verify hash before atomic commit
            if progress_callback:
                progress_callback('verifying', final_size, expected_size, f'Verifying {item["path"]} hash')

            actual_hash = support.digest(partial)
            if actual_hash != expected_hash:
                last_error = f'Hash mismatch: got {actual_hash}, expected {expected_hash}'
                # Keep partial for inspection but mark it
                partial.rename(partial.with_suffix(partial.suffix + f'.bad-{time.time_ns()}'))
                # A bad complete response must restart from byte zero on the
                # next mirror; carrying the old offset would create a corrupt
                # concatenation and hide the useful mirror fallback.
                start_byte = 0
                continue

            # Atomic commit
            partial.rename(target)
            if progress_callback:
                progress_callback('completed', expected_size, expected_size, f'{item["path"]} downloaded and verified')

            return dict(status='completed', bytes_downloaded=bytes_written, resumed=start_byte > 0)

        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            last_error = f'{type(e).__name__}: {e}'
            if progress_callback:
                progress_callback('mirror_failed', start_byte, expected_size,
                                f'Mirror {url_index + 1} failed, trying next')
            continue

    # All mirrors failed
    return dict(status='failed', bytes_downloaded=0, error=last_error or 'All mirrors failed',
                partial_preserved=partial.is_file())


def download_manifest(manifest_data, directory, mirrors=None, progress_callback=None, skip_existing=True):
    """Download all files from a manifest.

    Args:
        manifest_data: Full manifest dict with 'files' list
        directory: Target directory
        mirrors: Optional mirror URL prefixes
        progress_callback: Optional progress function
        skip_existing: Skip files that are already present and valid

    Returns:
        dict with total_files, completed, failed, bytes_downloaded, failures (list of dicts)
    """
    files = manifest_data.get('files', []) or []
    total_files = len(files)
    completed = 0
    failed_items = []
    total_bytes = 0

    for index, item in enumerate(files, 1):
        if progress_callback:
            progress_callback('file_start', index, total_files, f'Processing {item["path"]} ({index}/{total_files})')

        result = download_file(item, directory, mirrors=mirrors, progress_callback=progress_callback)

        if result['status'] == 'completed':
            completed += 1
            total_bytes += result.get('bytes_downloaded', 0)
        else:
            failed_items.append(dict(path=item['path'], error=result.get('error', 'Unknown error')))

    return dict(
        total_files=total_files,
        completed=completed,
        failed=len(failed_items),
        bytes_downloaded=total_bytes,
        failures=failed_items
    )
