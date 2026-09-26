# agent-beeps Plan 1 — Foundation (engine, render, measure, CLI, archetypes, lint)

> **For Claude:** REQUIRED SUB-SKILL: Use h-superpowers:subagent-driven-development, h-superpowers:team-driven-development, or h-superpowers:executing-plans to implement this plan (ask user which approach). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A managed-runtime Claude Code plugin whose `beeps` CLI turns JSON patches into Chromium-rendered, measured, linted WAV sounds, and generates diverse candidate sets from 16 SFX archetypes.

**Architecture:** Browser-safe engine in `runtime/engine/*.js` (plain ES modules + JSDoc, type-checked) builds Web Audio graphs; the Node CLI (`src/`, TypeScript run directly by Node 24) renders batches in one Playwright Chromium page via `OfflineAudioContext`, measures PCM in pure TS, and stores results in `.agent-beeps/`. Spec: `docs/superpowers/specs/2026-09-25-agent-beeps-v1-design.md`.

**Tech Stack:** Node ≥ 24 (type stripping), TypeScript 7 (`tsc --noEmit`, `checkJs`), commander 15, zod 4, playwright 1.63, vitest 5. Plan 2 (audition server, taste model, skills) builds on this.

**Deviation note:** file-level code is given for contracts, tests and algorithms; mechanical glue is described precisely instead of pasted, to keep this plan reviewable.

---

## File map

```
.claude-plugin/plugin.json          plugin manifest (name/version synced)
.claude-plugin/marketplace.json     local dev marketplace (source "./")
package.json, package-lock.json, tsconfig.json, vitest.config.ts, LICENSE, README.md
scripts/beeps.mjs                   bin: import { main } from '../src/cli.ts'
scripts/setup.js | managed-runtime.js | run-managed.js   managed runtime trio (from agent-vids, NAME agent-beeps, no ffmpeg)
runtime/engine/notes.js             note names ↔ Hz, scale snapping
runtime/engine/rng.js               seeded mulberry32 + noise buffers
runtime/engine/sources.js           osc | noise | fm | additive | modal | grains | metal → node builders
runtime/engine/layer.js             per-layer chain: pitchEnv, amp ADSR, filter(+env), lfo, drive, pan
runtime/engine/fx.js                delay, generated-IR reverb presets, limiter
runtime/engine/variation.js         variant parameter perturbation, pitch/gain jitter, variant picker
runtime/engine/patch.js             buildPatch(ctx, patch, opts) — the one entry point
runtime/engine/offline.js           renderOffline(patch, opts) → authored + delivered taps
runtime/render.html                 blank page that imports offline.js and exposes window.beepsRender
runtime/look.js                     canvas waveform + spectrogram + feature strip → PNG data URL
src/cli.ts                          commander wiring, JSON out, error envelope
src/errors.ts                       BeepsError {code,message,pointer?,hint?}
src/schema/patch.ts                 zod patch@1 + JSON Schema export + friendly issues
src/schema/project.ts               project.json schema + defaults
src/project.ts                      locate/init .agent-beeps, read/write patches, kit
src/hash.ts                         canonical JSON + sha256 render keys
src/render/host.ts                  static server + Playwright page lifecycle, renderBatch()
src/render/cache.ts                 render cache (renders/<hash>/)
src/audio/wav.ts                    16-bit/32f WAV writer + reader
src/measure/fft.ts                  radix-2 FFT, Hann window
src/measure/loudness.ts             K-weighting (48 kHz), momentary/short-term/integrated, true peak
src/measure/envelope.ts             attack, energy length, tail, crest
src/measure/spectral.ts             centroid, flatness, band energies, bark bands
src/measure/psycho.ts               sharpness (DIN 45692 approx), roughness, fluctuation
src/measure/pitch.ts                YIN pitch track, pitch strength, direction
src/measure/index.ts                measure(pcm) → Features
src/archetypes.ts                   load library/archetypes, sample from ranges
src/generate.ts                     sample → render → measure → farthest-point select
src/mutate.ts                       mutate/crossover with feature-direction acceptance
src/lint.ts                         rules.json checks over features + patch
src/kit.ts                          kit list/add/remove/check
library/archetypes/*.json           16 archetypes
craft/rules.json, craft/GUIDE.md    cited craft rules
tests/**                            vitest
```

Sample rate is **48 000 Hz everywhere** (BS.1770 coefficients are specified at 48 kHz).

---

### Task 1: Scaffold and managed runtime

**Files:** Create `package.json`, `tsconfig.json`, `vitest.config.ts`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `LICENSE` (MIT, ehartye), `scripts/beeps.mjs`, `scripts/setup.js`, `scripts/managed-runtime.js`, `scripts/run-managed.js`, `src/cli.ts` (version only), `tests/managed-runtime.test.ts`.

