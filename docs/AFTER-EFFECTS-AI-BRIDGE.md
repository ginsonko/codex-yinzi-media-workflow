# After Effects AI bridge

This unregistered candidate prepares an After Effects control test as JSX.
`afterEffectsBridge.createDemo(outputDir)` writes an isolated fixture;
when After Effects is installed, set `YINZI_AFTERFX_PATH` (or let the Windows
known-version paths be discovered) and run `runAfterEffects(scriptPath)`.

The fixture requests position, rotation, scale, opacity, mask feathering,
typography and render-queue output. It is deliberately
generated without downloaded footage so the first acceptance isolates AE
control from media acquisition. AE execution is pending installation. Acceptance requires launching the
actual executable, opening the `.aep`, rendering the movie, probing it with
FFprobe and visually checking representative frames. A JSX file or an
installed executable alone is not an acceptance result.

Use an empty editor and a new output directory. The candidate preserves open
projects and existing files. A dispatch receipt prevents automatic duplicate
launches. An uncertain timeout leaves the editor running. Completion depends
on the script receipt and nonempty AEP/AVI, followed by separate media QA;
the AfterFX launcher exit code is not a render receipt. The production
showcase remains a separate creative deliverable, not this engineering test.

If After Effects is absent, the bridge returns `AFTERFX_MISSING` and leaves the
workflow's existing local FFmpeg path available. It never downloads or
activates an untrusted installer.
