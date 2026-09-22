# Templates, evidence and pitfalls

## Choose a template by intended experience

Match purpose, audience, aspect ratio, music, pacing, amount of text and the
actual usable material. Propose a small number of materially different previews
when preferences are unclear, for example a clean product explanation, a lively
keyword-driven short or a restrained travel diary. Let the user choose or apply
the existing AI-led authorization. Do not ask them for resource IDs.

Three different routes must remain distinct:

| Resource | Current adapter route | Required verification |
| --- | --- | --- |
| A local readable project owned or authorized by the user | Duplicate, replace text/media, retain editable tracks | Independent ID/name/paths; original preserved; duration, fonts, crop and effects in actual editor |
| Built-in filter/transition/text-animation reference | Write a supported library enum and parameters | Installed version loads it; resource download works; account entitlement; visible effect |
| An online template/template link | Investigate its documented reuse/download route in the actual editor | Access, editable availability, rights, material substitution and export; URL alone is not an adapter input |

Do not claim that this adapter downloads any template by URL, that resource IDs
guarantee free use, or that every popular template is editable. Do not scrape
account tokens, spoof an allowed host process, bypass member-only resources or
decrypt unreadable drafts. A local template and its renders can be reused after
verification, with an evidence card containing source, rights, app version,
required resources, replaceable slots, sample output and known limitations.

## Accept the picture, not just the file

Use the same source excerpt, timing and output settings for a meaningful A/B.
Export baseline, preset and template-replaced variants from Jianying itself.
Keep an AE render as a separate route comparison, not a pixel-equivalent claim.
Measure draft construction, app launch, resource download, preview and rendering
separately. Milliseconds writing JSON cannot be compared with seconds rendering.

Check normal-speed playback and selected frames: text readability and layout,
font fallback, missing characters, subtitle timing, subject/feet safe area,
skin/product colors, overprocessed highlights, transition seams, audio continuity,
black frames and resource warnings. Explicitly inspect replacement titles that
are longer, bilingual or multiline. Run decode, duration/frame-rate/audio checks.
Technical success and artistic acceptance are separate verdicts.

For MV/PV, retain the established standards: actions fit lyrics and mood; visual
accents follow music; foreground/background occlusion has intent; causal actions
are ordered; repeated dance loops and gratuitous transitions do not fill missing
story. Templates can accelerate execution but are not an artistic ceiling.

## Observed on 2026-09-22

Windows 10 19045, Jianying Pro 11.5.0.14471, pyJianYingDraft 0.3.0:

- Isolated 12-second 1280×720/30fps drafts wrote four source videos, text, SRT,
  scale keys, three dissolve references, a cool-blue filter reference and four
  text intro references. Local template text replacement round-tripped.
- The raw library copied project identity/metadata. Normalize new root content
  ID and metadata name, ID and paths for each independent project.
- API drift: 0.3 uses `append_track(TrackSpec(...))`; old `add_track` examples
  failed. Pin the version and test against installed code.
- Missing media, same-name overwrite, malformed/non-JSON input and unintended
  track overlaps must remain clear failures, not silent omissions.
- The community UI export controller documents old-version restrictions (6 and
  below). This is that controller's limitation, not proof no current editor
  automation can ever work. Do not downgrade the user's app to match it.
- This host's Windows capture tool failed `SetIsBorderRequired 0x80004002` and
  the home accessibility tree exposed unnamed controls. The editor page later
  exposed `editor.export`, but clicking still failed with `coordinate input
  geometry is unavailable`. Ctrl+E was attempted; a physical Escape stopped
  Computer Use before its outcome could be established. Do not replay that
  action without first observing the current UI. This host's unattended export
  remains unverified; it is not a general restriction on every user's computer.
- Installed internal `lyra-cli --help` returned `unauthorized host process`.
  No public external rendering interface was established by this discovery.
- An AE 12-second same-source technical baseline was really rendered and fully
  decoded. It is not a Jianying result, a speed comparison or a polished MV.

### Later real export on the same host

The user opened the independently generated preset probe in Jianying 11.5 and
manually exported it. The actual MP4 decoded to 360 frames, 12 seconds,
1280×720/30fps, H.265. It contained a 44.1kHz stereo AAC stream whose decoded
samples were all zero, despite the source clips having no audio. Inspect actual
streams and samples; neither audio-stream presence nor its absence in source
proves that a delivered export has audible sound.

Selected frames verified all four clips, bilingual captions, title entry motion
and dissolves around 3, 6 and 9 seconds. The cool-blue filter's isolated visual
contribution was not established: a same-editor unfiltered export is still
needed. Resource downloads, current account entitlements and export speed were
not measured. This was the earlier standalone probe, not a separate GUI export
of every registered-operation variant. Preserve this provenance distinction.

The sample's generic centered title covered the anime character's forehead and
the lower caption overlapped her legs. These positions are not a professional
layout default. Inspect subject, product label and body/feet occupancy for each
shot, and place type in intentional negative space or a designed caption area.
Software defaults and successful preset rendering do not establish aesthetics.

Keep the user's original export immutable. A clearly labeled H.264 compatibility
copy is useful for browser preview, and a side-by-side video may combine two
actual renders; do not rebuild effects to make a fake editor result. Same-source
renders with different styling are route examples, not a controlled quality,
color or performance benchmark.

After app save, the tested editable copy's metadata/content could no longer be
parsed as ordinary JSON. Keep the pre-editor source draft and its original
receipt separately; never overwrite it with the saved editor copy, assume that
an opened project stays reusable as a plaintext template, or try to decrypt it.

Sources: [pyJianYingDraft](https://github.com/GuanYixuan/pyJianYingDraft),
[Jianying official product site](https://www.capcut.cn/).
The saved community README revision was
`c3318066d964744e2bfc66f75c71745fe8cea52a`.
Keep later application/render tests as additional evidence; do not turn this
bounded draft test into a universal compatibility guarantee.
