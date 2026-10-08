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
- `meta`: `priority` 1 (most important) to 5, `intent` click|oneshot|bed, `description`, and `variantOf`
  (hand-made variants authored as separate patches share it; `<stem>-<n>` names in one family group
  without it).

## Sources (`layers[].source`)

| type | fields | use for |
|---|---|---|
| `osc` | `wave` sine/square/sawtooth/triangle, `pitch`, `unison {voices, detuneCents}` | blips, coins, lasers, tones |
| `noise` | `color` white/pink/brown, `stereo` | whooshes, impacts, rumble, wide beds |
| `fm` | `pitch`, `operators [{ratio, index, wave}]`, `algorithm [[from,to]]` (0 = carrier) | bells, metallic tones, growls |
| `additive` | `pitch`, `partials [[ratio, gainDb, decaySec]]` | bells, chimes, realistic tones |
| `modal` | `pitch`, `modes [[ratio, q, gainDb]]`, `exciter` impulse/noiseBurst | struck wood, glass, metal, clicks |
| `grains` | `rate` per s, `grainDecay`, `center`, `q`, `rateEnd`, `stereo` | shakers, rain, debris, crackle |
| `voice` | `pitch` (f0), `formants [[hz, q, gainDb]]` (2-4), `tilt`, `jitterCents`, `vibrato {rate, cents}`, `tremolo {rate, depth}`, `breath` | animal calls, creature vocals, grunts, hisses, huffs |
| `metal` | `base` Hz, `bands [bp1, bp2]` | hats, cymbals, robots, anvils (808 recipe) |

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
