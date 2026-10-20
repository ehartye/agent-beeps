# Guitar-driven rock and metal

A worked example: how a gritty combat-racing metal score can be built with beeps, in the order it was done. The reasoning is in
`craft/GUIDE.md` section 11. Each part says what was measured and what only a listener can judge: measurements are not a listening verdict.

## 1. Build the instruments first, and measure them alone

There is no guitar, metal kit or distorted bass in `beeps instruments`; every bundled drum is soft. Define them in the song's
`instruments` block (or as project patches) and check each with `beeps measure` or a one-note song before writing music.

- **The amp is the chain, not a knob.** A layer runs `source -> drive -> filter -> tremolo -> amp envelope`. `drive` is
  `tanh(kx)` with `k = 1 + 20 * drive`, so above about 0.3 more drive barely changes the sound: the input spectrum and the
  filter after it decide the tone. The filter after the drive is the cabinet.
- **One layer per chord.** A power chord is a single `additive` layer holding the root's partials, the fifth's partials
  (ratio 1.5) and the octave, so the drive saturates them together and they intermodulate. The same notes as two saws, each driven
  alone, measured twice as rough (0.26 against 0.12) and read as synth.
- **Partials with their own decays.** Give each upper partial a shorter decay than the one below
  (`decay / (1 + 0.12 * (h - 1))`): the highs die first, as on a string.
- **Pick and fizz.** Add a short noise burst (band 2-2.5 kHz, 9 ms) for the pick and a driven pink-noise band (3.2 kHz) for the
  clipped-harmonic sizzle. Without them the note starts too clean.
- **Palm mute versus open.** Palm mute: decay 0.1 s, sustain 0.07, filter cutoff closing from 5.4 kHz to 2.2 kHz over 90 ms.
  Open chord: decay 0.5 s, sustain 0.8, release 0.2 s, filter closing slowly (0.6 s).
- **Lead.** Additive with a darker cabinet (lowpass 3.7 kHz), `drive` 1.0, vibrato at 5 Hz and 10 cents. A brighter smooth lead
  (6 kHz, 17 cents) read as a flute.
- **Bass.** An additive layer plus a sine at the same pitch and a quiet pick click. Highpass at 36 Hz; notes stay at or above E1.
- **Kit.** Kick: a sine with a fast pitch drop plus a short click. Snare: modal shell (about 175 Hz) plus a bandpassed noise body
  plus a high-passed sizzle. Hats and crash: `metal` plus noise. Toms: a pitched sine plus a click, one instrument per tom.
- **Limits that cost time.** A layer's own `highpass` field tops out at 2 kHz; for higher (a snare's sizzle, a cymbal's air) use the
  layer `filter` of type `highpass`. Track names are lowercase letters, digits and dashes.
- **Do not put a sub partial in the guitar.** A 0.5-ratio partial at -7 dB sat on top of the kick and bass and took the low-end
  share to 56%. At -22 dB, with guitar highpass at 90-110 Hz, it was 24-33%.

## 2. Double-track and let the humanizer work

Two tracks play the same pattern with the same instrument, panned -0.8 and +0.8, each with `humanize` 0.2-0.3 (seeded, different
per track). That is the double-tracked wall; a single panned track is not. Keep the bass and kick centred.

## 3. Write the riff as a 16-step string

One bar is 16 characters. Lower case is a palm-muted chug, upper case an accent, `.` a rest: `X.xx X.xx X.xx G.gx`. Map letters to
notes (`x` the root, `g` the flat second, `a` the flat third, `h` the tritone, `c` the fifth...) and build the bass line from the
same strings, so guitar and bass lock. A chorus riff is the same idea with a root letter per bar over a held open chord.

- **Patterns loop to fill their section.** Write a 4-bar riff as `bars: 4` and let it loop. Repeating a Python list (`notes * 2`)
  stacks the notes on the same beats and leaves the rest of the pattern empty; the look image showed it as a loud block, then a
  silent one.
- **Section mix moves are absolute.** `"mix": {"rhythm-l": {"gainDb": -6}}` sets the level at that section's start and persists
  into later sections, so state it in every section that should differ.

## 4. Key, register and the bass floor

Write the music in one reference key and move it with each track's `transpose`. Rhythm, chords, lead and any drone get the
shift; the lead double gets the shift minus 12. The bass takes the shift plus 12 whenever the shift is below -2 (so the lowest
bass note stays at or above E1). Set the guitar `highpass` under the new low note (110 Hz for A2 down to 70 Hz for B1).

## 5. What made it read as a JRPG overworld, and what fixed it

The first draft's verse and lift worked; the chorus, solo and breakdown read as "Zelda or Final Fantasy". Pitch and timing were
correct (on the grid, in tune with the bass); the cause was what was written:

