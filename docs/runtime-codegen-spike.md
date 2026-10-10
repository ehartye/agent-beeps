# Runtime path spike: one patch, two deliveries

Status: spike, experimental, branch `spike/runtime-codegen`. Nothing here is released; the new patch key is `xRuntime`.
I cannot listen to audio. Every claim below is a measured feature, a sample comparison, a graph comparison or a look image;
none is a claim that anything sounds good. Evidence files are in `docs/runtime-codegen-spike/`.

## Question

Can agent-beeps serve (1) baked assets (exists) and (2) a runtime path, where a game builds the sound in its own
AudioContext with named inputs (speed, size, distance, seed) bound to patch parameters, from one patch source, with the craft
knowledge (lint, loudness, measure, audition) shared? The proposed design was generated per-patch modules
`build(ctx, out, params, seed)` (option B). The alternatives were a shared interpreter (A), both (C), or baked only plus a lint
bridge for the game's own synth (D).

## Short answer

Yes, and the surprise is that the interpreter already exists: it is the renderer. `runtime/engine/patch.js` and seven siblings
turn a patch into a Web Audio graph on any `BaseAudioContext`, using nothing but node factory methods. The baked path is "run
that in headless Chromium, trim, encode". What was missing for a game is: named inputs, live handles, held voices, a vendoring
command, types. I built those, and I also built option B, then measured both.

* Parity: baked, interpreter and generated module are **bit-exact to each other** in Chromium and in Firefox for every static
  binding, with 5 fresh-page repeats each producing one distinct output. Live inputs differ from a bake of the same value by
  at most -82 dBFS (Chromium).
* CPU: generated code is **not faster** than the interpreter (medians within 0.1 ms). Building a cue costs 0.4 to 0.7 ms of
  graph construction, plus about 2 to 4 ms for each per-voice reverb and about 4 ms for a grain cloud. That is the real runtime cost.
* Size: both are ~8 to 10 KB gzipped for 18 cues. The same 18 cues baked as Opus are 117.7 KB.
* Recommendation: **A (interpreter) as the product**, generated typed declarations from B's emitter (cheap, the useful part),
  keep B's module emitter as an opt-in only if a game measures a need, and **D in parallel** because the game's ADR-014
  asks for it and it costs days. Details and what would kill it are in the last section.

## 1. Architecture: is the renderer separable from the harness?

Yes. The patch to graph code is `runtime/engine/{patch,layer,sources,fx,sum,rng,notes,variation}.js`: 932 lines of
JSDoc-typed ES modules. I grepped them for `window`, `document`, `process`, `OfflineAudioContext`, `fetch`, `setTimeout`,
`performance`, `Math.random`, dynamic `import(`: no hits (the only `import(` text is JSDoc type imports). They call
`createGain/Oscillator/BufferSource/BiquadFilter/WaveShaper/StereoPanner/Convolver/Delay/IIRFilter/PeriodicWave/Buffer` and read
`ctx.sampleRate`. `structuredClone` is used by `variation.js`. Everything random is a seeded mulberry32 (`rng.js`).

Harness-only pieces (not needed by a game): `runtime/render.html` and `runtime/engine/offline.js` (the 4-channel
delivered/authored tap layout, base64 transfer), `src/render/host.ts` (Playwright, static server), `src/render/pipeline.ts`
(loudness trim by measurement), `src/measure/*`, `src/lint.ts`, look rendering. `beeps player export` vendors only `fx, rng,
variation, notes` (the player plays files); the README already says games can import the engine, nobody can do it conveniently
(no vendoring command, types point at `src/schema/patch.ts`/zod), and ADR-014 in the game says "if agent-beeps gains a documented
runtime engine export" and treats it as not existing.

Determinism: this tree (0.9.0) has no `E_NONDETERMINISTIC`. Determinism is `sum.js` (fixed-order two-input gain chains so Chromium's
per-run connection order cannot change float sums) plus `tests/render/determinism.test.ts`. The runtime path inherits it
because it runs the same graph code.

What a runtime export ships (`beeps runtime emit`, measured with rolldown, minified, tree-shaken):

| Shipped | Minified | gzip | brotli |
|---|---|---|---|
| A: interpreter alone (`createVoice`, `buildPatch`, all 8 source types) | 17,366 B | 6,700 B | 6,138 B |
| B: kernel alone (what any generated module pulls in) | 1,513 B | 876 B | 806 B |

