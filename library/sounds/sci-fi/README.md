# Sci-fi sound collection

Eighteen owner-approved procedural effects. Expedition and Oddities preserve the original
samplers; Arcade includes the revised blaster, shield, hyperdrive and asteroid, with the original
Energy Shard and Gravity Hop. Each patch includes its intended use in `meta.description`.

| Expedition | Arcade | Oddities |
|---|---|---|
| Scanner Pulse | Comet Blaster | Crystal Switch |
| Relic Discovered | Shield Ripple | Pocket Portal |
| Curious Alien | Hyperdrive Charge | Sleepy Robot |
| Navigation Online | Asteroid Burst | Star Candy |
| Airlock Breath | Energy Shard | Bubble Ray |
| Engine Sleep | Gravity Hop | Cosmic Owl |

## Use

In a new project, place `project.json` and `kit.json` in `.agent-beeps/`, and copy the contents
of `patches/` into `.agent-beeps/patches/`. Keep the kit's seeds and measured trims: they reproduce
the approved sound identity and level. The project uses C major pentatonic, scale snapping,
48 kHz and a -18 LUFS base target with the normal family offsets.

From that project, export a WAV with the installed CLI:

```text
beeps export comet-blaster --wav assets/sfx/comet-blaster.wav
beeps kit check
```

For live Web Audio, pass the patch and its matching kit entry's `seed` and `trimDb`, plus
`scale: project.scale`, to `buildPatch`. Patches are editable synthesis definitions; WAVs are
generated outputs.

## Validation and intended limits

All 18 sounds render with zero lint errors. Hyperdrive deliberately sustains its charged hum
for about two seconds, exceeding the ordinary 1.2-second powerup tail recommendation.
The shipped WAV exports were copied from the approved previews. Independent rerenders of the
renamed patches match within one 16-bit PCM quantization step; Chromium's floating-point
rendering can differ at the rounding boundary.

This is a collection of distinct roles, not a finished mix for one game. Kit checks flag potential
masking between some effects, moving pitches between scale tones, and different registers within
the broad alarm family (scanner versus owl). These are intentional for individual effects;
audition the subset that can overlap in the target game before integration. The collection has
no refusal event, so the generic "one no sound" kit warning also remains. No extra refusal cue
or global remix was added to the approved set.
