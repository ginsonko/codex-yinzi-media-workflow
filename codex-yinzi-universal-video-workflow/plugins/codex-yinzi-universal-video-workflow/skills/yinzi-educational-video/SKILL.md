---
name: yinzi-educational-video
description: Turn a photographed or screenshot exercise into an accurate, polished narrated teaching video, a worked-solution long image, or an interactive explanation. Use for physics motion, mathematics and geometry, literary interpretation, and teacher/student lesson requests, including a complete worked transfer example.
---

# 银子教学视频与拍题讲解

Use the question as the content authority and the learner's level as the design constraint. Deliver a clear explanation with purposeful animation, not a transcript pasted into slides. If the Yinzi media workflow is installed, reuse its session, asset, paid-request and experience tools; local scripts can also run without its database.

## From input to a lesson

1. **Recover and read.** Preserve the photograph, identify the actual question(s), transcribe conditions, units, labels and the requested quantity. Separate printed solutions from the question. Do not infer dimensions from perspective, silently repair an ambiguous symbol, or use a provided answer as independent verification. Ask only when an ambiguity changes the solution and cannot be resolved from the image.
2. **Solve before animating.** Derive the answer independently. Save coordinates, assumptions, equations and checks separately from the narrative. Use symbolic simplification, dimensions, boundary cases and a numerically independent method when it catches a plausible error. For history/literature distinguish source facts, interpretation and AI visual reconstruction.
3. **Design the teaching path.** Establish what the learner should understand, then plan: question → model → key difficulty → derivation → answer → reusable method → complete worked variant. A variant changes a meaningful condition and contains its own calculation and answer; a list of “similar problems” is insufficient. Keep paid assets conditional on the user's budget. Save a short plan and check scientific and visual weak points before rendering; existing authorization does not need another approval.
4. **Build from one source of truth.** Motion, vectors, graphs, labels and values derive from the same parameterized model. Use analytic equations or a checked numerical solver for scientific motion, not generated video. Choose Manim/Cairo for exact 2D diagrams, Canvas/SVG for interaction, and AE or other compositing tools when their visual contribution justifies it. Read [physics and mathematics](references/scientific-modeling.md) for relevant motion/geometry work.
5. **Let narration set the timing.** Write spoken Chinese instead of reading symbolic notation literally. Generate or record audio in small cached segments; measure duration before allocating scene time. Keep visual reveal cues aligned with the spoken step and leave time for a difficult equation. Use a selected voice/provider or existing audio; online TTS is not offline synthesis or cloning. See [production methods](references/production.md).
6. **Choose the best presentation proactively.** Render genuine TeX/SVG formulas, reserve subtitle space, use stable semantic colors and leave the current relationship on screen. Effects should reveal motion, comparison or causality. Offer video for guided explanation, a long image for revision, and an interactive page for parameter exploration, construction or counterexamples when useful; the user need not know to ask for those formats. A strong interaction makes a learner's action reveal something: change a radius and see the first exit, move a point and see the slope, compare interpretations against source details. Keep pause/replay, labels, keyboard access and mobile use clear. Package a website subpage with relative asset paths and no local-machine dependencies when later embedding is intended. Prepare deployment instructions; do not infer permission to publish.
7. **Compose the delivery.** Compose to a temporary output and promote it only after a successful encode. Deliver the selected formats, editable source and a source manifest. Link video chapters to relevant interactive states where it improves comprehension; test the links and actual seeking in the intended server, not just their appearance.
8. **Check the actual output.** Decode the full final video, inspect representative frames at every section and the difficult transition/formula, check audio streams and subtitle timing. Numerical QA is not listening; report listening or visual sampling limits honestly. Revise specific issues, preserve the approved version, and record transferable failures/solutions with evidence.

## Reusable tools

- `scripts/lesson_timing.py`: Build an audio-measured, frame-aligned timeline from a lesson JSON and existing segment audio. Provider-neutral; no credentials or fixed paths.
- `scripts/tex_to_png.py`: Render a real LaTeX formula to a transparent image with Manim. Use for long images when a plotting library has incompatible native dependencies.
- `scripts/check_media.py`: Probe streams, decode all frames, measure audio and save a bounded evidence report. Does not judge subject accuracy or aesthetic quality.
- [Validated examples and limitations](references/validated-examples.md): Read when adapting the tested workflow, not as a universal solver.
- [Local music, reference voice and editable slides](references/audio-and-slides.md): Read for optional neural audio or PPTX, model setup, queue recovery, licensing and actual rendering/listening checks.

## Outcome boundaries

Teachers can ask for lecture pacing, students for a worked explanation, and showcase pieces for more visual polish. Keep those choices configurable. A correct six-minute explanation may be a better fit than a compressed promotional montage. Do not label generated historical/literary scenes as documentary evidence; do not pretend programmatic background music is a neural music model. Hardware-dependent tools are optional, and a successful local case is not proof that every photograph or subject can be solved reliably.
