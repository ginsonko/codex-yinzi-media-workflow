# Evidence and limits for frame repair

This records what one research session (Claude Opus 5.5, October 2026, Windows, RTX 2070 SUPER
8 GB) actually established. Private media, keys and machine paths are omitted. Treat each item
as a single observed case, not a guarantee.

## What was tried and what happened

### Code-only image recreation (background research)

- Handwritten SVG of a simple anime portrait reached structural similarity 0.41. Tool-assisted
  vector tracing reached 0.97; a vector layer plus a per-pixel residual layer was lossless
  (0 differing pixels of 1,572,516 in Chrome at device pixel ratio 1).
- AI-generated "flat" images contain tens of thousands of colours of invisible noise
  (71,189 in that portrait), so understanding plus hand-written code cannot reach 1:1.
- Recolouring through code worked well (4/4 scenes, 0 changed pixels outside the edit area).
  Removing/moving objects needed content that is not in the image; LaMa filled it, but garbled
  book-spine text behind a removed object and moved objects lacked contact shadows.
- Five ground-truth hole-filling tests (book-spine text, table edge, shadow, knit texture, anime
  hair): LaMa won overall; the "text model writes structure + classical texture" approach only
  tied on hair. Conclusion used by this Skill: the model decides structure and placement,
  learned models or real pixels supply texture.
- Code-driven part rigs of a still character (blink, breathing, talking, small arm swing) worked
  for small motion but looked uncanny ("Live2D-like"); turning and new poses were not possible.
  The user rejected that look. This Skill therefore does not animate characters; it repairs.

### Rigid-surface repair benchmark (scroll text)

190-frame panning shot, garbled scroll text replaced with font-rendered text from one key frame
and tracked back: changes stayed inside the scroll, at most about 2% of pixels per frame, region
flicker 3.03 vs 2.99 in the source; the new paper was slightly too bright/pink.

Synthetic ground-truth test, 72 frames with a garbled bright overlay added to a bookshelf:

| Method | PSNR vs clean source | Region flicker | Cost |
|---|---|---|---|
| No repair | 18.1 dB | 7.71 | - |
| LaMa on every frame | 26.8 dB | 3.27 | 72 inferences, about 4.5 s/frame on CPU |
| One key-frame fill, tracked and pasted | 26.4 dB | **2.88** | 1 inference |
| Classical inpainting every frame | 26.6 dB | 2.89 | no model |

Quality differed little on thin strokes; the tracked key-frame patch was the most stable and the
only one that can **replace** content (garbled text to real words).

### Real repair of an AI drama clip (noodle-shop scene)

Source: 1344x768, 24 fps, 362 frames, original audio. Defect list: garbled yellow shop sign,
garbled dark wooden plaque, menu poster with a wrong title and garbled lines/seal, a boot facing
the wrong way on a character looking at the camera, knife-handle count changing between shots.

| Defect | Method | Outcome |
|---|---|---|
| Yellow sign and dark plaque (wide shots) | Clean plate, font-rendered Chinese text, per-frame tracking, blur kernel and local tone fit on camera-move frames | Delivered; the dark render's median frame-to-frame change in the region was 1.21 vs 1.34 in the source |
| Menu poster (frames 37-159, close-up) | Occluder-free temporal model, LaMa clean plate with a second cleanup pass, font-rendered menu and seal, colour-based occluder classification so chopsticks/sleeve/subtitle stay on top | Delivered; automatic check: 0 pixels changed by more than 2 levels outside the edit boxes in frames 37-159. Tiny yellow specks remain on chopstick edges (user: not worth fixing) |
| Boot direction (frames 42-133) | `gpt-image-2` edited one cropped key frame (Gemini re-framed and was rejected), SIFT+ECC tracking, interpolation across frames where a mouse runs past, per-frame gain | Delivered; nine frames inspected side by side, mouse and tail stay in front. Outside-edit check not run for this pass |
| Poster still garbled in push-in frames 28-36 | Not done: tracking stopped at 37 | A visible half-second jump remained; offered as a follow-up |
| Knife-handle count | Reported only | Not repaired |

Timing: signs and poster took about 8 hours before anything was shown; the user said that a
process this long counts as a failure and asked for speed-first tiers. The boot took about
30 minutes once the scripts existed. Flicker for the whole repaired clip was not measured, and not
every frame was reviewed. The user did not give a final verdict on the boot version in that
session.

## User requirements captured

- Repair only what most viewers notice; skip details about 90% would not see.
- Three tiers: fast (big visible bugs only, speed first), standard, fine (pixel-level and
  zoom-only issues, small deformations).
- Show a complete version early; the progress page should show found issues, generated material
  and intermediate renders.
- The user first asked for no generative models at all, then accepted generated material as long
  as the model decides when to use it and placement stays deterministic.

## Source-priority rationale

Precise control is achievable everywhere; how good the fix looks depends on whether the correct
content exists somewhere. Estimates from the research (not measured per category):

| Defect | Content source | Expected quality |
|---|---|---|
| Single-frame flicker, colour jump, brief disappearance | Neighbouring frames | High |
| Colour drift of hair/clothes | Correct frames, region colour mapping (cel shading helps) | High |
| Garbled text on signs/scrolls/books | Font rendering + tracking | High (verified) |
| Extra object on wall/shelf/sky | Same image or revealed background | Medium-high, depends on texture |
| Broken line art | Code-drawn vector strokes | Medium-high (untested) |
| Wrong finger count, broken hand | Correct hand from another frame/shot; else generated | Medium if a source exists; otherwise regenerate |
| Collapsed profile, wrong features, new pose, hidden body | None | Regenerate |

## Fine-tier techniques that worked

- Occluder-free model of a surface: per pixel, mean of the largest cluster of gain-normalised
  observations across frames.
- Clean plate: brighten dark images (x2.2) and upscale x2 before LaMa; mask real dark objects as
  well and write back only the hole; pre-fill small holes with Telea.
- Include the sharpening ring around old strokes in the hole or a glyph-shaped ghost remains.
- Replace in frame space (alpha blend of the warped new plate), not by adding a delta warped from
  canvas space.
- Sub-pixel jitter: refine each frame's alignment against the static surface model.

## Not established

- Deforming regions (faces, hands in motion) with optical-flow/keyframe propagation.
- Long clips, many shots, or batch use.
- Whether non-expert viewers rate the repairs as invisible.
- Any cost comparison against regeneration beyond the time figures above.
