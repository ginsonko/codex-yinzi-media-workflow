# Edit selected frames and preserve their timing

Use `local.video.export-frames` and `local.video.assemble-frames` when the task needs
pixel-level repair, a short drawn effect, mask cleanup, or individually edited
frames. For transform animation, reusable effects, text, tracking and layered
compositing, consider the [AE bridge](after-effects.md) or
[local composition](local-composition.md) first: their parameters are easier to
revise than hundreds of rendered images. For selecting interesting moments, use
shot analysis; exporting every frame is unnecessary.

Show the brief visible plan and continue within existing authorization. Explain
which interval will change and how the original timing and soundtrack will be
kept. The Agent computes frame indexes and hashes. Never ask a beginner to type
hashes, edit a manifest or approve individual frames when the edit is already
authorized.

## Export, edit, assemble

1. Use the existing session and `local_media_run`, with a stable request key,
   `module_id: local.video.export-frames` and the source video as `input_path`.
   Its result is a JSON manifest; the adjacent `frames/` directory holds the PNGs,
   and `audio/` holds the extracted soundtrack when `keep_audio` is true.
2. Read only manifest summary/timeline and the frame entries needed for the edit.
   Each frame records zero-based `index`, file, dimensions, SHA-256 and original
   PTS. Do not print the complete manifest or load every frame into conversation.
   Preserve the export, and save edited frames separately. Use an already
   registered image editor or the authorized drawing method appropriate to the
   actual repair. Keep the canvas size consistent.
3. Compute each edited file's SHA-256 locally and pass
   `replacements: [{index, path, sha256}]` to `local.video.assemble-frames`, using
   the exported manifest as `input_path`. Absolute paths work; relative source,
   audio and replacement paths resolve against the manifest directory.
   The manifest's unedited frame hashes remain unchanged. This records which
   files the Agent deliberately changed and detects accidental changes.
4. Prefer `timing_strategy: pts`. It preserves the real interval of every frame,
   including variable frame rate footage. Use `bounded_cfr` with an explicit
   `cfr_fps` only when the goal calls for that timing choice, and inspect the
   resulting duration. Frame count divided by `avg_frame_rate` is unreliable for
   VFR. Never repeat the final frame to compensate for a concat duration issue.
5. Keep `keep_audio: true` to restore the source audio offset. A new `audio_path`
   explicitly selects a new soundtrack; `audio_offset_seconds` adds an adjustment
   to the recorded relative offset. Do not silently substitute the old voice if
   a requested new voice is missing. Use the existing timeline/mix executor for
   more elaborate music edits.
6. Inspect the delivered MP4, `assemble-manifest.json`, and registered comparison
   stills. Check exact frame count and duration, the edited frames and their
   neighbours, visible continuity, soundtrack onset and synchronisation.
   Technical success leaves the visual result available for content review.

Example parameters, prepared by the Agent:

```json
{
  "timing_strategy": "pts",
  "keep_audio": true,
  "comparison_count": 2,
  "replacements": [
    {"index": 30, "path": "edits/frame-30.png", "sha256": "<locally computed SHA-256>"}
  ]
}
```

## Size, recovery and observed limitations

Both operations use the existing FFmpeg component, prepared on demand. There is
no additional model requirement for exporting or assembling. Defaults are
3,600 frames, 120 seconds, approximately 1080p per frame and 2 GiB temporary
storage; limits are configurable in the registered parameter schema. Check the
available disk space and prefer a bounded shot for dense footage. CFR encodes
the sequence together; genuinely variable timing currently uses small disk
clips with two workers. That route avoids holding a whole decoded film in RAM,
but per-frame process startup is expensive for long footage.

Use the existing job ID to inspect a failure. Resume only after the cause is
fixed; use a new request key when intentionally selecting different inputs or
parameters. Missing frames, unexpected hashes, dimension changes, sequence gaps,
escaped paths and changed queued inputs have concrete error codes. Preserve
their records and the source files. A failed worker waits for already started
work to exit before the job ends, so an error is not a reason to start a second
overlapping job.

The current MP4 encoder uses H.264 with an even-sized canvas and AAC audio. For an
odd-sized source, choose a deliberate pad/crop or a different editor based on the
goal; do not silently change the canvas. AAC can soften very short silence edges.
Negative timestamps and long-film performance need further real acceptance.

These contracts provide the frame editing foundation. Consistent whole-character
replacement, image synthesis and motion interpolation each require their own
chosen engine and visual acceptance. A successful two-frame repair establishes
the editing roundtrip, not identity consistency across a full video.