- [ ] **Step 1:** `package.json`:
```json
{ "name": "agent-beeps", "version": "0.1.0", "private": true, "type": "module",
  "description": "Procedural sound composer for coding agents: Web Audio patches rendered in Chromium, measured, linted, auditioned by the owner, and ranked by a learned taste model",
  "engines": { "node": ">=24" }, "bin": { "beeps": "scripts/beeps.mjs" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit", "setup": "node scripts/setup.js" },
  "dependencies": { "commander": "15.0.0", "playwright": "1.63.0", "zod": "4.6.5" },
  "devDependencies": { "@types/node": "26.6.2", "typescript": "7.0.2", "vitest": "5.0.1" },
  "license": "MIT" }
```
`tsconfig.json` = agent-vids' plus `"allowJs": true, "checkJs": true` and `"include": ["src", "tests", "runtime"]`. `vitest.config.ts` = agent-vids' with `testTimeout: 60000`.
- [ ] **Step 2:** Copy `scripts/managed-runtime.js`, `run-managed.js`, `setup.js` from `C:\Users\ehart\repos\agent-vids\scripts\`, then: `NAME='agent-beeps'`; `RUNTIME_FILES = ['package.json','package-lock.json','tsconfig.json','scripts','src','runtime','craft','library','skills']`; `managedHome` uses `AGENT_BEEPS_HOME` / `~/.agent-beeps`; cli path `scripts/beeps.mjs`; delete `ensureFfmpeg` and its calls and the ffmpeg probe in `checkDependencies`; all messages say `beeps-setup`.
- [ ] **Step 3:** Failing test `tests/managed-runtime.test.ts`: `describeSource(root)` returns `name 'agent-beeps'`, a 64-hex fingerprint, and a key starting with `0.1.0-`; `resolveRuntime(root, {home: tmp})` throws `/beeps-setup/`; `installRuntime` refuses a home inside the checkout.
- [ ] **Step 4:** `npm install` (creates lockfile), run `npx vitest run tests/managed-runtime.test.ts` → PASS; `npx tsc --noEmit` → clean.
- [ ] **Step 5:** Commit `chore: scaffold agent-beeps with managed runtime`.

### Task 2: Errors, hashing, notes, RNG

**Files:** `src/errors.ts`, `src/hash.ts`, `runtime/engine/notes.js`, `runtime/engine/rng.js`; tests `tests/hash.test.ts`, `tests/engine/notes.test.ts`, `tests/engine/rng.test.ts`.

- [ ] Tests first:
```ts
// notes
expect(noteToHz('A4')).toBeCloseTo(440); expect(noteToHz('C4')).toBeCloseTo(261.626, 2);
expect(noteToHz('Bb3')).toBeCloseTo(233.082, 2); expect(noteToHz(1000)).toBe(1000);
expect(snapToScale(450, { root: 'C', mode: 'majorPentatonic' })).toBeCloseTo(440); // A in C pent
expect(snapToScale(466, { root: 'C', mode: 'majorPentatonic' })).toBeCloseTo(440); // Bb → A (nearest in-scale)
// rng
const a = mulberry32(7), b = mulberry32(7); expect([a(),a(),a()]).toEqual([b(),b(),b()]);
expect(noiseSamples('white', 4800, 3)).toEqual(noiseSamples('white', 4800, 3));
// hash
expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 0 }] })).toBe('{"a":[2,{"c":0,"d":1}],"b":1}');
expect(renderKey({ x: 1 }, { seed: 1, variant: 0 })).toMatch(/^[0-9a-f]{64}$/);
```
- [ ] Implement. `notes.js`: `noteToHz(n: string|number)`, `hzToMidi`, `midiToHz`, `SCALES = { chromatic, major, minor, majorPentatonic:[0,2,4,7,9], minorPentatonic:[0,3,5,7,10], dorian, blues }`, `snapToScale(hz, {root, mode})` (nearest midi whose pitch class ∈ scale). `rng.js`: `mulberry32(seed)`, `noiseSamples(color, n, seed)` (white; pink via Paul Kellet filter; brown via leaky integrator, each normalized to peak 1). `errors.ts`: `class BeepsError extends Error { code; pointer?; hint? }` + `toJson()`. `hash.ts`: sorted-key canonical JSON; `renderKey(patch, opts)` = sha256 of `canonicalJson({patch, opts, engine: ENGINE_VERSION, sr: 48000})`.
- [ ] Run tests PASS, typecheck, commit `feat: notes, rng, hashing, errors`.

### Task 3: Patch schema

**Files:** `src/schema/patch.ts`, `src/schema/project.ts`, tests `tests/schema/patch.test.ts`.

- [ ] Tests:
```ts
const ok = { schema: 'beeps/patch@1', name: 'coin', family: 'coin', duration: 0.4,
  layers: [{ source: { type: 'osc', wave: 'square', pitch: 'E6' }, amp: { attack: 0.004, decay: 0.18 } }] };
