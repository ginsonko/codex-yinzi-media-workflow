# Production methods and recovered mistakes

## Audio-first scene timing

Use a portable JSON structure:

```json
{"lesson":{"title":"Example","segments":[{"id":"s01","label":"Build the model","text":"Spoken explanation"}]}}
```

Prepare `audio/s01.mp3` (or WAV), then run:

```text
python scripts/lesson_timing.py lessons.json --audio-dir audio --output timelines.json --fps 30 --tail 1
```

Each section gets the measured audio length plus configurable reading room, rounded up to a video frame. Within the scene, reveal equations at the matching sentence. Do not speed through a derivation just because the total target is short. Preserve a readable summary while the voice finishes.

When synthesizing, fingerprint voice, provider/model, spoken text, rate and output settings. Reuse audio only when the fingerprint and successful audio probe agree. Write `.partial` files first. Preserve word/sentence boundaries when the provider supplies them, and rebuild subtitle timing from actual audio. Changing a line of script does not update its old MP3 automatically.

## Precise motion and layout

Tested Manim environment was 0.18.1 Cairo. That version uses `self.renderer.time`, not `Scene.time`. Do not upgrade a functioning global environment in the middle of production. Use a dedicated environment for dependency changes.

Keep equations as MathTex or verified SVG paths through final export. A NumPy/matplotlib binary-ABI failure was bypassed with Manim's TeX renderer; stripping backslashes from LaTeX produced visibly invalid formulas and is not a valid fallback. Create the selected media/cache root before Tex output.

Reserve stable areas for title, diagram, explanation and captions. Check braces and axis labels against field labels. View the final composited frame, not just the silent render, because captions introduce another layer of collisions. Static holding time is useful while a learner reads; explainable motion should continue only when the content calls for it.

## Assets and sound

AI-generated clips can establish mood in literature lessons. Keep a consistent visual brief, inspect anatomy/continuity, select short usable moments and mark them as AI interpretation. Scientific trajectories and mathematical plots remain deterministic. Public images require verified metadata; one candidate “landscape” was actually a sculpture and was rejected.

Budget authorization is not proof of an exact price. Keep submitted IDs, quoted/catalog estimates and actual billing separately. Querying an unknown request recovers that attempt. Within existing user authorization and budget, an explicit retry may start a fresh attempt in any prior state; archive the old request and keep unresolved billing truthful. Do not require another confirmation or proof of non-billing. Recover an existing download when only transfer failed. A failed shot does not invalidate a finished teaching lesson that uses other verified assets.

Use music below narration. Measure peaks and loudness, then listen when an audio-capable review channel is available. Stream presence and loudness do not establish pronunciation, emotional delivery or mix quality. Distinguish online neural TTS, local synthesis, voice cloning, procedural composition and neural music generation in user-facing claims.

## QA and recovery

Write encodes to `name.partial.mp4`, verify, then rename. Merely seeing an MP4 file while it is still being written does not make it readable (`moov atom not found`). Keep pending exports out of browser galleries.

Bound CPU workers and temporary disk use; do not install a heavy local audio model when current free VRAM cannot support it. A past GPU/display-driver failure is a reason to prefer a verified CPU route for small exact diagrams. It does not prove the machine can never run a local model.

Save source image, extracted question, independent derivation, narration, timeline, model, asset provenance, paid-request receipts and final checks. State what was sampled visually and what was not listened to. The next run should recover these facts, not rerender everything or resubmit paid work.
