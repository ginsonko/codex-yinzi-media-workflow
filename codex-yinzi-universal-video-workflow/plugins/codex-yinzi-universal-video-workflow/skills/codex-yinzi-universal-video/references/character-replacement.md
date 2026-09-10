# Existing-video character replacement

Use this reference for changing a face, full character, outfit or character style while retaining a supplied video's performance. Keep the requested scope explicit: face replacement, full-body replacement, anime restyling and small consistency repairs have different executors and quality requirements. Infer clear requirements from the existing conversation; ask only about a material missing choice.

## Select a route

| Target | Candidate route | Evidence needed |
| --- | --- | --- |
| Replace the full character while retaining performance and recognizable surroundings | Reference-driven video editing/generation, including the user's selected Seedance model when its actual adapter can send video and image references | Same-source sample preserves character identity, action timing, camera, scene and occlusions |
| Change only the face while retaining hair, outfit and body | Local face-swap executor such as FaceFusion | Identity, mouth/teeth, turns, occlusions, temporal stability and audio alignment; face swap does not replace the entire character |
| Full character or human-to-anime performance transfer locally | A supported Wan-Animate or comparable replacement executor with pose, face, background and mask conditioning | Actual device-compatible installation and complete conditioning/inference/quality evidence |
| Generated character and motion are good, with limited background drift | Composite the accepted subject over the original scene using tracked masks | Compatible camera and geometry, sound occlusion edges, no doubled limbs or missing background |
| Small exposure, compression or flicker defect with identity already correct | Existing local correction operations | The specified defect improves without damaging the rest of the clip |

For exact preservation outside the replaced subject, plan local scene preservation or a hybrid composition. Generation alone provides no pixel-preservation guarantee. A successful sample can support that sample's measured quality, not a universal guarantee. Incorrect motion or camera geometry cannot be repaired merely by pasting the original background behind it.

Choose from installed/registered executors and proven task results. A model name, package download or directory entry is not evidence that a production executor exists. When a registered local component is missing, use the existing `local_media_run` path so installation and execution continue in the same durable job. Reuse successful installations and cached source-derived assets. For a candidate without that executor, state the missing integration and use a supported route or a bounded authorized experiment; do not promise that downloading its weights completes the task.

## Bind the inputs

| Asset | Authority | Preparation |
| --- | --- | --- |
| Original video segment | Motion, timing, camera, scene, interactions and source audio | Retain source hash, start/end time, frame rate and shot boundaries. Preserve the complete original |
| Character reference | Face, hair, clothing and requested style | Reuse clear supplied views. When missing views matter, create a clean character sheet and identify inferred details |
| Same-scene placement image | Which character occupies each visible position, scale and occlusion | Edit a frame from this shot, keeping the original scene. Useful when multiple characters or an unrelated reference background create ambiguity |
| Optional mannequin/voxel proxy | Performance and distinguishable actor mapping | Use only if its motion, camera and timing have been checked against the original |
| Generated candidate | Proposed edited result | It becomes an accepted reference only after checking the relevant identity and continuity |

A character sheet is a visual asset, not necessarily 3D reconstruction, LoRA training or a new model installation. Generate only the views the shot needs; a clear supplied reference may already suffice. Keep unrelated scenery in a character portrait from becoming scene authority. Cache the accepted sheet with its source hash and revisions.

For multiple actors, map each source actor using visible position, clothing, entry/exit and time range to a specific target asset. A same-scene placement image makes the mapping visible when text is ambiguous. Do not rely only on left/right labels across turns or camera cuts. Split at suitable shot or entry/exit boundaries and carry accepted identity references across segments.

## Construct the request

For an existing-video recreation or replacement, derive a **source-grounded shot description** before composing the generation prompt. Read the actual video/keyframes and record each relevant source interval, visible action and expression changes, camera motion, scene/lettering/transition behavior, required edit, preserved elements, and corresponding frame IDs. This is often called reverse-prompting: it describes observed footage, not recovery of the creator's original prompt or diffusion inversion. Codex can perform the analysis directly from available media; a separate captioning service is optional and must not add an unnecessary installation or authentication step.