Files vendored: `engine/{gen,params,sum,rng,notes,sources,fx,layer,version}.js` + `voice.d.ts` for B; add
`live,patch,variation` for A. `layer.js`/`sources.js` carry the interpreter's builders too; a bundler drops them for B.

**Bundle growth for N cues** (the 18 sci-fi library patches, no inputs bound; `scripts/runtime-size.mjs`, `size-scifi18.json`):

| N cues | A interpreter + N patches as data (gz) | B generated modules (gz) | Baked Ogg Opus 72 kbps |
|---|---|---|---|
| 1 | 6,964 | 2,065 | ~6.5 KB each |
| 3 | 7,541 | 4,680 | |
| 5 | 7,915 | 5,776 | |
| 10 | 8,516 | 7,236 | |
| 18 | 9,618 (br 8,494) | 9,822 (br 7,800) | 117,690 (15.0 s of audio; WAV 2.89 MB) |

Interpreter slope: ~0.17 KB gz per cue; generated slope: ~0.5 KB, up to 2 KB for a 7-layer cue. Crossover is near 18 cues in
gzip and already past it in brotli, in the interpreter's favour above that. Both are an order of magnitude under baked.

## 2. The prototype

**Schema** (`src/schema/patch.ts`, experimental, optional, name `xRuntime` so it is hard to miss and cheap to remove):

```json
"xRuntime": {
  "delivery": "both",              // baked | runtime | both   (informational today; drives `build` later)
  "hold": true,                    // sounds until release(), instead of ending at `duration`
  "inputs": { "speed": { "min": 0, "max": 1, "default": 0.4 } },
  "bind": [
    { "input": "speed", "target": "/out/transpose",  "range": [-5, 12],  "live": true },
    { "input": "speed", "target": "/out/brightness", "range": [-1, 1.5], "live": true },
    { "input": "speed", "target": "/layers/2/gainDb", "range": [-9, 9],  "live": true },
    { "input": "size",  "target": "/layers/*/amp/decay", "range": [-0.6, 0.7], "clamp": [0.01, 2] }
  ]
}
```

The rule that keeps the two deliveries honest: **the authored patch is the value at each input's `default`.** A binding stores
a delta, `f(v) - f(default)` with `f` a lerp from `range[0]` at `min` to `range[1]` at `max` (optional `shape` quad/sqrt),
applied in the target's natural unit: dB and plain numbers add; Hz and seconds multiply by 2^delta (octaves); `/out/transpose`
is semitones. So at the defaults the runtime graph is the authored graph, and everything measured about the patch is true of the
runtime path there. Targets are JSON pointers (`*` for every layer; any number in the patch, array indexes included) or three
macros every game wants: `/out/gainDb` (the trim stage), `/out/transpose` (every pitched source and pitch envelope),
`/out/brightness` (every filter cutoff and cutoff envelope). Validation happens in `parsePatch` (so `beeps new` reports it with
a pointer): undeclared inputs, missing targets, non-live targets marked live, a default outside its range, and **every input at
min, at max and each end alone must still produce a valid patch** (else add `clamp`). Existing patches are untouched: all
shipped patches parse as before, and `patchRenderKey` ignores `xRuntime`, so editing a binding never re-bakes (tested).

**Voice API** (same for interpreter and generated module; `runtime/engine/voice.d.ts`):

```js
const v = build(ctx, out, { speed: 0.4 }, seed, { when, variant, scale, trimDb, limiter, tap });
v.set('speed', 0.9, at, tau);   // live inputs: automates a parameter the graph already has; no node is created
v.release(at);                  // hold voices; returns when silent (reverb tail included)
v.stop(fade);  v.end;           // fade + disconnect; context time the voice is silent
```

Live inputs are restricted to parameters the engine never schedules itself, so they cannot fight an envelope: layer gain,
pan, an oscillator's `detune` (pitch, in cents, which sums with unison spread and pitch LFO), a biquad's `detune` (cutoff, in
cents, which sums with a filter envelope), LFO rate, send gains, the trim gain. At the starting value they are a plain
`.value` write, scheduling nothing. Anything baked into automation or buffers (amp times, envelope shapes, grain rate, noise
colour, reverb preset, unison count) can only be a static input.

**Engine changes** (additive, `hold`, node references, exported `grainBuffer`/`exciterBuffer`): I rendered 88 reference
cases (the 18 library patches at their kit seeds, variants 0 and 1, plus 2 samples of each of 26 archetypes) through the
production render host before and after: all 88 hashes identical.

