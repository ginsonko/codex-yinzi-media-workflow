# MV production lessons and visible intermediate results

The new release extends the existing music and performance-MV Skills with full-film production lessons. The public example is [an original bilingual music video](https://workflow.yinziapi.top/learn/music-video/), 6 minutes 15 seconds, with Chinese and English sections. The homepage now contains twelve showcase videos; the previous eleven, teaching pages, live-action example and 301-module catalog remain available.

## What changes after updating

- The music Skill preserves the distinction between actual singing, narration and deliberately spoken remix, with lyric/emotion review and bilingual phrasing.
- The MV guide uses the accepted sample as the quality floor for the entire film. It records motivated actions and beat contacts, continuity and repetition review, local matte repair, authored lettering and bilingual release checks. These are adaptable production methods, not a mandate to copy this video's character or style.
- `begin_media_task` and `report_activity` accept `work_dir`. The task page displays that directory, supports copying it, and can ask the local operating system to open it. Remote viewers retain the copy option.
- `report_activity` can atomically register up to twenty completed intermediate files with the real progress update. A preview does not mark the whole task finished or imply content approval. The same event key reuses the original report.
- Local files receive stable preview URLs, including byte-range video playback. Moved or changed files are reported instead of silently showing a different version. Keep versioned files and register revisions under new IDs.
- Current task reads no longer wait serially for the sidebar and runtime identity reads. Existing polling, hidden-page backoff, reconnect behavior and terminal-state refresh remain. Older responses cannot overwrite a newer task snapshot.

## Producer contract

Register the real task directory when starting. After a file is fully written and usable, report it before telling the user it is ready. This works for local/AE outputs created outside the built-in executor as well as downloaded material. It does not watch arbitrary folders or infer readiness from a partially written file.

```json
{
  "session_id": "returned-session-id",
  "event_idempotency_key": "preview-cut-v1",
  "stage": "preview",
  "message": "第一版已落盘，可先看；正在检查抠像边缘",
  "next_action": "修复有问题的镜头，保留已认可音轨",
  "work_dir": "/absolute/project/output",
  "artifacts": [{
    "artifact_id": "cut-v1",
    "type": "video",
    "title": "第一版剪辑",
    "path": "/absolute/project/output/cut-v1.mp4",
    "status": "review_required"
  }]
}
```

Windows paths also work. The runtime and files must be on the same host. Local-file publication, preview and directory opening accept only requests from the workflow host and local browser origins; an unrelated website cannot borrow the new file routes. Remote viewers can copy paths; existing published storage URLs retain their previous behavior. An older runtime may accept the text but lack artifact publication; read the returned artifact URLs and upgrade the runtime when they are absent. For a standalone artifact POST, set `publish_local: true` to validate and expose its `path`.

## Update

Ask the Agent to update the existing installation from official `main`, preserve configuration, assets and task history, and run the installer for the current operating system. Windows: `install.ps1`; macOS/Linux: `install.sh`. Active work should retain its instance and files, with activation when that instance is idle. Code publication does not automatically replace an already running installation.

The product adds no mandatory cloud generation and no additional account setup. Local models, providers and optional professional software retain their own costs, hardware requirements and licenses. Project personal noncommercial use is free; source availability does not override model or asset rights.

## Validation boundary

The changed orchestration/file routes passed 35 focused backend checks; frontend tests passed 171 checks, the frontend production build passed, and MCP/Skill checks passed 47 tests. A real isolated browser session displayed a newly registered playable intermediate artifact after approximately 849 ms, retained additions after task completion, and displayed the project directory at desktop and phone widths.

The broader backend run was not fully green: an existing video-compositing test with nonzero source timestamps stalled and was terminated after its process timeout. The unchanged test also stalled in a separate clean checkout at the previous `6fbf9f9` baseline under a bounded diagnostic run. This release does not modify that compositor or claim to resolve the pre-existing condition. The runtime/FFmpeg-dependent full-suite result remains a known validation limit; focused progress and file-preview checks are separate evidence.
