# Colony Ambient — outpost, underside, window

A worked example of a small, connected song set: three original procedural scores for a quiet
orbital-garden setting, its floating underside and a furnished home module. A shared eight-note
seed phrase makes the places feel connected: D–F♯–A–E, then D–B–A–E, with rests between
gestures. The instruments are synthesized acoustic-like textures, not recordings.

| Song | Asset | Job and character | Form (4 bars per section) |
| --- | --- | --- | --- |
| Outpost Dawn | `music-dawn` | 80 BPM, 72 seconds. D-major warmth with a Lydian middle; breathy reed, plucked strings, soft roots, hand drum and two dew-like bell notes. | beds → shoots → paths → sunlight → water → beds |
| The Underside | `music-underside` | 72 BPM, 80 seconds. The seed phrase over Bm9, Gmaj7♯11 and suspended colors; airy felt-piano memory, glass and sparse plucks, without drums. | float → remember → clockwork → opening → drift → float |
| Window Light | `music-window` | 76 BPM, 50.526 seconds. Intimate felt-piano statement one octave lower, a few plucked answers, quiet roots and a soft low pad. | window → letter → kettle → window |

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
| Outpost Dawn | -20 | -4.09 | 5.6 | 1.9 | 21.6% |
| The Underside | -20 | -5.23 | 4.9 | 0.5 | 13.1% |
| Window Light | -20 | -3.84 | 6.7 | 0.7 | 21.6% |

All three scores pass schema/check and render lint with zero errors and zero warnings. Each part is
written in the range its instrument was built for: pads at octave 3 and arps at octave 4 for the
C4-rooted library instruments, the sparkle on `shimmer` (rooted at C6), and the instruments the songs
define themselves (the outpost reed at C5, plucks rebuilt around F4 and A4 with their filters scaled to
match) built at the pitch they play. Where a phrase sat above its instrument's range it moved down an
octave (the underside's felt-piano memory, the window song's plucked answers), the pads dropped the
chord tones that would reach past C5, and the outpost loop now returns to its opening chord so the
loop seam stays under 2 dB. All
three look images were inspected: the section arcs match the forms, quiet endings return to the
opening density, and bass energy leaves gaps between notes. The loop edge metric measures level
consistency, not a guarantee of inaudible musical joins; listening remains the final judgment.

Stems were inspected at full-mix trim. The first pass exposed a buried hand drum and overly
dominant pads. The final pass brings the physical gestures forward and makes the piano the
leading voice in the window song. Final stem levels sit within 11.5 LU of their mixes; there are
no buried-part warnings. Shared registers are deliberate soft accompaniment underneath distinct
attacks, with sparse melody and pluck rhythms. The evidence is arrangement and measured balance,
not a claim that a spectrogram can establish subjective masking.

Render keys (prefixes used in `.agent-beeps/renders/song-<prefix>/`) were recomputed after the
songs were renamed, with the `library/sounds/colony-sfx/project.json` settings, so they change if a
song's name, tags or content change:

- Outpost Dawn: `419b08fab37ac2e471c19aaaba2371fec04b4518`
- The Underside: `de8db4b7029c5d805acf78bc62b2d045979ee66f`
- Window Light: `ef443dc738b557c620eb7c7b62b51b9d7b370a14`

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
