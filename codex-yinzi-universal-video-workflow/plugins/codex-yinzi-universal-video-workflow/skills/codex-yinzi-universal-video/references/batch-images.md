# Multiple images through the durable batch queue

Use the runtime base returned by the workflow bridge. Reuse the saved image configuration and the user's selected model. `gpt-image-2.5`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` and `gpt-image-2` are Yinzi image options when available for that configuration. Model discovery is advisory. Do not replace an explicit model or force a newer default onto existing users. Prices and latency vary by site/group; use the current user's authorization or a saved quote, never assume a universal one-cent price.

For image edits, upload each authorized local reference through multipart `POST /api/v1/upload/reference-media`, field `file`. Retain its returned URL and hash. Local upload is preparation, not a paid generation. Give each reference a distinct role in the prompt, and preserve each item's attachment order.

Before submitting, record the actual item count and worst-case cost within the existing task budget. No new per-stage approval is needed when already authorized. Use a stable batch key derived from the original task and intentional batch revision; preserve the exact body through recovery. Submit independent images in one batch rather than awaiting each image before queuing the next.

`POST /api/v1/media-batches` accepts:

```json
{
  "kind": "image",
  "idempotency_key": "task-id:character-keyframes:revision-1",
  "title": "角色关键帧替换",
  "model": "gpt-image-2.5",
  "concurrency": 4,
  "exploration": {"mode": "fixed"},
  "settings": {"image_config_id": 1, "aspect_ratio": "1:1"},
  "items": [
    {"prompt": "Edit source frame A using identity B; preserve A's pose and scene.", "reference_images": ["uploaded-source-A", "uploaded-identity-B"]},
    {"prompt": "Edit source frame C using identity B; preserve C's pose and scene.", "reference_images": ["uploaded-source-C", "uploaded-identity-B"]}
  ]
}
```

Replace example IDs, references, model, size and concurrency with actual task values. `settings` are merged into every item; item fields override shared settings. Every item is a separate image request. If the user needs the same picture repeated without new generation, copy the existing file instead.

Return the real link `<frontend>/batch?batch=<returned-id>` and record it in the original orchestration task using `report_activity` or `record_event`. `GET /api/v1/media-batches/:id` returns item statuses, generation/task IDs, original requests, result paths, and errors. Use `item_page` and `item_page_size` for large batches. `GET /api/v1/media-batches?limit=100` lists recent batches, including idempotency keys. An uncertain create can be recovered with the same exact key/body; the service reuses it and rejects changed content under that key.

Pause via `POST /api/v1/media-batches/:id/pause`; running provider work continues. Resume via `/resume`. A `needs_review` item may already have been accepted and must not be requeued. An explicit failed item can use `/items/:itemId/retry` only under the existing retry/cost budget. A creative correction is a new named batch linked to the old result, not a hidden automatic retry.

Download and inspect actual completed outputs. Report generation success separately from creative acceptance. For character frames, compare identity, expression, anatomy, actor size, cropping, untouched text and background. Retain failed-quality frames and refine only justified defects. Never equate batch completion with an accepted video.