expect(parsePatch(ok).ok).toBe(true);
const bad = structuredClone(ok); bad.layers[0].filter = { type: 'lowpass', cutoff: 2000, q: 3 };
const r = parsePatch(bad); expect(r.ok).toBe(false);
expect(r.issues[0]).toMatchObject({ pointer: '/layers/0/filter', hint: expect.stringMatching(/resonanceDb/) });
// every source type parses
for (const source of [ {type:'noise',color:'pink'}, {type:'fm',operators:[{ratio:1},{ratio:2,index:3}],algorithm:[[1,0]],pitch:220},
  {type:'additive',pitch:440,partials:[[1,0,0.5],[2,-6,0.3]]}, {type:'modal',modes:[[1,30,0],[2.76,40,-6]],pitch:600,exciter:'impulse'},
  {type:'grains',rate:80,grainDecay:0.004,center:3000,q:2}, {type:'metal',bands:[3440,7100],decay:0.09} ])
  expect(parsePatch({ ...ok, layers: [{ source, amp: { attack: 0.001, decay: 0.1 } }] }).ok, source.type).toBe(true);
expect(patchJsonSchema()).toHaveProperty('$schema');
```
- [ ] Implement zod: `Pitch = z.union([z.string().regex(/^[A-G](#|b)?-?\d$/), z.number().positive().max(24000)])`; `Amp {attack≥0 default 0.005, decay≥0, sustain 0..1 default 0, release≥0 default 0.02}`; `Filter` = discriminated union on `type`: `lowpass|highpass` {cutoff, resonanceDb default 0, env?: {to, time}} ; `bandpass|notch|peaking` {cutoff, q default 1, gainDb?, env?}; strict objects so `q` on lowpass fails — then map zod's unrecognized-key issue to hint `"lowpass/highpass take resonanceDb (Chromium treats their Q as dB); bandpass/notch/peaking take q"`. Sources per spec §3 (discriminated on `type`, strict). Layer {source, start default 0, gainDb default 0, pitchEnv?: [{at, to: Pitch, curve: 'linear'|'exp'|'step'}], amp, filter?, lfo?: {target:'pitch'|'gain'|'cutoff', rate, depth}, drive? 0..1, pan? -1..1}. Patch {schema literal, name /^[a-z0-9][a-z0-9-]*$/, family string, archetype?, tags [], duration 0.02..10, layers 1..8, fx?: {delay?: {time, feedback ≤0.9, sendDb}, reverb?: {preset: small|room|hall|cave, sendDb}}, variation?: {pitchCents default 0, gainDb default 0, variants 1..16 default 1, noRepeat default true, weights?: number[]}, meta?: {priority 1..5 default 3, intent?: 'click'|'bed'|'oneshot'}}. `parsePatch(x) → {ok:true, patch} | {ok:false, issues:[{pointer, message, hint?}]}`; `patchJsonSchema()` via `z.toJSONSchema`. `project.ts`: `{schema:'beeps/project@1', scale:{root:'C', mode:'majorPentatonic', snap:true}, targetLoudness:-18, sampleRate:48000}`.
- [ ] PASS, typecheck, commit `feat: patch@1 schema with pointer hints`.

### Task 4: Engine — sources, layer chain, fx, buildPatch

**Files:** `runtime/engine/{sources,layer,fx,variation,patch}.js`; test `tests/engine/graph.test.ts` using a **fake context** that records node creation (`createOscillator`, `createGain`, `createBiquadFilter`, `createBufferSource`, `createBuffer`, `createWaveShaper`, `createStereoPanner`, `createConvolver`, `createDynamicsCompressor`, `createDelay`, `createChannelMerger`, AudioParam with `setValueAtTime/linearRampToValueAtTime/exponentialRampToValueAtTime/setTargetAtTime/cancelScheduledValues`).

- [ ] Tests (fake ctx):
```ts
const g = buildPatch(fake, coin, { destination: fake.destination, when: 0, seed: 1 });
expect(g.end).toBeCloseTo(0.4 + coin.layers[0].amp.release, 3);
expect(fake.count('createOscillator')).toBe(1);
// lowpass resonanceDb goes straight into Q (Chromium LP/HP Q is dB)
expect(fake.nodes('biquad')[0].Q.value).toBe(6);        // resonanceDb: 6
// unison phases are spread: N oscillators with distinct detune
expect(fake.nodes('osc').map(o => o.detune.value)).toEqual([-10, 0, 10]); // unison 3, 20 cents
// metal = 6 squares + 2 bandpasses
expect(fake.count('createOscillator')).toBe(6); expect(fake.nodes('biquad').filter(b=>b.type==='bandpass')).toHaveLength(2);
// no exponential ramp to 0 (would throw in real browsers)
expect(fake.rampTargets('exponential').every(v => v > 0)).toBe(true);
```
- [ ] Implement:
  - `sources.js` exports `buildSource(ctx, src, {when, dur, seed, pitchHz})` → `{ output: AudioNode, pitchParams: AudioParam[], start(t), stop(t) }`.
    - osc: `unison.voices` oscillators, detune spread evenly `-d/2..+d/2`, per-voice gain `1/voices` (declared, loudness trimmed later anyway).
    - noise: AudioBuffer from `noiseSamples(color, 2 s, seed)` looping source.
    - fm: operators as oscillators; `algorithm` = list of `[from, to]` edges (to 0 = carrier output); modulator gain = `index * carrierHz * ratio`, connected to target `frequency`; operator 0.. `ratio × pitchHz`.
    - additive: one sine per partial, freq `ratio×pitch` (skip partials ≥ 0.45·sampleRate), gain `dB→lin`, own exp decay to 1e-4 over `decay` s.
    - modal: exciter (impulse = 1-sample buffer, or `noiseBurst` = 5 ms white burst) → parallel bandpasses at `ratio×pitch` with `q`, gains, summed.
    - grains: pre-computed buffer (length dur) of Poisson-timed grains (`rate` per s, exponential inter-arrival from seeded RNG, each grain = white noise × exp decay `grainDecay`), through bandpass `center`/`q`.
    - metal: 6 squares at `[2, 3, 4.16, 5.43, 6.79, 8.21] × base (default 40 Hz)` → two bandpasses at `bands` → envelope handled by layer amp.
  - `layer.js` `buildLayer(ctx, layer, {when, duration, seed, scale, out})`: resolve pitch (`noteToHz`, snap when scale.snap and source pitched), schedule `pitchEnv` points on every pitch param (`step` = setValueAtTime, `linear`, `exp` ramps, targets clamped > 0), amp ADSR on a gain: `setValueAtTime(0,t)`, `linearRamp(peak, t+attack)` (linear attack: avoids the "slow then sudden" exponential attack), decay via `setTargetAtTime(sustain·peak, t+attack, decay/4)`, release from `t+duration` to 0 over `release` (linear to 0). Filter: `BiquadFilterNode`, `Q = resonanceDb` for LP/HP, `q` for others, optional cutoff env exponential ramp. LFO: oscillator → gain(depth) → target param (pitch: detune cents; gain: amp gain; cutoff: frequency Hz). Drive: WaveShaper `tanh(k·x)/tanh(k)` curve with k = 1+drive·20, 4× oversample. Pan: StereoPanner. Layer gainDb applied last. Returns `{ end }`.
  - `fx.js`: `buildReverb(ctx, preset, seed)` → convolver whose buffer is generated once per (ctx, preset) — stereo exp-decaying seeded white noise with descending one-pole lowpass (small 0.4 s, room 0.9 s, hall 2.2 s, cave 3.5 s; lowpass 8k→2k), cached in a `WeakMap<ctx, Map>`; `buildDelay`; `buildLimiter(ctx)` DynamicsCompressor threshold −3, knee 0, ratio 20, attack 0.001, release 0.05.
  - `variation.js`: `variantPatch(patch, variant, seed)` — variant 0 = the patch; others multiply each `pitch` (Hz) by `2^(u·pitchCents/1200)` and layer gains by `u·gainDb` with seeded `u∈[-1,1]`; `createPicker(patch, seed)` returns `next()` honouring `noRepeat` and `weights`.
  - `patch.js`: `ENGINE_VERSION = '1'`; `buildPatch(ctx, patch, {destination, when=0, seed=1, variant=0, trimDb=0, scale, taps})` → sums layers into `authored` gain, fx sends from `authored`, `authored → trim(trimDb) → limiter → destination`; if `taps` given, also connect `authored` to `taps.authored`. Returns `{ end, authored }`.
- [ ] PASS, typecheck, commit `feat: browser engine builds Web Audio graphs from patches`.

### Task 5: Offline render in Chromium

**Files:** `runtime/engine/offline.js`, `runtime/render.html`, `src/render/host.ts`, `src/render/cache.ts`, `src/audio/wav.ts`; tests `tests/audio/wav.test.ts`, `tests/render/host.test.ts` (browser, `describe.skipIf(!chromiumAvailable())`).

- [ ] `offline.js`: `renderOffline(patch, {seed, variant, trimDb, scale})` → `OfflineAudioContext(4, ceil((end+tailPad)*48000), 48000)`; `ChannelMerger(4)`; delivered stereo → inputs 0,1; authored (pre-trim, pre-limiter) through a StereoPanner-less splitter → inputs 2,3; returns `{ sampleRate, delivered:[L,R], authored:[L,R] }` as base64 Float32 strings. Render length = `buildPatch().end + 0.25 s` (reverb tails: + preset decay).
- [ ] `render.html`: `<script type="module">import { renderOffline } from './engine/offline.js'; window.beepsRender = async (items) => Promise.all(items.map(i => renderOffline(i.patch, i.opts).catch(e => ({ error: String(e) }))));</script>` — each item fails alone.
- [ ] `host.ts`: `openRenderHost()` → starts `node:http` static server on 127.0.0.1:0 rooted at `runtime/` (only GET, only files under root, MIME for .js/.html), launches `chromium.launch()`, `page.goto(/render.html)`, returns `{ render(items): Promise<RenderResult[]>, look(item), close() }`. Missing browser → `BeepsError('E_BROWSER_MISSING', ..., hint: 'Run the beeps-setup skill')`.
- [ ] `wav.ts`: `writeWav(channels: Float32Array[], sr, {bits:16|32})` → Buffer (16-bit with TPDF dither-free clamp), `readWav(buf)`. Test round-trip within 1/32768.
- [ ] `cache.ts`: `renders/<key>/` holds `delivered.wav`, `authored.f32` (raw), `features.json`, `look.png`, `meta.json {patchName, seed, variant, trimDb}`; `getOrRender(host, items)` renders only misses.
- [ ] Browser tests (these pin the Chromium facts the design relies on):
```ts
const [saw] = await host.render([{ patch: tone('sawtooth', 6000), opts: { seed: 1 } }]);
expect(peak(saw.authored[0])).toBeGreaterThan(0.68); expect(peak(saw.authored[0])).toBeLessThan(0.8); // band-limited table ≈ 0.737
const [a, b] = await host.render([{ patch: coin, opts: { seed: 5 } }, { patch: coin, opts: { seed: 5 } }]);
expect(a.delivered[0]).toEqual(b.delivered[0]);                  // deterministic
const [bp] = await host.render([{ patch: triangleThroughBandpass(220, { cutoff: 3000, q: 5 }), opts: {seed:1} }]);
expect(rms(bp.authored[0])).toBeLessThan(0.05);                    // a gain literal is not a loudness
```
- [ ] PASS, typecheck, commit `feat: Chromium offline render host with render cache`.

### Task 6: Measurement

**Files:** `src/measure/{fft,loudness,envelope,spectral,psycho,pitch,index}.ts`; tests `tests/measure/*.test.ts` with synthetic signals (`tests/helpers/signals.ts`: `sine(f, dur, amp)`, `am(f, modF, depth)`, `whiteNoise(dur, seed)`, `envelope(attack, decay)`).

- [ ] Tests:
```ts
// BS.1770: a 997 Hz sine at -20 dBFS on one channel of stereo reads ≈ -23 LUFS; both channels ≈ -20.
expect(momentaryMax([sine(997, 2, 0.1), sine(997, 2, 0.1)], 48000)).toBeCloseTo(-20, 0);
expect(truePeakDb([sine(12000, 0.5, 1)], 48000)).toBeGreaterThan(-0.5);
expect(centroid(sine(1000, 0.5, 0.5), 48000)).toBeCloseTo(1000, -1);
expect(flatness(whiteNoise(1, 1))).toBeGreaterThan(0.8); expect(flatness(sine(1000, 1, 0.5))).toBeLessThan(0.05);
expect(attackTime(envelope(0.02, 0.3), 48000)).toBeCloseTo(0.016, 2); // 10→90 % of a linear 20 ms attack
expect(roughness(am(1000, 70, 1), 48000)).toBeGreaterThan(3 * roughness(sine(1000, 1, 0.5), 48000));
expect(sharpness(highpassedNoise(4000))).toBeGreaterThan(sharpness(lowpassedNoise(500)));
const p = pitchTrack(sine(440, 0.5, 0.5), 48000); expect(p.medianHz).toBeCloseTo(440, 0); expect(p.strength).toBeGreaterThan(0.9);
expect(pitchTrack(glide(400, 800, 0.4), 48000).directionSemitones).toBeGreaterThan(8);
expect(pitchTrack(whiteNoise(0.5, 2), 48000).strength).toBeLessThan(0.5);
```
- [ ] Implement:
  - `fft.ts`: iterative radix-2 complex FFT; `hann(n)`; `stft(x, n=2048, hop=512)` magnitude frames.
  - `loudness.ts`: BS.1770-4 K-weighting at 48 kHz (stage 1 shelf b=[1.53512485958697,−2.69169618940638,1.19839281085285] a=[1,−1.69065929318241,0.73248077421585]; stage 2 HP b=[1,−2,1] a=[1,−1.99004745483398,0.99007225036621]); mean-square per channel, sum with G=1; momentary = 400 ms windows hop 100 ms, `−0.691 + 10·log10(Σ)`; `momentaryMax`, `shortTermMax` (3 s), `integrated` (abs gate −70, rel gate −10) with `reliable: durationSec ≥ 1`; `truePeakDb` via 4× polyphase windowed-sinc (48 taps) upsampling; `samplePeakDb`.
  - `envelope.ts`: RMS envelope (5 ms hop); `attackTime` 10 %→90 % of peak; `energyLength` = time from first crossing −40 dB (relative to peak) to last crossing; `tailLength` to −60 dB; `crest` = peak/RMS dB; `dcOffset`; `clippedSamples` (|x| ≥ 0.999).
  - `spectral.ts`: STFT-energy-weighted mean centroid, centroid at the peak frame, spectral flatness (geo/arith mean of power), 24 Bark bands (Zwicker edges) energies, 8 log bands 60–16k.
  - `psycho.ts`: specific loudness per Bark band `N'(z) = (E_z/E_ref)^0.23`; **sharpness** `0.11·Σ N'(z)·g(z)·z / Σ N'(z)` with `g(z)=1 (z≤15.8) else 0.066·e^{0.171 z}` (acum-like; DIN 45692 approximation, documented as an indicator); **roughness**: per Bark band, band-energy envelope at 1 kHz frame rate (hop 48), modulation spectrum via FFT of the envelope, weight by `w(fm) = exp(−(log2(fm/70))²/(2·0.8²))`, depth = weighted modulation magnitude / mean envelope, roughness = `0.25·Σ_z depth_z·N'(z)` (asper-like); **fluctuation** same with centre 4 Hz, σ = 1 octave.
  - `pitch.ts`: YIN (threshold 0.15, frame 2048, hop 480, 50–4000 Hz), `strength = 1 − min CMND` median over voiced frames; `medianHz`; `directionSemitones` = 12·log2(last voiced ÷ first voiced) (0 if < 3 voiced frames); `voicedFraction`.
  - `index.ts`: `measure({delivered, authored, sampleRate}) → Features` = `{ durationSec, samplePeakDb, truePeakDb, dcOffset, clippedSamples, momentaryMaxLufs, shortTermMaxLufs, integratedLufs, integratedReliable, attackSec, energyLengthSec, tailSec, crestDb, centroidHz, centroidPeakHz, flatness, bands, sharpness, roughness, fluctuation, pitchHz, pitchStrength, pitchDirection, voicedFraction }` measured on the **authored** tap except peaks/clipping which are reported for both (`delivered.truePeakDb`). `featureVector(f)` → the 11 taste features `[log energyLength, attack, log centroid, sharpness, roughness, fluctuation, flatness, pitchStrength, pitchDirection, crestDb, log pitchHz|0]` with names (used by Plan 2).
- [ ] PASS, typecheck, commit `feat: measurement — loudness, envelope, spectral, psychoacoustic, pitch`.

### Task 7: Loudness trim, render pipeline, look images

**Files:** `src/render/pipeline.ts`, `runtime/look.js`; test `tests/render/pipeline.test.ts` (browser).

- [ ] `pipeline.ts` `renderAndMeasure(host, items, {project, cacheDir})`: pass 1 renders with `trimDb 0`, measures authored `momentaryMaxLufs`, computes `trimDb = target + familyOffset − lufs` clamped ±24 dB; pass 2 renders delivered with that trim (authored tap unchanged, so features stay); writes cache entries; returns `{ key, patch, seed, variant, trimDb, features, wavPath, lookPath }[]`. Silent authored render (LUFS −∞) → item error `E_RENDER` "patch rendered silence".
- [ ] `look.js` (in browser): given PCM + features, draws 900×300 PNG: waveform (top), log-frequency spectrogram (middle, computed in JS with a small FFT), feature strip text (bottom); returns data URL; host writes `look.png`. Contact sheet: `lookSheet(items)` grid of looks with labels 1..N.
- [ ] Tests: coin trimmed so `momentaryMaxLufs(delivered)` within ±1 LU of −18; `look.png` exists and starts with PNG magic bytes.
- [ ] PASS, commit `feat: loudness-trimmed render pipeline and look images`.

### Task 8: Project store and CLI core

**Files:** `src/project.ts`, `src/cli.ts`, `src/commands/*.ts` (one file per command group: `capabilities.ts`, `patches.ts` (init/new/batch/render/measure/look/export), `generate.ts`, `lint.ts`, `kit.ts`); test `tests/cli.test.ts` (spawns `node scripts/beeps.mjs` in a temp project).

- [ ] Output contract: every command prints one JSON document to stdout; errors print `{"error":{code,message,pointer?,hint?}}` to stderr and exit 1 (2 for usage). `--project <dir>` (default: nearest ancestor containing `.agent-beeps/`, else cwd for `init`).
- [ ] Commands: `capabilities` → `{ version, engine, sampleRate, commands:[...], patchSchema, sourceTypes, archetypes:[names], refineDirections, errorCodes }`; `init [--scale C:majorPentatonic] [--target -18]` creates `.agent-beeps/{project.json,patches/,kit.json,sessions/,taste/,renders/,sets/}` and a `.gitignore` with `renders/` `cache/`; `new <file.json>` validates & saves to `patches/<name>.json` (E_CONFLICT if exists without `--force`); `batch <ops.json> [--dry-run]` ops `{op:'create',patch}|{op:'set',name,pointer,value}|{op:'delete',name}` applied transactionally (all validate first; dry-run reports `operationIndex` of the first failure); `render <name|file>... [--variants]` → rendered items; `measure <name>`; `look <name|set>` → PNG path(s); `export <name> --wav <path> [--variant n]`.
- [ ] Tests: init creates layout; `new` rejects q-on-lowpass with pointer+hint in stderr JSON and exit 1; batch dry-run reports failing `operationIndex: 1`; capabilities lists 16 archetypes.
- [ ] PASS, commit `feat: beeps CLI core commands and project store`.

### Task 9: Archetypes and generate

**Files:** `library/archetypes/*.json` (16), `src/archetypes.ts`, `src/generate.ts`; tests `tests/archetypes.test.ts`, `tests/generate.test.ts`.

- [ ] Archetype format:
```json
{ "schema": "beeps/archetype@1", "name": "coin", "family": "coin", "description": "Bright two-step pickup blip",
  "template": { "...": "a valid patch@1" },
  "ranges": { "/layers/0/source/pitch": { "min": 700, "max": 2200, "scale": "log" },
              "/layers/0/pitchEnv/0/to": { "ratioOf": "/layers/0/source/pitch", "choices": [1.25, 1.333, 1.5, 2] },
              "/layers/0/source/wave": { "choices": ["square", "triangle", "sine"] },
              "/layers/0/amp/decay": { "min": 0.08, "max": 0.3, "scale": "log" } } }
```
Range kinds: `{min,max,scale:'lin'|'log'}`, `{choices}`, `{ratioOf, choices|min/max}`. All 16 per spec §4, each designed with the craft rules (attack ≥ 4 ms except `ui-click` intent click, `no` = descending minor-third figure on triangle/sine with soft attack, `explosion` = brown noise + grains + low sine thump with lowpass env, `laser` = square/saw pitch drop through lowpass, `hit` = noise burst + low modal body, `alarm` = two-tone square alternation with variation off, `whoosh` = bandpassed noise with cutoff env, `jump` = rising sine/square glide, `land` = low thud (sine drop + brown noise tick), `powerup` = rising arpeggio over 3 layers with start offsets, `powerdown` = falling, `ui-hover` = very short soft sine, `confirm` = two ascending in-scale notes, `blip` = 30 ms square at voice pitch, `pickup` = additive bell-ish partials).
- [ ] `archetypes.ts`: `loadArchetypes()` (from `library/archetypes`, validated: template parses, every range pointer resolves), `sampleArchetype(a, rng, n)` → patches named `<archetype>-<seed>-<i>` with `archetype` field set.
- [ ] `generate.ts` `generate(host, {archetype, count=8, seed, project, near?})`: sample `4·count`, `renderAndMeasure`, drop items failing error-level lint, z-score feature vectors, farthest-point selection starting from the item nearest the median (or `near` patch's features), write `sets/<setId>/set.json {id, archetype, prompt?, candidates:[{index, patch, key, features, wavPath, lookPath}]}` + candidate patch files, return set JSON. `setId` = `<archetype>-<yyyymmddhhmm>-<4 hex>`.
- [ ] Tests: every archetype validates and every range pointer resolves; sampling is deterministic per seed and within ranges; farthest-point on synthetic points picks spread-out ones; (browser) `generate coin --count 4` yields 4 candidates, all passing error-level lint, pairwise feature distances > 0.
- [ ] PASS, commit `feat: 16 SFX archetypes and diverse candidate generation`.

### Task 10: Craft rules and lint; kit

**Files:** `craft/rules.json`, `craft/GUIDE.md`, `src/lint.ts`, `src/kit.ts`; tests `tests/lint.test.ts`, `tests/kit.test.ts`.

- [ ] `rules.json` entries `{id, statement, value?, unit?, check:'auto'|'judgement', severity:'error'|'warn', appliesTo:'patch'|'kit', sources:[{title, url}]}`. v1 rules: `true-peak-ceiling` (≤ −1 dBTP delivered; EBU R 128 / ITU-R BS.1770), `attack-floor` (≥ 0.004 s unless intent click; click-free onset practice), `no-dc` (|dc| < 0.001), `no-clipping`, `nyquist` (declared partial/mode/pitchEnv frequencies < 0.45·sr), `tick-length` (family ui-click/blip energyLength ≤ 0.06 s), `tail-ceiling` (per family table), `sharpness-warn` (> 2.2), `roughness-warn` (> 0.6 unless tag `gritty`), `variation-on-repeating` (tag repeating ⇒ variants ≥ 3 or pitchCents ≥ 20; Collins on repetition), `one-no` (kit: exactly one family `no`; judgement-backed by consistent-feedback practice), `priority-levels` (kit uses ≤ 5 distinct; FMOD virtual voices doc), `silent-not-quiet` (judgement: gated beds stop, not duck), `family-consistency` (kit: centroid spread within family ≤ 1 octave, warn), `key-consistency` (kit: pitched members snap to project scale), `reverb-preset-only` (auto: schema enforces), `loudness-target` (delivered momentary max within ±1.5 LU of target). Sources cite primary URLs (ITU-R BS.1770-5, EBU R 128, EBU Tech 3341, DIN 45692 summary, Zwicker & Fastl, Plomp & Levelt 1965, Collins *Game Sound* 2008, FMOD Virtual Voices docs, Chromium/Web Audio spec BiquadFilterNode, Cook 1997 PhISM, Moffat & Reiss 2018).
- [ ] `lint.ts` `lintPatch(patch, features, project)` / `lintKit(kit)` → `{ errors:[{rule,message,pointer?}], warnings:[...], judgement:[ruleIds] }`.
- [ ] `kit.ts`: `kit.json {sounds:[{name, family, priority}]}`; `add/remove/list`; `check` runs kit rules + masking overlap (pairs whose dominant Bark bands coincide and centroid ratio < 2^(1/3) flagged `masking-risk`).
- [ ] Tests: a patch with attack 0.001 → `attack-floor` error; kit with two `no` family sounds → `one-no` error; `judgement` always lists judgement rules.
- [ ] `GUIDE.md`: short craft guide (which synthesis method for which material, level/key/variation/blend principles) citing rules by id.
- [ ] PASS, commit `feat: craft rules, lint and kit checks`.

### Task 11: Mutate and crossover

**Files:** `src/mutate.ts`; test `tests/mutate.test.ts`.

- [ ] `DIRECTIONS = { brighter: {centroid:+1, sharpness:+0.5}, darker: {centroid:-1, sharpness:-0.5}, punchier: {attack:-1, crest:+1}, softer: {attack:+1, crest:-1}, shorter: {energyLength:-1}, longer: {energyLength:+1}, 'less-harsh': {sharpness:-1, roughness:-1}, 'more-character': {roughness:+0.5, fluctuation:+0.5, pitchDirection:+0.3} }`.
- [ ] `mutateCandidates(patch, rng, n)`: perturb 1–3 numeric leaves (log-normal σ 0.25 for frequencies/times, ±0.1 for 0..1 values; respect archetype ranges when `patch.archetype` set; keep schema-valid), `mutate(host, {patch, toward:[dirs], count})` generates 4·count, renders/measures, scores `Δz·direction`, keeps top `count` with score > 0 (falls back to best available, flagged `weak`). `crossover(a, b, t=0.5)` interpolates shared numeric leaves (log for Hz/time), takes structure from `a`.
- [ ] Tests: perturbations stay schema-valid (property test over 200 seeds); direction scoring ranks a brighter synthetic feature delta above a darker one; crossover at t=0 equals a.
- [ ] CLI: `mutate <name> --toward brighter,shorter --count 4` and `crossover <a> <b> [--t 0.5]` write a new set. Commit `feat: direction-steered mutation and crossover`.

### Task 12: README and end-to-end smoke

- [ ] README: pitch, workflow, commands, install (`/plugin install agent-beeps@hartye-plugins` then `/agent-beeps:beeps-setup`), managed home, requirements, development — agent-vids structure.
- [ ] Smoke (local, not managed): `node scripts/beeps.mjs init`, `generate coin --count 6`, `look <set>`, `lint`, `export`. Look at the contact sheet PNG with the Read tool; verify all numbers sane.
- [ ] `npm test` + `npm run typecheck` all green. Commit `docs: README` and `test: e2e smoke`.
