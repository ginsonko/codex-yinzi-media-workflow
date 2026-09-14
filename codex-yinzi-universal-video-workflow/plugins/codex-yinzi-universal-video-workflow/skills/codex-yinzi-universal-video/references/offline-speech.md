# Offline narration with installed system voices

Use `local.audio.synthesize-speech` for local tutorial narration, accessible readings, temporary dialogue or a first narration cut. The Windows executor uses installed `System.Speech` voices and FFmpeg; it sends no text or audio to a cloud service. Choose a voice based on the actual output and the user's delivery target. Dramatic acting and natural voice quality require listening and may call for another configured route.

Write the approved narration into a UTF-8 text file and give its path as `input_path` to the existing local media job tool. Set `language` from the text, such as `zh-CN` or `en-US`, or set the exact installed `voice` name when known. Empty voice and language use the system default. An unavailable explicitly selected voice produces an error listing the available voices; preserve that preference and explain a suitable available alternative.

Parameters: `rate` −10..10 (default 0), `volume` 0..100 (100), `sample_rate` 8000..96000 (48000), `max_characters` 1..200000 (12000). These are system synthesis controls; rate is not a percentage. The executor reads plain text, so markup is spoken as text. It creates a mono PCM WAV, a copy of the narration and JSON recording the selected voice, language, duration and parameters. Outputs register in the same task's artifact gallery.

Example job body:

```json
{
  "session_id": "the existing task id",
  "request_key": "task:narration:approved-version-1",
  "module_id": "local.audio.synthesize-speech",
  "input_path": "absolute path to approved narration.txt",
  "parameters": {"language":"zh-CN","rate":0,"sample_rate":48000}
}
```

After rendering, compare the actual duration with the shot plan. If the read is too long, revise phrasing or pauses according to the user's intent and create a new version; do not assume the planned duration was produced. Keep original text and audio versions. Review pronunciation, proper names and audible performance before final delivery. A local ASR transcript can reveal missing words; it cannot establish pleasant narration or emotional acting. Output quality remains `review_required` until reviewed.

Pass an accepted audio file to the existing timeline editor for picture and music assembly. Keep subtitle timing relative to the edited video timeline, accounting for the audio start offset.

## Local speech recognition and subtitles

Use `local.audio.transcribe` on an authorized audio or video file for tutorial captions, interview transcripts, livestream selection or dialogue notes. The ordinary local queue prepares `media.whisper` and FFmpeg, then runs whisper.cpp on the CPU. First installation downloads the pinned program and multilingual models; later transcription stays local and reuses that installation. A failed release download can use the same official GitHub asset API, still checked against the identical SHA-256. Runtime DLLs and model files are included in repair checks.

Choose `model: base` for the initial transcript; `tiny` is a faster option to compare on limited hardware. The small model made substantially more mistakes in the tested Chinese sentence. Set the known language (`zh`, `en`, `ja`, etc.) or `auto` to detect it. `translate: true` asks Whisper to translate into English; the default is false. Chinese may be returned in traditional characters: retain the actual transcript, then adapt script style if the user requests it. The model list and tested sentence do not guarantee recognition accuracy for new speakers or noise.

The main JSON contains text and timed segments; TXT, SRT and WebVTT are registered with it. Times use the video stream's origin when video exists, including any relative audio delay, or the audio origin for audio-only input. `timeline_offset_seconds` adds an explicit placement offset. Captions wholly before zero are omitted; captions crossing zero are clipped at zero. Malformed, overlapping or reversed model timestamps fail visibly and preserve raw output for repair.

`silence_threshold_db` defaults to −50 dB peak. Set it lower, or use null to disable filtering, when quiet speech is intentional. Silent input produces an empty transcript and valid empty subtitle files. `max_duration` defaults to 7200 seconds; longer sources can be split with source offsets retained. `threads` defaults to a bounded local CPU choice and can be set from 1 to 32. This operation selects the first audio track; extract another track first when needed.

Review names, numbers, homophones, timing and meaningful pauses against the source. Correct the text and render representative captioned footage before accepting a final movie. Quality stays `review_required`; a successful transcription is ready for content review and continued editing.

This executor has Windows coverage. If the system lacks a requested language voice or System.Speech, retain the task and use another available local engine or previously accepted recording. macOS/Linux offline voice adapters and neural voice model packages require their own installation and real output checks.