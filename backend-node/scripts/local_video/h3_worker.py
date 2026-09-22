"""One isolated H3 phase. Offline; all model downloads happen during setup."""
import argparse
import json
import os
from pathlib import Path
import sys
import time

from .support import atomic_json, digest, emit, manifest, read_json


class SamplingCompleteDecodeRequired(Exception):
    """Sampling is complete; the caller must decode in a separate process."""


def verify_recovery_file(request, source, name):
    expected = request.get('recovery_hashes', {}).get(name)
    if not expected:
        raise ValueError('Recovery hash missing for '+name)
    actual = digest(source/name)
    if actual != expected:
        raise ValueError('Recovery file changed after validation: '+name)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    parser.add_argument('--phase', choices=['text', 'sample', 'decode'], required=True)
    args = parser.parse_args()
    request = read_json(args.request)
    cfg, p = request['config'], request['parameters']
    out = Path(request['work_dir'])
    out.mkdir(parents=True, exist_ok=True)
    if cfg.get('runtime_dir'):
        sys.path.insert(0, cfg['runtime_dir'])
    sys.path.insert(0, cfg['source_dir'])
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', DO_NOT_TRACK='1')
    os.environ['CUDA_VISIBLE_DEVICES'] = str(request.get('execution_device',p.get('device',cfg.get('device',0))))
    import numpy as np
    import torch
    torch.set_num_threads(p.get('threads', cfg.get('threads', 4)))
    torch.set_grad_enabled(False)
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA unavailable in the configured isolated Python')
    from mmgp import offload, quant_router
    for handler in ('shared.qtypes.int8_convrot', 'shared.qtypes.gguf'):
        quant_router.register_handler(handler)
    from shared.qtypes import gguf
    quant_router.register_file_extension('gguf', gguf)
    from shared.utils import files_locator as fl
    from shared.attention import attention_config_shared_state
    from models.minimax_h3.minimax_h3_main import _load_text_encoder, _load_transformer, _load_video_vae, _load_audio_vae
    from models.minimax_h3.pipeline import MiniMaxH3Pipeline
    weights = Path(cfg['weights_dir'])
    fl.set_checkpoints_paths([str(weights)])
    meta = manifest()
    dtype = torch.bfloat16
    budgets = cfg.get('budgets', meta['defaults']['budgets'])
    profile = cfg.get('offload_profile', 5)

    def finite(tensor, label):
        if not torch.isfinite(tensor).all():
            raise ValueError('NONFINITE_'+label+': BF16 preset failed; intermediate failure retained, do not export blank/invalid pixels')

    def save_tensor(file, tensor):
        finite(tensor, file.stem)
        temp = file.with_suffix('.tmp')
        torch.save({'latent': tensor.detach().cpu(), 'fingerprint': request['fingerprint'], 'parameters':p, 'source_revision':meta['source']['revision']}, temp)
        os.replace(temp, file)
        emit('checkpoint_saved', '已保存可恢复的中间结果', path=str(file), sha256=digest(file))

    def save_pixels(video):
        finite(video, 'PIXELS')
        video = video.detach().cpu()
        pixels = video.permute(1,2,3,0).numpy() if video.dtype==torch.uint8 else ((video.float().clamp(-1,1)+1)*127.5).byte().permute(1,2,3,0).numpy()
        if pixels.shape != (p['frames'],p['height'],p['width'],3):
            raise ValueError('Decoded dimensions/frame count differ from the request: '+str(pixels.shape))
        np.save(out/'decoded-pixels.npy', pixels, allow_pickle=False)
        emit('pixels_saved', '视频画面解码完成，正在保存音频及导出', frames=len(pixels))

    def save_audio(audio, rate=32000):
        if isinstance(audio, torch.Tensor):
            audio = audio.detach().float().cpu().numpy()
        audio = np.asarray(audio)
        if audio.ndim!=2 or not np.isfinite(audio).all():
            raise ValueError('Invalid/nonfinite audio')
        if audio.shape[0]==2:
            audio=audio.T
        if audio.shape[1]!=2:
            raise ValueError('Expected stereo audio')
        samples = round(p['frames']/p['fps']*rate)
        if len(audio)<samples:
            audio=np.pad(audio,((0,samples-len(audio)),(0,0)))
        np.save(out/'decoded-audio.npy', audio[:samples], allow_pickle=False)

    if args.phase=='text':
        emit('text_loading', '正在加载文字编码器；完成后会退出释放内存')
        encoder = _load_text_encoder(str(weights/'Qwen3-VL-32B-Instruct/qwen3vl-32B-MiniMax-H3-Q2_K.gguf'), torch.float16)
        manager = offload.profile({'text_encoder':encoder.language_model,'vision_encoder':encoder.visual},profile_no=profile,pinnedMemory=False,quantizeTransformer=False,extraModelsToQuantize=[],budgets={'*':budgets.get('*',2000)},convertWeightsFloatTo=torch.float16,verboseLevel=1)
        emit('text_encoding', '正在编码本条提示词')
        with attention_config_shared_state('sdpa'), torch.inference_mode():
            embeddings,tags=encoder.encode(request['prompt'],[],torch.device('cuda'),torch.float16)
        finite(embeddings, 'TEXT')
        torch.save({'embeddings':torch.from_numpy(embeddings.detach().cpu().numpy().copy()),'tags':torch.from_numpy(tags.detach().cpu().numpy().copy()),'prompt':request['prompt'],'source_revision':meta['source']['revision'],'text_variant':'Q2_K'},out/'conditioning.pt')
        emit('text_ready', '文字编码已保存，释放编码器后加载视频模型')
        return

    if args.phase=='decode':
        source=Path(request['recover_dir'])
        verify_recovery_file(request, source, 'video-latent.pt')
        saved=torch.load(source/'video-latent.pt',weights_only=True,map_location='cpu')
        if saved['fingerprint'] != request['fingerprint'] or saved['parameters']!=p:
            raise ValueError('Recovery latent belongs to another configuration')
        finite(saved['latent'],'RECOVERY_LATENT')
        emit('decoding', '正在用独立解码器恢复视频；不会重新采样')
        vae=_load_video_vae('minimax_h3/minimax_h3_video_vae_int8_convrot.safetensors',dtype,False)
        decoder=torch.nn.ModuleDict({'post_quant_conv':vae.post_quant_conv,'decoder':vae.decoder})
        manager=offload.profile({'vae':decoder},profile_no=profile,pinnedMemory=False,quantizeTransformer=False,extraModelsToQuantize=[],budgets={'*':budgets.get('*',2000)},convertWeightsFloatTo=dtype,verboseLevel=1)
        vae.enable_tiling(tile_sample_min_height=cfg.get('vae_tile',256),tile_sample_min_width=cfg.get('vae_tile',256))
        with attention_config_shared_state('sdpa'), torch.inference_mode():
            video=vae.decode(saved['latent'].to('cuda',dtype=dtype))[0,:,:p['frames']]
        save_pixels(video)
        del video, vae, decoder, manager
        if (source/'audio-latent.pt').is_file():
            verify_recovery_file(request, source, 'audio-latent.pt')
            saved_audio=torch.load(source/'audio-latent.pt',weights_only=True,map_location='cpu')
            if saved_audio['fingerprint']!=request['fingerprint']:
                raise ValueError('Audio recovery fingerprint mismatch')
            audio_vae=_load_audio_vae('MiniMax-H3-audio_vae_fp32.safetensors')
            manager=offload.profile({'audio_vae':audio_vae},profile_no=profile,pinnedMemory=False,quantizeTransformer=False,extraModelsToQuantize=[],budgets={'*':budgets.get('*',2000)},convertWeightsFloatTo=dtype,verboseLevel=1)
            finite(saved_audio['latent'],'AUDIO_LATENT')
            with torch.inference_mode():
                save_audio(audio_vae.decode(saved_audio['latent'].to('cuda'))[0])
        emit('decode_ready', '独立解码已完成；原采样结果保留')
        return

    # GPU output quality is validated by manual normal-speed review, not CI alone.
    cached=torch.load(request['conditioning'],weights_only=True,map_location='cpu')
    if cached['prompt']!=request['prompt'] or cached['source_revision']!=meta['source']['revision'] or cached['text_variant']!='Q2_K':
        raise ValueError('Text cache identity mismatch; no sampling performed')
    class CachedPipeline(MiniMaxH3Pipeline):
        def _encode_prompt(self, prompt, presentation):
            if prompt!=cached['prompt'] or presentation:
                raise ValueError('Text-only cache cannot be used with visual references')
            return cached['embeddings'].to(device=self.device,dtype=self.dtype),cached['tags'].to(self.device)

    emit('model_loading', '正在加载本地 H3 与 Turbo8；本阶段不会下载模型')
    transformer=_load_transformer(str(weights/'MiniMax-H3-FL2VA-pruned_rank8_int8_convrot.safetensors'),dtype,True)
    vae=_load_video_vae('minimax_h3/minimax_h3_video_vae_int8_convrot.safetensors',dtype,False)
    audio_vae=_load_audio_vae('MiniMax-H3-audio_vae_fp32.safetensors')
    pipeline=CachedPipeline(transformer,None,vae,audio_vae,dtype=dtype)
    pipe={'transformer':transformer,'vae':pipeline.video_decoder,'video_encoder':pipeline.video_encoder,'audio_vae':audio_vae}
    # MMGP takes module identifiers here, not filenames.
    manager=offload.profile(pipe,profile_no=profile,pinnedMemory=False,quantizeTransformer=False,extraModelsToQuantize=[],budgets=budgets,convertWeightsFloatTo=dtype,verboseLevel=1,loras=['transformer'])
    adapter=next(i for i in meta['files'] if i['path'].startswith('loras/'))
    loaded=offload.load_loras_into_model(transformer,[str(weights/adapter['path'])],[1.0],activate_all_loras=True,pinnedLora=False,preprocess_sd=lambda sd:transformer.preprocess_loras('minimax_h3_fl2va_pruned',sd),split_linear_modules_map=transformer.split_linear_modules_map,verboseLevel=1)
    if transformer._loras_errors or len(loaded)!=1 or len(transformer._loras_active_adapters)!=1:
        raise ValueError('Trained 8-step accelerator is not active; refusing an untrained low-step substitute')
    original_video_decode=pipeline.vae.decode
    original_audio_decode=audio_vae.decode
    def checkpoint_video(latent):
        save_tensor(out/'video-latent.pt',latent)
        if p.get('audio','none')=='none':
            # Leave this process before decoding to release the transformer RAM.
            # The caller always runs the independent decoder before any export.
            raise SamplingCompleteDecodeRequired()
        emit('decoding', '采样完成，正在分块解码视频；此时还没有成片')
        decoded=original_video_decode(latent)
        # Preserve video pixels even if the subsequent audio decoder fails.
        save_pixels(decoded[0,:,:p['frames']])
        return decoded
    def checkpoint_audio(latent):
        save_tensor(out/'audio-latent.pt',latent)
        emit('audio_decoding', '正在解码原生立体声音频')
        return original_audio_decode(latent)
    pipeline.vae.decode=checkpoint_video
    audio_vae.decode=checkpoint_audio
    pipeline.vae.enable_tiling(tile_sample_min_height=cfg.get('vae_tile',256),tile_sample_min_width=cfg.get('vae_tile',256))
    def callback(step,preview,read_state,**kwargs):
        if isinstance(preview,torch.Tensor):
            finite(preview,'SAMPLING_STEP_'+str(step+1))
        if step>=0:
            emit('sampling', f'正在生成：第 {step+1}/8 步', completed=step+1,total=8)
    try:
        with attention_config_shared_state('sdpa'), torch.inference_mode():
            result=pipeline.generate(request['prompt'],frame_num=p['frames'],height=p['height'],width=p['width'],sampling_steps=8,seed=p['seed'],fps=p['fps'],shift=12,callback=callback,set_progress_status=lambda msg:emit('model_phase',str(msg)),guide_phases=1,attention_sparsity=1.0,sample_solver='euler')
    except SamplingCompleteDecodeRequired:
        emit('sampling_saved','有限视频 latent 已保存；退出采样进程以释放内存，再启动独立解码器')
        return
    if result is None:
        raise ValueError('Model returned no output')
    save_pixels(result['x'])
    if result.get('audio') is not None:
        save_audio(result['audio'], result.get('audio_sampling_rate',32000))
    emit('inference_ready', '画面与音频已保存，下一阶段导出并检查 MP4')


if __name__=='__main__':
    main()
