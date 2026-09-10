# Existing-Media Task Recipes

Read the relevant recipe only. Select the registered operation from the authorized input and requested result, then submit a durable local job. The runtime prepares missing components and continues automatically. These choices compose into a task; they are not mandatory stages.

| User need | Operation and parameters | Result check |
| --- | --- | --- |
| Resize a phone or product photo | `local.image.resize`, `width` or `height`, optionally both as inside bounds | Dimensions follow visible photo orientation; width alone must not inject a height constraint. |
| Fit the complete product in a square | `local.image.contain-white`, `contain-black`, or `contain-transparent` | Entire garment, buttons and edges remain visible. These presets produce 800x800 and do not remove an existing background. |
| Social crop or thumbnail | `local.image.social-square` or `thumbnail` | Cover/crop presets may cut products. Use containment when full-subject preservation matters. |
| Crop or rotate a phone picture | `local.image.crop` with visible-image coordinates, or `rotate` with `angle` | EXIF orientation is applied before user geometry, including mirrored orientations. |
| Put transparent art on white | `local.image.flatten`, then optional `convert` with `format: jpeg/webp/png` | Check edges; removing alpha alone does not create a white background. |
| Learned image enlargement | `local.image.realesrgan`, `model: anime/general`, `scale: 2/3/4` | Compare at equal display size. Preserve alpha and inspect text, faces and product texture. This executor requires a usable Vulkan GPU. |
| Extract image text | `local.image.ocr` | Produces UTF-8 text and lines/boxes; inspect names and numbers. Does not produce a PDF. |
| Searchable screenshot or scanned page | `local.image.searchable-pdf` | Retains the visible image and adds positioned OCR text. Search/copy phrases and inspect the page; full OCR accuracy and arbitrary multi-page PDF inputs are not guaranteed. |
| Mirror or resize video, retaining music | `local.video.hflip`, `scale`, or another picture filter | Compatible AAC/MP3/ALAC tracks are copied without audio/time filters. Other codecs convert to AAC for MP4. Inspect `details.audio_handling`. |
| Extract a clip | `local.video.trim`, `start`, `duration` in seconds | Both tracks are trimmed and timestamps reset. Check actual start/end content and duration. |
| Change playback speed | `local.video.speed`, `speed` from 0.5 to 2 | Both tracks change speed; audio re-encodes. Check final duration and synchronization. |
| Export soundtrack or mono speech | `local.audio.anull` or `local.audio.mono` | Outputs PCM WAV rather than a compressed copy. Check channels and duration. |

For chained work, use the completed job's actual output path as the next input. Retain the source and useful intermediate results. Group product folders by the actual SKU before selecting references; file proximity does not prove that garments match. Local preparation does not establish semantic body replacement, product claims or guaranteed commercial performance.

## Fast Execution and Recovery

- These local operations need no provider Key or remote model authentication. Clear input and output requirements are enough to start a matching tool.
- A single direct tool job needs no invented plan node. Its persisted state updates the task summary automatically. Explicit completion also reads standalone jobs and preserves incomplete/failed outcomes and content-review status.
- Show the first usable result immediately. Measure request-to-result, installation and inference separately; conversation elapsed time is not backend execution time.
- Read the original job after an interruption; it may already be recovering or complete. Resume that durable job rather than creating another request key.
- GPU work is serialized; independent lightweight CPU tasks can use the runtime's available concurrency. Basic-filter timing does not establish OCR or large-video latency.
- Ordinary media tasks need focused result checks, not developer suites or repeated endpoint discovery.
- Task-list archiving is reversible: the original task, artifacts and requests remain accessible. Restore the same task when needed. Archiving does not cancel provider requests or wake a stopped Codex agent.

## Content Review

Execution and decoding establish file validity, separate from content acceptance. The gallery provides accepted/needs-changes controls beside each result. They preserve the original file, do not themselves generate or charge for replacement, and are not required to continue authorized work.

Codex can use the same existing feedback operation:

```json
{
  "idempotency_key": "review-current-result-1",
  "message": "The visible orientation differs from the source; revise this result.",
  "scope": { "type": "artifact", "artifact_id": "THE_EXISTING_ARTIFACT_ID", "verdict": "needs_changes" },
  "actor": "codex"
}
```

Use `accepted` only after checking relevant content. Preserve failed output and feedback history; a newer result has its own artifact ID. Repeating an old feedback key reuses that feedback without overwriting a later review.

## Measured Scope

Windows x64 acceptance on 2026-09-10 executed 201 basic Sharp/FFmpeg operations on short fixtures. Twelve source-media scenarios caught and verified repairs for phone EXIF geometry and original-audio re-encoding; they completed in approximately 1.4 to 8.2 seconds per job with installed components. These are samples, not latency guarantees.

One real native Real-ESRGAN interruption recovered the same job and retained previous history. That case does not prove behavior under every driver or operating-system failure. OCR, searchable PDF and super-resolution have separate content-bearing evidence. Semantic character replacement and complete commerce video generation remain separate quality targets.

The ordinary searchable-PDF trial produced its first PDF after about 142 seconds, including agent preparation, with an 8.63-second local job. All 33 OCR lines were searchable and the embedded source image remained unchanged, but small-text OCR errors and viewer-dependent selection-box height remain. Do not present these sample timings as a guaranteed response time or require multiple PDF engines for an ordinary user's task.