Select frames by the requested edit: include meaningful pose transitions, mouths/eyes, occlusions, camera changes and no-character intro/outro context. Resolve ambiguous advice such as "24/48 frames" into an actual interval or selected count for this source; neither is a universal sampling constant. Keep observed facts separate from inferred motion between sparse frames. Describe repeated action cycles separately when their timing, camera or captions differ.

After editing the frames, compile the prompt from the same interval/frame map. State positive visual action in each interval instead of relying only on repeated "unchanged" constraints. Check that every image reference, frame label, timestamp and gesture exists in the final selected materials. If an edit changes the intended gesture, correct or exclude that frame and update the prompt mapping; do not rewrite the source description to fit a bad output. Record any remaining geometry/identity limitations when a frame is usable only as guidance.

Assemble ordered storyboard sheets with Python/Pillow or an equivalent deterministic local compositor. Retain full-resolution single-frame masters. For a native-size sheet, paste frames without resizing into lossless PNG pages, put labels outside the image area, and save a manifest of frame IDs, source timestamps, input hashes, page/cell rectangles and output hashes. Read each cell back and compare decoded pixels to its input. Split pages according to actual provider size/reference limits; if resizing is needed, record the scale and keep the originals. Lossless local assembly does not establish that the provider retains those pixels internally, and a timestamp drawn on an image is not a hard temporal-control field.

For a keyframe/storyboard route, **replace the character in the frames first, then assemble the accepted edited frames into the storyboard**. A grid of unchanged source frames plus one identity portrait leaves the video model to invent the replacement throughout the action. Sample actual shot changes, gestures, expressions, occlusions and camera scale; avoid a fixed frame count or taking a transition flash as a representative pose. Save the source frame index and timestamp for every selected frame.

Use [the image batch queue](batch-images.md) for multiple keyframe edits. Make the source frame authoritative for composition and performance, and the character sheet authoritative for appearance. Explicitly resolve conflicts that matter: whether source glasses/clothing should remain, target paw-pad colors, placement of distinctive marks, eyelid openness and hand perspective. The target sheet's neutral standing pose must not replace the source action. Inspect each output, correct observed inconsistencies, then build ordered storyboard sheets with times outside the actual frame area. The sheets, original video and clear reference roles become the video request. Upload the real sheets, not just their filenames.

Keep source intro/transitions/audio available for local reuse. A still-image edit can preserve a gesture while changing the head scale or lettering; inspect those before relying on it. Edited storyboards improve visual conditioning but do not establish precise temporal preservation until a resulting video has been compared with the source.

When a frame already has the right gesture or expression, correct the observed defect locally. In a local image2.5 batch, applying the entire identity sheet again improved costume details but reopened closed eyes and turned a fist into a displayed palm. A later edit limited to removing a leftover tie and an unwanted hand marking retained the intended pose. Carry accepted frames forward and batch only the necessary corrections; do not redraw the whole sequence merely because a few frames failed.

A tested storyboard request sent five image references and the complete source video through the adapter. One attempt failed explicitly; the same recipe then generated a playable video, but it mostly animated the first edited still, missed the source's hand/eye changes, and froze background lettering. The presence of attachments in a submitted request does not establish that the upstream model used their temporal guidance. Treat this recipe as unverified for precise motion preservation. If this pattern occurs, inspect the provider's effective video-reference contract and test a representative changing gesture with an evidence-based change to reference roles or segmentation. More prompt text, more stills, or restored source audio alone is not a demonstrated remedy.

Use a concise prompt that assigns jobs to the actual attachments and describes observable requirements. The following is an adaptable structure, not a provider syntax or a tested universal prompt:

