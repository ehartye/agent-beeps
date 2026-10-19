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
original file ID. Choose crop times within that recording. Import retains the exact original,
canonical 48 kHz Float32 WAV snapshot and local provenance/decoder receipt under
`.agent-beeps/samples/`. Preparation reads that snapshot, crops `[startFrame,endFrame)`, applies
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
