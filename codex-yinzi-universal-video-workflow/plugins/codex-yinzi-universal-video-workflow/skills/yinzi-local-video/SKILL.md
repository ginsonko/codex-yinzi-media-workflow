---
name: yinzi-local-video
description: Generate optional video footage on the user's own NVIDIA PC, inspect hardware, prepare a pinned isolated H3 Turbo8 backend on demand, and recover saved pixels or video latents without resampling. Use when time, privacy, API cost or an unreliable video provider makes local generation useful; use measured evidence to distinguish footage from previews and exact editing tasks.
---

# Optional local video

Use this route when the task can benefit from generated short footage and the user has enough hardware and waiting time. The host Agent makes the creative and routing decisions; the existing media workbench keeps jobs, real stage progress, artifacts and history. Local inference charges no video API fee; hardware, electricity, disk and time still matter.

For a media task, begin or recover the matching task through the main workflow Skill first. Preserve its approved direction and source material. Do not ask the user to learn another model UI or repeat their request. Existing authorization for the selected local plan covers its routine installation and execution; do not add repeated confirmation steps.

## Choose the route

- Inspect actual free VRAM, RAM and disk, task complexity, expected quantity, deadline and quality needs. The bundled `backend-node/scripts/setup-local-video.py --inspect` is read-only and does not load PyTorch or download weights. Resolve `<checkout>` from the active workflow runtime/installation, not a remembered developer path.
- Read [measured selection](references/selection.md) for actual timings and limits. H3 Turbo8 is the initial executable backend. LTX/Wan are measured alternatives with narrower evidence, not interchangeable automatic fallbacks.
- The latest H3 evidence includes four independently decoded, silent 4.46-second cases: coarse product B-roll, anime full-body blocking, rainy-street atmosphere and a black-background particle layer. Use the case matrix in [measured selection](references/selection.md); it does not authorize long dance, exact product text, cinematic dolly shots or final-MV delivery without a fresh review.
- Prefer AE/FFmpeg/Blender or existing footage for exact text, prices, diagrams, fixed motion paths and precise beat timing. Use local generation for plausible motion/atmosphere, previews or short inserts when its observed quality is adequate. Test contact, identity and multi-action scenes before committing a full sequence.
- In a new local proposal, explain the selected route, about 34.36 GB of H3 weights plus its environment/cache, the measured timing, and the expected use of the output. Do not promise timing on untested hardware or force a GPU-name whitelist. If the user has already approved this scope, proceed.
- The optional backend runs offline after setup. It does not submit prompts/media to a video API or silently switch to paid generation. Provider outages therefore need not block suitable local work; they do not make local quality equivalent to the best cloud model.

## Prepare only what is needed

Use the current checkout's `setup-local-video.py --prepare --root <ample-local-disk>` for a fresh isolated installation. Inspect first; use the installer options/help for source, weights, config and selected device. For an existing validated installation use `--adopt --python <isolated-python> --source-dir <pinned-source> --weights-dir <weights>` with optional `--runtime-dir <dependency-overlay>`; adoption does not pip-modify that environment.

Configuration is `~/.yinzi-media/local-video.json`, overridable with `YINZI_LOCAL_VIDEO_CONFIG`. Existing user fields are preserved. The versioned manifest records source revision, exact file hashes and alternate sources. Resume partial downloads and verify the final hash. A failed source is not a reason to repeat the entire download, change global proxy settings or install unrelated model families. Keep the original source/license notices; WanGP and H3 have separate community licenses.

## Run through the normal workbench

Write the shot prompt to a UTF-8 file. Include framing, subject, one clear motion sequence, camera motion, normal-speed timing and any meaningful visual constraints. Technical defaults are a starting point, not a promise of story compliance.

Call the existing local-tool interface (`local-run` in the main Skill CLI or its MCP equivalent):

```json
{
  "session_id": "the-existing-media-task",
  "request_key": "a-stable-shot-attempt-key",
  "module_id": "local.video.generate",
  "input_path": "absolute/path/to/shot.txt",
  "parameters": {
    "profile": "h3-turbo8", "frames": 107, "width": 832, "height": 480,
    "fps": 24, "seed": 42, "audio": "none", "timeout_seconds": 7200
  }
}
```

The current text-only profile uses the trained 8-step adapter and BF16 video computation. Frames are `3+8*n`, dimensions are multiples of 32; larger values need a new resource/quality trial. Default silent footage runs text encoding, sampling and video decoding in separate processes to reduce memory overlap. `audio:native` is an optional joint-audio path with higher memory pressure and separate listening review. Do not present unsupported reference inputs as implemented.

Observe real stages: preflight → text encoding/cache → model loading → sampling → saved latent → decoding → export → full-decode verification. Sampling 8/8 is not a finished video. One owned GPU job runs at a time; keep truthful progress and output paths visible. After completion, publish/inspect the real video and contact sheet through the existing task. Technical validation leaves `quality_status=review_required`.
Older benchmark outputs may have only `{latent, config}`. The independent decoder can inspect those files for evidence, but product recovery requires the current `recovery.json` manifest and hash checks. Do not convert a legacy benchmark file into a product recovery request by filling in guessed metadata.

## Recover and accept

On failure read the saved phase, error and `local-video/recovery.json`; see [recovery](references/recovery.md). Resume the same job when appropriate; matching saved video is reused across its attempts. `local.video.recover` takes a recovery manifest as `input_path` and never starts new sampling. Pixel-only recovery needs no GPU/model load. Preserve the first failed attempt and report both initial and recovery times.

Watch normal-speed motion and relevant frames; check framing, identity, product geometry, contact/order, continuity and usefulness for the actual edit. Inspect sound if requested. A playable file or a good closeup does not validate choreography, faithful product replacement or a complete MV. Return defects with timecodes and choose a bounded adjustment, alternative local backend, existing footage/editing, or an authorized cloud route. Do not quietly lower the user's delivery standard to fit a local model. GPU output quality is a manual review concern, not a CI guarantee. Recovery directories are single-owner working areas: do not edit or replace checkpoint files while a decode/recovery attempt is running; the decoder re-checks their hashes immediately before loading.
