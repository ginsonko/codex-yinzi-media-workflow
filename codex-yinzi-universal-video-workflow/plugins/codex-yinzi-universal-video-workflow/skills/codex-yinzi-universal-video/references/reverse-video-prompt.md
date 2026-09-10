# Reverse a reference video into an evidence-based shot prompt

Use this for recreating a source performance, replacing its character, or adapting its shots to a product. Keep the requested preservation target: a similar performance and exact background preservation require different acceptance. A prompt can describe the source precisely without guaranteeing that a generative model will obey it.

## Prepare, inspect, compile

1. Call `video_reverse_prepare` with the existing `session_id`, a stable `request_key`, the authorized local `input_path`, and `goal`. Start with `frame_count: 24` for a short clip, or provide explicit `timestamps` around pose changes, cuts and transitions. Increase coverage where motion requires it. “Every 24 frames” is a sampling interval, not 24 total frames; derive seconds from the actual frame rate or use the returned real timestamps for variable-frame-rate media.
2. The call returns a durable local job immediately. `local_media_get_job` returns the result manifest and attachments. FFmpeg and image components install automatically if missing; progress remains in the original session. Frames are full-resolution PNGs, and the tool groups them into unscaled storyboards with time labels. Long videos can be split into sections; the current prepare operation handles up to ten minutes and 120 selected frames per job. These are analysis limits, not provider reference limits.
3. Inspect every storyboard and necessary full-size frames. Describe what actually happens over time: subject action/expression, camera and placement, background/text, transition and audio. View or listen to the source when still frames cannot resolve motion or sound. Record uncertainty explicitly. File names, a generic “replace character” instruction, and an unviewed contact sheet are not visual analysis.
4. For character replacement, edit source keyframes as independent items in the [batch queue](batch-images.md), preserving each source pose and scene. Assemble accepted edited frames locally. Bind the actual uploaded files in their actual order: identity is an identity reference, edited boards are appearance/pose references, and the source video is the timing reference. Do not label an original board as already edited. A board with four cells counts as one uploaded image.
5. Call `video_reverse_compile` with `manifest_path` from prepare, the task goal and structured `observations`. Each observation has `start`, `end`, `frame_ids` from that manifest, and `description`; optional fields are `camera`, `background`, `transition`, `audio`, `uncertainties`. `references` entries contain `type` (`image`, `video`, `audio`), the actual one-based `index`, `role`, and optional `frame_ids`.
6. Set `preserve`, `avoid`, `output_duration` and the actual provider's `max_prompt_chars`. The default ceiling is 8000, but sites and models differ. Compile returns the prompt, a downloadable `prompt.txt`, warnings and acceptance times. It checks temporal and reference correspondence and refuses silent truncation. Fill missing important shot intervals before submitting. When intentionally changing timing, use `timing_mode: "retime"` and an explicit `retime_instruction`.

Example observation, using IDs and times from the actual manifest:

```json
{
  "start": 3.1,
  "end": 6.8,
  "frame_ids": ["K005", "K006"],
  "description": "The character extends one palm toward the camera, maintaining the source expression.",
  "camera": "Medium close-up, head on the left and hand in the right foreground.",
  "background": "Keep the source lettering and background at the corresponding source time."
}
```

Do not copy those IDs or times onto another video. The same tools are exposed as `local.video.reverse-prepare` and `local.video.reverse-compile` through `local_media_run` and the installed CLI's `local-run`. For compile, `input_path` is the manifest and the fields above go under `parameters`. This fallback continues work when a running Codex session has not refreshed MCP discovery.

## Submit and assess

Use the existing single-submit video tool or persistent video batch for multiple independent clips. The prompt and its reference roles must travel together. Keep the original request, response and task ID. Upload failure before the generation POST, ambiguous POST acceptance, upstream rendering, finalizing and local download failure are separate states. Recover the corresponding phase; never requeue an uncertain paid request just because no local file exists.

An upload can finish server-side after the local client times out. When the current site's file record has been reconciled to the same prepared-file hash and account, pass `file_id:THE_RETURNED_ID` in the corresponding reference list. The Yinzi adapter sends its native `file_id` and skips uploading that file. IDs are scoped to the original site/account; never copy one to another provider or guess an ID from a filename. Preserve the original local path, prepared-file hash, file ID and upload receipt in task evidence. File readiness is separate from video-generation acceptance.

Compare the returned video at the compiled acceptance times, including the opening, each pose change and the final transition. Check identity, action, camera, untouched text/background and timing separately. Reuse original audio locally when exact music is required and the user authorized its use. Equal duration and restored audio do not prove motion alignment. If background preservation must be exact, use masks and local compositing where actually supported, and inspect edges, occlusion and newly exposed areas. Keep rejected generations as evidence; refine a specific mismatch instead of repeating a long prompt without learning.

## Validated boundary

Windows local acceptance covered actual 24-frame extraction, six unscaled boards, durable job recovery, same-key reuse, attachment retrieval and structured prompt compilation. This establishes the tool chain. Exact character replacement remains a separate content acceptance: no particular video model or local model is certified by successful extraction or compilation.
