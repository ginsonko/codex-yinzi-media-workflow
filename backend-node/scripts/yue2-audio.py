"""Offline YuE2 singing worker for the durable local-media queue."""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import threading
import time
import traceback

spec = importlib.util.spec_from_file_location('yue2_support', Path(__file__).with_name('yue2-support.py'))
support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(support)


def load_pipeline(source, runtime=None):
    if runtime:
        sys.path.insert(0, str(runtime))
    sys.path.insert(0, str(source))
    folder = Path(source) / 'models/TTS/yue2'
    spec = importlib.util.spec_from_file_location('isolated_yue2', folder / '__init__.py', submodule_search_locations=[str(folder)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    from mmgp import quant_router
    quant_router.register_handler('shared.qtypes.int8_convrot')
    from isolated_yue2.pipeline import YuE2Pipeline
    return YuE2Pipeline


def validate_request(p):
    lyrics = p.get('lyrics', p.get('text', ''))
    if not isinstance(lyrics, str) or not lyrics.strip() or len(lyrics) > 12000 or '\0' in lyrics:
        raise ValueError('A song requires nonempty UTF-8 lyrics, at most 12000 characters')
    if p.get('purpose', 'personal') == 'commercial':
        raise ValueError('This YuE2 checkpoint uses CC-BY-NC-4.0 weights. Select a suitable licensed model for commercial work.')
    if not isinstance(p.get('style', ''), str) or len(p.get('style', '')) > 4000:
        raise ValueError('Song style must be text, at most 4000 characters')
    seconds = p.get('seconds', p.get('duration_seconds', 45))
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or not 5 <= seconds <= 360:
        raise ValueError('Requested song duration must be 5–360 seconds; actual model output can be shorter')
    if p.get('score_file'):
        score = Path(p['score_file'])
        if not score.is_file() or not 0 < score.stat().st_size <= 256000:
            raise ValueError('score_file must be a nonempty ABC text file no larger than 256 KB')
        text = score.read_text('utf-8-sig')
        if '\0' in text or '\ufffd' in text or not text.strip():
            raise ValueError('score_file must contain valid UTF-8 ABC text')
        if p.get('mode', 0) == 2:
            raise ValueError('An external ABC score requires mode 0 (full) or 1 (melody)')
    return lyrics, seconds


def request_fingerprint(p):
    # Output locations and interpreter/cache paths do not change the composition.
    excluded = {'output', 'receipt', 'python', 'cache_root', 'runtime_dir', 'source_dir', 'weights_dir'}
    content = {key: value for key, value in p.items() if key not in excluded}
    return hashlib.sha256(json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', type=Path, required=True)
    args = parser.parse_args()
    p = json.loads(args.request.read_text('utf-8-sig'))
    lyrics, seconds = validate_request(p)
    fingerprint = request_fingerprint(p)
    output, receipt = Path(p['output']), Path(p['receipt'])
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        # A process can exit after writing the file: recover a verified receipt,
        # never overwrite an existing take or silently generate it a second time.
        existing = json.loads(receipt.read_text('utf-8')) if receipt.exists() else {}
        if existing.get('success') and existing.get('request_sha256') == fingerprint and existing.get('sha256') == support.digest(output):
            support.emit('recovered', '已复用原尝试的完整歌曲，无需再次推理')
            return
        raise FileExistsError('Existing audio was preserved. Inspect/recover it or use a new local task attempt; no generation was started.')
    threads = int(p.get('threads', 4))
    cache = Path(p.get('cache_root') or output.parent / '.cache')
    cache.mkdir(parents=True, exist_ok=True)
    os.environ.update(OMP_NUM_THREADS=str(threads), MKL_NUM_THREADS=str(threads), OPENBLAS_NUM_THREADS=str(threads),
                      PYTHONIOENCODING='utf-8', HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                      TRITON_CACHE_DIR=str(cache / 'yue2-triton'))
    if p.get('runtime_dir'):
        sys.path.insert(0, p['runtime_dir'])
    started = time.monotonic()
    pipeline = manager = torch = None
    stop = threading.Event()
    monitor_thread = None
    result = dict(success=False, model='WanGP YuE2 INT8', source_revision=support.WANGP_REVISION,
                  weights_revision=support.WEIGHTS_REVISION, license='CC-BY-NC-4.0 weights',
                  requested_seconds=seconds, request_sha256=fingerprint, quality_status='review_required', lyrical_accuracy='requires_listening_review')
    peaks = dict(rss=0, allocated=0, reserved=0)
    try:
        profile = support.hardware(output.parent, int(p.get('device', 0)))
        result['hardware'] = profile
        support.emit('hardware_check', '已检查硬件；先用短样确认歌曲、人声和歌词', recommendation=profile['recommendation'])
        source, weights = Path(p['source_dir']), Path(p['weights_dir'])
        if support.source_revision(source) != support.WANGP_REVISION:
            raise RuntimeError('Supported pinned WanGP source is missing; rerun setup-yue2.py --inspect')
        if not support.weights_status(weights)['ready']:
            raise RuntimeError('YuE2 weights are missing/incomplete; rerun setup-yue2.py. No online inference is used.')
        import torch
        import psutil
        import soundfile as sf
        import numpy as np
        if not torch.cuda.is_available():
            raise RuntimeError('CUDA unavailable; this is a singing GPU backend, not the MusicGen CPU instrumental backend')
        device = int(p.get('device', 0))
        torch.cuda.set_device(device)
        torch.set_num_threads(threads)
        torch.set_num_interop_threads(min(2, threads))
        free, total = torch.cuda.mem_get_info(device)
        minimum_ram = float(p.get('minimum_free_ram_gib', 4))
        minimum_vram = float(p.get('minimum_free_vram_gib', 0))
        if psutil.virtual_memory().available < minimum_ram * support.GIB:
            raise RuntimeError(f'Available RAM is below your configured {minimum_ram:g} GiB reserve. Free resources or choose an online song provider; this task can be retried.')
        if free < minimum_vram * support.GIB:
            raise RuntimeError(f'Available VRAM is below your configured {minimum_vram:g} GiB reserve. Close another GPU task or change resource settings and retry.')
        # Leave room for display/other processes without tying a fraction to an
        # assumed 8 GB card. MMGP budgets remain independently configurable.
        fraction = p.get('gpu_fraction')
        if fraction is None:
            fraction = max(.1, min(.9, (free - .5 * support.GIB) / total))
        torch.cuda.set_per_process_memory_fraction(float(fraction), device)
        result['gpu_fraction'] = fraction
        torch.cuda.reset_peak_memory_stats(device)
        pipeline_class = load_pipeline(source)
        from mmgp import offload
        last_event = [0.0]

        def progress(**kw):
            now = time.monotonic()
            completed, total_steps = kw.get('step_idx'), kw.get('override_num_inference_steps')
            title = str(kw.get('denoising_extra') or kw.get('progress_title') or 'YuE2 原生歌唱生成')
            if now - last_event[0] >= 1 or completed == 0:
                last_event[0] = now
                event = dict(stage='song_synthesis', message=title, elapsed_seconds=round(now - started, 2),
                             completed=int(completed) + 1 if completed is not None else None, total=total_steps)
                support.atomic_json(output.parent / 'yue2-progress.json', event)
                support.emit(**event)

        class CheckpointPipeline(pipeline_class):
            def _tokens(self, prefix, sampling, seed, phase, callback, *args, **kwargs):
                tokens = super()._tokens(prefix, sampling, seed, phase, callback, *args, **kwargs)
                support.atomic_json(output.parent / (phase + '-tokens.json'), {'prefix': prefix, 'tokens': tokens, 'truncated': self.last_truncated.get(phase)})
                if self.last_plan:
                    support.atomic_json(output.parent / 'yue2-plan.json', self.last_plan)
                return tokens

        def monitor():
            with (output.parent / 'yue2-resources.jsonl').open('a', encoding='utf-8') as stream:
                while not stop.wait(3):
                    memory = psutil.virtual_memory()
                    current = dict(elapsed_seconds=round(time.monotonic() - started, 2), rss=psutil.Process().memory_info().rss,
                                   allocated=torch.cuda.memory_allocated(device), reserved=torch.cuda.memory_reserved(device), available_ram=memory.available)
                    for key in peaks:
                        peaks[key] = max(peaks[key], current[key])
                    stream.write(json.dumps(current) + '\n')
                    stream.flush()
                    if memory.available < min(minimum_ram, 2) * support.GIB or current['elapsed_seconds'] > p.get('timeout_seconds', 3600):
                        result['interruption'] = {'reason': 'low_system_memory' if memory.available < min(minimum_ram, 2) * support.GIB else 'time_limit',
                                                  'available_ram_gib': round(memory.available / support.GIB, 2), 'elapsed_seconds': current['elapsed_seconds']}
                        if pipeline is not None:
                            pipeline._interrupt = True
                        return

        monitor_thread = threading.Thread(target=monitor, daemon=True)
        monitor_thread.start()
        support.emit('model_loading', '正在加载本地 INT8 歌曲模型和 CPU 卸载管理器')
        pipeline = CheckpointPipeline(str(weights / 'YuE2_AR/YuE2_AR_int8_convrot.safetensors'),
                                      str(weights / 'YuE2_Acoustic_int8_convrot.safetensors'), str(weights / 'YuE2_AR/qwen.tiktoken'),
                                      str(weights / 'yue2/YuE2_VAE_bf16.safetensors'), str(weights / 'yue2/vae_config.json'),
                                      torch.bfloat16, torch.bfloat16, 'legacy')
        manager = offload.profile({'text_encoder': pipeline.text_encoder, 'transformer': pipeline.transformer, 'vae': pipeline.vae},
                                  profile_no=int(p.get('offload_profile', 5)), quantizeTransformer=False, extraModelsToQuantize=None,
                                  pinnedMemory=False, asyncTransfers=False, budgets=p.get('budgets', {'text_encoder': 3000, 'transformer': 1700, 'vae': 600, '*': 600}),
                                  vram_safety_coefficient=.55, verboseLevel=1)
        score = Path(p['score_file']).resolve() if p.get('score_file') else None
        if score:
            result['input_score_sha256'] = support.digest(score)
        if result.get('interruption'):
            raise RuntimeError('System resources changed while loading YuE2; stage files were preserved. Free resources and retry this local task.')
        audio = pipeline.generate(input_prompt=lyrics, alt_prompt=p.get('style', ''), seed=p.get('seed', 42), duration_seconds=seconds,
                                  sampling_steps=p.get('steps', 32), guide_scale=p.get('guidance', 1.0), temperature=p.get('temperature', 1.0),
                                  top_k=p.get('top_k', 100), top_p=p.get('top_p', .95), model_mode=p.get('mode', 0),
                                  input_custom=str(score) if score else None, custom_settings={'save_score': 0},
                                  VAE_tile_size=p.get('vae_tile', 64), callback=progress, offloadobj=manager)
        if audio is None or result.get('interruption'):
            reason = result.get('interruption') or {}
            note = f"Available system RAM fell to {reason['available_ram_gib']} GiB. " if reason.get('reason') == 'low_system_memory' else ''
            raise RuntimeError(note + 'YuE2 stopped without complete audio; free resources or adjust the timeout, then retry. Stage files and the existing attempt were preserved.')
        samples = audio['x'].detach().cpu().T.float().numpy()
        if not samples.size or not np.isfinite(samples).all():
            raise RuntimeError('YuE2 produced empty/nonfinite audio')
        peak = float(np.abs(samples).max())
        if peak < 1e-7:
            raise RuntimeError('YuE2 produced silent audio')
        gain = min(1.0, .97 / peak)
        samples *= gain
        temporary = output.with_suffix('.partial.wav')
        sf.write(temporary, samples, audio['audio_sampling_rate'], subtype='PCM_24')
        temporary.replace(output)
        result.update(success=True, seconds=len(samples) / audio['audio_sampling_rate'], sample_rate=audio['audio_sampling_rate'],
                      channels=1 if samples.ndim == 1 else samples.shape[1], audio=str(output), sha256=support.digest(output),
                      raw_float_peak=peak, pcm_export_gain=gain, peak=float(np.abs(samples).max()))
        support.emit('audio_exported', '已导出无新增削波的歌曲 WAV；接下来核对歌词与听感')
    except Exception as exc:
        result.update(error=str(exc), error_type=type(exc).__name__)
        traceback.print_exc()
    finally:
        if pipeline is not None:
            try:
                if pipeline.last_plan:
                    support.atomic_json(output.parent / 'yue2-plan.json', pipeline.last_plan)
                    if pipeline.last_plan.get('abc'):
                        (output.parent / 'composition.abc').write_text(pipeline.last_plan['abc'], 'utf-8')
                if p.get('save_latents') and pipeline.last_latents is not None:
                    torch.save(pipeline.last_latents.cpu(), output.parent / 'latents.pt')
                result['truncated'] = pipeline.last_truncated
                pipeline.release()
            except Exception as exc:
                result['cleanup_note'] = str(exc)
        if manager is not None:
            try:
                manager.unload_all()
            except Exception as exc:
                result['offload_cleanup_note'] = str(exc)
        stop.set()
        if monitor_thread:
            monitor_thread.join(timeout=5)
        result.update(elapsed_seconds=round(time.monotonic() - started, 3), resources=peaks)
        if torch is not None and torch.cuda.is_available():
            result.update(cuda_max_allocated=torch.cuda.max_memory_allocated(), cuda_max_reserved=torch.cuda.max_memory_reserved())
        support.atomic_json(receipt, result)
    if not result['success']:
        support.emit('failed', result.get('error', 'Local song generation failed'), retryable=True)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
