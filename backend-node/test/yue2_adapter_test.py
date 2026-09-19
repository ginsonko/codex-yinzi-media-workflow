"""Model-free configuration, installation safety and request contract tests."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import wave


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / 'scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


support = load('support', 'yue2-support.py')
worker = load('worker', 'yue2-audio.py')
setup = load('setup', 'setup-yue2.py')


class YuE2Adapter(unittest.TestCase):
    def test_config_merge_preserves_other_backends_and_custom_settings(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'neural-audio.json'
            initial = {'music': {'python': 'music-venv'}, 'voice': {'python': 'voice-venv'}, 'custom': [1, 2], 'song': {'user_note': 'preserve'}, 'cache_root': 'existing-cache'}
            target.write_text(json.dumps(initial), 'utf-8')
            support.merge_configuration(target, {'python': 'song-venv'}, Path(temp) / 'new-cache')
            saved = json.loads(target.read_text('utf-8'))
            self.assertEqual(saved['music'], initial['music'])
            self.assertEqual(saved['voice'], initial['voice'])
            self.assertEqual(saved['cache_root'], 'existing-cache')
            self.assertEqual(saved['custom'], [1, 2])
            self.assertEqual(saved['song'], {'user_note': 'preserve', 'python': 'song-venv'})

    def test_invalid_configuration_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'config.json'
            target.write_text('[1,2]', 'utf-8')
            with self.assertRaises(ValueError):
                support.merge_configuration(target, {}, temp)
            self.assertEqual(target.read_text(), '[1,2]')

    def test_hardware_advice_does_not_promise_4_5gb_or_submit_online(self):
        profile = {'selected_device': 0, 'disk_free_gib': 30, 'ram_available_gib': 24, 'gpus': []}
        self.assertEqual(support.recommend(profile)['status'], 'online_recommended')
        profile['gpus'] = [{'index': 0, 'total_gib': 8, 'free_gib': 2}]
        self.assertEqual(support.recommend(profile)['status'], 'free_resources_or_online')
        profile['gpus'][0]['free_gib'] = 7
        self.assertEqual(support.recommend(profile)['status'], 'local_short_sample_recommended')
        self.assertEqual(support.recommend(profile)['online_submission'], 'never_automatic')
        profile['selected_device'] = 1
        self.assertEqual(support.recommend(profile)['status'], 'online_recommended')

    def test_incomplete_weights_and_wrong_source_never_become_ready(self):
        with tempfile.TemporaryDirectory() as temp:
            self.assertFalse(support.weights_status(temp)['ready'])
            with self.assertRaises(RuntimeError):
                setup.install_source(Path(temp))
            self.assertEqual(list(Path(temp).iterdir()), [])

    def test_worker_checks_lyrics_duration_and_abc_before_model_load(self):
        self.assertEqual(worker.validate_request({'text': '[Verse]\nSing this line', 'duration_seconds': 30}), ('[Verse]\nSing this line', 30))
        for p in [{'lyrics': ''}, {'lyrics': 'test', 'seconds': float('nan')}, {'lyrics': 'test', 'seconds': True}, {'lyrics': 'test', 'purpose': 'commercial'}]:
            with self.assertRaises(ValueError):
                worker.validate_request(p)
        with tempfile.TemporaryDirectory() as temp:
            score = Path(temp) / 'melody.abc'
            score.write_text('X:1\nM:4/4\nK:C\nCDEF|', 'utf-8')
            worker.validate_request({'lyrics': 'This is a line', 'score_file': str(score)})
            with self.assertRaises(ValueError):
                worker.validate_request({'lyrics': 'This is a line', 'score_file': str(score), 'mode': 2})

    def test_recovery_identity_preserves_composition_and_ignores_output_location(self):
        first = dict(lyrics='唱出好天气', style='pop', seed=1, seconds=15, output='first.wav', python='venv-a')
        moved = {**first, 'output': 'second.wav', 'python': 'venv-b'}
        self.assertEqual(worker.request_fingerprint(first), worker.request_fingerprint(moved))
        self.assertNotEqual(worker.request_fingerprint(first), worker.request_fingerprint({**first, 'lyrics': '另一首歌'}))
        self.assertNotEqual(worker.request_fingerprint(first), worker.request_fingerprint({**first, 'seed': 2}))

    def test_recovery_uses_existing_take_without_importing_models_and_rejects_changed_lyrics(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output, receipt, request = root / 'song.wav', root / 'receipt.json', root / 'request.json'
            with wave.open(str(output), 'wb') as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(8000)
                audio.writeframes(b'\x01\x00' * 80)
            p = dict(lyrics='唱出好天气', output=str(output), receipt=str(receipt), seconds=10)
            request.write_text(json.dumps(p), 'utf-8')
            receipt.write_text(json.dumps(dict(success=True, sha256=support.digest(output), request_sha256=worker.request_fingerprint(p))), 'utf-8')
            with patch('sys.argv', ['yue2-audio.py', '--request', str(request)]), patch.object(worker, 'load_pipeline', side_effect=AssertionError('should not load model')):
                worker.main()
                p['lyrics'] = '现在是另一首歌'
                request.write_text(json.dumps(p), 'utf-8')
                with self.assertRaises(FileExistsError):
                    worker.main()
            self.assertEqual(support.digest(output), json.loads(receipt.read_text())['sha256'])

    def test_inspect_is_read_only_without_downloads(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'not-created'
            with patch('sys.argv', ['setup-yue2.py', '--inspect', '--root', str(root), '--config', str(root / 'config.json')]), patch.object(setup.support, 'hardware', return_value={'gpus': []}), patch.object(setup, 'run', side_effect=AssertionError('no process/download in inspect')):
                setup.main()
            self.assertFalse(root.exists())


if __name__ == '__main__':
    unittest.main()
