# Colony Ambient — outpost, underside, window

A worked example of a small, connected song set: three original procedural scores for a quiet
orbital-garden setting, its floating underside and a furnished home module. A shared eight-note
seed phrase makes the places feel connected: D–F♯–A–E, then D–B–A–E, with rests between
gestures. The instruments are synthesized acoustic-like textures, not recordings.

| Song | Asset | Job and character | Form (4 bars per section) |
| --- | --- | --- | --- |
| Outpost Dawn | `music-dawn` | 80 BPM, 72 seconds. D-major warmth with a Lydian middle; breathy reed, plucked strings, soft roots, hand drum and two dew-like bell notes. | beds → shoots → paths → sunlight → water → beds |
| The Underside | `music-underside` | 72 BPM, 80 seconds. The seed phrase over Bm9, Gmaj7♯11 and suspended colors; airy felt-piano memory, glass and sparse plucks, without drums. | float → remember → clockwork → opening → drift → float |
| Window Light | `music-window` | 76 BPM, 50.526 seconds. Intimate felt-piano statement one octave lower, a few plucked answers, quiet roots and a supporting upper pad. | window → letter → kettle → window |

Each loop returns to its opening accompaniment. The outpost melody rests during half the form;
the underside alternates melody and glints; the window song has a single explicit statement
framed by more fragmentary piano notes. These are background scores with room for environmental
sound and interaction cues (see `library/sounds/colony-sfx`), not cues to layer simultaneously.
Let the consuming application crossfade the scores between scenes.

## Reproduce and inspect

From the project root (the library songs are found by bare name):

```powershell
node scripts/beeps.mjs song check outpost-dawn the-underside window-light
node scripts/beeps.mjs song render outpost-dawn the-underside window-light
node scripts/beeps.mjs song stems outpost-dawn
node scripts/beeps.mjs song stems the-underside
node scripts/beeps.mjs song stems window-light
node scripts/beeps.mjs album open outpost-dawn the-underside window-light --title "Colony Ambient — outpost, underside, window"
node scripts/beeps.mjs song export outpost-dawn --wav <delivery>/music-dawn.wav --manifest --role music
node scripts/beeps.mjs song export the-underside --wav <delivery>/music-underside.wav --manifest --role music
node scripts/beeps.mjs song export window-light --wav <delivery>/music-window.wav --manifest --role music
```

Validation used 48 kHz stereo and a project `musicLoudness` of -20 (the settings in
`library/sounds/colony-sfx/project.json`). That project's D-major-pentatonic SFX snapping does
not apply to songs. Each export has a `.wav.json` asset manifest; its source ID is the song
name, while the WAV basename is the asset alias above. WAVs and render artifacts are ignored
local files, not committed source assets.

| Song | LUFS integrated | True peak dBTP | Loudness range LU | Loop edge level difference dB | Low-frequency share |
| --- | ---: | ---: | ---: | ---: | ---: |
| Outpost Dawn | -20 | -4.66 | 5.5 | 0.3 | 13.7% |
| The Underside | -20 | -7.85 | 3.9 | 0.4 | 7.8% |
| Window Light | -20 | -3.72 | 6.7 | 0.1 | 20.0% |

All three scores pass schema/check and render lint with zero errors and zero warnings. A song
retunes its instrument to each written note, so an instrument built at middle C and written two
octaves up would be flagged (`song-written-pitch`). The pad, pluck, bell and piano that sit far from
their library root therefore use song-local copies (`warm-pad-c5`, `soft-pluck-fs4` and so on, named
for the pitch they are built at) with every pitched layer moved to where the track plays, and the
outpost reed is built at E5. The copies sound exactly as the library instruments retuned did: the
renders are sample-for-sample identical to before. The library instruments are unchanged. Whether a texture built
for one register still suits another is a listening judgement the linter cannot make.
All
three look images were inspected: the section arcs match the forms, quiet endings return to the
opening density, and bass energy leaves gaps between notes. The loop edge metric measures level
consistency, not a guarantee of inaudible musical joins; listening remains the final judgment.

Stems were inspected at full-mix trim. The first pass exposed a buried hand drum and overly
dominant pads. The final pass brings the physical gestures forward and makes the piano the
leading voice in the window song. Final stem levels sit within 12.5 LU of their mixes; there are
no buried-part warnings. Shared registers are deliberate soft accompaniment underneath distinct
attacks, with sparse melody and pluck rhythms. The evidence is arrangement and measured balance,
not a claim that a spectrogram can establish subjective masking.

Render keys (prefixes used in `.agent-beeps/renders/song-<prefix>/`) were recomputed after the
songs were renamed, with the `library/sounds/colony-sfx/project.json` settings, so they change if a
song's name, tags or content change:

- Outpost Dawn: `fe050a1bda1e1e78f33868f8d78e8b6654b6fc57`
- The Underside: `ba7c0a3a50747000206a805b1239f8407d06a4b2`
- Window Light: `e844f461c668e55a0922f263383fc61abc8f4b1e`

## Tool friction observed during composition

The check outline's textual chord-voicing list did not pass the pattern's
`slash: false` option to the voicer. For `E/D` it printed an extra D3 even though
the compiled track correctly omitted that slash bass. The event-derived track
range was correct. This is an outline-reporting discrepancy, not a rendered
musical error, and it warrants a focused regression test in the tool.

The progressive album delivered a listening link before rendering completed;
stem analysis caught the balance issue before final exports. Export sidecars now
carry the loop flag, duration, role, normalization state and source render key,
so a consuming application can use explicit metadata rather than infer it from names.
