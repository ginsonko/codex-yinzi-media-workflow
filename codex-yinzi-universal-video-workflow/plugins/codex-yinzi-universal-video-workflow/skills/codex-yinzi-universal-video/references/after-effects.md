# Professional production with After Effects

AE is a primary local executor for precise motion graphics and compositing.
Select it when editable layers, timing, masks, typography, complex transitions,
2.5D camera animation or shot finishing materially improve the result. The user
can watch the real AE editor and continue editing the resulting AEP.

## Pick the right production route

| Task | AE contribution | Useful companion and order |
| --- | --- | --- |
| MAD, music video, game montage | Beat-aligned keyframes, typography, speed changes, layered impact transitions | Analyze shots and music first; select highlights, compose in AE, inspect every cut, encode delivery |
| Product advertisement | Product masks, controlled light overlays, packshots, camera moves, editable brand typography | Verify product details; prepare transparent assets, animate, compare to authoritative source |
| Animated comic or illustration | Layered stills, camera moves, mouth/pose timing, subtitles | Separate subject/background or use supplied layers; avoid revealing missing background pixels |
| Character replacement | Tracking, rotoscoping, masks, occlusion, color matching and compositing | Create/obtain replacement foreground, solve motion/occlusion, then composite; AE alone does not infer a new identity |
| Tutorial or explainer | Callouts, cursor emphasis, magnification, motion typography | Select screen recording segments before graphics; keep instructions legible |
| Travel film | Shot finishing, map/title animation and motivated transitions | Analyze/select real footage first; simple assembly may be faster in FFmpeg |
| Professional shot finishing | Masks, keying, motion blur, blending, camera work | Determine which specific effects/plugins are installed before choosing a technique |

AE is not the first choice for every media operation. FFmpeg handles simple
trimming, concatenation, normalization and encoding efficiently. Blender is
suited to actual meshes, lighting and character rigs. Native AE is unavailable
on Linux. Windows and macOS hosts must discover a working licensed installation;
the workflow does not install or activate AE itself.

## Choose the shot workflow

Use the dependencies of the chosen shot, rather than one fixed order for every
project. A screen replacement often tracks the unmodified source first, applies
the tracked surface to the insert, then adds occlusion masks and color matching.
A green-screen shot usually keys in source coordinates before large geometric
transforms. Keep the source available when a matte removes useful tracking detail.

| Technique | Production decisions that matter | Available fallback |
| --- | --- | --- |
| Masks and keying | Choose drawn/animated masks, supplied alpha or a discovered keyer from the actual background. Check premultiplied versus straight alpha, spill, hair and motion blur at moving edges. | Existing chromakey or foreground-segmentation tools; import their matte for AE finishing. |
| Point, planar or camera tracking | Match the solver to the motion; solve before attaching artwork, inspect drift and occlusion, then composite. Roto Brush is an interactive AE capability, not an assumed ExtendScript operation. | Tracked data from another registered tool or manual keyframes; stabilization alone is not tracking. |
| 2.5D illustration | Separate foreground/background, repair revealed pixels, plan Z spacing and camera/null motion. Select lighting and continuous rasterization per layer; do not switch them on indiscriminately. | Whole-image camera motion for a simpler move; Blender for modeled geometry, rigs and full 3D lighting. |
| MAD, MV and impact transitions | Listen to beat candidates, select meaningful motion peaks, block the edit, then animate time remapping, masks, typography, cameras and compositing around those cuts. Keep a continuous music timeline and inspect transition overlap. | FFmpeg for fast assembly/encoding; AE may own individual shots or the full timeline when detailed editable timing benefits the result. |
| Product and tutorial graphics | Preserve product identity and source facts. Establish readable typography and safe placement before animation; use tracking/callouts only where they help the viewer. | Existing image/video compositors for simpler layered results. |

For an unfamiliar effect, test one representative shot before extending the
technique across the film. Choose the fallback that preserves the creative goal;
a missing plugin need not reduce every transition to a fade.

## Visible execution

