---
name: yinzi-jianying
description: Prepare editable Jianying Pro drafts, subtitles, preset references and reusable local templates as an optional Yinzi editing route. Use when the user chooses Jianying or its preset workflow fits a short video. Inspect the installed environment and distinguish draft creation from editor rendering.
---

# Optional Jianying editing

Use the main media workflow Skill to register/recover the current task. The user
can choose Jianying, AE or automatic selection in the conversation; retain that
choice in the plan. No extra selection question is needed when already clear.
Jianying is useful for conventional short-video packaging and editable template
variants. AE remains appropriate for bespoke lyric interaction, complex masks,
camera/layer relationships and exact motion design. Use FFmpeg for simple batch
cuts/encoding. Installing Jianying alone does not establish automation support.

Read [execution and recovery](references/execution.md) for setup and the actual
job contract. Inspect first with `local.jianying.inspect`. Create the independent
project with `local.jianying.draft`. Both return JSON documents, not movies. Use
the normal `local_media_run` job path when the current runtime exposes them;
otherwise the documented source CLI can prepare the same draft. Do not restart
another running media task merely to discover the new operations.

Once this route is selected, handle the isolated dependency setup for the user
under the existing editing authorization. Draft generation normally prepares
an independent copy in the editor's detected draft directory (`prepare_editor:
true`); show its exact project name and directory immediately. Keep the original
generated project as a recoverable master. Existing editor copies can change
after opening and must not be overwritten on retry. If placement is unavailable,
preserve the usable master and resolve the location through inspection/config.

For an unclear aesthetic, offer two or three suitable template/style directions
using a real preview and explain what each changes. Reuse the main Skill's
guided/AI-led requirement mode; do not reopen settled choices. Without a usable
reference, design a representative short passage before scaling up. A mature
template is a starting point, not a reason to ignore the story, soundtrack or
user's quality standard. Read [templates and acceptance](references/templates.md).

Report the actual stages separately: environment inspected, draft prepared,
opened in editor, resources verified, exported, technical checks, visual/audio
review. `draft_ready` means editable engineering output only. Keep the directory
and next action visible immediately. If the editor bridge fails, preserve the
draft and give the smallest concrete continuation step; continue independent
work. Never manufacture a Jianying preview by rendering similar FFmpeg effects.

No automatic purchases, cloud upload, global draft migration or forced version
downgrade. Follow the user's existing authorizations. Resource eligibility and
rights are distinct from the Apache-2.0 license of the draft-writing library.
Do not treat an internal host-restricted CLI as a public rendering API.

Tested boundaries and specific failure lessons are in
[templates and acceptance](references/templates.md). Keep new findings scoped to
the actual application version, resource, account conditions and real output.