```text
Edit the supplied source video segment. Its scene, camera, action timing,
interactions and shot order define the result.

Replace [identified source actor, location and time range] with the character
in [attached identity reference]. Preserve that character's face, hair,
outfit and intended style. [Attached placement reference] defines the
character's position, scale and overlap in this source scene.

Keep [specific background/props and untouched people] consistent with the
source. Match [specific turn, gesture, contact or transition] at the source
times. Preserve foreground occlusion and contact with objects.

Produce [supported duration/aspect] under [the actual adapter's reference
roles]. [Retain source audio in the final edit when required.]
```

Resolve bracketed assets to real attachments and supported identifiers before submitting. Flova asset mentions, file names and textual references alone do not prove an API attachment exists. Inspect the current adapter's supported fields, media types and reference roles. Use `first_frame` only when that contract actually supports it; otherwise describe the attached placement image according to its real role. Do not invent a field or downgrade the user's selected model because a catalog is incomplete.

When refining a prompt, describe the requested edit directly and give each attachment one clear job. Prefer observable identity details and preservation instructions over repeated negative clauses, conflicting static poses or claims of guaranteed precision. For example, source video defines the performance and timeline, the identity sheet defines appearance, and one placement reference defines scale and position. Multiple views on an identity sheet describe the same actor. Changing vocabulary is an experiment; an unspecified provider failure does not identify a prohibited keyword or prove that a particular wording will succeed. Maintain the same visual acceptance criteria across prompt revisions.

Record model/config revision, final prompt, actual attachment order/type/role, local hashes, uploaded bytes or returned media identifiers, submitted duration and source time range. Keep secrets, base64 media and signed access URLs out of ordinary logs. Distinguish local upload success, provider acceptance, model behavior and final quality.

Choose a short representative segment using supported model durations, including a meaningful turn, gesture, occlusion or actor interaction when present. Do not silently stretch, loop or discard source action to fit a duration. If an endpoint requires a longer output, record that mismatch and the intended retained interval. A prompt asking for the source action in the first few seconds is an experimental request, not evidence of correct timing. Check the actual result before trimming or expanding to the whole video.

Submit through `generate_video_once`, preserve its stable request identity and reconcile the original request. Transport timeout or missing provider ID means acceptance may be unknown. Recover from the original receipt or permitted provider task history; do not run another paid generation to discover whether the first was accepted. Existing authorization continues to cover work within scope and budget without another per-stage confirmation.

## Handle provider failures and waiting

Separate submission, generation and visual outcomes before choosing the next action:

| Observed state | Action |
| --- | --- |
| Reference preparation or POST is still active | Report that phase and continue the existing task; an early absent provider ID is not a terminal failure |
| Provider ID received and queued/processing | Query that same task using bounded, backed-off polling; show actual elapsed time and the last observed state |
| Explicit terminal generation failure | Preserve the error and original task. Within existing authorization and the remaining request/cost budget, a new independent attempt may reuse the same recipe for an intermittent failure or revise a specific input when evidence supports it |
| Transport ended without a provider ID | Preserve acceptance as unknown and reconcile the original record. Never replay it automatically or infer a prompt defect from a timeout |
| Video generated but visual requirements failed | Save the candidate as failed quality, identify the concrete discrepancy, and revise the relevant reference, prompt or pipeline before another bounded attempt |

Do not require another confirmation for each already-authorized retry. Set the attempt and cost limits before submitting; every independent retry has a new request identity and a link to its predecessor. Count unknown outcomes conservatively against those limits. Stop serial submissions when repeated failures show the same unresolved transport problem. A user may explicitly authorize a separate experiment while an older request remains unknown; keep both identities and their cost uncertainty visible.

User reports on 2026-09-10 described roughly two-thirds success, 10-20 minute waits and refunds on failed Seedance 2.5 jobs. Supplied screenshots showed successful jobs taking about 597 and 1276 seconds. These are attributed observations, not a measured overall success rate or service guarantee. A local attempt subsequently received a provider task ID and an explicit failure message stating that credits were returned. Keep that provider statement separate from a verified billing refund; neither a claimed refund nor an incomplete catalog should become a lengthy prerequisite to an already-authorized bounded trial. Generation waiting time is separate from the HTTP submission timeout.

