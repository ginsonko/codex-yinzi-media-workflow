# Local Motion Interpolation

Use `local.video.interpolate` when the user needs intermediate motion frames.
Choose `local.video.fps` for simple frame duplication or dropping.

Submit through the existing local media job API with the current session,
authorized input file and a stable request key. Read the saved job and receipt
before retrying. The result is an MP4 plus its execution receipt.

## Engine And Rate

- `engine: auto` tries optional RIFE ncnn Vulkan and records a fallback reason
  if installation or execution fails, then uses FFmpeg minterpolate.
- `engine: rife` requires RIFE. Its failure remains explicit.
- `engine: minterpolate` uses FFmpeg without installing RIFE.
- Specify either `target_fps` (1-120) or `multiplier` (greater than 1, up to 16).
  Omit both for the internal 2x default. Never fill both rate fields.
- Keep `scene_detection: true` for clips containing cuts. Adjust
  `scene_threshold` (1-100, default 12) only after inspecting the cut frames.
- The default RIFE model is `rife-v4.6`. `gpu_id`, `threads`, `rife_model`
  and `uhd` are configurable. Select installed hardware and models from
  actual component evidence.

```json
{ "engine": "auto", "target_fps": 60 }
```

```json
{ "engine": "minterpolate", "multiplier": 2 }
```

The component manager reuses verified installations. The RIFE package is
optional and currently registered for Windows x64. A binary copied elsewhere
is not automatically an installed component; use the registered component
state and installer rather than guessing a personal directory. FFmpeg remains
available when RIFE cannot run on the host.

## Inspect The Output

Compare duration, frame count, sound timing, first and final motion, and frames
on both sides of cuts. Review fast movement, thin edges, occlusion and faces
at normal speed and frame by frame. The receipt records the actual engine;
`review_required` is not visual acceptance.

Do a short representative section before processing a long clip. Real Windows
checks cover both engines, default/explicit rates, low-FPS tail protection,
and installation fallback. Variable-rate sources, multiple audio tracks and
unusual timestamps still require their own output review. Preserve the source
and successful outputs while adjusting parameters for a specific defect.
