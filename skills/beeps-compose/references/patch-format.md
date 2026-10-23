# beeps/patch@1

`beeps capabilities` prints the full JSON Schema and an example; this is the working summary.

```json
{ "schema": "beeps/patch@1", "name": "coin", "family": "coin", "tags": ["repeating"], "duration": 0.3,
  "layers": [
    { "source": { "type": "osc", "wave": "square", "pitch": "E6" },
      "pitchEnv": [{ "at": 0.06, "to": "B6", "curve": "step" }],
      "amp": { "attack": 0.004, "decay": 0.12, "sustain": 0, "release": 0.05 },
      "filter": { "type": "lowpass", "cutoff": 6000, "resonanceDb": 0 } },
    { "source": { "type": "noise", "color": "white" }, "amp": { "attack": 0.002, "decay": 0.03 }, "gainDb": -18 }
  ],
  "fx": { "reverb": { "preset": "small", "sendDb": -20 } },
  "variation": { "pitchCents": 30, "gainDb": 1, "variants": 4, "noRepeat": true },
  "meta": { "priority": 3, "intent": "oneshot" } }
```

## Top level

- `name`, `family`: lowercase-dash. Family sets the loudness offset and groups kit checks (coin,
  pickup, ui-click, ui-hover, blip, confirm, no, hit, explosion, ...).
- `duration`: note-off time in seconds; each layer releases after it.
- `layers`: 1-8. `fx`: optional `delay {time, feedback<=0.9, sendDb}`, `reverb {preset: small|room|hall|cave|space, sendDb}`
  and `dcBlock: true` (a one-pole 10 Hz DC blocker on the layer mix, before the effects, for `no-dc`;
  off by default, and patches without it render exactly as before; songs ignore it).
- `variation`: `pitchCents`, `gainDb`, `variants` (1-16), `noRepeat`, `weights` (relative play odds per variant).
- `xRuntime`: optional named runtime inputs (`inputs`, `bind`, `delivery`, `hold`) for a game that plays the patch live; ignored by every
  baked command. Format, units, macros and validation: `docs/runtime.md`; how to design inputs: `runtime-inputs.md` here.
- `xExpect`: optional checkable statements about how the sound should measure (`{ "check": "duration", "max": 0.35 }`, `centroid`, `pitch`, `tail`...).
  Never changes a render and is not part of a render key. `lint`, `kit check` and `build` check it; kinds, fields and units: `docs/expectations.md`.
