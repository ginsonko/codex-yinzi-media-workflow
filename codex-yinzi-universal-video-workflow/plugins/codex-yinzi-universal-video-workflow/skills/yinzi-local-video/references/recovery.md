# Recovery without repeating expensive sampling

Use actual files and phase events. A download, loaded model, finite first-step probe, 8/8 sampling or a hash-valid MP4 is a different milestone. Do not conflate them with useful footage.

## Proven pitfalls

1. **FP16 video conditioning overflow.** A reproduced projection reached 72,754.2265625; two values exceeded FP16 maximum 65,504. BF16 video computation passed the paired probe and real runs. The original 30-step failure lacked step guards, so it cannot be attributed solely to the VAE. The current adapter checks finite values during sampling and before decoding/casting.
2. **Text and video models overlap in RAM.** Run Q2 text encoding in a separate process, save plain CPU tensors, exit, then load diffusion. The tested text encoder uses FP16 and GPU/offload; it is not a CPU-only BF16 stage. Cache identity includes the exact prompt, source and encoder variant. Do not reuse it for a different prompt or visual references.
3. **Decoding needs headroom.** A later ecommerce run completed finite sampling but hit the system-memory reserve during decoding. Default silent footage therefore exits the sampler before starting the independent VAE decoder. Optional native audio still needs more headroom. Retain the failed attempt instead of silently lowering the reserve or killing unrelated applications.
4. **Export can fail after expensive work.** The original baseline lacked `imageio_ffmpeg`; final latent enabled a 197.463 s recovery after the 4,371.608 s failed execution. The shipped path preflights system FFmpeg/ffprobe, saves decoded pixels before export and fully decodes the resulting MP4. A recovery's few minutes are not a new-generation timing.
5. **MMGP adapter registration.** `loras=['transformer']` registers the module hook; actual adapter paths load separately. Removing the module ID breaks trained Turbo8 activation. The adapter checks that loading produced one active adapter without errors.
6. **Downloads can stall independently of inference.** Alternate HTTPS sources are acceptable only for the same expected content. Match Content-Range before appending and check full size/SHA before activation. Preserve partial bytes, don't retain signed redirect URLs in public manifests, and don't change global proxy settings to repair one model download.

## Use the saved stage

Each attempt has `local-video/` with request, phase logs, events, resource observations and `recovery.json`. Final video latents are `.pt` loaded with `weights_only=True`; pixels/audio are `.npy` loaded with `allow_pickle=False`. Recovery verifies hashes and input identity. Never bypass those checks with unrestricted pickle loading.

- If **decoded pixels** exist, export directly on CPU. No video model or CUDA load is needed.
- If only a **finite video latent** exists, load the pinned video VAE in its own process and decode. Recover native audio only when its saved latent/pixels exist; otherwise report missing audio. Do not imply audio was preserved when failure occurred before its checkpoint.
- If only **text conditioning** exists, sampling is still unfinished. A new sampling attempt must remain within the task's existing authorization and retain the failed attempt.
- Same-job resume reuses compatible completed intermediates. For explicit recovery, submit `local.video.recover` with the original `recovery.json` as `input_path`, a stable request key and optional timeout/device. It never samples.
- Corrupted or incompatible recovery files are a concrete failure. Keep them, inspect the source and create a new approved attempt if necessary. Do not call a file technically valid when its content/shape is wrong.

After recovery, verify the output, inspect normal-speed motion and update the task with original attempt time, recovery time, output path and remaining quality limitations. Keep the model/source versions, prompt, seed, dimensions, frames and actual result hash for reproducibility; do not claim one seed establishes a success rate.
