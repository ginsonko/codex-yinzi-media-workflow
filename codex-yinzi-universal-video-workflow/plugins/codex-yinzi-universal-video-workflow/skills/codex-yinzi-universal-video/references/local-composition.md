# Local music and layered editing

These operations use the same durable `local_media_run` job and missing-component
installation as other local tools. All source files remain unchanged. Use actual
artifacts from each step as the next step's inputs, and record content review in
the local experience store. Technical completion does not establish artistic quality.

## Music-driven editing

1. Use `local.audio.analyze-beats` on the source audio or video. Inspect its JSON
   times and SVG envelope; candidate transients and tempo hypotheses are suggestions.
2. Select meaningful musical accents and source shot intervals. Alternate scene
   scale, preserve action continuity and allow quieter moments; cutting at every
   detected onset usually harms the result.
3. Use `local.video.compose-clips` with ordered source indices and intervals.
   Sources may have different frame rates, sizes or no audio. Each clip uses
   `source`, `source_in`, `source_out`; subsequent clips accept `cut` or a named
   transition from the current contract's `transition_options`, plus
   `transition_duration`. Transition duration overlaps the clips and reduces the
   combined timeline length. The tool reports requested and actual frame-grid
   boundaries, pads absent audio, and retains delayed audio relative to video.
4. Use the existing `local.video.edit-timeline` for source-music/narration layers,
   and delivery steps according to its current schema. Review sound,
   transitions, frame order and real duration, then register the final artifact.

Example request body (resolve paths and the session before execution):

```json
{
  "session_id": "EXISTING_SESSION",
  "request_key": "SESSION-compose-v1",
  "module_id": "local.video.compose-clips",
  "input_path": "/actual/source-a.mp4",
  "sources": [{"path":"/actual/source-a.mp4"},{"path":"/actual/source-b.mp4"}],
  "parameters": {
    "width":1280,"height":720,"fps":24,"audio_mode":"source",
    "clips":[
      {"source":0,"source_in":1,"source_out":4},
      {"source":1,"source_in":2,"source_out":5,"transition":"fade","transition_duration":0.25}
    ]
  }
}
```

The source indices follow the submitted `sources` order, including repeated
source uses. Timing is relative to each source video's visible start. Output is
contain-scaled to the requested canvas, preserving geometry with bars where needed.
Current limits protect memory and run time; split unusually large edits at real
shot boundaries. This tool provides deterministic cuts/transitions, not automatic MAD
direction, tracked video masks or generative interpolation.

### Choose a transition by its purpose

The Tools page's “转场预览” plays short videos produced by this executor. Read
the current contract for supported names; these are parameters of one tool.
Use a cut for strong action continuity, fade for a softer passage, slide/wipe
following the outgoing shot's direction, zoomin for matched scale changes,
circleopen for a subject reveal, and pixelize for a deliberate game-like beat.
Do not apply a flashy transition at every beat. Test the most important change
with the actual two shots before propagating a style through a long edit.

The first clip has no incoming transition. A transition overlaps two clips;
two adjacent overlaps must leave an independent interval in the middle clip.
When a requested transition is shorter than one output frame, the plan records
its conversion to a cut. Inspect the returned frame-grid times, especially when
the soundtrack or target delivery duration is fixed. Keep a separate continuous
music layer when the picture cuts should not also cut the music.

## Still-image layers and masks

`local.image.composite-layers` supports ordered layers with location, size,
opacity, blend mode and an alpha/luminance mask. Read its parameter schema for
the exact source indices. Use it for product layouts, overlays, compositing and
mask-controlled corrections. A background replacement still needs a correct
foreground mask; this compositor does not automatically segment a person or sky.

For commerce, preserve product texture, color, logos and specifications. Use the
original product image as authority and review the composed image before making
motion or batching variants. A proven single layout can be reused, with changed
facts reviewed per item.

## Video layers and dynamic masks

Use `local.video.composite-layers` to place video or transparent-image layers over
a base video: picture-in-picture, before/after comparisons, titles, product layouts,
or a local repair with an already prepared mask. Supply every layer and mask through
`sources`. `input_path` selects the base video from that list; layer `source` and
`mask_source` are indices in the same list. The base keeps its duration and audio
timeline; `audio_mode: "none"` removes its audio deliberately. Layer audio is not mixed.

Each layer accepts `start`, `end`, `source_in`, pixel `x`/`y`, `width`/`height`,
`fit`, `opacity`, `mask_source`, `mask_mode` and `mask_invert`. The display interval
includes start and excludes end. `source_in` is measured relative to the layer's
visible start and is also used for a video mask; trim a mask into its own source if
it needs a different offset. Short video layers and masks end at their actual EOF;
they are not silently looped or frozen. Check `planned_layers[].end` against
`requested_end` before interpreting a shorter overlay as a failure.

`contain` keeps geometry with transparent padding; `cover` crops and `fill`
stretches deliberately. An alpha mask uses its transparent channel; a luminance
mask uses white to reveal and black to hide. Existing layer transparency and
opacity are multiplied with the mask. Negative positions crop at the canvas edge.
This operation composites a provided mask; it does not detect, track or segment a
character. Choose a segmentation/tracking tool separately when the task needs one.

Example: base at sources[0], overlay at sources[1], mask at sources[2]:

```json
{"layers":[{"source":1,"start":0.5,"end":2,"x":80,"y":45,"width":320,"height":180,"fit":"contain","opacity":0.9,"mask_source":2,"mask_mode":"luminance"}]}
```

Inspect the reveal, edge quality, entrance/exit frames and original audio. Container
duration can include a nonzero timestamp offset, especially MKV; these tools use
the video stream or actual packet span instead of treating that end timestamp as
playable duration. Do not fix an apparent offset by randomly changing the creative
prompt or resubmitting a cloud generation.

## Camera motion from keyframes

Use `local.video.camera-motion` for a pan, push-in, pull-back or still-image
motion. Each ordered keyframe has `time`, normalized `center_x`/`center_y`,
`zoom` (1–10), and outgoing `easing`: `linear`, `ease-in-out` or `hold`.
For video, select `source_in`/`source_out` relative to its visible start.
For a still image, set `duration`. Keyframe times are relative to the output.

```json
{"width":1280,"height":720,"fps":24,"duration":3,"keyframes":[{"time":0,"zoom":1,"easing":"ease-in-out"},{"time":3,"zoom":1.25,"center_x":0.55,"center_y":0.45}]}
```

The source is fitted into the requested canvas without stretching. Coordinates
refer to that canvas, including any bars; a crop reaching an edge is clamped.
At zoom 1 the entire canvas is visible, so moving the center alone has no effect.
Use modest zooms for a composition-preserving drift and inspect faces, text and
product edges. A camera move transforms the whole image; it does not animate a
character's limbs or interpolate poses.

Source audio follows the selected video interval, including original delays and
silent tails. The receipt separates requested duration from its actual output
frame grid. Hold changes at the next keyframe boundary; normal easing approaches
the endpoint continuously. For exact delivery timing, inspect the returned frame
count before composition. Windows real samples cover images, MJPEG video, offset
MKV, delayed audio and 100 keyframes; other platforms need their own real runs.
