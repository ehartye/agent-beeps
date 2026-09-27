# Space to Grow · places and small acts of care

Original procedural sound designs for Clementine's Plot 7B, authored for this project on
2026-09-27. No recordings or third-party samples are used. The JSON recipes are the source;
rendered WAVs are build artifacts. These assets accompany the separate D-centred musical score.

`project.json` records the exact render configuration: D major pentatonic snapping for effects,
48 kHz, the standard effect target and music target. Songs do not snap their pitches. Each effect
was exported with seed **1**, variant **0**; its recipe also defines four playback variations.

## Environmental loops

Each scene is a 20-second, four-bar loop at 48 BPM. The tempo only provides a time grid: there is
no drum pattern or tune. Long breaths, sparse incidental events and reverb/release tail folding
make a continuous environment. These are separate ambience assets, intended to sit quietly under
the score with scene crossfades, not compete with it at their normalized audition level.

| Game ID | Source | Layers and purpose | Seam level difference |
| --- | --- | --- | --- |
| `ambience-garden` | `environments/garden.json` | Filtered leaf-air, irregular fine foliage, distant life support and two small water drops; an inhabited garden sheltered from space | 1.1 dB |
| `ambience-upside` | `environments/upside.json` | Airborne wind, a lower drifting wash and alternating glass resonances; spacious without a bass drone | 1.1 dB |
| `ambience-interior` | `environments/interior.json` | Warm ventilation, a subdued appliance, a soft kettle texture and rare ceramic contacts | 0.4 dB |
| `ambience-barn` | `environments/barn.json` | D2 machinery, an airy middle layer, D3 field resonance and occasional hardware settling; the portal is powered but not travelling | 0.3 dB |

The beds render at -20 LUFS integrated. All have zero song-lint errors. The Upside's thin-low-end
warning is intentional: it leaves space for the separately playing score and distinguishes the
weightless place. Whole-song register diagnostics currently label noise/grain trigger notes as
pitched overlaps; those labels are not evidence of actual tonal masking. Filter bands and stem
measurements were used to balance those layers. Noises retain deliberate overlap as a continuous
environment; the occasional pitched details remain subordinate.

## Interaction effects

| Game ID / source file in `effects/` | Listening label | Event and character |
| --- | --- | --- |
| `till` | Soil and steel | Successful tilling: a padded tool bite, quiet handle contact and loose grains settling |
| `plant` | A seed tucked in | Successful planting: tiny shell rattle, soft soil and a rounded low pluck |
| `water` | Watering the roots | Successful watering: soft pouring noise and staggered falling droplets |
| `harvest` | Picked with care | Successful harvest: a woody stem release with restrained upper overtones |
| `discovery` | Something new in the Almanac | First discovery only: a four-note glass figure with a warm low anchor |
| `door` | Habitat door | A building transition: rounded latch, short air seal and cushioned catch |
| `portal` | Across the threshold | Completed portal travel: gathering field, air passage and an opening fifth |
| `repair` | The fitting catches | Successful repair only: two hardware contacts followed by warm resonance |
| `rest` | Breathe, then begin again | A short rest transition: descending ceramics and an exhale |

All nine effect renders have zero lint errors. Discovery and rest retain approximately one-second
tails, exceeding the generic `confirm` family warning of 0.8 seconds; both are rare transitions,
not rapid UI confirmations. Repeated actions have short energy lengths and four no-repeat recipe
variants. A single exported WAV does not contain those variants: the first game integration uses
variant 0; export additional variants if the game later chooses between them.

Inspection covered every effect in the contact sheet and all four environment look images:
intended noise bands, sparse resonances, non-clipped peaks, decaying effect tails and steady loop
edges. Stem measurements exposed and corrected inaudible glass/ceramic details and excessive
sub-bass in the first barn draft. This is measured and visual validation, not a claim of listening
approval. The owner hears the labeled effects in an exploration session and beds in an album.

## Rebuild and delivery

Create an isolated beeps project, copy this `project.json` into its `.agent-beeps/project.json`,
then run from the agent-beeps repository:

```text
node scripts/beeps.mjs --project <work> export library/sounds/space-to-grow/effects/till.json --seed 1 --variant 0 --wav <delivery>/till.wav --manifest --role sfx
node scripts/beeps.mjs --project <work> song export library/sounds/space-to-grow/environments/garden.json --wav <delivery>/ambience-garden.wav --manifest --role ambience
```

Repeat for the IDs in the tables. Each `<id>.wav.json` sidecar records the asset identity, role,
render key, timing and measured loudness used by the game mixer.

Current local delivery (outside Git):

- `C:/Users/ehart/repos/agent-beeps/.agent-beeps/space-to-grow-delivery/mapping.json` maps all 13 IDs to exact source, WAV and sidecar paths.
- `C:/Users/ehart/repos/agent-beeps/.agent-beeps/space-to-grow-delivery/<id>.wav` and `<id>.wav.json` are the copy-ready assets.
- `C:/Users/ehart/repos/agent-beeps/.agent-beeps/space-to-grow/effects-sheet.png` is the inspected effect contact sheet.
- `C:/Users/ehart/repos/agent-beeps/.agent-beeps/space-beds-render.json` contains final environment look paths and measurements.

One asset has one cause: do not play success effects after an unsuccessful action. The game mixer
owns scene fades and music/ambience/effects gains; do not bake gameplay gain into these recipes.
