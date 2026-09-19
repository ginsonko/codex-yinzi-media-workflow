# Lyrics, singing and evidence

## Observed success and limits

A WanGP YuE2 INT8 prototype produced a 32.24-second stereo 48 kHz short song, then a 97.96-second section, on an 8 GB NVIDIA GPU with CPU offload and tiled VAE. They took about 345 and 879 seconds respectively. The user accepted the singing direction and later a 191.96-second edited Chinese track. This demonstrates that route on that hardware, not guaranteed latency, exact singing of every word, an accepted English version or physical testing on a 4.5 GB card.

PyTorch maximum reserved allocation was about 3.26 GiB for the short run and 4.21 GiB for the longer run. These process measurements exclude some board usage. Drivers and other applications need additional room. Inspect current free resources.

## Failures that change the next decision

| Symptom | Useful correction |
| --- | --- |
| Good music but drifting lyrics | Use a lyrics-conditioned singing model; shorten overloaded phrases, isolate the problematic section and audition actual words. More style adjectives do not make an instrumental model sing exact text. |
| Accurate TTS with no singing feel | Keep it for narration or deliberate meme remix. Pitch, rate and emotion parameters add spoken expression but cannot guarantee a coherent melody. |
| The ending becomes inaudible after the backing fades | Check whether automation affected the entire mix. Automate accompaniment separately if stems exist; avoid hiding the voice. |
| All roles sound identical | Assign timbre/roles before synthesis. Subtle artificial processing can distinguish an AI character; do not sacrifice lyric clarity. Duets and persistent identity still require audition. |
| ASR differs but listeners understand | Check audio and lyrics together. Names, drawn-out vowels and overlapping vocals confuse transcription. Preserve an accepted performance unless the audible error matters. |
| NaN, silence or import failure | Inspect precision, quantization handlers, tokenizer assets and runtime versions. Separate numerical/environment failure from artistic quality; do not repair a project by replacing global Python libraries. |

## Lyrics and versions

Map each section to an emotional or story change. Repeat a hook with a new response or meaning; repetition alone does not make a song memorable. Leave breathing space. Rewrite crowded phrases instead of uniformly accelerating every word.

For another language, preserve meaning and stress, then rewrite naturally. Reusing ABC is useful structure, not proof of matched phonemes, timing, voice or backing. Keep source lyrics, score and receipts; compare phrase starts, endings and emotional turns.

## Acceptance

Decode the complete file and check channels, finite/non-silent samples and actual duration. Requested duration can be an estimate; assess musical completeness rather than inventing a 0.1-second tolerance. Check clipping and cut boundaries, then listen on normal playback devices.

Sample-peak headroom (the prototype used at most 0.97) prevents new PCM integer clipping. It does not prove encoded true-peak compliance or repair earlier distortion. Measure the encoded deliverable when a loudness/true-peak target matters. Save original WAV and export gain.

Archive accepted audio by hash/version, permitting later requested revision. New outputs use new attempt identities; preserving a master is not a ban on authorized changes.