Four bounded local follow-up attempts on the same cartoon-character task used detailed and concise prompts, a complete source and a six-second excerpt, and either two or three image references. All received provider IDs and terminal failures stating that credits were returned; none produced a video. This does not establish a cause or a general success rate. The tested prompts remain unverified recipes, and repeated wording changes alone are not a demonstrated fix.

A separately user-authorized follow-up reduced only the prompt from 266 to 93 characters, retaining the same media and parameters. Its POST timed out without a provider ID, leaving acceptance unknown. That transport result is not evidence of a content rejection or excessive prompt length. A local capability hint is not proof of the provider's actual rejection reason.

When the user requires unchanged music or dialogue, retain the original audio and use local stream copy when the final container supports it. Validate source and output start timestamps, duration and decoded audio, including encoder delay. Do not ask a generative model to reproduce identical music as the sole preservation mechanism. Restoring the original audio cannot repair changed gesture timing, lip sync or shot order; inspect those independently before delivery.

## Inspect and continue

Review the representative result against the original at normal speed and at selected difficult frames. Check identity, hair/outfit, action timing, camera, scene, other actors, hand/object occlusions, shot boundaries and audio alignment. Technical decode, a changed face or a single plausible frame is insufficient for a complete replacement claim. Record unavailable playback or untested occlusions as limitations.

When a result fails, keep it and identify a concrete discrepancy before changing the input or pipeline. Examples include an ambiguous actor mapping, reference scenery leaking into the scene, cropped reference anatomy, wrong attachment roles or incorrectly aligned conditioning. Reuse good assets and change a bounded set of related causes; avoid repeating the same request with arbitrary adjectives. For local pipelines, compare actual decoded conditions with the selected implementation's expected tensor layout, temporal grouping, preprocessing and reference framing before another long inference run.

After the sample meets the task requirements, continue the remaining segments using cached character assets, source timing and original audio. Inspect joins and identity across cuts. Register the final actual files in the original task and preserve failed attempts and recoverable work.

Tell the user the chosen route and why it fits, then report meaningful milestones: references ready, a component's actual download/install progress, provider queue/submission, the current segment, a visible sample and any concrete correction. Show measured elapsed times separately from estimates. Record request-to-result time as well as model execution time; installation, analysis and idle coordination still count toward user waiting. Keep quoted prices, user cost assumptions, budget reservations and settled charges distinct. Do not substitute test counts for creative progress.

## Tutorial evidence and limits

For a two-dimensional meme with a few repeated poses, consider editing those poses and preserving the source timeline/layers before installing a large performance-transfer model. Character design, expression and paw/hand anatomy still require visual review. Affine matching can select the wrong pose; dense optical flow can tear a changed silhouette. A local two-pose trial on 2026-09-09 preserved source audio and pixels outside its edit mask but retained old character edges and incorrect expressions, so it did not meet one-to-one replacement acceptance. This remains an experimental route rather than an automatically deliverable recipe. Do not count static edited poses as a completed video.

The [Seedance 2.5 / Flova demonstration](https://www.bilibili.com/video/BV1nK8b6oEhp/) was inspected on 2026-09-09 using key frames and sampled burned-in captions. It shows character sheets around 00:45-03:35, video/image references around 03:35-05:42, a mannequin/voxel intermediate, shot segmentation around 05:45-06:36, and placement-image correction after actor duplication around 07:30-08:45. This supports investigating the reference-driven route. The demonstration does not expose Flova's final API payload or a complete reproducible proxy-construction process; its timing claims are not this workflow's measured latency.

Local trials on that date achieved true FaceFusion inference but only face replacement with quality limitations. Four low-resolution Wan-Animate trials completed inference without acceptable full-character quality. The fourth corrected temporal mask packing and improved part of the background, while identity, hair and head/neck quality still failed. These are bounded failures of the tested inputs and configurations, not proof that every version or AI video route is unsuitable. Keep capability claims tied to the executor and the task evidence actually verified.
