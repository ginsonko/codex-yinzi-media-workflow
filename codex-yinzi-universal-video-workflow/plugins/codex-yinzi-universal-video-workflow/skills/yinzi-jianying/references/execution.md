# Execution and recovery

Locate the current repository/runtime root through the main Skill. Paths below
are relative to that root. Never use a developer's drive letters in user jobs.

## Setup

`python backend-node/scripts/setup-jianying.py --help` shows the supported
installer options. `--inspect` is read-only. Prepare the optional isolated
environment only when this editing route has been selected:

```text
python backend-node/scripts/setup-jianying.py --prepare --root <user-chosen-runtime-directory>
```

The host performs this setup; users should not have to paste Python commands.
Omitting `--root` uses the isolated per-user default. An optional `--drafts-root`
stores an existing editor draft directory when automatic discovery is unavailable.

The adapter pins `pyJianYingDraft==0.3.0`; do not install it into global Python.
Configuration defaults to `~/.yinzi-media/jianying.json`, overridable with
`YINZI_JIANYING_CONFIG`. Preserve other settings. An existing isolated interpreter
can be validated with the installer's `--adopt` option. The optional `executable`
configuration points to the user's editor. An environment receipt proves the
library imports; it does not prove GUI export, cached effects or membership.

## Jobs

Use `local_media_run` with the current `session_id`, stable `request_key`,
`module_id: local.jianying.inspect` and an input JSON file containing `{}` for
environment inspection. The draft operation is `local.jianying.draft`; its
`input_path` is a UTF-8 job JSON. Relative media, SRT and template paths resolve
against that job file. Public times are **numeric seconds**.

```json
{
  "name": "Short product story",
  "width": 1280, "height": 720, "fps": 30,
  "clips": [{
    "path": "assets/product.mp4", "kind": "video", "track": "footage",
    "start": 0, "source_start": 0, "duration": 3,
    "filters": [{"name": "冷蓝", "intensity": 25}],
    "keyframes": [{"property": "uniform_scale", "time": 0, "value": 1},
                  {"property": "uniform_scale", "time": 3, "value": 1.04}]
  }],
  "texts": [{
    "text": "A small everyday upgrade", "track": "titles",
    "start": 0.2, "duration": 2.6,
    "style": {"size": 9, "bold": true, "color": [1, 0.85, 0.35], "align": 1},
    "border": {"width": 20}, "transform": {"transform_y": 0.66},
    "animation": {"kind": "intro", "name": "弹入", "duration": 0.25}
  }],
  "subtitles": [{"path": "captions.srt", "track": "captions"}]
}
```

These preset names were tested as draft references, not accepted current-version
rendered effects. Use actual enums/resources and report unknown names clearly;
never silently remove a requested effect. Set clip `kind` explicitly for audio
and images. Use distinct tracks for intentional overlaps.

The current adapter writes linear keyframes. Do not promise arbitrary AE-style
Bezier easing; use an actual supported editor animation or the AE route where
those motion curves are essential.

Find supported names with `local.jianying.inspect` parameters
`{"preset_type":"filter","query":"冷","limit":10}`. The same lookup is
available through `node backend-node/src/services/jianyingDraft.js catalog filter 冷 10`.
Types include `filter`, `transition`, `text_intro`, `text_outro`, `text_loop`,
`font` and `clip_intro`. Results are package reference names; `library_vip_hint`
is not current account entitlement or a guarantee of free commercial use.

For a **local readable template** use `template.path` (draft directory or
`draft_content.json`), `text_replacements` with `track`, zero-based `index`,
`text`, and `media_replacements` with original `name`, replacement `path` and
`kind`. Verify source durations and the output geometry when replacing media.
Unknown/encrypted templates need an exported readable copy or a different
authorized route; do not rewrite the source in place.

Direct source CLI, useful before activating a new runtime:

```text
node backend-node/src/services/jianyingDraft.js inspect
node backend-node/src/services/jianyingDraft.js run <job.json> <new-output/result.json>
```

The draft operation's `parameters.prepare_editor` defaults to `true`. It reads
the configured `drafts_root`, or the current Windows editor setting, and prepares
a separate editor copy. It never edits the home index. The raw CLI behaves the
same; append `--draft-only` to keep only the generated master. Missing/unwritable
editor locations retain the master and report `manual_location_needed` rather
than discarding successful work. Configure/fix that location and resume the same
receipt; do not regenerate media.

`editor_delivery.draft_path` and `.project_name` identify the copy to open.
`draft_path` still identifies the immutable generated master. Repeated delivery
preserves changes saved in the editor copy, including non-JSON saved files.
`editor_copy_prepared` means placed in the configured directory; it does not prove
home discovery, app loading or export.

The result identifies the independent `draft_path`, dependencies and unresolved
editor stages. Reusing a request must verify job/source identity and output
integrity. An input change requires a fresh run; do not silently return the old
draft. Preserve originals and failed receipts.

## Opening a generated project

The editing screen's **Media / Import** dialog filters for video, image and audio
files. It does not open `draft_content.json`; an apparently empty directory in
that dialog is not a missing-project error. Do not send users there or tell them
to switch the file filter to force a JSON import.

The adapter discovers the editor's current draft-save directory. On the tested Windows
11.5 installation, `User Data/Config/globalSetting` is an INI file and its
`currentCustomDraftPath` may differ from the default Projects directory. Read
this setting with an INI-aware parser; do not assume it is JSON or hardcode a
developer's drive. Copy the complete independent generated project into a new,
nonconflicting child directory there when it is not already installed. The registered
draft operation now performs that copy by default. Preserve
existing projects and media. Prefer doing this step for the user within the
authorized editing task, instead of asking the user to copy JSON files.

Read the current `User Data/Projects/com.lveditor.draft/root_meta_info.json`
index to check whether the editor has discovered that exact path. Do not modify
the index. On this tested host, Jianying discovered the three copied directories
and rewrote their metadata IDs itself. Do not treat old generated IDs as proof
of current home-list identity; retain both receipts with provenance.

Open the named project **from the home draft list**, then export to a separate
new file. Home-index discovery proves discoverability only, not loaded media,
effective presets or a rendered movie. If it is not yet listed, return to the
home page and check again; avoid overwriting data or repeatedly regenerating.
Version-specific behavior must be tested on the actual machine.

Use supported desktop controls when they can reliably identify the project and
export UI. On the tested Windows 10 / Jianying 11.5 host, screenshot capture
failed with `SetIsBorderRequired 0x80004002` and the home accessibility tree had
unnamed controls. Do not blind-click cards or claim unattended export works.
Give the exact home-list project name as the smallest manual continuation.
This capture failure does not prove Jianying inherently requires manual export
on every machine. The bundled community controller only advertises export for
Jianying 6 and below; do not downgrade users automatically.

## Interchange

Keep original media, SRT, audio stems, frame rate, aspect ratio and timecodes.
For difficult shots render an AE intermediate and replace that shot in the
timeline. AEP and Jianying projects are not losslessly interchangeable; AE
expressions, plugin state, cameras and masks cannot be assumed to transfer.
