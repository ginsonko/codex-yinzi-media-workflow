# Lyrics, singing and evidence

## Observed success and limits

A WanGP YuE2 INT8 prototype produced a 32.24-second stereo 48 kHz short song, then a 97.96-second section, on an 8 GB NVIDIA GPU with CPU offload and tiled VAE. They took about 345 and 879 seconds respectively. The user accepted the singing direction and later the edited Chinese audio. Production subsequently delivered Chinese and English MVs of 191.958333 seconds each and a 375.416667-second continuous bilingual release. These are completed local files with technical and recorded visual checks, not evidence of guaranteed latency, exact singing of every word, physical testing on a 4.5 GB card or final audience approval.

The release reused the chosen language masters. Signal alignment checks confirmed preservation; they did not establish a new word-by-word listening review. Retain any unresolved lyric/listening notes even when the final encode passes.

PyTorch maximum reserved allocation was about 3.26 GiB for the short run and 4.21 GiB for the longer run. These process measurements exclude some board usage. Drivers and other applications need additional room. Inspect current free resources.

## Failures that change the next decision

| Symptom | Useful correction |
| --- | --- |
| Good music but drifting lyrics | Use a lyrics-conditioned singing model; compare the audible phrase with the intended text, shorten overloaded phrases, isolate the problematic section and audition actual words. Preserve accepted sections. More style adjectives do not make an instrumental model sing exact text. |
| Accurate TTS with no singing feel | Keep it for narration or deliberate meme remix. Pitch, rate and emotion parameters add spoken expression but cannot guarantee a coherent melody. |
| The ending becomes inaudible after the backing fades | Check whether automation affected the entire mix. Automate accompaniment separately if stems exist; avoid hiding the voice. |
| All roles sound identical | Assign timbre/roles before synthesis. Subtle artificial processing can distinguish an AI character; do not sacrifice lyric clarity. Decide who leads, answers, doubles or harmonizes for each phrase. Duets and persistent identity still require audition. |
| Accurate words but an emotionally flat performance | Review the phrase's intention, stress, breath, register and escalation. Try a representative performance revision or a suitable singing route; increasing loudness, pitch or speaking speed alone does not create convincing grief or anger. Preserve a spoken remix separately when that becomes the desired creative result. |
| ASR differs but listeners understand | Check audio and lyrics together. Names, drawn-out vowels and overlapping vocals confuse transcription. Preserve an accepted performance unless the audible error matters. |
| NaN, silence or import failure | Inspect precision, quantization handlers, tokenizer assets and runtime versions. Separate numerical/environment failure from artistic quality; do not repair a project by replacing global Python libraries. |

## Lyrics and versions

Map each section to an emotional or story change. Repeat a hook with a new response or meaning; repetition alone does not make a song memorable. Leave breathing space. Rewrite crowded phrases instead of uniformly accelerating every word.

For another language, preserve meaning and stress, then rewrite naturally. Map the source phrase to the target meaning, stressed syllables, breath/pause and approximate phrase length. Prefer a singable adaptation to a crowded literal translation. Reusing ABC is useful structure, not proof of matched phonemes, timing, voice or backing. Keep source lyrics, score and receipts; compare phrase starts, endings and emotional turns in both recordings.

When pictures must stay identical, check that both performances fit the same story contacts before committing the picture edit. If timing differs, use section-aware edits or revise the affected performance within scope; do not globally speed up a master and call it equivalent. For a connected bilingual release, remove only redundant instrumental material where musically appropriate, preserve final syllables and tails, and review the actual transition. See [bilingual delivery](../../codex-yinzi-universal-video/references/authored-typography-and-bilingual-delivery.md).

## Acceptance

Decode the complete file and check channels, finite/non-silent samples and actual duration. Requested duration can be an estimate; assess musical completeness rather than inventing a 0.1-second tolerance. Check clipping and cut boundaries, then listen on normal playback devices.

Record listening evidence separately from automated signal checks: which language/phrases were auditioned, intelligibility and emotional findings, and any remaining uncertainty. Muted browser playback, waveform inspection or ASR cannot stand in for hearing the performance. If audio listening is unavailable, say what remains unassessed and provide a usable listening preview; do not invent a passed audition.

Sample-peak headroom (the prototype used at most 0.97) prevents new PCM integer clipping. It does not prove encoded true-peak compliance or repair earlier distortion. Measure the encoded deliverable when a loudness/true-peak target matters. Save original WAV and export gain.

Archive accepted audio by hash/version, permitting later requested revision. New outputs use new attempt identities; preserving a master is not a ban on authorized changes.