- `meta`: `priority` 1 (most important) to 5, `intent` click|oneshot|bed, `description`,
  `loudnessOffsetDb` (-30..12 LU added to the family's offset for this patch alone; absent: none), and `variantOf`
  (hand-made variants authored as separate patches share it; `<stem>-<n>` names in one family group
  without it).

## Sources (`layers[].source`)

| type | fields | use for |
|---|---|---|
| `osc` | `wave` sine/square/sawtooth/triangle, `pitch`, `unison {voices, detuneCents}` | blips, coins, lasers, tones |
| `noise` | `color` white/pink/brown, `stereo` | whooshes, impacts, rumble, wide beds |
| `fm` | `pitch`, `operators [{ratio, index, wave, indexEnv?}]`, `algorithm [[from,to]]` (0 = carrier) | bells, metallic tones, growls |
| `additive` | `pitch`, `partials [[ratio, gainDb, decaySec]]` | bells, chimes, realistic tones |
| `modal` | `pitch`, `modes [[ratio, q, gainDb]]`, `exciter` impulse/noiseBurst | struck wood, glass, metal, clicks |
| `grains` | `rate` per s, `grainDecay`, `center`, `q`, `rateEnd`, `stereo` | shakers, rain, debris, crackle |
| `voice` | `pitch` (f0), `formants [[hz, q, gainDb]]` (2-4), `tilt`, `jitterCents`, `vibrato {rate, cents}`, `tremolo {rate, depth}`, `breath` | animal calls, creature vocals, grunts, hisses, huffs |
| `metal` | `base` Hz, `bands [bp1, bp2]` | hats, cymbals, robots, anvils (808 recipe) |
| `sample` | `asset: "sha256:<64 lowercase hex digits>"` | prepared recorded contact/detail, finite unpitched SFX |

### Prepared samples (engine 4)

Use `sample import` → `sample prepare --name` → edit/add procedural layers → save → render/lint/look →
`sample bundle` the final edited patch. Read [hybrid sources](hybrid-sources.md) directly for exact
commands, replay, privacy and native playback. A source ID names canonical prepared 48 kHz Float32
WAV bytes in the project store, not a local path or URL. Prepared sources are 1–480000 frames,
mono/stereo, up to ten seconds; normalized snapshots up to 120 seconds, original imports up to 64 MiB.
The patch still has at most eight layers total.

The sample plays once at the layer's `start`, with the ordinary amp/filter/gain/pan/effects chain.
Keep the preparation command's neutral amp for an unchanged recorded contour. Sample layers reject
`pitchEnv` and `lfo.target: "pitch"`; gain/cutoff LFOs remain valid. Samples do not pitch-shift with
transpose/variation, loop, stretch or act as song instruments. A held sample exhausts and begins its
authored release; it cannot become an infinite bed. Attenuation cannot restore already clipped PCM.

Runtime cues carry an exact prepared-source manifest. Resume the context in a user gesture, await
`loadCueAssets(ctx, cue, { baseURL: cueURL, signal })`, then create a fresh voice with
`build(ctx, out, cue, { samples })`. Graph construction stays synchronous with no I/O. Cache verified
buffers rather than started voices; use Stop/replacement abort and generation guards as shown in
[the runtime guide](../../../docs/runtime.md#playing-it).

### FM index envelopes

`index` sets an operator's peak modulation depth. Optional `indexEnv` multiplies that depth by
normalized breakpoints, letting the spectrum change independently of the audible amp envelope:

```json
{"type":"fm","pitch":"C4","operators":[{"ratio":1},
 {"ratio":2.76,"index":4,"indexEnv":[[0,0],[0.006,1],[0.15,0.2,"exp"],[0.6,0]]}],
 "algorithm":[[1,0]]}
```

- Points are `[seconds, scale, arrivalCurve?]`, relative to the layer's onset. Times are finite,
  start at 0, increase strictly, and stay in 0–10 seconds; scales are 0–1. Use 1–64 points.
- `linear` is the default arrival; `step` holds then jumps; `exp` interpolates exponentially
  and needs positive scales at both ends. Use linear segments to reach or leave zero.
- The final scale holds. Held voices keep the same onset clock; releasing the amp does not
  restart the index envelope. Points after the source stops are inaudible.
- Only operators with outgoing modulation edges can use `indexEnv`. The audible carrier's
  index alone has no effect. Each outgoing edge follows its operator's curve.
- Static `xRuntime` bindings and song `velocityInput` mappings on `index` scale the whole curve.
  Bound curve values/times are checked again at actual runtime values before automation.
- Without `indexEnv`, the fixed-index graph is unchanged. Engine 3 is required for enveloped
  cues; rebuild locks/cues when updating. High ratios/indices can still alias; this adds no
  oversampling or anti-alias guarantee. Compare at matched loudness and inspect the spectrum.

The [Flux study](https://ehartye.github.io/agent-beeps/#flux) demonstrates three static/shaped pairs.

`noise` and `grains` are mono by default. `stereo: true` (or a width 0..1; correlation between the
channels is sqrt(1 - width)) gives each channel its own seeded noise: deterministic, the left channel
is the mono signal, and patches without it render exactly as before. Use it on beds and ambiences;
a layer `pan` then moves the whole image as a balance. Two panned mono tracks with different noise
are no longer needed for width.

`voice` is a source-filter voice: a glottal pulse train at `pitch` (draw the f0 contour with the
layer's `pitchEnv`) feeds 2-4 parallel bandpass resonances that stay put as the pitch moves, as a
real tract does. `tilt` is the harmonic slope (1/n^tilt: 0.7-1 buzzy and raspy, 2+ soft and hooty),
`jitterCents` a seeded random pitch wobble (roughness), `vibrato` and `tremolo` the wobble of a
bleat or the flutter of a growl, `breath` (0..1) swaps pulse energy for seeded breath noise through
the same formants (1 is a hiss). Rough formant starting points: open "ah" 700/1200/2600, "oo" 350/700/2300,
"eh" 550/1800/2500. Small animals sit higher (yip: 900/2200/3200), big ones lower (moo: 450/800/2200).
Songs pitch-shift it; the formants do not move. New type: existing patches render exactly as before.

`pitch` is a note name (`E6`, `F#5`, `Bb3`) or Hz. Pitched sources snap to the project scale
(`beeps init --scale C:majorPentatonic` is the default) so overlapping sounds share a key. Songs
(beeps-music) never snap: a patch played as an instrument sounds the notes the song writes.

## Per layer

- `start` offset (s), `gainDb` balance, `pitchEnv [{at, to, curve: step|linear|exp}]` (all
  frequency params follow, keeping their ratios).
- `amp {attack, decay, sustain 0-1, release}`: linear attack, exponential decay toward sustain.
- `filter`: `lowpass`/`highpass` take `cutoff` and `resonanceDb`; `bandpass`/`notch`/`peaking` take
  `cutoff`, `q` (and `gainDb` for peaking). Optional `env {to, time}` sweeps the cutoff.
- `highpass` (Hz, 10-2000): an optional second filter after the amp envelope (resonance 0), so a
  lowpassed layer can also lose its sub-audible content (`filter` is one filter per layer). It is
  the `no-dc` fix for a short low sine or lowpassed noise burst; absent, the graph is unchanged.
- `lfo {target: pitch|gain|cutoff, rate, depth}` (pitch depth in cents, cutoff in Hz, gain 0-1).
- `drive` 0-1 soft saturation; `pan` -1..1.

## Errors

A bad patch fails with `E_SCHEMA`, a JSON `pointer` to the field, and a `hint`. Fix exactly that
field; `beeps batch ... --dry-run` checks a whole edit before writing.