- A chorus of F#m - D - A - E: the relative-major chords every game theme uses. Use the minor root and its flat second, flat
  sixth, flat seventh and tritone over a low root: `i i bII tritone | V bVI bVII tritone`.
- A melody of arpeggio leaps up the major triad in the fifth octave. Use long held notes in the fourth octave, a descending
  chromatic tail, and one blue-note run in the solo. Keep the hook at or below E5 (G5 in the final chorus); only the solo's
  repeat goes up an octave.
- A smooth additive lead and sustained, stabby open chords in the chorus. Keep the palm-muted chug going under held chords.
- Bright eighth-note hats. Use accented sixteenths and crash on the first bar of every two.
- **The mood may want no melody at all.** For a lawless, gritty combat game the listener rejected the lead as the wrong mood. A
  melody over a scored chorus reads as a keytar however it is voiced. The riff, the drums and the cut carry the section instead: constant sixteenth chugs (engine and machine-gun cadence), kick and
  snare landing like gunfire, a kick, tom and chug war-drum stomp, a d-beat, junkyard clanks. Ask what the track is for before
  adding a hook.

## 6. Noir: contrast and atmosphere (black, white and red)

- **Hard cuts.** The last two beats of the lift are silence in every part, and the chorus lands on the downbeat with a crash. The
  look image shows it as a black gap. A cut reads as more violent than any build.
- **Atmosphere under the sparse sections only.** A wind bed (`nebula`), a low pedal (`drone`), junkyard clank hits (a modal hit at
  590 Hz and a low one at 240 Hz) and one held, static feedback note (additive, no vibrato, a 0.9 s swell, a 0.15 s release so a
  cut stays crisp) in the intro, breakdown and outro. They need far more gain than feels right: at first they sat 18-32 LU under
  the mix and `beeps song stems` flagged them as likely inaudible; at 10-17 LU under (they only play in a quarter of the song)
  it stopped.
- **Do not use a siren.** A slow-wail sawtooth with a pitch sweep was tried: a listener heard a police siren, the wrong world for a
  lawless setting. A sweeping or vibrato lead note can do the same; keep atmosphere static.
- **Stop the atmosphere a bar or two before the loop point.** Otherwise the outro ends denser than the intro starts and
  `song-loop-seam` fires (3.3 dB here).

## 7. One track per level

For a game with levels of different tempos, fix only what the game needs: the tempo and the bar count (here 104 bars at each
level's tempo gave 156-195 s, chosen to fit a loop slot) and the tuned instruments. Everything else is written fresh per level.

Do not derive the levels from one song. The first attempt kept one 9-section form and one hook and varied the key, riff cells and
atmosphere, with the hook and solo inverted, stretched or compressed per level; a listener heard one song in five arrangements.
What worked, each with its own riffs, groove and form (an example of planning key and tempo per level):

| Level | Groove | Form (bars, 104 total) |
|---|---|---|
| Level A, E, 152 | thrash gallop, kick and snare as gunfire | intro 8, verse 16, lift 8, stomp chorus 16, slam 8, second riff 16, lift 8, final 16, outro 8 |
| Level B, A, 138 | war-drum stomp, kick, toms and chugs in unison | intro 8, verse 16, lift 8, chorus 16, drum-only breakdown 12, verse 16, lift 8, final 16, outro 4 |
| Level C, D, 144 | tremolo-picked tritone chase on a d-beat, falling chromatic riff | intro 8, chase 16, fall 8, lift 8, hit 16, breakdown 8, chase 16, lift 8, hit 8, outro 8 |
| Level D, B, 128 | slow crushing riffs over double kick and sixteenth hats | intro 8, verse 16, lift 8, chorus 16, breakdown 8, verse 16, lift 8, final 16, outro 8 |
| Level E, C#, 160 | punk d-beat blitz, constant sixteenths | intro 4, blitz 16, run 16, lift 8, chorus 16, stop 4, blitz 16, lift 8, final 12, outro 4 |

Every lift ends in the two-beat silence. Section lengths vary freely as long as the total fits; patterns loop to fill them.

## 8. The loop that finds the problems

Render, read the report, open `look.png`, run `beeps song stems`, fix, render again. A long multi-track song can take minutes to
render; render several songs in one command to run them in parallel. This loop found: the 56% low end, a mix with the chords
almost as loud as the whole song while the hats sat 27 LU down, the loop seam, the repeat bug above, and the inaudible
atmosphere. It cannot tell you whether the guitar sounds like a guitar. The `song-written-pitch` warning on a lead that spans
more than an octave is expected for an additive instrument (it retunes exactly); the fixed-pitch layers are only noise.
