"""CPU orchestration tests; model phases/export are fixtures, not GPU acceptance."""
from contextlib import ExitStack, nullcontext
import copy
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from local_video import runner, support
from local_video.h3_worker import verify_recovery_file


class LocalVideoHandoffTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.prompt = self.root/'prompt.txt'
        self.prompt.write_text('A simple motion preview.', encoding='utf-8')
        self.cfg = dict(python=sys.executable, source_dir=str(self.root),
                        weights_dir=str(self.root/'weights'))
        vae = self.root/'weights/minimax_h3/minimax_h3_video_vae_int8_convrot.safetensors'
        vae.parent.mkdir(parents=True)
        vae.write_bytes(b'fixture-vae')
        meta = copy.deepcopy(support.manifest())
        meta['files'] = [item for item in meta['files'] if 'qwen3vl' in item['path']]
        meta['files'].append(dict(path=vae.relative_to(self.root/'weights').as_posix(),
                                 size=vae.stat().st_size, sha256=support.digest(vae)))
        for module in (runner, support):
            self.stack.enter_context(patch.object(module, 'manifest', return_value=meta))
        self.stack.enter_context(patch.object(support, 'source_revision', return_value=meta['source']['revision']))
        self.preflight = self.stack.enter_context(patch.object(runner, 'validate_config'))
        self.lock = self.stack.enter_context(patch.object(runner, 'gpu_lock', side_effect=lambda *args: nullcontext()))
        self.stack.enter_context(patch.object(runner, 'worker', side_effect=self.worker))
        self.stack.enter_context(patch.object(runner, 'emit'))
        self.stack.enter_context(patch.dict(sys.modules, {'local_video.media': SimpleNamespace(export_video=self.export)}))
        self.phases = []
        self.decode_error = None
        self.tamper_before_decode = False
        self.exports = 0

    def request(self, attempt, mode='generate', source=None):
        directory = self.root/f'job/attempt-{attempt}'
        directory.mkdir(parents=True)
        return dict(mode=mode, config=self.cfg, input_path=str(source or self.prompt),
                    output_path=str(directory/'output.mp4'), receipt_path=str(directory/'result.json'),
                    parameters={}, ffmpeg='fixture-ffmpeg', ffprobe='fixture-ffprobe')

    def worker(self, request_file, phase, cfg, p, started, work):
        self.phases.append(phase)
        request = support.read_json(request_file)
        if phase == 'text':
            (work/'conditioning.pt').write_bytes(b'fixture-conditioning')
        elif phase == 'sample':
            (work/'video-latent.pt').write_bytes(b'complete-finite-latent-fixture')
        elif phase == 'decode':
            source = Path(request['recover_dir'])
            if self.tamper_before_decode:
                (source/'video-latent.pt').write_bytes(b'changed-latent')
            verify_recovery_file(request, source, 'video-latent.pt')
            if self.decode_error:
                raise RuntimeError(self.decode_error)
            (work/'decoded-pixels.npy').write_bytes(b'decoded-pixels-fixture')

    def export(self, work, output, parameters, ffmpeg, ffprobe):
        self.assertEqual((work/'decoded-pixels.npy').read_bytes(), b'decoded-pixels-fixture')
        self.exports += 1
        output.write_bytes(b'fixture-export-not-a-real-mp4')
        return dict(output_path=str(output), technical_status='passed')

    def test_fresh_sampling_hands_checkpoint_hash_to_real_decoder_guard(self):
        request = self.request(1)
        runner.run(request)
        self.assertEqual(self.phases, ['text', 'sample', 'decode'])
        work = Path(request['output_path']).parent/'local-video'
        saved = support.read_json(work/'recovery.json')
        forwarded = support.read_json(work/'request.json')['recovery_hashes']
        self.assertEqual(forwarded['video-latent.pt'], saved['files']['video-latent.pt']['sha256'])
        self.assertEqual(self.exports, 1)

    def test_changed_latent_is_rejected_before_export(self):
        self.tamper_before_decode = True
        request = self.request(1)
        with self.assertRaisesRegex(ValueError, 'changed after validation'):
            runner.run(request)
        self.assertEqual(self.exports, 0)
        failure = support.read_json(Path(request['output_path']).parent/'local-video/failure.json')
        self.assertEqual(failure['stage'], 'decode')

    def test_failed_decode_retries_saved_latent_without_resampling(self):
        self.decode_error = 'fixture decoder interrupted'
        first = self.request(1)
        with self.assertRaisesRegex(RuntimeError, 'fixture decoder interrupted'):
            runner.run(first)
        old = Path(first['output_path']).parent/'local-video'
        before = support.digest(old/'video-latent.pt')
        self.decode_error = None
        self.phases.clear()
        self.preflight.reset_mock()
        result = runner.run(self.request(2))
        self.assertEqual(self.phases, ['decode'])
        self.preflight.assert_not_called()
        self.assertEqual(result['recovered_from'], str(old/'recovery.json'))
        self.assertEqual(before, support.digest(old/'video-latent.pt'))
        self.assertTrue((old/'failure.json').is_file())

    def test_pixel_recovery_bypasses_worker_models_and_gpu_lock(self):
        first = self.request(1)
        runner.run(first)
        source = Path(first['output_path']).parent/'local-video/recovery.json'
        self.phases.clear()
        self.preflight.reset_mock()
        self.lock.reset_mock()
        runner.run(self.request(2, mode='recover', source=source))
        self.assertEqual(self.phases, [])
        self.preflight.assert_not_called()
        self.lock.assert_not_called()
        self.assertEqual(self.exports, 2)

    def test_decoder_rejects_missing_hash(self):
        with self.assertRaisesRegex(ValueError, 'Recovery hash missing'):
            verify_recovery_file({'recovery_hashes': {}}, self.root, 'video-latent.pt')


if __name__ == '__main__':
    unittest.main()