**The five patches** (`library/sounds/runtime-spike/`): `comet-blaster` (laser: saw + FM + pink noise, drive, filter
envelope, pitch envelope, reverb), `asteroid-burst` (explosion: white/brown/pink noise, Poisson grains, modal, highpass,
reverb), `hyperdrive-charge` (sine + FM + additive + bandpass noise, filter and pitch envelopes), `shield-ripple` (FM + LFO gain
tremolo, pan, bandpass envelope, reverb), `engine-drone` (new: held saw unison + sub + brown noise bed, all inputs live). Four
are copies of the sci-fi library patches with only `xRuntime` added, using the library's kit seeds and the pipeline's
measured trims (which equal the kit's: -5.56, -2.42, -13.76, -8.36).

**Option B emitter** (`src/codegen/emit.ts`, 413 lines): per patch, straight-line `build()` with every decision the patch makes
taken at emit time (source type, which layers have a filter, partial counts); only what an input, a variant or the caller's scale
can change stays an expression. Imports only `../engine/gen.js`; contains no patch data (tested). Unsupported: the `voice`
source (it throws, naming the pointer), so voice patches stay baked or interpreted.

Look images (spectrogram + envelope, baked vs runtime, same seed; I viewed all six): `docs/runtime-codegen-spike/looks/`.
Comet blaster at `size=1, distance=0.6`: both read pitch 94 Hz, -28.4 LUFS, TP -14.6 dB, centroid 268 Hz, identical pictures.
Engine drone at `speed=1, load=1`: both read 99 Hz, 2.00 s, -12.6 LUFS, identical pictures. Asteroid at `size=0.1`: identical.

## 3. Parity measurement

Method (`beeps runtime parity`, `src/codegen/parity*.ts`): each cue, in a fresh page per run of the same browser, through (i)
the baked path (the patch with every binding applied as a fixed number, rendered by the same `renderOfflinePcm` the host uses;
for Chromium additionally cross-checked bit-for-bit against the production `openRenderHost().render`), (ii) the interpreter,
(iii) the generated module; same seed, kit trim, scale; 4-channel OfflineAudioContext (delivered and authored taps). Cases per
cue: defaults; variant 2 with another seed; all inputs at min; at max; and for live cues max with scale snap off. Compared:
max |a-b|, RMS of the difference relative to the reference, correlation, differing sample count, and the repo's `measure`
features (loudness, peaks, centroid, envelope length, attack, tail, crest, flatness, sharpness, roughness, pitch). Each path
repeated 5 times in fresh pages and its outputs hashed. Negative control: the module at seed+1 must differ from the bake
(it did in all 50 cases), so the comparison can fail. Chromium 153.0.8010.12, Firefox 155.0 (`parity.json`, 6 min 8 s).

**Same browser** (25 cases per browser):

| | Chromium | Firefox |
|---|---|---|
| gen and interp bit-exact vs baked (all samples, both taps) | 22 / 25 | 22 / 25 |
| distinct outputs over 5 repeats, any path | 1 | 1 |
| harness bake == production host bake | 25 / 25 | n/a |
| the 3 non-exact cases | all `engine-drone` with live inputs moved | same |

The 3 non-exact are the live-bound drone. With the project scale on, the bake snaps the transposed pitch to the scale
(99.2 to 98 Hz) and a live detune cannot, so they differ by design (max -7.8/-3.4 dBFS, correlation negative, features within
0.1 LU, 1 Hz centroid and 1.1 Hz pitch). With scale snap off, the live voice (inputs applied as detune cents before the first sample)
against the bake of the same values: **max |diff| -81.7 dBFS (Chromium), -95.0 dBFS (Firefox); RMS diff -88 / -102 dB relative;
correlation 1.00000; every measure feature identical** (no feature moved by more than its rounding).
Hold mode: `release(duration)` reproduces the baked render to the bit (defaults and variant cases).

**Mid-note moves** (`beeps runtime live`, `live-engine-drone-unison.json`): speed 0.4 to 1 at 0.5 s, tau 30 ms, single voice
(unison off, explained below): pitch 55 Hz to 99.19 Hz vs 99.17 Hz for a static bake; loudness -7.88 vs -7.85 LUFS; centroid
157.1 vs 157.8 Hz; largest sample step around the move 1.36x the larger static bake's (about what the pitch rise alone gives);
tau 0.1 ms makes it 2.45x, an audible-risk step, so the default tau is 20 ms. With the 3-voice unison stack the settled window
differs from a bake by up to 1.7 LU and 27 Hz centroid: a voice that glided and one born at the final pitch have different
unison beat phase (0.45 Hz vs 0.8 Hz beat). That is physical, not an error, but it means a live pitch input cannot be matched
to a bake by a 250 ms window; match by feature over whole beat periods.

**Cross-browser** (`parity.json`, Firefox vs Chromium's bake, same case): tonal, non-sweeping cues agree closely
(hyperdrive-charge: -50 to -55 dB relative, correlation 1.0000, loudness delta 0 LU, centroid delta 0 Hz; shield-ripple
-49 to -50 dB, 0.00 to 0.01 LU; engine-drone -51 to -62 dB, 0.02 LU). Noise-and-sweep cues do not match sample for sample
(asteroid-burst correlation -0.5 to 0.5, comet-blaster -0.00 to 0.42), and at feature level move by up to 0.99 LU (comet-blaster
defaults/variant), 0.33 LU (asteroid-burst max) and up to 31 Hz centroid (comet-blaster, max, no snap). I did not isolate which
primitive diverges (my guess is exponential-ramp phase accumulation in chirps and `Math.exp/log` ulps in the grain cloud, unverified).
**WebKit**: Playwright's WebKit on this Windows machine has no `OfflineAudioContext`; reported `no-web-audio`, not passed. Safari
is unmeasured.

**Honest tolerance.**
* Same browser build, static inputs: bit-exact. Require it; it is achievable and `verify` can fail on any difference.
* Same browser, live inputs, no scale: max |diff| below -75 dBFS, correlation above 0.99999, every feature within rounding
  (tests assert that).
* Across browsers: do not compare samples. Compare features: loudness within 1 LU, centroid within ~5% or 30 Hz, same
  pitch, no new lint finding. A game on Firefox hears the Chromium bake only that closely, for cues with sweeps and noise.

## 4. Runtime concerns, measured

`beeps runtime perf`: build N=80 voices of each cue into one context; `first` is the cold build (JIT, noise buffer, reverb IR),
`med/p95` the warm builds. Chromium, offline context; the same in a running `AudioContext` (headless, state `running`:
`perf-realtime.json`, within noise). Machine: this Windows desktop, not a phone.

| cue | nodes | warm median (A / B) | p95 | first | notes |
|---|---|---|---|---|---|
| engine-drone | 36 | 2.5 / 2.4 ms | 2.9 | 15 ms | small reverb |
| comet-blaster | 46 | 2.7 / 2.6 | 3.2 | 19 | 2 noise layers, reverb |
| hyperdrive-charge | 59 | 2.7 / 2.7 | 3.3 | 15 | |
| shield-ripple | 56 | 5.2 / 5.1 | 5.7 | 23 | |
| asteroid-burst | 64 | 10.2 / 10.2 | 11.5 | 39 | grains + reverb |

* **Interpreter vs generated: no difference** (every row within 0.1 ms). Interpretation overhead is invisible next to
  Web Audio node creation, so codegen buys no CPU.
* **Where the time goes** (earlier run, same machine, patch edited): removing the reverb from shield-ripple takes it from
  4.3 to 0.4 ms; removing grains from asteroid-burst takes 8.7 to 4.3 ms; removing both gets 0.6 ms for 54 nodes. A
  ConvolverNode per voice is ~4 ms; a grain cloud is ~4 ms and 233 KB of fresh `AudioBuffer`. A game must send voices to its
  shared reverb bus instead of a per-voice convolver (the engine builds one per patch with `fx.reverb`; a `dry + send tap`
  option is the first follow-up).
* **Voices per frame**: warm builds of 2.5 ms mean 6 per 16.7 ms frame if the frame did nothing else; at a 1 to 2 ms audio
  budget that is under one such cue per frame; a reverb-less cue (0.4 to 0.7 ms) allows 2 to 4. Spawning must be spread or
  capped, as the game's director already does.
* **Garbage**: 36 to 64 nodes per cue plus the limiter shaper. With a fixed seed the warm builds allocate no buffers except
  grain clouds (233 KB). **A per-play seed is expensive**: `noiseBuffer` is cached per context by `colour:seed`, 2 s mono =
  375 KB, so a game that passes a fresh seed per shot allocates 375 KB per noise layer per play, retained until the context
  dies (cache is a `WeakMap` keyed by context, no eviction), and warm medians rise to 3.4 to 15 ms (`perf-vary-seed.json`).
  Variation should come from `variant` (4 to 16 declared, no new buffers) with a handful of fixed seeds, or the noise cache
  needs a bound; this must be fixed before a game ships on it.
* **Bundle growth** for N cues: section 1 table.
* **Seed variation**: `seed` selects the noise/grain content and (with `variant`) the pitch/gain draw. Side finding: with the
  project scale snapped (`snap: true`) pitched layers collapse to the scale note, so `variation.pitchCents` does nothing:
  comet-blaster's first oscillator is 880.00 Hz for variants 0 to 3 (902.86, 902.18, 903.59, 904.98 with snap off), shield-ripple
  196.00 Hz for all. The same snap quantises continuous static pitch inputs. For continuous-pitch cues pass no scale (or
  `snap:false`); passing the game's world scale gives degree-quantised pitch inputs for free.
* **Mid-note parameter changes**: yes, live handles exist, are node-free, and are tested (section 3, `tests/codegen/live.test.ts`:
  events are exactly `cancel` + `target` on `detune`/`gain` params; none on envelope or frequency params).

## 5. How the shared craft knowledge keeps working

| Command | Effect of the runtime path |
|---|---|
| `lint`, `measure`, `look`, `render`, `export`, `generate`, `mutate`, `kit`, `audition`, `taste` | **Unchanged.** They see the patch (the `xRuntime` key is ignored, and excluded from the render key). Baked bytes and locks do not move. The audition plays the bake at the defaults, which the game plays bit-exactly. |
| `beeps runtime check <patches>` (new) | Lints the patch where the runtime path can take it: defaults, each input at min/max alone, all min/all max. Renders each twice: normalised (spectral rules) and at the default's fixed trim plus the binding's own gain delta (what the game plays), checked for true peak and clipping, with the loudness spread reported. Real result: `asteroid-burst` at `size=max` raises a `no-dc` error the default does not have; `engine-drone` spans -2.3 to +5.5 LU around its default; `comet-blaster` at `distance=max` is -17.7 LU. |
| `beeps runtime verify <dir> <patches>` (new) | Module current? Patch hash, engine version, and byte-identical against a fresh emit. Exit 1 on drift. |
| `beeps runtime parity` (new) | The measurement above. Needs Chromium. |
| `beeps taste` | Unaffected. Owner picks stay about the patch at defaults. Auditioning an input range needs corner patches in a set (`runtime check` already builds them; wiring them into `set create` is not done). |

The baked pipeline normalises every render to the project loudness target, which erases exactly what a runtime input
legitimately changes (level). That is why `check` renders at fixed trim as well; a `loudness-target` finding at a corner is
expected and is excluded.

**`beeps build` and `delivery`** (designed, not implemented): `recipes[id].delivery` (default `baked`; or the patch's
`xRuntime.delivery`): `baked` = today. `runtime` = no WAV/Opus; the recipe emits a module/patch JSON into `out/beeps-runtime/`.
`both` = ship both. Lock: add a `runtime` part to `planAsset`'s input hash (`src/build/plan.ts`: sha256 of the emitted module
text, which is deterministic, plus the engine version; the `renders` part already ignores `xRuntime`), and a `runtime` entry per
asset in `audio.lock.json` with the module's sha256. `beeps verify`: module hash against the lock, and with `--parity` (needs
Chromium) the `both` cues' default-input renders baked vs runtime must be bit-exact, else `E_VERIFY` (a toolchain change is the
usual cause, handled like `E_TOOLCHAIN`). `ci export`/`fetch.mjs` are untouched: modules are text, committed or stored by hash
like any asset; the store needs no change.

