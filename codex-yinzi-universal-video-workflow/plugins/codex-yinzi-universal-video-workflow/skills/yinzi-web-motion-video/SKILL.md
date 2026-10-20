---
name: yinzi-web-motion-video
description: "Make explainer, science, data, UI, typography or abstract cinematic videos with no video generation model: a strong front-end model writes an HTML/CSS/Canvas/SVG/WebGL page whose window.renderFrame(t) draws the exact frame for time t, then every frame is captured and encoded to MP4 (render_video tool, or the bundled headless-browser fallback). Use for 科普/讲解/示波器/物理/数学/数据可视化/片头/字幕卡/抽象动效 such as the 波与谷 (峰与谷) film; not for realistic people, everyday human scenes or specific real places."
---

# Code-rendered motion video (前端代码渲染视频)

Every pixel comes from code, so motion is exact, repeatable, editable and free of generation
fees. Two real productions used this route and the user now shows both as showcase works: an
8-minute narrated oscilloscope physics lesson and the 5.6-minute film 《峰与谷 CREST & TROUGH》
(often called 波与谷). See [production notes](references/production-notes.md) for their structure
and measured results.

## When to use it

Good fits: diagrams, waveforms, fields and particles, physics or maths models, data and charts,
interface walkthroughs, maps drawn as graphics, kinetic typography, bilingual title cards,
abstract or cosmic imagery, logo stings, chapter cards, lyric or subtitle layers for another
edit. Cinematic, polished, show-off quality is achievable: bloom, depth, grain, letterboxing,
camera moves, music-synced cuts.

Do not use it for realistic everyday people, acting, crowds, specific real cities, landmarks or
real places, or photoreal products. Viewers judge faces and bodies harshly; code-animated
characters looked uncanny in testing. For those, use footage or the video-generation routes, and
use this route only for overlays, diagrams or titles composited on top. The 峰与谷 brief itself
said "no complex scenes and people"; the story was carried by abstract shapes, light and text.

For a photographed exercise or classroom lesson, start with the sibling `yinzi-educational-video`
Skill (it owns question solving and teaching design) and use this Skill for the rendering method.

## The page contract

The page is a deterministic function of time:

```js
window.renderFrame = (t) => { /* draw the exact state at t seconds; may return a Promise */ };
window.ready = loadFontsAndAssets();   // optional Promise; the renderer awaits it once
```

- Compute everything from `t` (or from the frame index `Math.round(t * fps)`). Never read
  `Date.now()`, `performance.now()`, `requestAnimationFrame` timing, CSS animation or transition
  state, video element playback position, or unseeded `Math.random()`.
- Use a seeded PRNG keyed by frame or object for grain, particles and jitter, so a frame rendered
  twice is identical and segments can render in parallel in any order.
- Avoid simulation state that accumulates from frame to frame. If a scene truly needs it, derive
  it in closed form, precompute it in `ready`, or recompute from the shot start inside
  `renderFrame`.
- Size the page to the output: `html, body` fixed at the target width and height,
  `overflow: hidden`, device pixel ratio 1. Load every font with `document.fonts.load(...)` for
  the actual text (CJK glyphs load lazily) before `ready` resolves.
- DOM text is fine (CSS typography, MathML, SVG); the capture includes it. Set its opacity and
  transform inside `renderFrame` instead of using CSS transitions.
- For WebGL, create the renderer with `preserveDrawingBuffer: true` and pass `t` as a uniform.
- Optional: a `?play` query that drives `renderFrame` from the clock for live preview only.

[assets/starter.html](assets/starter.html) is a small working example (Canvas waves, seeded grain,
DOM title and timed captions).

## Render with the app's `render_video` tool

When the host app exposes `render_video`, call it with:

```json
{
  "html": "<absolute path to the .html page>",
  "out": "optional output mp4 name",
  "seconds": 12,
  "fps": 30,
  "width": 1920,
  "height": 1080,
  "audio": "<optional absolute path to the soundtrack>"
}
```

Defaults: `fps` 30, `width` 1920, `height` 1080. The tool loads the page, calls
`renderFrame(i / fps)` for every frame `i`, captures it and encodes an H.264 MP4 (with the audio
when given). Inspect the returned file: duration, frame count and representative frames.

## Fallback without the tool

`scripts/render_page.mjs` does the same with only Node 22+, a local Chrome or Edge and FFmpeg:

```
node <skill>/scripts/render_page.mjs --html page.html --out film.mp4 --seconds 12 --fps 30 \
     --width 1920 --height 1080 [--audio mix.wav] [--start 0] [--crf 16]
```

It starts headless Chrome over the DevTools protocol, awaits `window.ready` and fonts, captures a
PNG per frame and pipes it into FFmpeg (libx264, yuv420p, `+faststart`). For long films run
several processes with `--start`/`--seconds` on separate frame ranges or per shot, then join the
segments with `ffmpeg -f concat -safe 0 -i list.txt -c copy`. It reports page errors and exits
non-zero when any occurred. Equivalent Playwright or Puppeteer scripts were used in the real
productions (see the notes).

## Production steps

1. **Story and timeline first.** Write the script, then one timeline file (scenes/shots, durations,
   caption cards, narration lines, music cues). It is the single source of truth for the page,
   the soundtrack and subtitles.
2. **Narration sets timing.** For voice-over, synthesize per line (cached), measure each clip's
   duration, then place lines and visual cues from the measured times. Check pronunciation with
   ASR against the script and fix polyphonic words and terms. Leave reading time for formulas.
3. **Build the page in layers:** background, main drawing (Canvas 2D, SVG or WebGL), glow/bloom,
   DOM typography, captions in a reserved safe area, final grade (vignette, grain, letterbox).
4. **Preview stills before the full render.** Render a handful of timestamps per scene and look at
   them: overexposure, labels colliding with graphs, subtitles overflowing, cards covering labels
   and garbled HUD text during crossfades were all caught this way.
5. **Soundtrack.** Mix narration, music and effects from the same timeline (duck music under the
   voice). Procedural music in code is possible but say so; do not present it as a neural music
   model. Loudness about -16 LUFS integrated, true peak about -1.5 dBTP for phones and web.
6. **Full render.** A high-quality master (CRF about 14, `-preset slow`, `-tune grain` when there
   is film grain), then a share copy (CRF 19-20, optional `-maxrate 12M -bufsize 24M`), AAC 48 kHz,
   `+faststart`. Stream frames into FFmpeg instead of storing PNG sequences; keep renders off a
   nearly full system drive.
7. **Verify the actual file.** Duration equals the timeline, frame count equals duration x fps,
   audio length and loudness, zero page errors, a contact sheet of the final file and frames at
   every scene. Re-render only the shots that need fixes. State honestly that numeric checks are
   not listening or full viewing.

## Pitfalls seen in real work

- A disk filled up during the final concat after all frames had rendered; doing concat, encode
  and audio mux in one FFmpeg pass avoided a 3.6 GB intermediate.
- Windows PowerShell 5.1 corrupted UTF-8 source (Chinese text, symbols) when files were rewritten
  through shell commands; edit files with an editor tool or write them from Node/Python as UTF-8.
- Online TTS can be blocked (HTTP 403); an offline voice (for example Kokoro through sherpa-onnx)
  worked but needed lexicon fixes for physics terms.
- A shader uniform used but not declared, or a scene module failing to load, rendered silently
  wrong frames; log page errors and fail the render on them.
- Bloom and additive light overexpose easily; check stills at the brightest moments.