Follow the existing visible plan policy. A user-selected AE method executes
after a brief concrete table; an open-ended method follows the ordinary-mode
or unattended-mode rules. Show what AE will create, the required inputs, the
companion tools and the fallback. Do not repeat an already granted approval.

Use the installed `scripts/orchestration-cli.mjs`:

```text
node <skill>/scripts/orchestration-cli.mjs ae discover
node <skill>/scripts/orchestration-cli.mjs ae run --input inspect.json --output <new-inspection-dir>
node <skill>/scripts/orchestration-cli.mjs ae run --input job.json --output <new-job-dir>
node <skill>/scripts/orchestration-cli.mjs ae read --output <same-job-dir>
```

`inspect.json` can be `{"mode":"inspect"}`. The CLI reads the source checkout
from the installed runtime registry; `--project-root` overrides that location.
It returns a compact summary; inspect only needed fields of `ae-receipt.json`.
An active older backend need not restart for this direct local bridge.
The current source registry also includes `local.ae.compose`; use `local-run`
with the job JSON as `input_path` when that backend exposes this module.

Inspection of the current editor without `open_project` is read-only for its
project. Supplying `open_project` switches the active project and must follow the
same preservation procedure as editing; do not describe it as a read-only action.

`YINZI_AFTERFX_PATH` or `AFTERFX_PATH` selects an executable explicitly.
Discovery also checks normal installation paths, Windows App Paths registry
and the unique running AfterFX executable, including custom installation drives.

## Structured job contract

The implementation is `backend-node/src/services/afterEffectsJob.js`, with the
AE runtime in `afterEffectsRuntime.jsx`. JSON is embedded as data, never evaluated
as input code. No arbitrary scripts or expressions are accepted by this bridge.

```json
{
  "mode": "compose",
  "preserve_current": true,
  "assets": [{"id":"image","path":"C:/authorized/photo.png"}],
  "comps": [{
    "id":"main","width":1920,"height":1080,"duration":3,"fps":30,
    "layers":[
      {"id":"photo","type":"footage","source":"image"},
      {"id":"title","type":"text","text":"Your title","font_size":96,
       "properties":[
         {"path":["ADBE Transform Group","ADBE Position"],
          "keys":[{"time":0,"value":[960,680],"influence":72},
                  {"time":0.8,"value":[960,540],"influence":72}]}
       ]}
    ]
  }],
  "view_comp":"main",
  "view_time":1
}
```

Layer types: `footage`, `comp`, `solid`, `text`, `shape`, `camera`, `null`.

For an un-stretched footage segment, a source interval starting at `source_in` placed at `timeline_in` uses `start_time = timeline_in - source_in`, with layer in/out points in composition seconds. With time remapping, keys explicitly map composition times to source times. Do not assign source in/out times directly to composition in/out points: that can create blank openings, wrong frames and shifted cuts. Treat music trim origin independently and compare actual audio/video end times after encoding.

Define source assets and source comps before referencing them. Layers are
listed back-to-front. `three_d`, `parent`, `start_time`, `in_point`, `out_point`,
`audio_enabled`, `blending_mode`, `time_remap` are supported. A later comp can
nest earlier comps, preserving editable shot boundaries.

Every property uses a `path` of matchNames or verified numeric property indices,
plus `value` or ordered `keys`. Keys contain `time` in seconds, `value`, optional
`influence` (0.1-100), `interpolation:"hold"`, and spatial `inTangent/outTangent`.
Scale and opacity use percentages; rotations use degrees; positions use pixels.
2D/3D dimensions must match the actual property. Set 3D before its properties.
Parenting keeps the current world placement; animate after planning that space.

The bridge currently applies property keys before assigning parents. Position
keys on an unparented layer are in comp space; a parented layer uses parent space.
For an exact parent-relative trajectory, inspect the resulting values and either
update the already-parented layer in a subsequent protected job or extend that
operation deliberately. Do not copy AE anchor-based positions to FFmpeg's
top-left-based compositor, or AE scale/opacity percentages to its 1.0/0-1 units.