## 6. Options

| | A shared interpreter | B generated code | C both | D baked only + lint bridge |
|---|---|---|---|---|
| **Time** | Productionise in 2 to 3 days (spike has it); no lag later | ~1 to 1.5 weeks (voice source, remaining options, docs); every engine change needs an emitter change | A + B, plus the harness | 1 to 2 days (`lint`/`measure` accepting a game's offline-rendered WAVs and a family) |
| **Risk** | Low: it is the renderer, parity by construction (bit-exact measured) | Medium: second transcription; drift is caught by the graph-isomorphism tests (89 patches) and `verify`, but only if CI runs them | Medium | Low; does not give authoring-time sharing |
| **Complexity** | Lowest: one graph builder | +413-line emitter, +typed outputs, unsupported-source gaps | Highest | Low |
| **Best practice** | Normal (data-driven interpreters; one source of truth) | Normal too (compile to code); better for dead-code elimination | Defensible as oracle + product | Weakest: craft rules apply after the fact to hand-tuned code |
| **Maintainability** | One path; ~17 KB min. to carry | Two paths that must stay isomorphic; readable straight-line output | Both burdens | The game keeps hand-writing every cue (its `sfxVoices.ts` is 550 lines for 20 cues) |
| **Measured benefit** | CPU = B; size 6.7 KB gz fixed + 0.17 KB/cue | CPU = A; size 0.9 KB gz + 0.5 KB/cue | | n/a |

**Recommendation: A first, D alongside, B deferred.** B's measured advantages over A are small: no CPU difference, a few KB
of gzip below ~15 cues, typed input names (which A can have too, by emitting only the `.d.ts`), and a reviewable graph. Its
costs are a permanent second implementation. B was worth building as the parity oracle (the isomorphism test needs a second
builder to compare against, and it found no divergence), not obviously as the product. C is only worth it if a game's size
budget demands B's per-source tree-shaking.

**What would kill the idea**
* A game that cannot route voices to a shared reverb bus (4 ms per voice per convolver) and needs more than 1 to 2 voices a
  frame. Mitigation is designed (dry output + send tap), not built.
* A game that varies sounds by a fresh seed per play without the noise-cache fix (375 KB per noise layer per play).
* Needing sounds the patch vocabulary cannot express (the game's own `bell`/creature-call voices); the `voice` source works
  in the interpreter but not codegen.
* Cross-browser tolerance stricter than ~1 LU / 30 Hz centroid for sweep and noise cues (measured on Firefox), or Safari
  lacking something (unmeasured).
* The game's CI refusing a vendored engine folder (ADR-010 is about audio assets; patches and a JS engine are not samples, but
  `noAudioAssets.test.ts` should be checked against vendored JSON).

**Staged plan**
0. Done (this spike): schema, interpreter voice, generated modules, parity/perf/live/check/verify/look, 130 tests.
1. (S, 2 to 3 d) Productionise A: `beeps runtime emit --interpreter` as the documented engine export (README, `game-player.md`,
   beeps-ship skill), generated per-patch `.d.ts` for input names, `onEnded`, bound the noise cache, `fx: 'bus'` (dry + send),
   decide whether `xRuntime` graduates to `runtime`.
2. (S, 1 to 2 d, parallel) D: `beeps lint --wav` for the game's offline cue renders (ADR-014 names this).
3. (M, ~1 wk) Build integration: `delivery` in recipes, lock `runtime` part, `verify --parity`, `runtime check` as `lint --runtime`,
   corners into `set create` for audition.
4. (M, ~1 wk, in the game, owner authorised) Pilot: replace 2 to 3 hand-written cues (gun, beam tick, an engine bed) with
   patch voices through `AudioDirector`; the owner listens, since I cannot.
5. (optional, M to L) B as a supported emitter only if a size budget demands it; add the `voice` source.

## What I could not verify
* Anything by ear: that the five patches, their input ranges, or the `engine-drone` sound good or sound like engines.
* Safari/WebKit (no OfflineAudioContext in Playwright WebKit here), mobile CPU, sustained polyphony and glitching under
  real load, real audio-device behaviour (headless uses a null sink).
* Why Firefox diverges sample-wise on sweeps and noise (hypothesis only).
* Actual integration in the game (no `no-claudes-sky` file was touched; I read `sfxVoices.ts`, `voices.ts`, `offline.ts`, ADR-010/014).
* Baseline suite: `tests/audition/album-page.test.ts > saves the captured moment` failed on the untouched checkout
  (timing assertion `35 < 35`, unrelated, while I ran other work); it passed in the final full run: 842 passed, 1 skipped, `tsc --noEmit` clean.

## Reproduce
```text
cd library/sounds/runtime-spike
beeps runtime emit patches/*.json --out /tmp/rt --project-file project.json --kit kit.json --interpreter
beeps runtime verify /tmp/rt patches/*.json --project-file project.json --kit kit.json
beeps runtime parity patches/*.json --project-file project.json --kit kit.json --engines chromium,firefox --runs 5
beeps runtime perf patches/*.json --project-file project.json --kit kit.json [--vary-seed | --realtime]
beeps runtime live patches/engine-drone.json --input speed --to 1 --project-file project.json --kit kit.json
beeps runtime check patches/*.json --project-file project.json --kit kit.json
node scripts/runtime-size.mjs --ns 1,3,5,10,18 --baked
```
