# FM index envelopes and the Flux SFX bench

The SFX counterpart to Touch is source-level timbre evolution: optional multistage envelopes on
FM operators. The current craft guide recommends index envelopes but the engine exposes only a
fixed index. This is a focused procedural-synthesis extension, with a live comparison in the
existing public booth. It does not introduce recorded samples, physical-material claims or 3D audio.

## Authoring contract

An FM operator can declare `indexEnv: [[seconds, scale, arrivalCurve?], ...]`. `index` remains the
peak modulation amount; the envelope multiplies it by a scale from 0 to 1. This keeps static
runtime inputs and song velocity mappings on `index` effective across the whole envelope.
Example: `"index": 4, "indexEnv": [[0, 0], [0.006, 1], [0.15, 0.2, "exp"], [0.6, 0]]`.

A curve has 1..64 points, starts at time 0, uses finite seconds in 0..10, and strictly increasing
times. Arrival curves are `linear` (default), `step`, or `exp`. An exponential segment requires
positive scales at both endpoints; zero attack/release endpoints use linear segments. A zero
base index stays silent without attempting exponential ramps to zero. The last value holds.
An envelope is valid only on an operator with an outgoing modulation edge, since the index of
an operator used only as an audible carrier has no effect. Optional fields and omitted tuple
members remain absent unless authored.

## Engine and compatibility

The normalized envelope scheduler is a reusable browser-safe primitive in `engine/envelope.js`;
FM depth is its first caller. This foundation does not include a general modulation matrix.

Validate the actual mapped curve and each scaled automation target before starting any patch
layer. Runtime inputs can combine beyond the schema's sampled corners. Onsets and peak depths
must be finite and nonnegative; targets must remain finite as Float32, and nonzero exponential
endpoints must remain positive after Float32 conversion. Reject invalid values without clamping.
This preflight prevents a failing later layer from leaving an earlier held sound running.

Each outgoing edge receives the source operator's envelope at that voice's absolute onset time,
scaled by the existing depth formula (index × played fundamental × destination ratio). Nothing
automates an operator's frequency or the audible amp envelope. Chained/fan-out algorithms,
transposition, onset offsets and overlapping voices each keep their own automation. Held and
finite runtime voices share this graph; the envelope is onset-time-based and does not restart
when the amp releases. Points beyond source stop are inaudible, like existing pitch envelopes.

No envelope means the exact existing node/event path. Existing library/archetype golden graph
hashes and representative legacy PCM must remain unchanged. The engine capability/cache version
moves to 3 so an older runtime cannot silently accept a new enveloped cue as engine-compatible;
release 0.15.0 requires rebuilding audio locks even where legacy PCM is unchanged.

## Listening study and verification

Flux presents three paired recipes: a resonant strike, an energy discharge and a machine sound.
Each pair shares source ratios, pitch, layers, amp, effects, seed and scale; only the index curve
and measured delivery trim differ. Both takes use the same new engine. Max-momentary loudness
matching is used for these short effects, with measured peak limits. Playback is synthesized
live using the booth's existing controller, styles, master volume, spectrum and stop behavior.
Every recipe is downloadable and self-contained. Compare labels describe static versus shaped
index, without asserting preference or physical realism. Owner listening remains pending.

Schema tests fail first; graph tests cover all edge depths, scaling, time and independence.
Native Chromium tests verify changing sideband energy, unity-envelope/legacy equality, exact
repeat determinism and baked/runtime parity. Release checks include typecheck, the golden
matrix, full suite, measured/look-reviewed study renders, asset manifest and desktop/mobile
Pages-subpath browser checks. The wiki records sources, implementation and actual listening status.
