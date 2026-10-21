# Colony SFX · places and small acts of care

A worked example of a small environment and effect kit: four ambience beds and nine interaction
effects for a quiet, cultivation-and-craft setting. All sounds are original procedural designs. No
recordings or third-party samples are used. The JSON recipes are the source; rendered WAVs are
build artifacts. The kit pairs with the song set in `library/songs/colony-ambient`, which uses the
same D-centred palette.

`project.json` records the render configuration the kit was designed against: D major pentatonic
snapping for effects, 48 kHz, the standard effect target (-18 LUFS) and music target (-20 LUFS).
Songs do not snap their pitches. Each effect was exported with seed **1**, variant **0**; its
recipe also defines four playback variations.

## Environmental loops

Each scene is a 20-second, four-bar loop at 48 BPM. The tempo only provides a time grid: there is
no drum pattern or tune. Long breaths, sparse incidental events and reverb/release tail folding
make a continuous environment. They are separate ambience assets, meant to sit quietly under
music with scene crossfades, not compete with it at their normalized audition level.

| Asset | Source | Layers and purpose | Seam level difference |
| --- | --- | --- | --- |
| `ambience-glasshouse` | `environments/glasshouse.json` | Filtered leaf-air, irregular fine foliage, distant life support and two small water drops; an inhabited garden sheltered from the outside | 1.1 dB |
| `ambience-canopy` | `environments/canopy.json` | Airborne wind, a lower drifting wash and alternating glass resonances; spacious without a bass drone | 1.1 dB |
| `ambience-interior` | `environments/interior.json` | Warm ventilation, a subdued appliance, a soft kettle texture and rare ceramic contacts | 0.4 dB |
| `ambience-workshop` | `environments/workshop.json` | D2 machinery, an airy middle layer, D3 field resonance and occasional hardware settling; powered but idle | 0.3 dB |

The beds render at -20 LUFS integrated. All four have zero song-lint errors and zero warnings.
The canopy bed's low end is thin on purpose: it leaves space for music playing underneath and
distinguishes a weightless place. Whole-song register diagnostics currently label noise/grain trigger notes as
pitched overlaps; those labels are not evidence of actual tonal masking. Filter bands and stem
measurements were used to balance those layers. Noises retain deliberate overlap as a continuous
environment; the occasional pitched details remain subordinate.

## Interaction effects

| Asset / source file in `effects/` | Listening label | Event and character |
| --- | --- | --- |
| `till` | Soil and steel | Successful tilling: a padded tool bite, quiet handle contact and loose grains settling |
| `plant` | A seed tucked in | Successful planting: tiny shell rattle, soft soil and a rounded low pluck |
| `water` | Watering the roots | Successful watering: soft pouring noise and staggered falling droplets |
| `harvest` | Picked with care | Successful harvest: a woody stem release with restrained upper overtones |
| `discovery` | A new find | First discovery only: a four-note glass figure with a warm low anchor |
| `door` | Interior door | A building transition: rounded latch, short air seal and cushioned catch |
| `portal` | Across the threshold | Completed portal travel: gathering field, air passage and an opening fifth |
| `repair` | The fitting catches | Successful repair only: two hardware contacts followed by warm resonance |
| `rest` | Breathe, then begin again | A short rest transition: descending ceramics and an exhale |

All nine effect renders have zero lint errors. Discovery and rest retain approximately one-second
tails, exceeding the generic `confirm` family warning of 0.8 seconds; both are rare transitions,
not rapid UI confirmations. Repeated actions have short energy lengths and four no-repeat recipe
variants. A single exported WAV does not contain those variants: export additional variants if the
consuming application chooses between them.

Inspection covered every effect in the contact sheet and all four environment look images:
intended noise bands, sparse resonances, non-clipped peaks, decaying effect tails and steady loop
edges. Stem measurements exposed and corrected inaudible glass/ceramic details and excessive
sub-bass in the first workshop draft. This is measured and visual validation, not a claim of
listening approval; judge the labeled effects in an exploration session and the beds in an album.

## Rebuild and delivery

Create an isolated beeps project, copy this `project.json` into its `.agent-beeps/project.json`,
then run from the agent-beeps repository:

```text
node scripts/beeps.mjs --project <work> export library/sounds/colony-sfx/effects/till.json --seed 1 --variant 0 --wav <delivery>/till.wav --manifest --role sfx
node scripts/beeps.mjs --project <work> song export library/sounds/colony-sfx/environments/glasshouse.json --wav <delivery>/ambience-glasshouse.wav --manifest --role ambience
```

Repeat for the assets in the tables. Each `<asset>.wav.json` sidecar records the asset identity,
role, render key, timing and measured loudness for the consuming mixer.

## Guidance this kit illustrates

- One asset has one cause: do not play success effects after an unsuccessful action.
- The consuming application's mixer owns scene fades and music/ambience/effects gains; do not bake
  gain for a particular context into these recipes.
- Keep rare transitions (discovery, rest) apart from repeated actions: repeated sounds stay short
  and carry no-repeat variants, rare ones may ring longer.
- Give each bed layers that do different jobs (air, texture, resonance, incident), and leave the
  low end open when music will play on top.
