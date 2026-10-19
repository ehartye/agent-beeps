# The runtime path: one patch, two deliveries

A patch ships as a **baked** file (a WAV or Opus the game plays) or as a **cue** the game plays **live**: it builds the
sound in its own `AudioContext`, with named inputs (speed, size, distance) bound to patch parameters and a seed that varies
it. Both come from the same patch, through the same graph code, and are checked against each other. The craft rules
(`lint`, loudness, `look`, audition, taste) apply to both because they apply to the patch.

I cannot listen to audio. Every claim here is a measured feature, a sample comparison or a look image, never a claim that
anything sounds good.

## Pick a delivery

| | `baked` | `runtime` | `both` |
|---|---|---|---|
| You ship | `<id>.<n>.ogg` + sidecar, in the catalog | `<id>.runtime.json` plus any prepared sample WAVs | both |
| The game | plays a file | builds nodes: 0.4 to 10 ms of main-thread time per play | picks per use |
| Inputs that move while it sounds | none | yes (`live` bindings) | the runtime copy |
| Size for 18 sounds | 118 KB (Opus 72 kbps) | 10.5 KB gzip including the 7.9 KB engine | both |
| Variation | declared variants, one file each | any seed, any variant, any input value | both |
| Browser differences | codec only | graph code: bit-exact in one browser build, features across browsers | both |
| Works offline in `beeps verify` | sha256 and headers | sha256, schema, engine, `--parity` | all of it |

The size/cost measurements above describe procedural cues. Recorded-source cues also carry their
prepared WAV bytes and require an explicit asynchronous load before a voice starts. A ten-second
stereo Float32 source alone is 3840044 bytes; it does not shrink when the baked bitrate drops.

Choose **runtime** when the sound is a function of game state: an engine whose pitch follows speed, an impact whose weight
follows mass, a tick that gets faster, a creature whose size is a parameter, a sound you would otherwise bake dozens of
variants of. Choose **baked** for everything else: one-shots with no input, sounds with a long tail or heavy noise and grain
content (building a grain cloud costs about 4 ms and 233 KB), music, and anything that must not cost main-thread time in a
busy frame. Choose **both** when a sound has a cheap baked form for the common case and a live form for the interesting one,
or while you are moving a game from one to the other: `beeps verify --parity` then proves the two stay the same sound.

A patch that declares no `xRuntime` block still plays at runtime, at its authored values; there is nothing to move.

## The `xRuntime` block (stable `beeps/patch@1` extension)

```json
"xRuntime": {
  "delivery": "both",
  "hold": true,
  "inputs": {
    "speed": { "min": 0, "max": 1, "default": 0.4, "description": "0 idle .. 1 full burn" }
  },
  "bind": [
    { "input": "speed", "target": "/out/transpose",  "range": [-5, 12],  "live": true },
    { "input": "speed", "target": "/out/brightness", "range": [-1, 1.5], "live": true },
    { "input": "speed", "target": "/layers/2/gainDb", "range": [-9, 9],  "live": true },
    { "input": "size",  "target": "/layers/*/amp/decay", "range": [-0.6, 0.7], "clamp": [0.01, 2] }
  ]
}
```

The key is optional and ignored by every baked command: a patch without it, and the same patch with it, render to the same
bytes, have the same render key, and lint the same. Editing a binding never re-bakes anything.

**The rule that keeps the deliveries honest: the authored patch is the value at each input's `default`.** A binding stores
a *delta*, `f(v) - f(default)`, where `f` is a lerp from `range[0]` at `min` to `range[1]` at `max` (optional `shape`:
`quad` or `sqrt`). At the defaults the runtime graph is the authored graph, so everything measured about the patch (loudness,
lint, look, audition) is true of the runtime path there.

| Field | Meaning |
|---|---|
| `delivery` | what the patch ships as unless the build recipe says otherwise: `baked` (default), `runtime`, `both` |
| `hold` | the voice sounds until `stop()` instead of ending at `duration` (engine beds, held tones). `stop()` releases with the layers' own `amp.release` |
| `inputs` | name (camelCase) to `{ min, max, default, description? }`. `default` lies inside `[min, max]` |
| `bind[].input` | a declared input |
| `bind[].target` | a JSON pointer into the patch (`*` for every layer; any number, array indexes included), a list of them, or a macro |
| `bind[].range` | the binding's value at the input's `min` and `max` |
| `bind[].shape` | `linear` (default), `quad`, `sqrt` |
| `bind[].unit` | `db`, `lin`, `oct`, `st`; default from the target's name |
| `bind[].live` | automate the running voice with `set()`; otherwise the value is fixed when the voice starts |
| `bind[].clamp` | keep the bound number in `[min, max]` (use it when an input corner would make the patch invalid) |

