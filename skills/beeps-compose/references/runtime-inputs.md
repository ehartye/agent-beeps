# Runtime inputs: designing a patch a game plays live

Read `docs/runtime.md` for the format and the API; this page is how to decide and design. You cannot hear: the checks below
are measurements and `look` images, and the owner's ear still judges (beeps-audition plays the patch at its defaults, which
is the sound the game plays when no input has moved).

## Runtime or baked?

Ask what in the game changes the sound.

- **Nothing** (a UI click, a pickup, a one-shot): bake it. Do not add `xRuntime`.
- **A continuous quantity** (speed, load, distance, charge, mass, health): runtime, with an input per quantity.
- **A choice among a few flavours**: bake the variants (`variation.variants`), unless the flavours are points on a scale that
  the game already has as a number.
- **A long tail, heavy noise or a grain cloud**: bake; building a grain cloud costs about 4 ms of main-thread time on desktop-class
  hardware (phones are unmeasured; see the hardware guidelines in `docs/runtime.md`).
- **Many copies at once** (rain, a crowd's footsteps, gun fire): bake, or runtime with the reverb sent to a shared bus and few
  voices per frame; measure with `beeps runtime perf --bus`.

`delivery: both` while migrating: the game keeps the baked file and trials the cue, and `beeps verify --parity` keeps them
the same sound.

## Declare inputs

One input per game quantity. `min` and `max` are the game's real range; **`default` is the value the authored patch already
sounds right at** (it is the sound the owner auditions, the sound that is baked and the level the cue's trim is measured at).
Camel-case names the game's code would use (`speed`, `distance`, `size`). Add a `description` saying what 0 and 1 mean.

## Bind

`range` is the binding's value at `min` and at `max`; the authored value sits at `default`, so a binding is a delta.

| Want | Target | Range unit | Live? |
|---|---|---|---|
| louder or quieter overall | `/out/gainDb` | dB | yes |
| pitch of everything | `/out/transpose` | semitones | yes (continuous); a static one is snapped to the scale |
| brighter or darker | `/out/brightness` | octaves of every cutoff | yes |
| one layer's level | `/layers/N/gainDb` | dB | yes |
| pan | `/layers/N/pan` | -1..1, added | yes |
| one filter cutoff | `/layers/N/filter/cutoff` | octaves | yes |
| LFO speed | `/layers/N/lfo/rate` | octaves | yes |
| reverb or delay amount | `/fx/reverb/sendDb`, `/fx/delay/sendDb` | dB | yes |
| envelope time, grain rate, noise colour, unison, an FM index | `/layers/*/amp/decay` and the like | octaves for times and rates | **no**: fixed at `start()` |

Make an input **live** when it changes while the sound plays (an engine, a charge-up, a proximity hum). Make it static when
it is known when the sound starts (a size, a weight, a material); a static binding can move anything in the patch.

Prefer a few bindings per input that each do one audible thing. Check each range at both ends: add `clamp` when an end would
make a number invalid (a cutoff below 20 Hz). `parsePatch` names the input corner that breaks the patch.

## Check

1. `beeps lint` the patch (defaults).
2. `beeps runtime check <patch>` lints the defaults, each input at min and at max, all min, all max. Read `newAtCorner` (a
   finding the default does not have, such as `no-dc` at a size extreme) and `runtime.vsDefaultLu`, the loudness spread: a
   full-range engine that is 8 LU louder at the top needs `/out/gainDb` bound against its other bindings.
3. `beeps runtime look <patch> --set speed=1` at each extreme: the baked and runtime images must match, and you read the
   spectrogram for energy you did not intend.
4. `beeps runtime parity <patch>` must pass in Chromium; add `--engines chromium,firefox` for sweeps and noise.
5. A live input: `beeps runtime live <patch> --input speed --to 1`; `stepRatio` near 1 means no click, `finite` true.

## Variation, seeds and the scale

- Variety from `variant` (declared 4 to 16) or a handful of fixed seeds costs nothing. A fresh `seed` per play builds a fresh
  noise buffer per noise layer each time (the engine keeps at most 16 MiB of them, but building them is the cost): prefer
  `seed: base + (play % 8)`.
- The project scale snaps the authored pitch; variants and live transposition then detune it, so `pitchCents` works in a
  snapping project. A static pitch input is snapped; use a live one (or `scale: null` in `build`) for a continuous pitch.
- A patch with a `voice` source plays at runtime like any other (the creature call example). Its jitter table is built per
  voice (375 KB), so keep creature calls few per frame.
