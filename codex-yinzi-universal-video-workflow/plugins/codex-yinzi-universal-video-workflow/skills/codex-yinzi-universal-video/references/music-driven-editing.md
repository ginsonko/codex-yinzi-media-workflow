# Music-driven local editing

Use this recipe when the user wants music-synced MAD/MV, highlights or rhythmic remix edits. Work from the selected source video or soundtrack and its actual timestamps. Preserve source files; use derived outputs through the local job system so progress, component preparation and results stay visible.

For thematic design, dynamic source collection, reference study, meme structure and artistic iteration, also read [MAD and remix creative direction](mad-remix-creative-direction.md).

## Choose the sound before the effects

For a trailer or character-led adaptation, first identify useful original dialogue, room tone and story sounds. Silencing a visibly speaking character without a deliberate reason weakens the scene. Audition the source soundtrack or music associated with the work when available and authorized, alongside other music fitting its mood. Do not default to the same background loop across unrelated samples or restart that loop at every visual cut. A continuous musical phrase with a chosen entrance, escalation and release often connects a short montage better.

Keep dialogue, music, ambience and effects separately editable. Let speech lead across a cut (J-cut), or finish over the following image (L-cut), when it clarifies continuity. Reduce the music under key words with gentle volume envelopes; retain enough atmosphere that the world does not go silent. Place added impacts selectively, and match musical cuts at compatible phrases rather than hiding every join behind a loud whoosh. With retimed footage, check speech/lip timing separately instead of stretching all audio with the video.

Inspect loudness, true peak and decoded alignment, then listen to the final mix with picture. Technical measurements cannot establish whether speech is intelligible, a music entry is emotionally appropriate or an effect is distracting. Preserve the previous approved mix when the user only requests visual changes.

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

For source footage with many shots, use `local.video.analyze-shots` through the same local-job queue. It prepares FFmpeg and Sharp on demand, then returns a JSON shot timeline, timestamped keyframe images and a contact sheet in the task gallery. This is useful for MAD, livestream highlights, tutorials and Vlogs; read the contact sheet and open promising ranges before choosing an edit.

Start with `sample_fps: 8`, `max_keyframes: 24` and `scene_threshold: 0.22`. Lower the threshold when clear cuts are missed; increase it when flashes or overlays create false cuts. For a short clip requiring frame precision, `sample_fps: 0` analyzes every decoded frame under the configurable frame limit. Times are relative to the video stream's start, and each keyframe keeps its integer source PTS. The end of the final shot includes the final frame's duration. Do not add a fixed early seek to extract a cut: a 20 ms offset selects the previous frame at 60 fps.

Use `shots[].start/end` with audio `onsets[].seconds` on the same source timeline. The exported `alignShotsWithBeats` helper reports nearby candidates; select actions, character reveals and emotional beats after viewing them. Motion and brightness measurements describe pixels and cannot decide narrative importance. Dark or still footage can still be essential. For silent footage, analyze the chosen soundtrack separately and explicitly place it on the edit timeline.

Long input is bounded by `max_duration` and `max_frames`; split a large source into useful ranges if a limit is reached, retaining each range's source offset. The JSON remains `review_required` until the selected content and final edit have been checked.

Match important actions, gestures, reveals and emotional changes to selected musical events. Keep enough lead-in and recovery around each action. Use cuts for clear accents and a fade when scene continuity benefits. Not every detected transient needs a cut or effect. Retain the original soundtrack timing when assembling the video.

Keep a source interval list when selecting a small amount of good footage from several generations. Check internal cuts and face/prop changes before splicing. Avoid overlapping source intervals and repeated reveals introduced merely to fill duration; shortening the sample is preferable when the remaining footage does not support the story. For restrained promotional wording and text that belongs in the image, read [story and compositing](music-mv-story-and-compositing.md#promotional-keywords-and-scene-aware-typography).

The tool prepares cut suggestions; it does not by itself produce a finished MAD or guarantee artistic quality. Verify the rendered video at normal speed, then inspect important cut points and audio/video synchronization. Record the actual successful settings, useful failure lessons and quality limits in the local experience records, linked to the job rather than copied into a new automatic receipt.

When a user reports stutter despite a valid constant-frame-rate file, inspect
source-to-output speed and frame repetition before changing the player. In a
real anime MAD revision, stretching sub-second shots to 0.3–0.6x speed caused
visible pauses despite complete decoding. Shortening the edit and restoring
action speed addresses that cause; changing the export FPS alone does not.
Align action peaks and reveals as well as cut boundaries to selected accents.

Use optical flow selectively inside a clean shot, never indiscriminately
across a montage. In that revision it reduced repeated action frames but
created doubled eyelids in an expression close-up; those close-ups retained
their original animation cadence. Examine faces, hands, guns and occlusion
boundaries after interpolation. Intentional short graphic holds may remain,
but distinguish them from accidentally frozen movement. A lower duplicate
frame ratio is not a quality verdict, and computed onsets do not prove listening.
