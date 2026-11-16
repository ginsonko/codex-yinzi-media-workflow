# Sound effects through the one entry (`sfx_tool`)

When the host app's media MCP server offers `sfx_tool`, every sound effect and ambience bed comes from it. It is the same entry the manju pipeline uses (`sfx.find` in the app), so an AE edit, a 剪映 draft, an FFmpeg cut, a canvas `export_video` rough cut and a `render_video` film all draw on one library with one license record. Do not download effects from random sites and do not synthesize noises with FFmpeg as a substitute.

## Order of sources

1. The user's own sound folder (`folder`), indexed incrementally; nothing is written into it. These count as the user's own material: fine in the user's film, never redistributed as a public pack.
2. The built-in library shipped with the app (about 400 sounds: doors, footsteps, impacts, blades, cloth and props, food and drink, rain, wind, forest, crowds, markets, classrooms, interface sounds). Every entry is CC0 or an author's public-domain waiver, traceable to its original page, and machine-checked (`review: auto_checked`; nobody has listened to it).
3. Local synthesis, only as a fallback. It is returned with `placeholder: true`; say so in the edit notes and to the user.

## Find

`{action: "find", use: "甩门"}`. Write the purpose in Chinese or English: an action, a material, a place (「木地板上的脚步」「拔剑」「雨夜 环境声」「door slam」). Candidates come in two groups:

- **直接命中**: the word is in the sound's name or tags.
- **意思接近**: the app's word table linked them (a synonym, an action or a material that can stand in, such as 甩门 → a door closing).

Prefer a direct hit, then a near one. `fit: "generic"` on a placeholder means not even the kind of sound was recognised: rephrase or leave it out rather than putting a random noise in the film. Several takes of one sound count as one candidate (`variants`); pass `variant` to use a different take for repeated steps or knocks.

## Mix

`{action: "mix", input: "成片.mp4", cues: [{use: "敲门", at: 3.20, gain_db: -6}, {use: "下雨 环境声", at: 0, seconds: 30, bus: "amb"}]}` writes a new file (never over the input) plus a `.cues.json` table.

- `at` is when the event happens in the film: the frame where the door bangs or the fist lands. Short sounds are placed so their onset (the first real transient after any silence) lands on `at`.
- Short sounds get 3–10 ms fades that remove clicks and keep the attack; beds get 500/800 ms. Effects and beds go to two separate buses mixed with `normalize=0`, so levels do not jump when one cue ends.
- Trimming, gain and fades live in the cue only. The source sound file is never changed.
- Record each cue's `asset_id` and license in the edit notes.

For AE or 剪映, use `find` to get the files and place them yourself on separate effect and ambience tracks, aligning each short sound's `onset_ms` to the event frame.
