# Source overview

Let an agent see the shape of a recording longer than ten seconds and choose crop windows for
`beeps sample prepare`, instead of cropping blind. A prepared sample stays at most ten seconds;
only the way an agent finds its window changes.

## Problem

`sample import` retains a normalized snapshot of up to 120 seconds, and `sample prepare` crops any
window of at most ten seconds from it. Nothing shows the whole recording. `beeps look` takes only
patches, `beeps analyze` reports numbers without an image or windows, and the agent picks
`--start/--end` by guessing. Cropping a window to inspect it also costs a prepare, a named patch and
a render.

## Command

```
beeps sample overview <source> [--start <s>] [--end <s>] [--out <png>] [--gap-db <dB>] [--min-gap <ms>] [--no-image]
```

`<source>` is a normalized sample ID (`sha256:` plus 64 hex digits, project required, read with the
120 second source bound) or an audio file path (no project needed). Both are
decoded with the same limits and bytes as `sample import` (48 kHz, 120 seconds, 64 MiB), so every window the
command proposes can be imported and prepared. Longer files fail with `E_SCHEMA` and a hint to trim
them first.

`--start` and `--end` select the view range in seconds. The range may exceed ten seconds. Segments
are found inside it and all times stay in source time. Overview a whole file, then a sub-range for
detail. `--no-image` skips Chromium and returns the JSON only.

Defaults: `--gap-db 40`, `--min-gap 200`. Ranges, all `E_SCHEMA`: `--gap-db` above 0 and at most 100; `--min-gap` 10 to
10000 ms; `--start` at least 0; `--end` after `--start`; both inside the source length.

## Segmentation

Deterministic, on a mono mix at 48 kHz in 10 ms RMS frames.

1. A gap is a run of at least `--min-gap` ms whose frames sit at least `--gap-db` below the loudest
   frame, with an absolute floor of -70 dBFS.
2. Segments are the stretches between gaps, extended 20 ms earlier so an onset is not clipped.
   A segment under 50 ms is dropped as a click.
3. A segment over ten seconds is cut at its quietest frame between 6 s and 10 s from its start,
   repeatedly. Every piece except the last carries `cutAt10s`. A source with no gap at all comes out
   as ten second slices with a hint.
4. Beyond 64 segments the 64 with the highest peaks are kept, still in time order. `omitted` counts
   the rest and a hint names `--min-gap`.
5. No segment is ranked or scored. Choosing a sound is the owner's ear.

## Output

```json
{
  "source": { "file": "take.wav", "normalizedId": "sha256:...", "durationSec": 74.2, "sampleRate": 48000, "channels": 2, "view": { "startSec": 0, "endSec": 74.2 } },
  "image": "<path or null>",
  "segments": [
    { "index": 1, "startFrame": 163680, "endFrame": 288960, "startSec": 3.41, "endSec": 6.02, "durationSec": 2.61, "peakDb": -3.1, "momentaryMaxLufs": -17.4,
      "crestDb": 14.2, "centroidHz": 2310, "clippedSamples": 0, "events": { "count": 5, "rpm": 640 },
      "flags": [], "prepare": "beeps sample prepare sha256:... --start 3.41 --end 6.02" }
  ],
  "omitted": 0,
  "hints": []
}
```

Flags: `clipped` (any clipped sample), `cutAt10s` (the sound continues past the cut), `short` (under
150 ms). Features come from the existing `measure` and `findEvents` code on each segment, so they
match `analyze` for the same audio.

`source.normalizedId` is the ID `sample import` gives the audio (same decode limits and encoding, shared
in code), and every `prepare` line uses it. A file source also carries `file` and a hint to run
`sample import` first and check the printed ID matches; an ID source has no `file`. Seconds are the
exact frame count over 48000, rounded to 6 decimals, and each segment also has `startFrame` and
`endFrame`, so `prepare --start/--end` reproduces the frames. `--out` with `--no-image` is `E_USAGE`.

## Image

Reuses `host.songPcmLook` and `renderSongLook`: waveform, per-second loudness arc and a fixed-scale
log-frequency spectrogram. Segments are the numbered section bands (1..N, matching the JSON) and
gaps stay dark. A source-specific footer (duration, view range, peak) replaces the song footer
through one optional feature flag in `runtime/look.js`; song looks must not change. At 120 s a
pixel is about 86 ms, so the image shows shape; use `--start/--end` for transients.

Default path with a project: `.agent-beeps/renders/overviews/<key>.png`, where key is the first 12 hex
of the sha256 of the canonical JSON of the normalized ID, the view frames and the gap parameters, not the footer label, so a file run and an ID run of the same
audio write the same path (the later label wins). It is gitignored derived output, so an existing file is overwritten (it is a view, not an immutable
object). Without a project `--out` is required. Missing Chromium fails with the existing `E_BROWSER_MISSING`; `--no-image` is the
workaround.

## Skill and documentation support

- `skills/beeps-compose/references/hybrid-sources.md`: a "Long recordings: overview first" section.
  Flow: import, overview, pick a segment, prepare with the printed times, look, audition. It covers
  `cutAt10s`, `clipped`, `--start/--end`, and that the overview proposes, the owner's ear decides.
- `references/matching-a-reference.md`: point long references at the overview.
- `skills/beeps-compose/SKILL.md` (127 of 150 lines): two lines in the sample bullets and
  "a recording longer than ten seconds" in `when_to_use`.
- `src/commands/capabilities.ts`: `sample overview` in the sample commands and a workflow note.
- `README.md`, `docs/runtime-package.md`: mention it where the ten-second limit is described.
- Wiki: a design page and a roadmap entry for the friction (`look` is patch-only, `prepare` cannot
  suggest windows).
- Version 0.17.0, following the release pattern of the previous feature PRs.

## Tests

- Segmenter unit tests on synthetic audio: three bursts with gaps, noise only, 25 s continuous
  (cuts and `cutAt10s`), a dropped click, more than 64 segments, a `--start/--end` range, flag rules
  and determinism.
- CLI tests on a synthetic WAV path and on an imported ID, including bad arguments, over-length
  source, unknown ID and `--no-image`.
- A PNG smoke test (signature, dimensions), skipped without Chromium like the existing look tests;
  song look PNGs are compared by hash on main and on the branch by hand (Chromium-dependent).
- `skills.test.ts` limits and the capabilities snapshot.

## Out of scope

Ranking or scoring windows, `prepare --auto`, tempo or pitch detection, sources over 120 seconds,
loops and long-form playback. Each is a separate decision.
