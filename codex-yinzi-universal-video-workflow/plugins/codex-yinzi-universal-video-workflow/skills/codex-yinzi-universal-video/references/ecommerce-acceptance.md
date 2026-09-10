# Ecommerce and batch acceptance

## Intake and separation

For a large folder, group by product before creative work. Use hashes, relative paths, visual/text evidence, SKU/product names, package labels, and folder structure. Keep ambiguous cross-product files in a review queue; never let one product's claims or appearance contaminate another.

For each product record:

- authoritative appearance views and package/logo variants;
- confirmed name, model, materials, dimensions, price, offer, audience, and usage facts;
- seller-provided claims, uncertain claims, conflicts, and facts that must not be invented;
- suitable direct clips, B-roll, audio, testimonial evidence, and missing coverage.

## Research

When the user requests popular or high-performing patterns, define platform, region, category, audience, time window, observable metric, source, and stop condition. Extract structural patterns such as opening hook, pain point, demonstration, proof, pacing, CTA, framing, captions, and sound—not another creator's protected footage, identity, logo, music, or exact script.

Popularity is evidence-bounded. If metrics are unavailable, label the result `trend-inspired` or `pattern-derived`, not “proven viral.” Store URLs, observed dates, metrics, and uncertainties.

## Creative variants

For traffic testing, create independent hypotheses rather than cosmetic duplicates. Useful axes include hook, audience/pain point, proof method, scene, presenter/no-presenter, tempo, CTA, and duration. Keep the actual product appearance and factual claims stable.

A 15-second 9:16 concept may use a nine-grid planning board, but nine cells are not automatically nine cuts or a mandatory generation format. The delivered timeline, voiceover, captions, safe zones, and first-frame legibility determine success.

## First usable sample

Read one representative product's actual images and available prior receipts before preparing an entire campaign. Reuse an approved board or source clip and cache product facts. Produce and inspect one complete sample before cloning the same unresolved generation problem across many SKUs. A large plan with no submitted work is preparation, not throughput.

For a nine-grid request, bind actual attachments explicitly. One uploaded board is one image reference: name its row and column when describing a cell. Use nine separate attachment identifiers only after nine files have actually been supplied. Give product appearance, presenter identity, lining/material evidence and storyboard separate roles; do not let a detail photo from another variant change the selected product. Compare visible counts, trim and structure against the chosen authority rather than repeating an old script. If that authority is itself generated and conflicts with a real product photo, record the conflict before making a factual product claim.

Map moved folders by a verified relative suffix under the user-provided root, checking existence and file identity. Do not forward stale paths from another computer. Preserve old receipts and source documents when resolving paths.

An adaptable sales sequence is: a specific viewer problem or visible benefit in the opening three seconds, a visible product demonstration, a distinct wearing/use context, and a proportionate action cue. Each shot should add evidence or a new use rather than repeat the opening. Time the spoken copy at natural speed against the planned shots. Nine complex actions and a long script may not fit fifteen seconds; adapt the shot count and wording to the requested duration. Compare hook hypotheses later using retention, clicks or orders when real campaign data is available; a compelling script alone cannot establish sales performance.

If submission is uncertain, retain that request and its references. Continue independent editing or copy work while recovering it, but do not present a still-image animatic as a generated dynamic video or add another paid attempt merely to test whether the first worked. Report elapsed time to the first usable image and complete sample, including planning and provider waiting.

## Reusable 15-second finishing route

The Windows acceptance used an existing generated dynamic product clip, selected five useful shot ranges, added an independent Chinese narration and exported a 15-second 720×1280 H264/AAC video. The durable editing job completed in about 16 seconds with already installed components and reused the same job on a repeated request key. This is a local observation, not a universal speed promise. It does not establish native 15-second Seedance 2.0 generation success; that separate provider submission remained uncertain.

Use the selected product photo as appearance authority. A planning grid controls shot ideas, and a presenter photo controls the presenter. Detail references from another variant must not change buttons, pockets, piping, silhouette or color. Confirm each claimed material/benefit from the actual product evidence. Do not infer a medical benefit from a healthcare setting.

Choose a compact sequence such as opening use/benefit, visible detail, wearing context, and action cue. Write one naturally spoken sentence per useful beat, then time the actual narration. If a generated clip has suitable footage but weak pacing or speech, reuse its good ranges and replace the narration locally. Avoid regenerating the whole product just to repair speech.

Call `local_media_run` with the existing session and stable request key:

```json
{
  "module_id": "local.video.edit-timeline",
  "input_path": "ABSOLUTE_PATH_TO_ACCEPTED_DYNAMIC_VIDEO",
  "parameters": {
    "cuts": [{"start": 0.1, "end": 4.1}, {"start": 16, "end": 18}, {"start": 6, "end": 9}, {"start": 23, "end": 27}, {"start": 28, "end": 30}],
    "narration_path": "ABSOLUTE_PATH_TO_VERIFIED_NARRATION",
    "width": 720,
    "height": 1280,
    "fps": 24
  }
}
```

Those cuts are an example from a 30-second source; select actual shot boundaries for the user's footage. The tool checks source ranges and refuses narration longer than the finished video instead of cutting off words. Without `narration_path`, it keeps source audio for each selected range. It preserves aspect ratio with padding, so inspect the final frame before claiming a platform-ready crop.

Reuse an existing narration file first. The bundled TTS service supports Edge Neural without an API key, but it uses an online service. `/api/v1/audio/extract` requires a saved TTS configuration; it does not silently configure a missing one. Codex can set up the supported Edge configuration under the user's existing task authorization, preserving any explicitly selected paid voice. The existing `ttsService.synthesizeWithEdge` service can also create a local narration file when using the backend directly. Record the chosen voice, measured duration and source text; verify final speech and shot timing. Network failure must remain visible. Do not describe Edge as offline.

Multiple image edits belong in the persistent [batch queue](batch-images.md). For multiple ready video variants, use the same `/api/v1/media-batches` route with `kind: "video"`, saved `video_config_id`, provider/model, duration and each item's actual references. Configure concurrency according to that channel's supported capacity and the user's budget; keep independent jobs queued while completed outputs are reviewed. Publish the real batch link and counts. Reuse product facts and uploads across variants, but retain separate SKU/creative IDs. A `needs_review` or ambiguous submission is reconciliation work, not another billable attempt.

The acceptance sequence is full decode/playback, product detail inspection at useful full-size frames, narration completeness and audio timing, then review of the sales hypothesis. A first usable sample allows the customer to judge the route. Test retention and conversion with real campaign data later; this workflow cannot certify a “viral” result from its script alone.

## Required QA

- product identity, color, structure, packaging, logo, and quantity remain consistent;
- no invented price, certification, effectiveness, scarcity, medical claim, or guarantee;
- spoken copy, captions, shots, and landing intent agree;
- key text is readable inside platform safe zones;
- hook and product appear early enough for the selected hypothesis;
- imported user clips are reused where suitable and not regenerated unnecessarily;
- every generated or edited output maps to one product and one test hypothesis;
- exports use the requested duration, aspect, codec, audio, and naming convention.

Deliver a variant matrix and a traceable hypothesis ID so later spend/performance results can be attached without rewriting the creative history.
