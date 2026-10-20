---
name: yinzi-frame-repair
description: "Experimental. Repair small visible defects in an otherwise usable AI drama or video clip (穿帮镜头, 乱码字/招牌/海报, wrong shoe or hand direction, a stray object, short flicker) instead of regenerating it: a strong multimodal model finds the defects and decides the repair, one key frame gets corrected material (neighbouring frames, font-rendered text, or a single image edit), and scripts track and composite it frame by frame with occluders kept on top, original timing and audio preserved. Decide repair vs regenerate first; large or strongly moving defects are regenerated."
---

# Frame-accurate repair of small defects (漫剧瑕疵局部修复)

Status: **experimental**. The method comes from one research session with Claude Opus 5.5 on
real AI-generated clips. It produced a shareable repaired clip, but the user also judged the
first pass far too slow. Read [evidence and limits](references/evidence.md) before promising a
result. Reuse the method, not the case's numbers.

The core idea: the model does not paint pixels. It decides **what** is wrong, **where** the correct
content comes from and **which** parameters to use, then checks numbers and zoomed panels.
Deterministic scripts do the pixel work: tracking, warping, light matching, occlusion and
assembly. A generator, when used at all, produces material for **one** key frame. It never
re-renders whole frames of the video, because that drifts, flickers and changes things nobody
asked for.

## 1. Repair or regenerate? Decide first

Repair is worth it only when the clip is already accepted overall (story, acting, identity,
camera) and the defect is local. Otherwise regenerate the shot through the normal drama route
(`ai-drama-motion.md`) and keep the old attempt.

| Situation | Choice |
|---|---|
| Garbled sign, poster, scroll, book or screen text; logo on a rigid surface | Repair (best case: planar tracking + font-rendered text) |
| Extra/missing small prop, stray object on a wall/table/background | Repair (clean plate + tracking) |
| One-frame flicker, colour jump, an object vanishing for a few frames | Repair from neighbouring frames, usually no generator |
| Small wrong detail on a body part that barely moves (shoe/foot direction, a sleeve, an accessory) | Repair with one generated key-frame patch (observed working for a boot) |
| Face collapse during a head turn, broken hands while waving, wrong pose, new viewpoint, body hidden then revealed | Regenerate; frame repair cannot invent consistent new motion |
| Defect covers most of the frame or most of the shot, or several unrelated defects in one shot | Regenerate unless the user explicitly wants this take |
| Repair estimate (agent time, paid edits, review) exceeds one more generation | Regenerate; say why |

Fix what a viewer notices at normal speed. The user's rule from the source session: details that
about 90% of viewers would not notice are not worth fixing unless they ask for the fine tier.

## 2. Pick a tier and a time box

| Tier | Scope | Time box for a ~15 s clip |
|---|---|---|
| 快速 fast | Only defects obvious at 1x speed | First complete version in 1-2 h |
| 常规 standard | + all frames/shots where the object appears, occluder handling, light matching, automatic outside-edit check | 2-4 h |
| 精细 fine | + zoom-only issues, ghosts of removed content, sub-pixel jitter, small deformations | Only on request; can take many hours |

Deliver a complete fast version of the whole clip first, show it, then refine what the user
still cares about. In the source session, polishing two objects at the fine tier before showing
anything took about 8 hours and the user called that a failure. A later single-object fix (the
boot) with the scripts already written took about 30 minutes. When one method fails twice,
change the method instead of tuning thresholds again.

## 3. Prerequisites

- The clip, the user's authorization for any paid image edit, and the existing media task
  (begin or recover it through the main workflow Skill and report progress there).
- FFmpeg (the workflow prepares it), Python 3 with `opencv-python` (or `-headless`) and `numpy`.
- Optional clean-plate inpainting for removing old content under new content: LaMa (for example
  the Apache-2.0 `big-lama` weights or an ONNX export). It ran at about 4.5 s per 1344x768 frame on
  CPU, so use it on one key frame, not per frame. It is itself a learned model.
- Optional image-edit model through the workflow's image tools for one corrected key-frame crop.

## 4. Steps

