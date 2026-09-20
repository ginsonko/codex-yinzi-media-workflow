---
name: yinzi-music-creation
description: Write lyrics and create sung songs, rap, instrumental music or bilingual versions with the Yinzi media workflow. Inspect hardware, choose local YuE2 or MusicGen versus an authorized online service, test a musical section, review the singing and deliver audio or prepare an MV.
---

# 银子歌曲创作

Turn the user's story and mood into an actual musical result. Distinguish a **sung song** (YuE2), **instrumental background music** (MusicGen), and **spoken narration / dialogue** (TTS). Pitch/time editing is useful for a deliberately spoken remix; it is not a substitute for singing.

Use the sibling [media workflow](../codex-yinzi-universal-video/SKILL.md) for task progress, module discovery and local-job APIs. Keep current user choices and authorization. The chosen local route or an already authorized retry needs no additional approval.

## Choose a usable route

YuE2 and MusicGen are optional, on-demand components. Do not download their weights during ordinary workflow installation, browsing a capability list or preparing an unrelated task. When a requested task actually needs song/music generation, compare routes during planning: inspect the actual OS, GPU model, total/free VRAM, available RAM, CUDA/driver where applicable, and free disk at environment/model/output paths. Explain the useful local route and its preparation cost, then download only the selected components within the user's authorization. Do not treat a published minimum or a module being listed as evidence that this machine is ready.

Read repository `docs/LOCAL-SONG-YUE2.md` for portable setup/inspect commands. Prepare only the chosen model in an isolated environment; preserve music/voice configuration and reuse verified weights. A short CPU MusicGen run may be an option when time permits, but benchmark it before promising practical throughput.

YuE2 through WanGP offers INT8, CPU offload and tiled VAE. About 4.5 GB is a low-memory route to evaluate, not a guarantee for every 4.5 GB card. Prototype evidence used an 8 GB NVIDIA GPU; length, concurrent processes and runtime affect the peak. Start with a representative section and inspect the receipt. Do not silently substitute an unverified CPU YuE2 implementation. MusicGen CPU makes short instrumental music, not vocals.

If hardware is unsuitable, explain the measured constraint and offer an online song service. Check current official availability, lyrics control, API access, price, output rights and data handling. Do not label a third-party Suno wrapper as its official API or assume Yinzi API has a music endpoint. A recommendation alone does not authorize uploading or payment. YuE2 and bundled MusicGen/F5 weights have noncommercial licensing; software licensing does not override model rights.

Useful starting points are [Suno](https://suno.com/) with its [official help/tutorials](https://help.suno.com/), and [Udio](https://www.udio.com/) with its [official help](https://help.udio.com/). These are service and learning links, not promises of an available public API or a particular free tier. If the user prioritizes low cost, offer existing authorized music, spoken narration or a TTS rhythm placeholder as appropriate; clearly label a spoken draft and do not present it as a lower-quality version of actual sung music. Avoid configuring or downloading a local singing model for a task that only needs dialogue.

## Make the music

1. Preserve story beats; design genre, voice roles, emotional progression, hook and sections. Write performable lyrics with rhyme, stress, silence and varying density. Avoid a universal characters-per-bar formula.
2. Inspect `local.audio.neural-song` and use UTF-8 lyrics, style and the desired length. Use `score_file` only with an actual compatible ABC score. Save seed, parameters, revision and input identity. A score guides structure; it does not guarantee identical bilingual timing or singers.
3. Test a representative hook/transition before expanding an uncertain direction. Choose a suitable sample length rather than a fixed 9/30-second requirement. Preserve accepted audio and change only remaining parts unless revision is requested.
4. Review actual singing: core lines, pronunciation, omissions, emotion, vocal balance and transitions. ASR flags possible mismatches but is not ground truth. A decodable WAV proves execution, not performance quality. Read [vocal production](references/vocal-production.md).
5. Deliver original WAV, a listening file and lyrics/section times. Keep gain and mixes separable. Attenuating accompaniment should not also fade vocals. Mixed outputs do not imply perfect source stems.

For bilingual versions, translate meaning and rewrite stress for the phrase; audition both independently. For an MV, build the beat/lyric timeline from the chosen audio and read [performance and compositing](../codex-yinzi-universal-video/references/music-mv-story-and-compositing.md).

## Recover without deadlocks

Keep failed logs and outputs. Import failure, GPU exhaustion, invalid audio and artistic rejection have different remedies. Correct the cause and create a new local attempt. Cloud status queries are read-only; an explicit retry within existing scope/budget creates a fresh attempt while retaining the old task and unknown charge. A failed download normally resumes the existing asset. Uncertainty or a stale status must not create a permanent retry ban.
