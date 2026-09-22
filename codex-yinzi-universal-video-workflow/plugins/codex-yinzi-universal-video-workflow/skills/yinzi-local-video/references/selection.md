# Measured selection and practical boundaries

Evidence date: 2026-09-22. Host: Windows, RTX 2070 SUPER 8 GiB, Ryzen 5 3600X, 48 GiB RAM. Timings are observations on this host, not minimum requirements or predictions for every machine. Initial downloads, prior diagnosis and first text encoding are excluded unless explicitly included.

| Route | Actual observation | Use / limits |
|---|---|---|
| H3 base + trained Turbo8 | 832×480, 107 frames, 24 fps, 4.46 s; one near-face scene: 1,398.288 s total, 1,155.346 s sampling; whole-GPU peak 5.68 GiB, process RSS peak 27.85 GiB | Candidate for expressive short closeups. Starts already looking up, so the exact “eyes lowered first” instruction is imperfect. Broader scenarios need separate evidence. |
| H3 base, 30 steps | Same scene/seed/specs: 4,148.875 s sampling; 4,371.608 s initial run plus 197.463 s decoder recovery | More waiting did not establish better quality. Initial exporter dependency failure retained. Recovered video is silent because original audio latent was not saved. |
| H3 community Hybrid b25–49 + Turbo8 | 1,404.939 s total, 1,117.019 s sampling, same scene | No demonstrated end-to-end advantage over Turbo8 in this one text-only trial. Additional ~21 GB checkpoint. Different saved AdaLN precision is a comparison confound. Not verified as an official “Hybrid” release. |
| LTX Video 2B distilled | Four 4 s prompt cases took about 72–111 s; matched I2V 81.206 s | Fast previews and some atmosphere shots. Tested walk→stop→wave lost framing/order; grip→lift→place mug had contact/geometry failures. These failures do not prohibit every final-use shot; inspect the exact result. |
| Wan 2.2 TI2V 5B Q4 | Small 512×320 configurations showed artifacts; 1280×704, 41 frames, UniPC 30 steps/shift 8 produced recognizable grass/tree; 1,257.317 s total | One 1.71 s environment test, much time spent decoding/paging. Bad tiny settings are not the model's quality ceiling. Later tiled-decode optimization was not validated in that test. |

## Four newly decoded H3 Turbo8 cases

The following four cases were sampled before this release and then decoded independently from their saved latent files. They are four prompts on one RTX 2070 SUPER host, not a success-rate estimate. Each output is 832×480, 24 fps, 107 frames and 4.458 s, with no audio stream because this batch used `audio:none`.

| Case | What the normal-speed review supports | What remains unproven | Recommended use |
|---|---|---|---|
| E-commerce presenter + amber bottle | Adult presenter, bottle and tabletop remain mostly stable; reach → grip → lift → turn order is broadly visible | Exact label text, fingers and commercial product geometry | Rough product B-roll or atmosphere after a product-identity check |
| Anime full-body blocking | Silver hair, navy dress and black boots remain visible; side-step → stop → raise-arms order is broadly visible; both boots stay in frame in sampled keyframes | Long dance, complex hands, repeated choreography and identity continuity across shots | Low-cost blocking, rehearsal or background insert after full-speed review |
| Cinematic rainy street | Rainy street, warm storefronts, blue sign, wet reflections and a left-to-right pedestrian are readable | Strong dolly motion, stable rain detail and cinematic camera continuity | Atmosphere B-roll, transition layer or background texture |
| Gold ribbon particle effect | Ribbon sweeps from lower-left to upper-right, spreads and fades with a coherent subject | True alpha, clean edges at every frame and compositing without a key check | Screen/Additive or luma-keyed AE layer after edge inspection |

These reviews are recorded in `H:\Yinzi-LocalVideo-Lab-20260921\decoded-release-review.json`. Technical MP4 validation and contact sheets do not replace normal-speed artistic review. None of these cases proves complex choreography, exact brand fidelity, native audio quality or complete-MV readiness.

H3 Turbo8's **sampling** speedup over the ordinary 30-step closeup was 3.591×. Do not mix that with total runtime, download speed, or a promised quality improvement. Native audio on Turbo/Hybrid was finite 32 kHz stereo; numerical validation is not subjective listening acceptance.

The executable adapter starts with the measured H3 configuration. Hunyuan1.5, newer LTX, 4-step/PDD/VDN routes and specialized kernels are research candidates until separately exercised. INT8 weight storage does not imply native accelerated INT8 computation; Turing has no native BF16 tensor acceleration. Do not blindly install the newest Triton/FlashAttention.

## Hardware and task routing

- Look at **available** resources and background workload. A 28 GiB process peak still needs room for the OS, decoding and other programs; a 48 GiB computer can run out of headroom. The current runner stops its own process at configurable reserves and preserves checkpoints.
- The bundled H3 weights total 34,355,672,047 bytes, about 32.0 GiB. Also allow for CUDA packages, pinned source, partial download files and saved intermediates. Prefer a spacious disk and reuse verified content. Avoid claiming a 40 GiB free disk always suffices.
- No CUDA GPU means this adapter is unavailable, not that local video in general is impossible. CPU-only/AMD/Apple routes are unverified here. High-end NVIDIA cards may be faster; no invented timing multipliers.
- Strong deadline, high volume, precise choreography or faithful branded products often favor existing footage, procedural work, or an authorized online model. Privacy/no-upload needs, modest short-clip volume, available compute and patient iteration can favor local generation.
- A local preview can become a reference for a cloud model **only if** the current cloud contract supports video reference and the user authorizes upload/cost. Preserve camera/action information; do not assume a rough preview forces correct final motion.
- The four benchmark files use the legacy `{latent, config}` envelope. They can be read by the pinned independent compatibility decoder used for this report, but they are not valid inputs to the product `local.video.recover` contract. Product recovery requires the versioned `recovery.json` manifest with fingerprint, parameters, prompt, source revision and hashes; never relabel an old benchmark file to bypass that check.

## What the workflow adds

Deploying H3 directly can reach the same underlying model quality. This workflow adds versioned measured recipes, task-aware choice, hardware inspection, tested download recovery, isolated environments, useful progress, saved latents/pixels and workbench artifacts. It reduces repeated setup and diagnosis; it does not make model weights intrinsically smarter or guarantee that every generated shot is usable.

Third-party licensing remains attached to the selected version. WanGP source uses WanGP Community License 2.0; H3 weights use the MiniMax H3 Community License Agreement. Free local use/output production and selling hosted access to the software are different permissions. Read current terms for the actual use; do not label all dependencies Apache or all footage non-commercial.
