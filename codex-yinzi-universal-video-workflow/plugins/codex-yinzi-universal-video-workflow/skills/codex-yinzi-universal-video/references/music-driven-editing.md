# Music-driven local editing

Use this recipe when the user wants music-synced MAD/MV, highlights or rhythmic remix edits. Work from the selected source video or soundtrack and its actual timestamps. Preserve source files; use derived outputs through the local job system so progress, component preparation and results stay visible.

## Find useful cut points

Call `local_media_run` with an existing session and stable request key:

```json
{
  "session_id": "EXISTING_SESSION_ID",
  "request_key": "soundtrack-analysis-v1",
  "module_id": "local.audio.analyze-beats",
  "input_path": "ABSOLUTE_SOUNDTRACK_OR_VIDEO_PATH",
  "parameters": { "low_hz": 40, "high_hz": 300, "min_interval": 0.15 }
}
```

Read the JSON result's `onsets`, `envelope`, `time_resolution_seconds` and `tempo_hypothesis`, plus the SVG attachment. The native tool streams local audio through FFmpeg; a missing registered FFmpeg component follows the normal automatic preparation flow. There is no cloud generation charge for this operation.

Times refer to the source video origin when video exists, or the first audio stream origin for audio-only input. A delayed soundtrack therefore stays delayed. The selected audio stream is the first audio track; choose the intended track with the normal extraction tool when the source contains several tracks.

The default low-frequency band often finds kicks and impacts. To look for sharper percussive events use a wider frequency band; `sensitivity` is a threshold multiplier, so lowering it returns more candidates. `min_interval` suppresses near-duplicate impacts. Listen at representative points and retain useful shots around them. A steady tone, silence or sparse impacts may produce no credible tempo hypothesis. Half-time, double-time, vocals, variable tempo and syncopated music remain possible; do not force a regular grid over unrelated events.

## Build the edit around meaning

Match important actions, gestures, reveals and emotional changes to selected musical events. Keep enough lead-in and recovery around each action. Use cuts for clear accents and a fade when scene continuity benefits. Not every detected transient needs a cut or effect. Retain the original soundtrack timing when assembling the video.

The tool prepares cut suggestions; it does not by itself produce a finished MAD or guarantee artistic quality. Verify the rendered video at normal speed, then inspect important cut points and audio/video synchronization. Record the actual successful settings, useful failure lessons and quality limits in the local experience records, linked to the job rather than copied into a new automatic receipt.
