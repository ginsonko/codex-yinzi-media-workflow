# Production notes: two code-rendered films

Both films were made by a coding agent without any video generation model. The user now shows
both as showcase works. The notes record what was built and measured; they are not a listening
or viewing review.

## 1. Oscilloscope physics lesson (示波器)

| Item | Value |
| --- | --- |
| Length and format | about 8 min 05 s, 1920x1080, 30 fps, 14,560 frames |
| Drawing | Canvas 2D for the oscilloscope, beams, fields and graphs; DOM overlay for titles, formulas and subtitles |
| Page contract | `window.renderFrame(t)` plus a `window.ready` Promise for fonts and assets |
| Capture | Playwright (Python) driving Chromium; frames taken with the DevTools `Page.captureScreenshot` command |
| Parallelism | 5 worker processes, each rendering its own frame range and piping PNG frames into FFmpeg |
| Encode | libx264, CRF 14, `-preset slow`, then a lighter share copy |
| Narration | Edge online TTS returned HTTP 403 for synthesis; switched to an offline Kokoro voice through sherpa-onnx. Lines were synthesized one by one, measured, and the visual cues placed from the measured durations. ASR of the result was compared with the script to catch mispronounced physics terms. |
| Music | Generated procedurally with numpy (not a neural music model), ducked under the voice |
| Loudness | `loudnorm` to about -16 LUFS integrated |
| Delivery | The MP4 plus a web page with an interactive lab, deployed to the user's server |

Problems hit and fixed:
- The system drive filled up while concatenating segments after all frames had rendered. Joining
  segments, encoding and muxing audio in one FFmpeg pass removed the large intermediate file.
- A gallery tag overlapped an axis label; found by rendering stills per scene before the full
  render. Final spot checks at 2:00, 4:00, 6:00 and 7:50 showed no subtitle overlap.
- The high-quality master was about 3.5 GB; the share copy was about 690 MB.
- PowerShell 5.1 rewrites corrupted Chinese text in source files; files were then written only
  with editor tools or UTF-8 aware scripts.

## 2. 《峰与谷 CREST & TROUGH》 (often called 波与谷)

| Item | Value |
| --- | --- |
| Length and format | 336 s, 1920x1080, 24 fps, 8,064 frames, 2.39:1 widescreen picture letterboxed inside the 16:9 frame |
| Brief | An abstract film about waves and life's highs and lows; the brief explicitly excluded complex scenes and people |
| Drawing | Three.js with custom GLSL shaders (wave surfaces, particles, light, bloom, grain); DOM for bilingual title and caption cards |
| Source of truth | One `timeline.json` with scenes, durations, captions and music cues, read by the page and by the score generator |
| Page contract | `window.renderFrame(frameIndex)` style deterministic rendering, all motion derived from time |
| Capture | puppeteer-core with the local browser; each frame read with `canvas.toDataURL` as JPEG and piped into FFmpeg |
| Encode | libx264 CRF 14 with `-tune grain`, then a share copy |
| Render time | about 16 minutes for all 8,064 frames on an RTX 2070 SUPER |
| Music | Procedural score generated with numpy from the timeline cues, measured at -15.0 LUFS integrated with the agent's own K-weighted meter (not a certified meter) |

Problems hit and fixed:
- A shader used a `uTime` uniform that was never declared, and scene modules not yet written
  returned 404s; both surfaced only once page console errors were logged. The final render
  reported zero page errors.
- The system drive had about 13 GB free, so frames were streamed to FFmpeg and renders kept on
  another drive. Headless capture ran at about 7 fps at 1080p on this GPU.
- One scene (the calm sea) was overexposed overall; caught on still previews and corrected.

## What the evidence supports

- The route reliably produces long, exact, re-renderable films at 1080p for diagrams, physics,
  abstract imagery and typography, with total cost limited to local compute.
- Frame-accurate determinism (everything from `t`) is what made parallel and partial re-renders
  possible in both projects.

## What it does not establish

- No test with realistic people, acting or real places; earlier code-animated character tests
  (part-rigged image animation) were rejected by the user as uncanny.
- The procedural music was accepted as part of the showcase but was not compared with a music
  model or a licensed track.
- The bundled `scripts/render_page.mjs` is a new dependency-free reimplementation of the same
  capture loop. It was checked on short renders (3 s at 1920x1080/30 fps; a 1 s segment with
  `--start` and audio at 1280x720/24 fps), not on a full-length film.
