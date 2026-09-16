# Visible plans, approval and successful method reuse

## Choose the interaction from the user's intent

Always show a plan in the conversation before production steps. Startup, local discovery and minimal input inspection may happen first. Do not ask the user to move to the workbench to read or approve it.

| Situation | Plan detail | Continue after showing it? |
| --- | --- | --- |
| User chose the method, tools or a sufficiently complete procedure | Short table covering that route and its result | Yes, within that instruction |
| New goal with the method left to the agent; ordinary mode | Detailed tool table, explanation and useful alternatives | Wait for plan approval |
| New goal with unattended mode enabled | The same detailed plan and fallback sequence | Yes; state that unattended mode is active |
| Same kind of successfully delivered work, with no later objection | Reused route, why it still applies and input changes | Yes, unless the user asks to approve first |
| User asks for a proposal, preview, stop or approval before action | Plan at the requested level | Respect that instruction even in unattended mode |

"Make an impressive MAD" leaves substantial method decisions open. "Use FFmpeg to keep the soundtrack and trim 00:10 to 00:20" chooses a route. Specificity about a result is not approval of an unchosen method. A routine single operation can have one table row. Avoid unnecessary research, benchmarks, storyboards and model calls. Efficiency means fewer unnecessary steps, not lowering the requested result quality.

## Discover the whole registry without a large request

For an open-ended request, read the complete compact index, including uninstalled registered tools. From the Skill directory:

```text
node scripts/orchestration-cli.mjs module-index --limit 60 --offset 0
node scripts/orchestration-cli.mjs module-index --limit 60 --offset NEXT_OFFSET
node scripts/orchestration-cli.mjs module MODULE_ID
node scripts/orchestration-cli.mjs experiences --query "short task phrase" --limit 10
node scripts/orchestration-cli.mjs experience EXPERIENCE_ID
```

Follow `next_offset` until null. Keep the catalog fingerprint and selected IDs in the local plan. If the fingerprint changes between pages, refresh the compact index before claiming complete coverage. Read full contracts only for plausible primary and fallback tools, and the component profile for their prerequisites. Reuse an already complete index with the same fingerprint. User-selected routes need only their relevant contracts.

The index includes registered modules regardless of installation and enabled state. `availability` is a contract's integration state, not proof of installation or quality. Mark missing components as prepared on demand. Mark disabled or unimplemented choices as unavailable unless the current scope covers enabling or integrating them; do not silently enable a disabled tool. Research candidates and transition presets are not additional executable modules. An external tool may be a justified extension, but label it as such instead of claiming it is registered.

If the compact command is unavailable, project the existing module-list response locally to IDs, names, summaries and availability before returning tool output. Report incomplete discovery rather than fabricating a catalog. Never print all schemas, historical events, credentials or media blobs to establish coverage.

## Explain the route so a beginner can judge it

Start with the intended result and main approach in plain language. Give a readable Markdown table in the user's language:

| Step | Workflow tool | What it does for this task | Result |
| --- | --- | --- | --- |
| 1 | Actual registered tool name (`module_id`) | Concrete operation and why it matters | Inspectable intermediate result |
| 2 | Actual next tool (`module_id`) | How it consumes the previous result | Next intermediate or final file |

Replace every example cell with current tools and facts. Combine related operations when that improves readability. Keep the table visible in fast, unattended and reused routes as well as first-time planning.

For agent-designed creative work, follow the table with enough connected explanation to answer:

- How the selected steps produce the requested effect, and why their dependency order matters.
- Why the route fits the requested quality, turnaround, hardware, budget and local/cloud preferences; cite a past method when it actually informed the decision.
- What will be delivered and how it will be checked, which components need installation and whether a step has a real model cost. Distinguish measured timings from estimates and unknowns.
- Which input assumptions affect the result. Ask only for missing information that cannot reasonably be inferred and is necessary to proceed.

For substantial creative tasks, several explanatory paragraphs are appropriate; do not reduce the plan to opaque IDs or a slogan. Do not add filler to reach a word count. A specified simple operation needs only a short table and a sentence.

Give as many useful fallback routes as the real catalog and constraints support:

| Fallback | When it would be used | Tool or method | Tradeoff |
| --- | --- | --- | --- |
| Actual alternative | Observable failure or quality limitation | Candidate verified in the registry | Time, cost or quality difference |

There is no mandatory number of alternatives. Explain a first useful preview when it reduces wasted work, and continue to the full result under the same approval. Close with the real execution status: awaiting approval, following the user's chosen route, unattended execution, continuing an approved revision, or reusing a successful route. Ask one plain-language approval question only for an ordinary new plan.

## Persist and resume using existing contracts

Save the visible plan in the existing orchestration `plan` object, for example:

```json
{
  "plan": {
    "summary": "A concrete description in the user's language",
    "presentation_markdown": "The same visible table and explanation",
    "planning_context": {
      "route_origin": "agent_designed",
      "approval_basis": "awaiting_user",
      "catalog_fingerprint": "actual index fingerprint",
      "experience_refs": [],
      "fallbacks": []
    }
  },
  "confirm": false
}
```

This is metadata in the existing flexible plan, not a new API schema or user form. Supply actual nodes and current `expected_revision` through `submit_plan` / CLI `plan`. Fallbacks can record module IDs, trigger observations, tradeoffs and attempt result references. Keep individual steps in existing node `decision` fields.

- Ordinary new proposal: send `confirm:false`, report `needs_user:true` and wait. On approval, confirm that revision through the existing operation, then start it. One approval covers the primary route and its described authorized fallbacks.
- User-selected, previously approved or reused successful method: record that basis and send `confirm:true` under the current instruction. A stored recipe supports the decision; it does not authorize an action by itself.
- Unattended production: omit `confirm` to use the backend preference. Explicit approval-first or preview-only instructions always use `confirm:false` even in unattended mode.
- Report actual progress with stable activity/event keys. After compaction recover the existing plan, its approval, attempted alternatives and unfinished nodes. Reuse completed work and pending request IDs.

Recipe reuse is a Skill decision recorded in plan metadata, not an automatic backend classifier. On subsequent requests, inspect matching experience and later feedback as described in [media experiences](media-experiences.md). A successfully delivered result with no complaint makes that method the default without a satisfaction survey. Silence is not an invented quality review. Changed constraints, dissatisfaction or an obsolete tool may make it unsuitable and require a new proposal in ordinary mode.

## Try alternatives to a real stopping point

In unattended mode, show the plan and continue within the requested task and budget. After an observed failure or insufficient result, record the cause and try the next applicable untried alternative, preserving usable output. Reconcile unknown paid submissions before another route. Do not repeat the same failed configuration under a new label or increase the user's limits.

Stop when the requested result passes its appropriate review, the user stops work, necessary authorization/input is missing, the budget is exhausted, or all applicable authorized routes have been tried. Deliver useful partial outputs and a clear attempted-route summary if none succeeded. Do not stop after the first ordinary recoverable failure or promise to exhaust infinitely many hypothetical tools.