`masks` accept `vertices`, optional `inTangents/outTangents`, `closed`, `feather`,
`mode` and animated `properties`. Mask points are in source-layer coordinates,
not comp coordinates. `shape` accepts a rectangle/ellipse `size` or a Bezier
`vertices` path, with `fill`, `stroke`, `stroke_width` and `roundness`.
`effects` contain an installed `matchName`, optional `name`, and `properties`.
AE indexed groups invalidate cached property handles when children are added:
reacquire properties by path after adding siblings.

### DOM details for extending the bridge

These are AE scripting interfaces, not additional JSON fields accepted by the
current bridge. Discover the installed version and property before using them.

- A mask's mode is `mask.maskMode = MaskMode.ADD`, a `MaskPropertyGroup`
  attribute; it is not an `ADBE Mask Mode` property path. The existing JSON
  `masks[].mode` is translated to that attribute by the runtime.
- In AE 23+, use `target.setTrackMatte(matteLayer, TrackMatteType.ALPHA)` or the
  corresponding LUMA/inverted type. `trackMatteLayer` is read-only. Modern
  mattes need not be the preceding layer; older `trackMatteType` workflows use
  layer adjacency. Track-matte assignment is not yet a field in this bridge.
- `setTemporalEaseAtKey(index, inEase, outEase)` takes incoming easing first.
  Match the number of `KeyframeEase` objects to the actual property, for example
  using `keyInTemporalEase(index).length`; spatial Position uses one temporal
  ease even when its position value has multiple coordinates. Spatial tangents
  control the path separately. Use HOLD for deliberate step changes, not as a
  substitute for a smooth stop. Separated Position dimensions need their actual
  follower properties.
- Discover effects from `app.effects` and verify `canAddProperty(matchName)`.
  Standard scripting names include Glow `ADBE Glo2`, Curves `ADBE CurvesCustom`
  and Keylight `Keylight 906`; installation discovery decides availability.
  Do not invent a localized name or infer a third-party plugin from a screenshot.

