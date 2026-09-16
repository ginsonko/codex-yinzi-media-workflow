# Local Portrait Finishing

Use these operations for skin texture, face-local color and image finishing.
Resolve the current module contract before submitting a local job. Components
reuse the existing Sharp and YuNet installation; video also uses FFmpeg.

| Goal | Module | Main Controls |
| --- | --- | --- |
| Face-local texture smoothing | `local.image.face-beauty` | `smooth_strength`, `texture_retention`, `feature_protection` |
| Face-local skin color | `local.image.skin-tone` | `tone_mode`, `intensity`, `preserve_background` |
| Tracked video portrait finishing | `local.video.face-beauty` | Same texture controls, `output_fps`, `max_duration`, `max_frames` |
| Separate color and fine detail | `local.image.frequency-separation` | `radius`, `texture_gain`, `color_blur_blend` |
| Edge-weighted image denoising | `local.image.bilateral-denoise` | `spatial_sigma`, `edge_threshold`, `mix` |
| Highlight and shadow shaping | `local.image.dodge-burn` | `dodge_highlights`, `burn_shadows`, `midtones_contrast` |
| Three-way color grading | `local.image.color-grade` | Read the current color and exposure contract |
| Vignette | `local.image.vignette` | `radius_ratio`, `falloff_feather`, `darkness`, `tint_color` |
| Grain | `local.image.film-grain` | `intensity`, `size`, `monochrome` |

Start portrait tests with moderate smoothing and high texture/feature retention:

```json
{
  "module_id": "local.image.face-beauty",
  "input_path": "C:/Media/portrait.png",
  "parameters": {
    "smooth_strength": 0.45,
    "texture_retention": 0.8,
    "feature_protection": 0.9
  }
}
```

Inspect eyes, eyebrows, lips, skin texture and the boundary with hair. Review
multiple skin tones and lighting conditions for a real client task. No-face
outputs retain the picture and report `unchanged`; a manual `user_rect` is a
normalized region, not a detected face. These operations do not replace a whole
character or establish anonymity. For character replacement, start with the
accepted image-plus-video route in [character replacement](character-replacement.md).

Video keeps a bounded CFR timeline with original audio alignment. Set
`max_duration` and `max_frames` intentionally, then check the actual returned
duration and frame count. `max_duration` excludes the frame starting exactly
at the limit; a fractional final frame can extend by less than one output slot.
Review movement and cuts as well as individual portraits.

`tracks_path` can reuse matching `local.video.track-faces` output. Its source
hash, geometry and tracking parameters must match. It is included in source
integrity checks. Cache lookup uses real timestamps and FFmpeg's actual frame
selection. Missing cache coverage defaults to `cache_gap_policy: "skip"`, which
keeps those frames untouched; `"fail"` stops the job. A cache with one frame and
no duration covers only that timestamp. Rebuild incomplete tracks when needed.

Record module, parameters, component versions, source/output hashes and the
actual quality verdict. `review_required` means the operation ran and needs
visual assessment. Use the selected work's real constraints to decide whether
to adjust strength, use a manual region or choose another engine.
