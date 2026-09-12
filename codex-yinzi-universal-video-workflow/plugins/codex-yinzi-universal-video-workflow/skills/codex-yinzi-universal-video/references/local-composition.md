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
   `source`, `source_in`, `source_out`; subsequent clips accept `cut` or `fade`
   plus `transition_duration`. Fade duration overlaps the clips and reduces the
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
shot boundaries. This tool provides deterministic cuts/fades, not automatic MAD
direction, tracked video masks or generative interpolation.

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
