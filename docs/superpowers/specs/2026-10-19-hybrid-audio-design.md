# Recorded and procedural hybrid audio

Deliver an ordinary SFX patch containing recorded and procedural layers through import,
preparation, audition, measured rendering, portable source exchange, baked export and runtime
cue delivery. Use the current listening UI and shared graph. An import command alone does not
complete this feature. The envelope foundation shipped separately in 0.15.0.

## Sources and scope

The wiki's recorded-reference studies and matching roadmap identify the integration gap:
recordings currently require external preparation/layering scripts. Existing analysis/compare
commands remain useful, but do not supply a source layer or portable dependency handling.
Procedural and recorded candidates can both win by ear. This feature makes them composable;
it does not claim either method is universally better.

Use finite unpitched one-shots first, matching the existing ten-second patch contract. Mono
and stereo sources retain their channels. Sample layers support ordinary start offsets,
amp, gain, pan, filters and effects. Pitch envelopes and pitch LFOs on a sample layer are
rejected explicitly. Pitched/looping/time-stretched samples are later capabilities. Reject
sample instruments in both Node song resolution and browser song construction until the
song preload path is supported. A hybrid SFX patch may still transpose its procedural layers.

## Immutable audio and preparation

An imported original is preserved byte-for-byte. Decode to a retained canonical 48 kHz
snapshot, then prepare from that snapshot rather than repeatedly editing a lossy result.
Canonical objects are IEEE float32 WAV: exact 44-byte little-endian header, one or two
channels, finite PCM and no metadata chunks. Their IDs are `sha256:<64 lowercase hex digits>`
computed over the exact WAV bytes. Prepared objects have 1..480000 frames; retained normalized
source snapshots may have up to 120 seconds. Reject originals over 64 MiB before decoding.
Bound decoded duration and reject excess channels/frames before allocating PCM from headers.

Store under `.agent-beeps/samples/`: `objects/<hex>.wav`, `originals/<hex>.bin`,
`imports/<receipt-id>.json`, and `recipes/<recipe-id>.json`. Object writes are immutable: an
existing object must match its ID, never silently overwrite corrupt content. Import receipts
retain original hash/name, normalized ID and exact decoder identity plus optional declared
origin/license. Absolute paths and timestamps are informational, excluded from audio identity.
Receipts remain separate so identical audio from multiple origins does not overwrite provenance.

Preparation is a strict `beeps/sample-prep@1` recipe:

```json
{"schema":"beeps/sample-prep@1","source":"sha256:<normalized WAV hash>","startFrame":0,"endFrame":7909,"fadeInFrames":96,"fadeOutFrames":480,"gainDb":-3}
```

Frame crop is end-exclusive; integer frames are authoritative. Apply crop, linear amplitude
fades, then gain. A fade of N>=2 frames runs inclusively between 0 and 1; a one-frame fade
sets that frame to zero; zero frames means no fade. Fade lengths cannot overlap or exceed
the crop. Gain is finite in -60..24 dB. Reject nonfinite output without clamping. Preparation
is repeatable from the stored normalized snapshot, including after original-file removal.
Recipe ID is canonical JSON hash; output asset ID is canonical WAV byte hash. Re-decoding an
original with a different decoder is not promised bit-exact; the normalized snapshot is retained.

## Patch, resolver and runtime boundaries

The strict new source is `{ "type": "sample", "asset": "sha256:<prepared WAV hash>" }`.
No URL, local path or implicit codec decoding is accepted in a graph. Node resolves all
referenced objects against an explicit project sample directory and verifies actual bytes
before any cache or lock reuse. Asset IDs are already in patch/render identity and, once
verified, identify the actual input bytes. Missing or corrupt objects fail even on warm caches.
Derived frames/channels/rate/bytes come from verified PCM, not mutable metadata.

A browser-safe module parses the canonical WAV with bounded header/data validation. It also
loads relative runtime cue dependencies, checks their SHA256 and metadata, and returns shared
AudioBuffers. Network/loading happens before the existing synchronous `build`/`start` path.
Pass prepared buffers explicitly in graph options. Preflight all sample dependencies before
any patch layer starts, alongside the existing envelope preflight. Each voice gets its own
AudioBufferSourceNode; shared AudioBuffers remain immutable. Disposing one voice cannot stop
another voice using the same buffer. Natural sample end cannot be prolonged by held amp.

