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
- `layers`: 1-8. `fx`: optional `delay {time, feedback<=0.9, sendDb}` and `reverb {preset: small|room|hall|cave|space, sendDb}`.
- `variation`: `pitchCents`, `gainDb`, `variants` (1-16), `noRepeat`, `weights` (relative play odds per variant).
- `meta`: `priority` 1 (most important) to 5, `intent` click|oneshot|bed.

## Sources (`layers[].source`)

| type | fields | use for |
|---|---|---|
| `osc` | `wave` sine/square/sawtooth/triangle, `pitch`, `unison {voices, detuneCents}` | blips, coins, lasers, tones |
| `noise` | `color` white/pink/brown | whooshes, impacts, rumble |
| `fm` | `pitch`, `operators [{ratio, index, wave}]`, `algorithm [[from,to]]` (0 = carrier) | bells, metallic tones, growls |
| `additive` | `pitch`, `partials [[ratio, gainDb, decaySec]]` | bells, chimes, realistic tones |
| `modal` | `pitch`, `modes [[ratio, q, gainDb]]`, `exciter` impulse/noiseBurst | struck wood, glass, metal, clicks |
| `grains` | `rate` per s, `grainDecay`, `center`, `q`, `rateEnd` | shakers, rain, debris, crackle |
| `metal` | `base` Hz, `bands [bp1, bp2]` | hats, cymbals, robots, anvils (808 recipe) |

`pitch` is a note name (`E6`, `F#5`, `Bb3`) or Hz. Pitched sources snap to the project scale
(`beeps init --scale C:majorPentatonic` is the default) so overlapping sounds share a key. Songs
(beeps-music) never snap: a patch played as an instrument sounds the notes the song writes.

## Per layer

- `start` offset (s), `gainDb` balance, `pitchEnv [{at, to, curve: step|linear|exp}]` (all
  frequency params follow, keeping their ratios).
- `amp {attack, decay, sustain 0-1, release}`: linear attack, exponential decay toward sustain.
- `filter`: `lowpass`/`highpass` take `cutoff` and `resonanceDb`; `bandpass`/`notch`/`peaking` take
  `cutoff`, `q` (and `gainDb` for peaking). Optional `env {to, time}` sweeps the cutoff.
- `lfo {target: pitch|gain|cutoff, rate, depth}` (pitch depth in cents, cutoff in Hz, gain 0-1).
- `drive` 0-1 soft saturation; `pan` -1..1.

## Errors

A bad patch fails with `E_SCHEMA`, a JSON `pointer` to the field, and a `hint`. Fix exactly that
field; `beeps batch ... --dry-run` checks a whole edit before writing.
