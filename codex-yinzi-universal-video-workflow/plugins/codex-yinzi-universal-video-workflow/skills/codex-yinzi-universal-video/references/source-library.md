# Find, download and index source material

Use this route for a folder of travel footage, a large livestream collection,
MAD/MV source gathering, or product assets that need an inventory. For one
known file and a clear edit, use that file directly.

`local.media.download` and `local.media.index` are local executors. Discover
their current contracts in the module catalog. Downloads prepare FFmpeg and
Sharp through the normal component manager; a webpage that needs extraction
prepares `tool.yt-dlp` on demand. Registered availability includes tools that
are not installed yet. Current packaged yt-dlp installer: Windows x64.

## Choose sources and explain the route

For an open goal, explain a short plan: identify suitable sources, download
selected media, index and deduplicate, inspect candidate shots, then edit.
Name the actual registered tools and what each contributes. The Agent uses
its available search/browser tools to find relevant pages; the downloader
does not itself search the web or decide whether a shot fits the story.
Read relevant past experiences. Follow the user's chosen method, unattended
setting and existing approvals from the main Skill.

If a dedicated search tool is unavailable, use reachable public source pages
or the source's documented search API through the available browser/HTTP
client. Save the actual query, result and selected page. Missing `yt-dlp` on
PATH is not proof that downloading is unavailable: direct media URLs work
without it, and the registered downloader prepares the extractor when needed.
Keep access failures specific to the attempted source and transport.

Prefer source pages with usable originals, useful descriptions and known
usage terms. Keep URL, title, author and a license clue with each item. A
license clue records evidence for the Agent to assess; it is not an automatic
permission decision. Keep engineering fixtures out of an original showcase.
Publicly accessible material and promotional clearance are separate facts;
source credits, third-party content, identifiable people and logos can carry
different conditions. Preserve these findings with the asset instead of
labeling an entire publisher's catalog commercially cleared.

## Download a selected list

Write a UTF-8 JSON source manifest as `input_path`:

```json
{"items":[{"id":"clip-01","url":"https://example.org/clip.mp4",
"title":"Selected source","author":"Source author",
"license_clue":"Terms and source page checked for this task"}]}
```

Submit it with `local_media_run`, the existing `session_id`, a stable
`request_key`, `module_id: "local.media.download"`, and appropriate limits:

```json
{"max_items":10,"max_bytes_per_file":524288000,"max_total_bytes":2147483648,
"max_duration_seconds":1800,"timeout_ms":90000,"allowed_formats":["video","audio","image"]}
```

Default `prefer_direct: true` tries the file URL first. Actual HTML pages can
use the optional extractor; `prefer_direct: false` selects extraction directly
when the source is known to require it. Do not use extraction as a workaround
for corrupt media, a provider JSON error, hash mismatch, or an exceeded limit.
Supported content groups and explicit formats are checked against real bytes.

The job's result JSON preserves each item's outcome and provenance; successful
media becomes normal gallery attachments. Read individual failures for a mixed
batch and continue with the useful files. All-failed batches fail the job and
keep their result JSON and original error. Component installation failures keep
the original direct-download cause. HTTPS verification remains enabled.

Resume the same failed job for a transport interruption. Direct HTTP resumes
only with compatible validators; a changed ETag or Last-Modified restarts the
file instead of joining two versions. Orphan files and unvalidated caches are
not treated as successes. An optional `expected_sha256` on an item binds a
known exact source. yt-dlp's own partial output is not proof of completed media.

## Index authorized folders

Write a second input JSON:

```json
{"roots":["/absolute/path/to/authorized/material"]}
```

Use `local.media.index` with `max_files`, `max_depth`, and optional
`include_kinds` (`video`, `audio`, `image`, `document`). Defaults compute hashes
and technical metadata. To refresh, pass the previous result JSON as
`cache_path` under a new request key. Cache reuse checks size and exact mtime
and ctime, and whether the previous result fulfills the requested hash/probe
options. A nonexistent root fails visibly. Limits and truncation are reported.

Duplicate entries refer to canonical content without deleting originals.
`follow_symlinks` defaults to false; when enabled, targets must remain inside
the listed authorized roots. Group by duration, orientation, resolution and
duplicates, then examine representative images or `local.video.analyze-shots`
results. For music edits, combine the selected shots with
`local.audio.analyze-beats` and check rhythm by listening. Technical metadata
does not establish semantic relevance or a compelling highlight.

Download validation reads the container and decodes the first two seconds of
audio/video; images receive a real decode sample. Indexing extracts technical
metadata and flags observed corruption. These checks do not establish that an
entire long film is free from damaged frames. Fully decode and visually review
the clips actually selected for the final edit; check sound timing and content.

## Dialogue-led comedy and remix

First inspect what the source actually says and shows. Select a clear setup,
escalation and payoff before choosing music. Source syllables, breaths, impacts
or newly made sounds may form the rhythm; use generated images only to fill a
specific visual gap. Preserve the source context and distinguish comedic
captions from a translation of the speaker's words.

Record source in/out points and output timing for every reused phrase. A
planned pause must produce real silence or a deliberately held shot in the
rendered timeline. Derive subtitles from that same timeline, then check the
encoded output: concatenation, speed changes and frame rounding can change
timing. Repetition needs development or a reveal, not only a repeated clip.
Technical checks do not establish humor, dialogue clarity or musical quality;
state the actual viewing/listening coverage and refine against the result.