Offline render transport carries verified canonical source bytes to the same browser parser.
The runtime voice, live audition and offline renderer use the same source graph and buffers.
Playback at context rates other than 48 kHz resamples normally; exact PCM parity is claimed
only at the same tested engine/context rate.

## Authoring and portable source exchange

Expose `beeps sample import`, `prepare`, `bundle`, and `sync` through the normal JSON CLI.
Prepare accepts seconds in CLI controls, converts explicitly to integer 48 kHz frames, stores
the resulting recipe, and optionally creates a named sample-only patch. That patch has a
neutral amp so preparation fades are not applied twice. Lint keeps measured onset checks;
declarative amp assumptions must not falsely classify an already prepared source as a click.

A source bundle contains `patches/*.json`, `samples/<hex>.wav` and `samples.json`. Bundle
includes only prepared dependencies by default, never private originals. Sync validates the
entire manifest, byte hashes and patch dependency closure before writing imported objects
and project patches. Relocation requires this ordinary CLI operation, not an external script.
The existing patch-only sync retains its current contract. Imported patches then work in
ordinary sets and the current listening UI, including procedural layer edits.

## Cues, builds and shipping

Runtime cues gain an optional asset manifest keyed by content ID, carrying relative file,
sample rate, channels, frames and bytes. Use flat cue-owned filenames
`<cue-id>.sample-<hex>.wav` so rebuilding one cue cannot remove another cue's dependency.
Standalone runtime export and runtime/both build delivery copy every declared dependency.
Baked-only game delivery needs only its rendered files. Lock/store/tar output lists and
budget estimates include runtime source files. Verify and fetch check dependency closure,
hashes, metadata and containment. Never include original/profile paths in runtime cues.

The vendored game player continues to load baked catalogs. Async cue asset preparation is an
engine runtime API; do not imply the baked player understands live cues. Initial capability
release is 0.16.0 / engine 4, requiring lock/cue rebuild. Legacy patch graphs and PCM must
remain unchanged; intentional versioned cache identity changes are documented.

## Existing UI and public proof

Add sample preloading to the existing authenticated audition flow. Selection/stop generation
guards prevent an obsolete load from starting a discarded sound. Retain lineup/duel/stop and
owner taste semantics. No custom replacement listening app.

The public booth will demonstrate a recording, procedural contribution and their hybrid at
matched measured levels, with portable recipes and source/license information. Use the
official Kenney Impact Sounds CC0 asset verified in the local provenance receipt. Do not use
private owner recordings. Signals, looks and parity checks do not establish owner approval.

## Acceptance

1. Import preserves original bytes, normalization provenance and independent immutable IDs.
2. Crop/fades/gain are exact, bounded and replayable; malformed headers fail before allocation.
3. Sample-only and hybrid patches render, measure, lint, form sets and play in the existing UI.
4. Native tests cover mono/stereo, onset/layer offsets, overlapping shared buffers, natural
   end, release/effect tails, stop/dispose and preflight failure without leaked earlier layers.
5. Offline, runtime cue and audition graph PCM agree at 48 kHz. Sample-only parity uses a
   changed-source negative control; a seed change alone cannot prove that path is exercised.
6. Missing/corrupt objects fail before warm render/build reuse. A changed asset affects only
   dependent sources, apart from the explicit one-time engine capability bump.
7. Bundle/sync relocates recipes and dependencies after original paths are removed.
8. Baked, runtime-only and both build/export/verify/store/fetch deliver the correct closure;
   static project-subpath runtime loading works with no authoring server. Baked player works.
9. Legacy graph/PCM and old public examples retain behavior. Full tests/typecheck, measured
   public examples, verified manifest and desktop/mobile hosted playback pass before landing.
10. Wiki source evidence, architecture/roadmap, README, authoring/runtime docs and plugin
    catalog describe the actual shipped capability and retain owner-listening status honestly.