1. **Export frames with timing.** Prefer `local.video.export-frames` with `keep_audio: true`
   (see the main Skill's `references/frame-sequences.md`); it records each frame's PTS and the
   audio offset, and names frames `frame-%06d.png` from index 0. Plain
   `ffmpeg -i in.mp4 work/src/%04d.png` also works for constant-frame-rate clips, but then you own
   the timing and audio mapping. Work on copies; never edit the export in place.
2. **Survey.** Split shots by frame-difference spikes and make one contact sheet per shot
   (`scripts/sheet.py grid`). List defects in a table: id, what, frames, where, severity (visible
   at 1x or only zoomed), planned source and method. Follow each object over its **whole
   lifetime**: an edit that starts at the close-up while the object already appears in the
   push-in before it creates a visible jump (this was missed once). Put the table into
   `repair.json` and run `scripts/dashboard.py` so the user can see issues, materials and renders.
3. **Choose where correct content comes from**, in this order:
   1. real pixels from neighbouring frames of the same shot;
   2. the same character/prop drawn correctly in another shot or a reference sheet;
   3. code: font-rendered text (the original ink colour, size and slant), geometry, flat fills,
      lines, simple cel shadows;
   4. a generated patch: crop about 512-1024 px around the key frame's defect, send it with a
      precise instruction ("toe points straight at the camera, foreshortened; change nothing else:
      same framing, colours, grain"), try 2-3 candidates and pick by eye. Observed: `gpt-image-2`
      kept framing and surroundings; `gemini-3-pro-image-preview` re-framed the crop and was
      rejected. Align the result back to the crop (phase correlation) and fit a per-channel gain on
      unchanged pixels.
4. **Mask.** For dark-on-dark objects a difference mask misses much of the old shape: use a
   polygon/rectangle covering both old and new silhouettes, 4 px feather, edges on content the
   generator kept in place. For text: old-glyph mask + an 8-10 px ring (AI sharpening halo) +
   new-glyph coverage.
5. **Track** the surface from the key frame: `scripts/track_region.py` (SIFT + RANSAC homography,
   refined by two ECC passes with large residuals masked). Use `--interp A-B` where something
   crosses the region and `--extrap K` for motion-blurred shot ends. A reference point jumping
   more than about 1 px on a static camera is a tracking error.
6. **Composite** with `scripts/paste_patch.py`: warp patch and mask, match light per frame on a
   ring around the mask, keep occluders (pixels far from the warped key frame) on top. It backs up
   each frame to `_pre` first so a pass can be rerun without compounding.
7. **Reassemble against the original timing.** With the export manifest, pass the changed frames
   to `local.video.assemble-frames` (`timing_strategy: pts`, `keep_audio: true`, each replacement
   with its locally computed SHA-256). With a plain ffmpeg export:
   `ffmpeg -framerate <fps> -i final/%04d.png -i in.mp4 -map 0:v -map 1:a -c:v libx264 -crf 15
   -pix_fmt yuv420p -c:a copy repaired.mp4` (no `-shortest`; it can drop frames). `final/` must
   contain every frame, not only the changed ones.
8. **Verify.**
   - `scripts/check_outside.py` on the frame folders: changed pixels outside the warped, padded
     edit mask must be 0.
   - `scripts/sheet.py ba` before/after crops at the start, middle, occluded part and end of each
     repaired range; `--gain` brightens dark scenes for inspection only.
   - Watch the whole repaired clip at normal speed. A contact sheet is sampled evidence.
   - Optionally compare the median frame-to-frame change inside the region with the source; the
     repair should not add flicker.
9. **Deliver** the repaired clip with the original audio, a stacked before/after video for sharing,
   a cropped side-by-side per repaired object, and a short report: fixed, skipped (with the tier
   reason), and what remains visible when zoomed. Register them as task artifacts with
   `review_required`.

## 5. Script reference

All scripts take `--pattern` (printf style, default `%04d.png`; use `frame-%06d.png` for the
workflow's frame export). Run with `python <skill>/scripts/<name>.py -h`.

| Script | Purpose |
|---|---|
| `track_region.py FRAMES KEY X0 Y0 X1 Y1 FIRST LAST OUT.json` | Homography of a region from the key frame to each frame |
| `paste_patch.py KEY.png PATCH.png MASK.png TRACK.json IN_DIR OUT_DIR [--occ 22]` | Composite the corrected key frame through the tracked range, occluders on top |
| `check_outside.py BEFORE AFTER TRACK.json MASK.png [--thr 2 --pad 5]` | Count changed pixels outside the allowed region; exit code 1 if any |
| `sheet.py grid|ba ...` | Contact sheets and before/after panels |
| `dashboard.py PROJECT_DIR` | Static progress page from `repair.json` |

The scripts cover rigid or slowly moving regions. Deforming regions need dense optical flow or
point tracking and keyframe propagation (EbSynth-style); that route was researched but not
implemented or tested here.

## 6. Known failures and corrections

Read [evidence and limits](references/evidence.md) for the full list. The most expensive ones:

- AI-generated video "breathes": old strokes change shape every frame. Treating "differs from the
  static model" as an occluder kept fragments of old text. Classify occluders by colour instead
  (material colours of the board/ink/seal can be replaced; chopsticks, sleeves and subtitles stay).
- A resampled delta warped from a canvas model leaves faint outlines; blend the warped new plate
  in frame space.
- LaMa grew dark blobs from nearby dark objects in its context and kept part of what lay under
  small holes: mask real dark objects too, brighten dark images (x2.2) and upscale x2 before LaMa,
  pre-fill small holes with Telea.
- A generated patch that re-frames the crop is unusable however good it looks.
- In-place passes over their own output compound the edit: always read from a backup.
- Windows PowerShell 5.1 corrupted Chinese text in source files when rewritten through
  `Get-Content`/`Set-Content`; write files with an editor tool or Python using UTF-8.