Scripting references: [AVLayer](https://ae-scripting.docsforadobe.dev/layer/avlayer/),
[MaskPropertyGroup](https://ae-scripting.docsforadobe.dev/property/maskpropertygroup/),
[Property](https://ae-scripting.docsforadobe.dev/property/property/), and
[effect matchNames](https://ae-scripting.docsforadobe.dev/matchnames/effects/firstparty/).

For exact control of a saved project, `open_project` opens that AEP as the
editing starting point and saves the result to a new job directory. Use
`existing_name` on a comp/layer to update it. Unique names avoid ambiguous edits.
External footage used by an existing AEP must remain available; the job does not
automatically collect hidden AEP dependencies. Keep an asset manifest with it.

Traverse the nested comps reachable from the delivery comp when checking effects
and footage. A clean top-level effect list does not establish a plugin-free
project. Save compact names/counts/dependency paths first; inspect a selected
effect's necessary properties afterwards. Large particle effects can expose
thousands of properties, so never load their entire tree into the conversation.

Inspect unknown properties before using them:

```json
{"mode":"inspect","inspect":{"comp":"Your comp name","layer":"Your layer name","path":["ADBE Effect Parade"],"depth":2}}
```

The receipt lists real effects and requested property values/matchNames. Follow
current scripting documentation for unsupported actions, and add a reusable
operation when needed. Planar/camera tracking, Roto Brush, advanced keying,
expressions, lighting and third-party plugins are AE options, not automatically
verified by a successful keyframe demo. No fixed whitelist of creative recipes
limits which professional approaches an Agent may propose.

## Save, render and review

Without `render`, the bridge saves an AEP and opens the comp. With
`"render":{"comp":"main","extension":"mp4"}`, it also renders using the
current default output module. A verified `output_template` or `render_template`
may be supplied. Templates are installation-specific; the receipt contains
their actual names/settings. AE 26.2.1 in the real Windows acceptance defaulted
to H.264 and rewrote `.avi` to `.mp4`. Always use the actual `outputModule.file`
and output settings, never infer the format from a requested suffix.

Before replacing the open project, inspect it. `preserve_current:true` saves a
unique recovery copy inside the job directory before opening/creating the target.
Saving clears AE's dirty flag and changes its active save path; the previous
file on disk is not overwritten. Recovery copy existence and later AEP opening
are the evidence of preservation. Without this option a busy project is refused
before any switch. Inspecting the current project does not save or switch it.

If `open_project` is already the active file, compose preserves a recovery copy
and continues with the in-memory content, including unsaved edits; it does not
reload an older disk version. A different target opens at most once after the
recovery save. The receipt's `before`, `recovery_project`, `before_opened` and
`open_count` describe the operation. A failed save or refused/cancelled switch
does not save the original project as a partially completed target.
The direct CLI exits nonzero for a `failed` receipt while retaining its JSON.
Still read the receipt: a launch exit code alone never proves render success.

One global editor lock protects concurrent jobs. `ae-job.json`, JSX, dispatch
and receipt live in the job directory. Repeating the identical job reconciles
the old execution; changing a job in that directory is rejected. A timeout
keeps AE running and keeps the lock. Read the same directory and check the editor.
Do not delete the lock or start a fresh equivalent job while execution is unknown.

After a reported script failure, inspect its error/line and partial AEP, repair
the specific defect, and use a new revision directory only after the failed
attempt is confirmed. Missing plugins justify a known available effect or other
local tool within the user's intent, not a fake success.

Check the rendered file with FFprobe and full decoding, sample transitions and
held frames, check text fit and occlusion, and verify sound duration/levels. A
render receipt establishes execution; visual quality remains a separate check.
Keep AEP, assets, job JSON and the final movie as the reusable deliverable.

## Heavy projects and reusable acceptance

### Recover a crash or an apparently successful render with no output

When the editor and another GPU-accelerated application fail together, compare
their logs with Windows Display 4101 / NVIDIA TDR events and resource-exhaustion
events. A driver reset establishes a GPU failure event, not its provoking
workload or a VRAM/RAM exhaustion diagnosis. Post-crash free memory cannot prove
what happened at the peak. Preserve the AEP, existing job/receipt, event times
and source hashes before changing the recovery copy.

Keep process launch, script execution and completed media separate. Do not wrap
an interactive AE launch in a subprocess timeout that kills its child while
the editor is still working. Preserve argument boundaries with a process API,
then reconcile a newly written JSX receipt. A launcher exit code, an empty log
or a queue item that remains QUEUED does not prove rendering. ExtendScript is
not modern Node JavaScript: feature-check helpers such as `Date.toISOString`
and `File.flush`; use `getTime()` and explicit open/write/close where needed.

For a confirmed stopped attempt, a useful recovery option is a saved copy using
`GpuAccelType.SOFTWARE`, multi-frame rendering disabled, and a short representative
full-resolution range. These are workload choices, not permanent defaults or a
guarantee that input decoding and the UI no longer use the GPU. Monitor available
RAM, commit and VRAM; keep effects and resolution unless the brief permits a
change. A locally enumerated lossless output template followed by CPU encoding
can isolate GPU output encoding from composition rendering.

If `render()` returns without producing a file in an otherwise responsive GUI,
inspect queue status and actual paths. With the project safely saved and no
active render, independent `aerender -project ...` without `-reuse` can isolate
the current GUI instance. Use locally discovered template names and an explicit
inclusive `-s`/`-e` frame range; choose memory/MFR options from measured pressure.
Allow the launched render worker to finish even when its launcher exits early.
For command-line MFR control, the tested AE 26.2.1 syntax takes both a state
and a CPU percentage, including when disabled: `-mfr OFF 25`. Omitting the
second value caused an "Illegal argument flag" on the following option in a
real attempt. Inspect the installed version's help; do not diagnose that parser
error as a GPU crash or a filename-encoding failure. Applying a locally
enumerated output template inside JSX also avoids shell quoting ambiguity.
Check both the completion log and actual frame count/duration. In the Windows
AE 26.2.1 recovery sample, GUI `timeSpanDuration=48/fps` exported 49 frames while
independent inclusive frame bounds exported the intended 48. Do not silently
drop a frame without checking the intended timeline and audio alignment.

A normal editor restart after preserving the current project restored GUI
preview and script rendering in that sample; the exact anomalous-state cause
remained unknown. Reopen and inspect the saved project after any restart.
The same recovery produced a fully decoded 406-frame 1080p movie with aligned
audio. This proves that recovery route on that project, not long-term driver
stability or final artistic quality. Source captions, black gaps and rhythm
still need their own review. Avoid driver, paging or TDR-registry changes merely
to conceal an unisolated failure.

Before a full render, inspect the composition duration, work area, nested in/out
points and a few representative frames. An opening countdown, placeholder or
author-credit section is not evidence of the requested animation. Select the
effective section using the actual timeline and user brief; retain source records
outside the image when the user requests clean presentation.

For a constrained machine, start with a short representative work area. Consider
disabling multi-frame rendering, shortening segments, proxies and purging caches
between confirmed jobs according to measured memory pressure. Retain completed
segments and their receipts; no fixed machine speed or render duration is promised.
The bridge accepts `render.start`, `duration`, `multi_frame`, `max_cpu_percent`
and `purge_cache` for these choices.

Preview resolution is not proof of render resolution. `render.resolution_factor`
sets the render queue's `Resolution:{x,y}` after applying templates and verifies
the numeric readback. When this explicit factor is supplied, it also disables
output-module Resize and Crop so they cannot override the requested dimensions.
Without a factor, the selected template keeps its normal behavior.

After rendering with an explicit factor, the bridge briefly imports the movie
to read its encoded dimensions, removes that probe item, and records
`expected_output_size` and `actual_output_size`. A mismatch produces `failed`
with `AE_OUTPUT_SIZE_MISMATCH`, retaining the AEP and movie. The Windows AE26.2.1
test showed H.264 reducing a requested 240x135 to 240x134; a discovered lossless
AVI template preserved 240x135. Choose a suitable installed template or discuss
a delivery-size adjustment under the user's constraints. Do not silently alter
the requested size. FFprobe, full decode and visual QA remain the final checks.

On this Windows installation, the repaired bridge passed real unsaved-project
recovery, busy refusal, same-project edit preservation, and 480x270 / 960x270 /
240x135 render checks on 2026-09-14. This does not establish macOS, other AE
versions, every codec or every custom-template behavior.

Record an experience after a real task: the requested result, chosen tools and
order, relevant inputs/settings, failed approaches and specific cause, successful
adjustment, measured output, user feedback and remaining limits. Use
[media experiences](media-experiences.md) to find or reuse related recipes; local
notes are the recovery entry if an older running backend lacks that endpoint.

For time-remapped trailer edits, add the intended remap keys before removing
unused default keys. On AE 26.2.1, removing every remap key first disabled the
property and subsequent `setValueAtTime` failed with a hidden-property error.
Retain explicit source-to-composition times and inspect both sides of internal
source cuts; a named clean clip or coarse contact sheet is not a clean handle.
When a transition reveals the previous shot, extend every visible panel layer
through that overlap and hold its last safe source frame. Extending only one
panel can expose black; extrapolating source time can introduce the next PV
title card. Check the rendered transition midpoint and final held frame.

AE can hold imported audio files open. Reuse unchanged, verified audio or write
a new version when the mix changes. A failed preparation command must prevent
dispatch of a stale JSX file. Keep build, dispatch receipt, AEP save and actual
render completion as separate steps, especially in PowerShell where a later
statement can run after an earlier native executable failed.

The Windows AE 26.2.1 example accepted on 2026-09-14 produced a four-second
1080p60 showcase and a 1.5-second 1920x816 clean montage segment. Its new titles
use built-in AE operations, but nested source animation still references
Deep Glow (`PEDG`), Particular (`tc Particular`) and `S_WipeDots`. This proves
that particular rendered result and editable package; it does not validate
plugin-free portability, automatic tracking/roto or every AE technique. Preserve
the user's accepted result and original-versus-new-work attribution when reusing it.

After an interrupted render, inspect the existing output before rerendering.
A progress log can stop before the container's actual last decoded frame.
Verify complete decoding, actual frame count, intended duration, audio timing
and the final picture; only then recover a delivery encode from that output.
An encoder exit code alone does not establish completeness. Keep the source
project and original render until the recovered version is checked.
