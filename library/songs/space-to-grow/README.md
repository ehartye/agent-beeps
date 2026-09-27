# Space to Grow — garden, sky, home

Three original procedural scores for Clementine's Plot 7B, its floating Upside,
and the furnished habitat interiors. A shared eight-note seed phrase makes the
places feel connected: D–F♯–A–E, then D–B–A–E, with rests between gestures.
The instruments are synthesized acoustic-like textures, not recordings.

| Song | Game asset | Job and character | Form (4 bars per section) |
| --- | --- | --- | --- |
| Sproutpost | `music-garden` | 80 BPM, 72 seconds. D-major warmth with a Lydian middle; breathy reed, plucked strings, soft roots, hand drum and two dew-like bell notes. | beds → shoots → paths → sunlight → water → beds |
| The Upside | `music-upside` | 72 BPM, 80 seconds. The seed phrase over Bm9, Gmaj7♯11 and suspended colors; airy felt-piano memory, glass and sparse plucks, without drums. | float → remember → wingnuts → opening → drift → float |
| Clementine's Window | `music-interior` | 76 BPM, 50.526 seconds. Intimate felt-piano statement one octave lower, a few plucked answers, quiet roots and a supporting upper pad. | window → letter → kettle → window |

Each loop returns to its opening accompaniment. The garden melody rests during
half the form; the Upside alternates melody and glints; the interior has a single
explicit statement framed by more fragmentary piano notes. These are background
scores with room for environmental sound and interaction cues, not cues to layer
simultaneously. Let scene transitions crossfade the scores in the consuming game.

## Reproduce and inspect

From the project root:

```powershell
node scripts/beeps.mjs song check sproutpost the-upside clementines-window
node scripts/beeps.mjs song render sproutpost the-upside clementines-window
node scripts/beeps.mjs song stems sproutpost
node scripts/beeps.mjs song stems the-upside
node scripts/beeps.mjs song stems clementines-window
node scripts/beeps.mjs album open sproutpost the-upside clementines-window --title "Space to Grow — garden, sky, home"
node scripts/beeps.mjs song export sproutpost --wav .agent-beeps/space-to-grow-delivery/music-garden.wav --manifest --role music
node scripts/beeps.mjs song export the-upside --wav .agent-beeps/space-to-grow-delivery/music-upside.wav --manifest --role music
node scripts/beeps.mjs song export clementines-window --wav .agent-beeps/space-to-grow-delivery/music-interior.wav --manifest --role music
```

Validation on 2026-09-27 used 48 kHz stereo and project `musicLoudness: -20`.
The project's C-major-pentatonic SFX snapping does not apply to songs. Each export
has a `.wav.json` asset manifest; its source ID is the song name, while the WAV
basename is the game asset alias above. WAVs and render artifacts are ignored
local files, not committed source assets.

| Song | LUFS integrated | True peak dBTP | Loudness range LU | Loop edge level difference dB | Low-frequency share |
| --- | ---: | ---: | ---: | ---: | ---: |
| Sproutpost | -20 | -4.66 | 5.5 | 0.3 | 13.7% |
| The Upside | -20 | -7.85 | 3.9 | 0.4 | 7.8% |
| Clementine's Window | -20 | -3.72 | 6.7 | 0.1 | 20.0% |

All three final scores passed schema/check and render lint with zero errors and
zero warnings. All three look images were inspected: the section arcs match the
forms, quiet endings return to the opening density, and bass energy leaves gaps
between notes. The loop edge metric measures level consistency, not a guarantee
of inaudible musical joins; the owner's listening remains the final judgment.

Stems were inspected at full-mix trim. The first pass exposed a buried garden
hand drum and overly dominant pads. The final pass brings the garden's physical
gestures forward and makes the interior piano the leading voice. Final stem
levels sit within 12.5 LU of their mixes; there are no buried-part warnings.
Shared registers are deliberate soft accompaniment underneath distinct attacks,
with sparse melody and pluck rhythms. The evidence is arrangement and measured
balance, not a claim that a spectrogram can establish subjective masking.

Final render keys (prefixes used in `.agent-beeps/renders/song-<prefix>/`):

- Sproutpost: `724051d4a0a067be58d3f824dac8b7fe9f3c4225`
- The Upside: `2a5080cbb8bb14fd879454503530e883ae01c753`
- Clementine's Window: `353467f30258c2f6e1af0aaf46ff20edd5246605`

## Tool friction observed during composition

The check outline's textual chord-voicing list did not pass the pattern's
`slash: false` option to the voicer. For `E/D` it printed an extra D3 even though
the compiled track correctly omitted that slash bass. The event-derived track
range was correct. This is an outline-reporting discrepancy, not a rendered
musical error, and it warrants a focused regression test in the tool.

The progressive album delivered a listening link before rendering completed;
stem analysis caught the balance issue before final exports. Export sidecars now
carry the loop flag, duration, role, normalization state and source render key,
so the consuming game can use explicit metadata rather than infer it from names.
