# Module contracts and planning

Availability describes the current executor, not whether the work is permitted:

- `integrated`: the orchestration API itself performs and persists the operation.
- `bridge`: Codex or an existing local workflow performs the real work and records its receipt.
- `advisory`: the module produces a diagnosis, proposal, or sandbox receipt; it is not proof of applied production behavior.
- `unknown`: no local contract is registered. Keep the node visible and actionable with an explicit executor and acceptance test.

V1 covers durable sessions, asset analysis, dynamic plans, retries, checkpoints, readback, and manual takeover. V2 covers research, product facts, creative directions, shot grids, copy, and claim traceability. V3 covers imported media, generation, editing, timelines, subtitles, audio, and export. V4 covers diagnosis, adapter/patch proposals, sandbox tests, module registration, skill export, and replay.

Do not create a ceremonial node for every catalog entry. A good plan contains only steps that change or verify the outcome. Examples:

- A user supplies finished clips and asks for a montage: scan, classify, timeline, audio/subtitle if needed, QA, export. Do not generate character sheets or storyboards.
- A product folder has only white-background photos and no creative direction: fact extraction, bounded trend research, creative directions, shot plan, missing-media generation, timeline, claim QA, export.
- A novel-to-animation task benefits from script, recurring character/scene authority, shot planning, generated media, continuity QA, and assembly.
- A single portrait asked to move may need subject-authority binding, a compact motion plan, one image/video request, and identity/technical QA. Do not replace the portrait with a new unrelated character.

Every generated-media node must name all references that will actually be sent, their roles, the prompt construction basis, model/config revision, duration/aspect constraints, and prohibited drift. Every editing node must preserve source clip provenance and non-destructive parameters.

When new evidence invalidates the plan, submit a new plan revision. Keep already valid outputs and running nodes; do not reset the entire project by default.
