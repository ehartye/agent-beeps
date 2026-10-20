# Recorded-source and hybrid SFX

Use a recording for detail synthesis would be costly to recreate, and procedural layers for the
body, resonance or tail you want to edit. This is the finite SFX path; songs and music remain
`beeps-music` and cannot use sample instruments. A hybrid patch has up to eight total layers.

## Import, prepare, edit, validate, then bundle

`beeps` is the managed CLI described in the skill. From an initialized project:

```text
beeps sample import contact.wav --origin "licensed field take" --license "CC0"
beeps sample prepare <normalizedId> --start 0 --end 0.15 --fade-in 0.002 --fade-out 0.02 --gain -3 --name contact-hybrid --family foley
```

Use the import command's actual `normalizedId` (`sha256:` plus 64 lowercase hex digits), not the
original file ID. Choose crop times within that recording (longer than ten seconds? Look at it
first: [overview](#long-recordings-overview-first)). Import retains the exact original, canonical
48 kHz Float32 WAV snapshot and local provenance/decoder receipt under `.agent-beeps/samples/`. Preparation reads that snapshot, crops `[startFrame,endFrame)`, applies
linear amplitude fades, then gain; seconds round to the nearest 48 kHz frame. The preparation
receipt contains the frame recipe and expected output hash. Replay it with
`beeps sample prepare --recipe <recipePath>`; the original encoded recording is unnecessary.

`--name` saves a neutral sample-only patch at `.agent-beeps/patches/contact-hybrid.json`.
**Now edit that patch**: keep its real prepared `asset` ID and neutral sample amp, then add a
procedural layer. For example, append this quiet body to its `layers` array:

```json
{"source":{"type":"noise","color":"pink"},"start":0.012,"gainDb":-24,
 "amp":{"attack":0.005,"decay":0.1,"sustain":0,"release":0.02},
 "filter":{"type":"bandpass","cutoff":900,"q":0.7}}
```

Save the edited patch before the next commands. If instead you keep JSON in a versioned source
folder, copy the prepared patch there, edit it, then `beeps sync <patch-directory>` to save the
final version into the project. Ordinary `sync` imports patch JSON, not its sample dependencies.

```text
beeps render contact-hybrid
beeps lint contact-hybrid
beeps look contact-hybrid
beeps sample bundle contact-hybrid --out exchange/contact-hybrid
```

Open the actual look image and inspect the onset, band balance and tail. Fix errors and explain
warnings, re-rendering after changes. **Bundle the final edited patch**, after validation; a bundle
of the sample-only patch made before adding the body omits that edit. Use a fresh output directory
for a changed bundle (an identical existing bundle is allowed). Finish with owner audition; a
measurement or a schema-valid patch is not listening approval.

On another machine/project, `beeps sample sync exchange/contact-hybrid` validates the whole bundle
before adding/updating patches and immutable source objects. `--dry-run` validates without writes.
Render/lint/look/export/build/runtime commands use the ordinary prepared-object store and verify
dependencies even on warm cache paths. A lone hybrid patch JSON does not carry its recording.

## Long recordings: overview first

A recording can run to 120 seconds; a prepared source is at most ten. Look at the whole recording
before you crop it, from a normalized ID or straight from a file:

```text
beeps sample overview <normalizedId>
beeps sample overview take.wav --out shape.png --start 40 --end 70   # zoom into a stretch
```

A file needs no project to be overviewed, but then the image needs `--out <png>`; import and prepare
still need a project. The PNG (default `.agent-beeps/renders/overviews/<key>.png`; **open it**) shows
the waveform, the per-second loudness arc and a spectrogram, with numbered bands for the segments. The
JSON lists the same segments: stretches between gaps, each cut to at most ten seconds, with
`peakDb`, `momentaryMaxLufs`, `crestDb`, `centroidHz`, `clippedSamples`, `events`, `flags` and a ready
`prepare` line. Run that line, adding `--name`, fades and gain as usual. Times are exact frames, so
the crop is the segment. For a file, the lines use the ID `sample import` will give it: import the
file first and check the IDs match.

- Gaps: 200 ms or more at least 40 dB under the loudest frame **of the view** (`--min-gap` 10 to
  10000 ms, `--gap-db` above 0 up to 100). Zooming with `--start`/`--end` can therefore surface
  quieter segments a whole-recording view merged or left out.
- `events` is `{count, rpm}`: detected repeats and their rate per minute (`rpm` is null when nothing
  repeats). Detection reads a bass-only pulse (a kick drum) as nothing, as in
  [matching a reference](matching-a-reference.md).
- `clipped`: the segment has flattened peaks; lowering gain will not repair them. Prefer another.
- `cutAt10s`: the sound goes on past the cut. Choose a shorter window that ends where you want.
- `short`: under 150 ms. A tap, click or contact transient is listed as its own segment (a lone
  10 ms tap shows as about 30 ms with its lead-in). Check it is a wanted sound and not stray noise
  or a room reflection; a tap more than `--gap-db` under the loudest moment is not listed, so lower
  `--gap-db` to find quiet ones.
- `hints` say when nothing is audible, when one continuous
  sound had no gap to cut at (lower `--gap-db` or `--min-gap`), or when quieter segments were left
  out (at most 64 are kept: raise `--min-gap`, or zoom). A 120-second image is about 86 ms per
  pixel: zoom to see transients.
- Nothing is ranked. The overview proposes windows; picking the sound is the owner's ear
  (beeps-audition).
- Without Chromium the image fails with `E_BROWSER_MISSING`: run the beeps-setup skill (the error's
  hint) to get it; `--no-image` returns the JSON alone as a stopgap.

## What leaves the project

The default source bundle contains the selected final patches and exactly their prepared WAV
dependencies. `beeps sample bundle contact-hybrid --out exchange/contact-preparation
--include-preparation` explicitly adds required normalized source snapshots and replay recipes.
Those snapshots may include the full recording and outtakes beyond the prepared crop. Neither mode
includes original encoded imports, import receipts, private original paths or unrelated objects.
Keep public license/provenance notes beside the strict bundle, whose inventory permits only its
declared files. Import receipts can contain private paths; do not copy them into an exchange.

`sample bundle` is authoring exchange. `beeps build`, `export`, the game catalog `bundle` command,
and `player export` are delivery. Baked hybrid WAV/Opus/MP3 uses the existing player. Runtime/both
delivery ships the cue plus its exact prepared-source closure, with cue-owned filenames and locked
hashes/byte counts. Store and standalone Node 20 CI fetch verify the complete closure, including
already-present outputs, without the authoring originals, Chromium or ffmpeg.

## Native runtime lifecycle

Use the complete Stop/loading/replacement handler in [the runtime guide](../../../docs/runtime.md#playing-it).
The engine entry exports `loadCueAssets`; `build` stays synchronous and does no I/O:

```js
// Inside each play button's user-gesture handler, with a current cue and AbortSignal:
await ctx.resume();
const samples = await loadCueAssets(ctx, cue, { baseURL: cueURL, signal });
// Check this play's generation/signal again before starting.
const voice = build(ctx, out, cue, { samples }).start(); // a NEW voice every play
```

Import `build`, `parseCue` and `loadCueAssets` from `agent-beeps-runtime`. Parse a cue once, resolve
`baseURL` from the actual cue URL (including any static project subpath), and pass its AbortSignal
to the loader. It verifies bounded bytes, content hash and canonical WAV metadata before allocating
the buffers. It works on HTTP LAN origins without WebCrypto. The loader has no automatic cache:
the caller may cache its verified immutable buffers for that cue/context. Do not mutate those buffers
or cache a started voice. Stop/replacement aborts pending work, invalidates the generation and
disposes the old voice; guard late resume/load completions before starting. A voice plays once.

## Limits and signal character

- Prepared sources contain 1–480000 frames at 48 kHz, mono or stereo (up to ten seconds), canonical
  Float32 WAV. Normalized snapshots are at most 120 seconds; original imports at most 64 MiB.
- Samples play once, unpitched, at their authored onset. Pitch envelopes and pitch LFOs on sample
  layers, sample loops/stretching and song sample instruments are unsupported. Gain and cutoff
  LFOs, filters, gain, pan, amp envelopes and patch effects remain available. Pitch variation and
  transpose affect procedural pitched layers, not a sample's playback rate.
- `hold` cannot make a finite sample loop: exhaustion starts its authored release. Patch duration,
  envelopes and effects still determine the voice lifetime; a source's end need not be its tail's end.
- Use preparation gain for headroom, layer gains for balance and project/family loudness settings
  for placement. Compare actual delivered max-momentary loudness and inspect true peak. Attenuating
  an already clipped recording does not restore its flattened transient or remove its distortion.

Working examples: [Fuse metal](../../../library/examples/fuse/README.md),
[Tommy five bursts](../../../library/examples/fuse-tommy/README.md),
[M16 one sustained burst](../../../library/examples/fuse-m16/README.md). The
[public booth](https://ehartye.github.io/agent-beeps/#fuse) has three rows and nine takes.