Units: dB and plain numbers add. Hz and seconds (cutoff, pitch, rate, attack, decay, release, start, duration, highpass,
time, q, centre) multiply by 2^delta, so the range is in octaves. Macros every game wants, defined once so a static and a live
binding agree: `/out/gainDb` (the trim stage, dB), `/out/transpose` (every pitched source and pitch envelope, semitones),
`/out/brightness` (every filter cutoff and cutoff envelope, octaves).

**Static or live.** A static binding changes the number the graph is built with (envelope times, grain rate, noise colour,
unison, anything baked into automation or buffers) and can only be set before `start()`. A live binding automates a
parameter the graph already has and the engine never schedules itself, so it cannot fight an envelope and creates no node:
a layer's `gainDb` and `pan`, a filter cutoff, an LFO rate, the reverb and delay sends, the macros. An oscillator's pitch moves
through its `detune`, in cents, which sums with unison spread and a pitch LFO.

**Validation** happens in `parsePatch` (so `beeps new` reports it with a pointer): an undeclared input, a target the patch
lacks, a non-number target, a live binding to something the graph does not automate, a default outside its range, and **every
input at its min, at its max and each end alone must still produce a valid patch** (else narrow the range or add `clamp`).

### Pitch, variants and the scale

The project scale (`snap: true` by default) decides which note a pitched sound is: the authored pitch snaps to it. Offsets
then move it from there, **after** the snap: a variant's `variation.pitchCents` detune, and live `/out/transpose` bindings.
(Before engine fix, a snapping scale applied the variant's cents first and snapped them away, so `pitchCents` did nothing in
a default project: a comet blaster's first oscillator was 880.00 Hz for variants 0 to 3. See "Compatibility".)
A static `/out/transpose` or `/pitch` binding changes the authored note itself, so the scale quantises it like any authored
pitch. For a continuous pitch input (an engine), make it live, or pass `scale: null` to `build`.

## The cue

`beeps build` writes `<id>.runtime.json` (`beeps/runtime-cue@1`) for a recipe whose delivery is `runtime` or `both`: the
parsed patch, the seed the baked asset uses, the project scale, the engine version and the loudness trim the baked pipeline
measured for that seed, so the live voice plays at the level of the exported file at the input defaults. The cue is
canonical JSON, one line, and byte-identical for identical inputs. `beeps runtime export <patches> --out <dir>` writes the
same files by hand.

## Playing it

The page below has `#play`, `#stop` buttons and a `#status` text element. Set `cueURL` to the
actual cue location, including your static project subpath. Load/parse the cue before enabling Play.

```js
import { build, parseCue, loadCueAssets } from 'agent-beeps-runtime';

const ctx = new AudioContext();
const out = ctx.destination; // or your master gain
const playButton = document.querySelector('#play');
const stopButton = document.querySelector('#stop');
const status = document.querySelector('#status');
let cueURL = new URL('/audio/contact-hybrid.runtime.json', location.href);
let cue = parseCue(await (await fetch(cueURL)).json());
let generation = 0, pending, voice, cached;

function stop() {
  generation++;
  pending?.abort();
  pending = undefined;
  voice?.dispose();
  voice = undefined;
  status.textContent = 'Stopped';
}

playButton.onclick = async () => {
  stop();
  const mine = generation;
  const controller = pending = new AbortController();
  const selectedCue = cue, baseURL = cueURL;
  status.textContent = 'Loading';
  try {
    await ctx.resume(); // called within this user gesture, before awaiting asset I/O
    if (mine !== generation || controller.signal.aborted) return;
    const samples = cached ?? await loadCueAssets(ctx, selectedCue, {
      baseURL, signal: controller.signal,
    });
    if (mine !== generation || controller.signal.aborted) return;
    cached = samples; // verified immutable buffers, for this cue and context only
    voice = build(ctx, out, selectedCue, { samples, onEnded() {
      if (mine === generation) { voice = undefined; status.textContent = 'Stopped'; }
    } }).start(); // build a fresh voice on EVERY play; a voice starts only once
    status.textContent = 'Playing';
  } catch (error) {
    if (mine === generation && !controller.signal.aborted) {
      status.textContent = `Playback failed: ${error.message}`;
    }
  } finally {
    if (pending === controller) pending = undefined;
  }
};
stopButton.onclick = stop;

// When selecting another already-fetched cue, cancel the previous play/loading first.
function selectCue(nextCueJson, nextURL) {
  stop();
  cue = parseCue(nextCueJson);
  cueURL = new URL(nextURL, location.href);
  cached = undefined;
}
```

`loadCueAssets(ctx, cue, { baseURL, signal, fetcher? })` fetches exactly the cue's prepared-source
closure, checks bounded byte counts, hashes and canonical WAV metadata, then returns hash-keyed
`AudioBuffer`s. It works on HTTP LAN origins without WebCrypto. A procedural cue returns an empty
map. It has no automatic cache: keep verified buffers immutable and cache them only for the current
cue/context, never a started voice. Abort and generation checks around both `resume()` and the loader
prevent Stop/replacement from playing obsolete work. Show loading until the voice actually starts.

`build` is synchronous and performs no I/O. It requires the prepared `samples` map for sample layers;
it does not fetch missing assets or silently fall back to a baked file. For a procedural-only cue,
`samples` can be omitted. Optional starting inputs still go in `params`, e.g. `{ speed: 0.4 }`;
`voice.set('speed', 0.9)` moves a declared live input after start.

* `build(ctx, out, patchOrCue, opts)`. `opts`: `seed` (default the cue's), `params` (starting inputs; unknown names throw),
  `variant`, `trimDb` (default the cue's), `scale` (default the cue's project scale; `null` for none), `limiter` (default
  true), `hold`, `tap`, `reverb`, `onEnded`, `samples` (verified, immutable hash-keyed buffers). A patch must be **parsed** (defaults filled): raw JSON goes through `parsePatch`
  from `agent-beeps-runtime/schema`; a cue already is.
* `start(at?)` creates every node. That is where the cost is (below); `build` is cheap, and a voice plays once.
* `set(name, value, at?, tau?)` before `start` takes any input; after it, only inputs whose bindings are all `live` (it
  throws otherwise, and says which). Values outside `[min, max]` are clamped.
* `stop(at?, fade?)` returns the context time the voice is silent. `end` is that time, effect tails included (a shared bus's
  tail is not the voice's), `Infinity` while a held procedural voice is held, `undefined` before `start`. Finite sample
  exhaustion starts its authored release even with `hold`; envelopes and effects can outlast the source.
* `onEnded` fires once when the voice is over, however it ended. A silent, unconnected `ConstantSourceNode` carries the
  event; it adds nothing to the audio path.
* `dispose()` stops every source and cuts the voice from its output and sends, so the browser can collect the graph. It is
  not a fade.

### Prepared-source cues (engine 4)

A sample layer is `{ source: { type: 'sample', asset: 'sha256:<64 lowercase hex digits>' }, ... }`.
The cue's optional `assets` map must be exactly the distinct sample IDs its patch references; every
entry records a safe relative WAV filename, byte count, 48000 Hz rate, one/two channels and frame count.
`parseCue` validates that manifest without I/O. `loadCueAssets` verifies the actual files separately;
`build` uses the resulting buffers through the same source graph as offline renders.

Each prepared source is 1–480000 frames (up to ten seconds), mono/stereo canonical Float32 WAV.
Imports retain originals up to 64 MiB and normalized source snapshots up to 120 seconds for local
preparation. The patch has up to eight layers total. Samples are finite, unpitched one-shots;
pitch envelopes/pitch LFOs on sample layers, sample loops/stretching and song sample instruments
are unsupported. Gain/cutoff LFOs and ordinary layer processing remain available. Transpose/pitch
variation affects procedural pitched layers, not sample playback rate. Attenuating an already clipped
source does not restore its transient. [Authoring and portable exchange](../skills/beeps-compose/references/hybrid-sources.md).

### A shared reverb bus

A patch with `fx.reverb` builds a `ConvolverNode` per voice, about 2 to 4 ms of main-thread time each. A game with many
voices sends them to one bus it owns instead:

```js
const bus = createReverbBus(ctx, master, { preset: 'hall', returnDb: -2 });
build(ctx, master, cue, { reverb: bus }).start();              // every voice with a reverb sends to this one
build(ctx, master, cue, { reverb: { hall: bus, room } })        // or by preset; a preset it lacks keeps the voice's own reverb
```

The voice keeps its dry path and adds a send gain into `bus.input`; the send carries the loudness trim so the wet signal is as
loud as inside a voice with its own reverb. The wet signal skips the voice's safety clipper and the authored tap, a live
`/fx/reverb/sendDb` binding still moves the send, and the bus uses the same impulse response as a voice's own reverb. One
bus takes every voice whatever preset its patch asked for: the game owns the room.

### Per-play seeds and memory

`seed` selects the noise and grain content and, with `variant`, the pitch and gain draw. A fresh seed per play builds a
fresh 2 s noise buffer (375 KB mono, 750 KB stereo) per noise layer. The engine keeps those buffers in a per-context cache
with a **byte budget (16 MiB by default, least recently used first)**, so a long session of fresh seeds holds at most that
many; a buffer a voice is still playing is held by its source node, so eviction never cuts a sound. Variation from
`variant` (declared 4 to 16) or from a handful of fixed seeds allocates nothing. `setNoiseCacheLimit(bytes)` changes the
budget; `noiseCacheStats(ctx)` reads it. Grain clouds and a voice source's jitter table are per voice and are garbage once
the voice is disposed.

## The build

`beeps.build.json` recipes take a `delivery`:

```json
{ "engine-drone": { "source": "sfx/engine-drone.json", "role": "ambience", "kind": "patch", "delivery": "runtime" },
  "comet-blaster": { "source": "sfx/comet-blaster.json", "role": "sfx", "delivery": "both" } }
```

The recipe's `delivery` wins; absent, the patch's `xRuntime.delivery`; absent, `baked`. Songs ship baked. A `runtime`
recipe exports and encodes nothing and so needs no ffmpeg; it needs one render (variant 0 at the input defaults, a cache hit
when the sound was baked before) to measure its trim.

The input hash gains a `runtime` part (sha256 of the patch with its `xRuntime` block), only for assets that ship a cue. A
baked asset's hash is exactly what it was before this existed, so no existing lock goes stale. The part is in the lock as
`parts.runtime`, with `"delivery": "runtime" | "both"` on the asset and the cue as one of its sha256-pinned outputs, so the
store, `ci export` and `fetch.mjs` carry cues and their exact cue-owned prepared WAV closure.
The lock pins source bytes/hashes as outputs, budgets their fixed bytes, and verifies them on warm
checks and fetches too. Authoring originals and preparation snapshots are not runtime outputs. A runtime-only asset ignores bitrate and encoder
changes. Editing a binding rebuilds that cue and not its bake (`inputs changed (runtime)`).

`beeps verify` checks each cue: schema, engine version (a cue from another engine has a stale trim), id, that its patch
still parses. **`beeps verify --parity [engines]`** then plays every cue at its input defaults and compares it with its bake:

| Where | Rule |
|---|---|
| Chromium (the browser the build bakes with) | bit-exact on both taps, or `E_VERIFY` |
| Another engine (`--parity chromium,firefox`) | not samples: loudness within 1 LU and spectral centroid within 30 Hz of Chromium's bake |
| An engine with no `OfflineAudioContext` (Playwright WebKit on Windows) | reported as a warning, never passed |

`parity` is a toolchain check (the engine, Chromium or a graph change that makes the voice differ from the renderer); a
`both` asset's shipped file is covered by its sha256 in the lock and by the decode checks `verify --decode` already runs.

## Commands

| Command | |
|---|---|
| `beeps runtime export <patches> --out <dir>` | write the cue files (what `build` writes) |
| `beeps runtime check <patches>` | the craft rules where the runtime path can take the patch: defaults, each input at min and at max alone, all min, all max. Each corner is rendered normalised (spectral rules) and at the default's trim plus its own gain delta (peaks, clipping, loudness spread). A finding the default does not have is the runtime path's own. A `lint` clean patch is not a clean runtime patch |
| `beeps runtime verify <dir> <patches>` | are the cues in the folder current: engine, patch, seed, scale, trim |
| `beeps runtime parity <patches> [--engines chromium,firefox]` | baked vs voice per case, determinism over fresh pages, a negative control (a different seed must differ), the production render host against the harness, other browsers against Chromium |
| `beeps runtime perf <patches> [--vary-seed] [--bus] [--plays N]` | build cost and the nodes and buffers created; `--plays` is a long session with a live-buffer count |
| `beeps runtime live <patch> --input speed --to 1` | move an input mid-note against static bakes of both values |
| `beeps runtime look <patch> --set speed=1` | look images, baked and runtime, from the same seed |

What each parity case owes: `exact` (every sample of both taps), `near` (a live input moved: the voice applies it as a
detune, the bake as a frequency; below -75 dBFS and correlation above 0.99999), `bus` (the wet signal is summed elsewhere;
correlation above 0.9999, loudness within 0.1 LU), and `by-design`, reported and never failed: a live pitch input with the
scale snapping, which the bake quantises to a scale degree and a continuous detune cannot.

## Compatibility

* A patch with no `xRuntime` is unchanged. All 88 reference renders of the 18 sci-fi patches and the archetypes are
  bit-identical across this work, except the ones below.
* **Snap and variant detune fix.** With a snapping scale (the default), `variation.pitchCents` used to be snapped away, so
  variants 1 and up of a pitched patch played the same note as variant 0. They now detune from the snapped note. Variant 0,
  and any project with `snap: false`, are unchanged to the bit. The render key of an affected render carries
  `detune: after-snap`, so exactly those renders (and the locks built from them) go stale and nothing else does; the engine
  version stays 2. The graph test `tests/engine/graph-golden.test.ts` pins 510 graphs (84 patches, 3 variants, snap on and off)
  and lists exactly the cases that moved.
* The vendored game player no longer ships `engine/notes.js` (it no longer needs it).

## Measured

Machine: a Windows desktop (not a phone), Chromium 153.0.8010.12, Firefox 155.0, Playwright WebKit 26.6 (no
`OfflineAudioContext` on Windows: reported as `no-web-audio`, never passed; Safari is unmeasured). The six example cues in
`library/sounds/runtime-examples` (`beeps runtime parity`, 35 cases per browser, 3 fresh pages per path).

**Size** (`node scripts/runtime-size.mjs`, minified, rolldown): the engine (`build`, `createReverbBus`, `parseCue`) is 20.4 KB,
**7.9 KB gzip**, 7.2 KB brotli; every export 8.4 KB gzip. Adding the 18 sci-fi patches as data brings it to **10.5 KB gzip**
(about 0.15 KB per patch, three to eight KB of cue file each before compression). The same 18 sounds baked as Ogg Opus 72 kbps
are 117.7 KB.

**Build cost** (`start()`, 80 voices into one context, warm median; first build in brackets):

| cue | nodes | own reverb | shared bus | with a fresh seed per play |
|---|---|---|---|---|
| engine-drone | 36 | 1.9 ms (11.8) | **0.3 ms** (5.1) | 2.9 ms |
| comet-blaster | 47 | 2.0 (14.1) | **0.4** (10.4) | 4.3 |
| hyperdrive-charge | 60 | 2.1 (11.9) | **0.5** (5.9) | 3.0 |
| shield-ripple | 57 | 3.9 (17.4) | **0.5** (8.9) | 6.4 |
| asteroid-burst (grains) | 65 | 7.2 (25.7) | **4.0** (16.4) | 11.1 |
| creature-call (voice source) | 28 | 0.9 (8.8) | 0.9 (8.4) | 1.7 |

A running `AudioContext` gives the same numbers within noise. A convolver per voice is 1.6 to 3.4 ms; the grain cloud is the
remaining 4 ms of asteroid-burst. Spread spawning: at 16.7 ms a frame, a few such voices a frame is already most of it; with a bus the reverb cues here cost 0.3 to 0.5 ms each.
A fresh seed adds the noise and grain generation (375 KB per noise layer, 233 KB per grain cloud) to every play.

**Memory, 10,000 plays with a fresh seed each** (`beeps runtime perf --plays 10000`, a running context, every voice
disposed, a garbage collection before counting; `liveAudioBuffers` is `Runtime.queryObjects` over `AudioBuffer`, not a
working-set estimate, which this machine's other browsers make useless):

| | bounded cache (default) | unbounded (before the fix) |
|---|---|---|
| comet-blaster (2 noise layers), 10,000 plays | 44 buffers, **16 MB**, 43 cached entries | 3,000 plays: 6,001 buffers, **2,197 MB** (linear: about 7.3 GB at 10,000) |
| asteroid-burst (grains, 3 noise layers), 10,000 plays | 44 buffers, 16 MB | not run |
| engine-drone (1 noise layer), 10,000 plays | 44 buffers, 16 MB | not run |
| AudioNodes alive after 10,000 plays | 9 (the context's own) | |

The bound holds from 1,000 to 10,000 plays; the median build time does not creep (3.8, 4.0 and 5.2 ms at 1,000, 3,000 and
10,000). `tests/runtime/leak.test.ts` runs the same instrument for 1,500 plays (with an unbounded control that must fail the
bound), and `tests/runtime/voice.test.ts` runs 10,000 plays on a recording context.

**Parity, same browser** (35 cases: defaults, variant 2 with another seed, inputs at min, at max, at max with no snapping,
shared bus). These historical procedural measurements cover no sample assets. Both Chromium and Firefox: 35 of 35 meet their expectation, 1 distinct output over fresh-page repeats for every
path, the negative control (seed + 1) always differs, and in Chromium the harness bake equals the production render host's bake.

| Case | Chromium | Firefox |
|---|---|---|
| defaults, variant 2, static inputs (24 cases, 5 cues, both `voice` and noise/grain sources) | **bit-exact**, both taps | **bit-exact**, both taps |
| live input moved, no snapping (engine-drone, creature-call) | max diff -81.7 / -91.9 dBFS, correlation 1.00000 | -95.0 / -90.4 dBFS, 1.00000 |
| live pitch input with snapping (by design) | differs: the bake snaps to a scale degree | same |
| shared reverb bus vs the voice's own convolver (5 cues) | -131 to -133 dBFS, correlation 1.0000000 | the same |

**Parity, across browsers** (Firefox's voice against Chromium's bake, same case; the bake and the voice move together within
a browser, so this is the browser's difference, not the runtime's):

| cue | samples | loudness | centroid |
|---|---|---|---|
| hyperdrive-charge, shield-ripple, creature-call (tonal, no live sweep) | correlation 1.0000 | 0 to 0.01 LU | 0 to 0.1 Hz |
| engine-drone | correlation 1.0000 | 0.01 to 0.08 LU | 0.1 to 1.2 Hz |
| comet-blaster (chirp and noise) | correlation -0.00 to 0.42 | 0.20 to **0.96** LU | up to **31 Hz** |
| asteroid-burst (grain cloud) | correlation -0.5 to 0.5 | up to 0.26 LU | up to 11.6 Hz |

Sweeps and noise do not match sample for sample across browsers (I did not isolate which primitive diverges). The gate is
therefore features: loudness within 1 LU and centroid within 30 Hz, evaluated at the input defaults by `verify --parity`.
**comet-blaster is at the edge**: its defaults measure 0.90 LU and 4.4 Hz, a variant 0.96 LU, and its inputs-at-max case 31 Hz
(just past the centroid limit; not a gated case). A game that must run a sweep-and-noise cue on Firefox inside 1 LU should
expect to bake that one for Firefox or leave headroom in the tolerance.

**Mid-note moves** (`beeps runtime live`, engine-drone, one voice, speed 0.4 to 1 at 0.5 s, tau 30 ms): pitch 55 Hz to 99.19
Hz against 99.17 Hz for a static bake, loudness -7.88 against -7.85 LUFS, largest step 1.36 times the larger static bake's (the
pitch rise alone), tau 0.1 ms gives 2.45 times (a click risk), hence the default of 20 ms. With a 3-voice unison the settled
window differs from a bake by up to 1.7 LU and 27 Hz centroid because a voice that glided and one born at the final pitch have
different unison beat phase: match a live pitch input to a bake by feature over whole beat periods, not by window.

## What this cannot tell you

* Anything by ear: that any example, its input ranges or the engine-drone sound good or sound like engines.
* Safari and WebKit, mobile CPU, sustained polyphony and glitching under real load, real audio-device behaviour (headless
  uses a null sink; build cost is main-thread time, not audio-thread load).
* Why Firefox diverges sample-wise on sweeps and noise.
* A whole game: nothing in a game repository was touched; its integration is its own change.
