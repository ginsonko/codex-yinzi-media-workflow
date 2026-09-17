"""Offline CPU audio worker. Invoked by the existing durable local-media queue."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import time


def emit(stage, message, **fields):
    print(json.dumps(dict(stage=stage, message=message, **fields), ensure_ascii=False), flush=True)


def split_text(text, limit=130):
    sentences = re.findall(r"[^。！？!?\n]+[。！？!?]?|\n", text)
    chunks, current = [], ''
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        while len(sentence) > limit:
            cut = max(sentence.rfind('，', 0, limit), sentence.rfind(',', 0, limit), sentence.rfind(' ', 0, limit))
            if cut < limit // 3:
                cut = limit
            else:
                cut += 1
            if current:
                chunks.append(current)
                current = ''
            chunks.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        separator = ' ' if current and re.search(r'[A-Za-z0-9.!?]$',current) and re.match(r'[A-Za-z0-9]',sentence) else ''
        if current and len(current) + len(separator) + len(sentence) > limit:
            chunks.append(current)
            current = ''
            separator = ''
        current += separator
        current += sentence
    if current:
        chunks.append(current)
    return chunks


def digest(file):
    h = hashlib.sha256()
    with open(file, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', type=Path, required=True)
    args = parser.parse_args()
    p = json.loads(args.request.read_text('utf-8-sig'))
    output = Path(p['output'])
    if output.exists():
        raise FileExistsError('Preserve existing output; recover its receipt or use a new attempt.')
    threads = int(p.get('threads', 4))
    os.environ.update(OMP_NUM_THREADS=str(threads), MKL_NUM_THREADS=str(threads), HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
    import numpy as np
    import soundfile as sf
    import psutil
    import torch
    minimum = float(p.get('minimum_free_ram_gib', 4))
    if psutil.virtual_memory().available < minimum * 1024 ** 3:
        raise RuntimeError(f'Available RAM below configured {minimum:g} GiB; close heavy work or select an online backend.')
    torch.set_num_threads(threads)
    torch.set_num_interop_threads(1)
    torch.manual_seed(p.get('seed', 42))
    started = time.monotonic()
    pieces = []
    emit('model_loading', '正在读取已下载的模型')
    if p['mode'] == 'music':
        from transformers import AutoProcessor, MusicgenForConditionalGeneration
        model_dir = Path(p['model_dir'])
        processor = AutoProcessor.from_pretrained(model_dir, local_files_only=True)
        model = MusicgenForConditionalGeneration.from_pretrained(model_dir, local_files_only=True, use_safetensors=True).eval()
        emit('generating', '正在生成短配乐')
        inputs = processor(text=[p['text']], padding=True, return_tensors='pt')
        with torch.inference_mode():
            result = model.generate(**inputs, do_sample=True, guidance_scale=3.0, max_new_tokens=round(float(p['seconds']) * 50))
        data = result[0, 0].cpu().numpy()
        rate = model.config.audio_encoder.sampling_rate
        model_name = 'facebook/musicgen-small'
    else:
        from f5_tts.api import F5TTS
        reference = Path(p['reference_path'])
        if not reference.is_file():
            raise FileNotFoundError(reference)
        ref_info = sf.info(reference)
        if not 1 <= ref_info.duration <= 30:
            raise ValueError('Use a clean 1–30 second reference recording; trim a suitable utterance first.')
        chunks = split_text(p['text'], int(p.get('segment_characters',130)))
        if not chunks:
            raise ValueError('No narration text')
        from importlib.metadata import version
        from importlib.resources import files
        vocab = Path(p.get('vocab_file') or files('f5_tts').joinpath('infer/examples/vocab.txt'))
        identity = {'text':p['text'],'reference':digest(reference),'reference_text':p['reference_text'],
                    'checkpoint':digest(p['checkpoint']),'vocab':digest(vocab),
                    'vocoder':{name:digest(Path(p['vocoder'])/name) for name in ['config.yaml','pytorch_model.bin']},
                    'f5_tts_version':version('f5-tts'),'seed':p.get('seed',42),'steps':32,'split_version':2,'segment_characters':int(p.get('segment_characters',130))}
        cache_key = hashlib.sha256(json.dumps(identity, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        cache = Path(p.get('cache_root') or output.parent / 'cache') / 'voice-segments' / cache_key
        cache.mkdir(parents=True, exist_ok=True)
        model = None
        audio = []
        rate = 24000
        for index, text in enumerate(chunks):
            file = cache / f'{index:04}.wav'
            metadata = cache / f'{index:04}.json'
            reused = False
            if file.is_file() and metadata.is_file():
                try:
                    old = json.loads(metadata.read_text('utf-8'))
                    reused = old.get('sha256') == digest(file) and old.get('text') == text
                except (ValueError,OSError):
                    reused = False
            if not reused:
                if model is None:
                    model = F5TTS(device='cpu', ckpt_file=p['checkpoint'], vocab_file=str(vocab), vocoder_local_path=p['vocoder'])
                emit('generating', f'正在生成第 {index+1}/{len(chunks)} 段配音', completed=index, total=len(chunks))
                temp = cache / f'{index:04}.partial.wav'
                wav, rate, _ = model.infer(ref_file=str(reference), ref_text=p['reference_text'], gen_text=text,
                                          nfe_step=32, seed=p.get('seed',42)+index, file_wave=str(temp))
                samples, actual_rate = sf.read(temp)
                if actual_rate != 24000 or len(samples)<actual_rate/4 or not np.isfinite(samples).all():
                    raise RuntimeError('Voice segment invalid; the partial file is retained for inspection.')
                temp.replace(file)
                metadata.write_text(json.dumps({'text':text,'sha256':digest(file)},ensure_ascii=False), 'utf-8')
            samples, actual_rate = sf.read(file)
            if actual_rate != rate:
                raise RuntimeError('Cached voice sample rate changed')
            audio.append(samples)
            if index < len(chunks)-1:
                audio.append(np.zeros(round(rate*.18)))
            pieces.append({'index':index,'text':text,'seconds':len(samples)/rate,'reused':reused,'sha256':digest(file)})
            emit('segment_completed', f'第 {index+1}/{len(chunks)} 段已保存',completed=index+1,total=len(chunks))
        data = np.concatenate(audio)
        model_name = 'F5TTS_v1_Base'
    if not np.isfinite(data).all() or len(data)<rate/4 or np.max(np.abs(data))<1e-6:
        raise RuntimeError('Generated audio is invalid or silent')
    output.parent.mkdir(parents=True, exist_ok=True)
    peak = float(np.max(np.abs(data)))
    gain = min(1.0, .95 / max(peak, 1e-9))
    temp = output.with_suffix('.partial.wav')
    sf.write(temp, data*gain, rate, subtype='PCM_24')
    temp.replace(output)
    receipt = {'model':model_name,'mode':p['mode'],'device':'cpu','threads':threads,'seed':p.get('seed',42),
               'sample_rate':rate,'seconds':len(data)/rate,'elapsed_seconds':time.monotonic()-started,
               'sha256':digest(output),'peak_before_gain':peak,'output_gain':gain,'segments':pieces,
               'weights_license':'CC-BY-NC-4.0','quality_status':'review_required','offline_inference':True,
               'subjective_listening':'not_evaluated','text':p['text']}
    Path(p['receipt']).write_text(json.dumps(receipt,ensure_ascii=False,indent=2),'utf-8')
    emit('audio_saved','音频与参数已保存，等待内容核对')


if __name__ == '__main__':
    main()
