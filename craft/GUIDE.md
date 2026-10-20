# agent-beeps craft guide

This guide explains the reasoning behind `rules.json`. Rule ids are in `code`. Each rule's
sources are listed in `rules.json` with a title and URL. `beeps lint` checks the `auto` rules. The
`judgement` rules are listed on every lint run, and applying them is your job. Numbers are
evidence about the signal. The owner's ear grades the sound.

## 1. Pick the synthesis method from the material (`synthesis-choice`)

| The sound is… | Use | Why |
|---|---|---|
| A struck object: wood, glass, a bell being hit, a metal clank | `modal` (resonant bandpass modes, `impulse` or `noiseBurst` exciter) | Few, weakly coupled, decaying modes are what a struck body is (Cook's PhISAM). |
| Many small collisions: shakers, rain, gravel, debris, crackle | `grains` (Poisson-timed grains through a bandpass) | Cook's PhISEM: the physics supplies the collision statistics and cheap noise grains make the sound. |
| A bell's sustained ring, organ-like tones, anything that should read as "real" | `additive` (partials with their own decays) | Additive was the one method listeners could not tell from recordings (Moffat & Reiss 2018). Check `nyquist` on high partials. |
| Cymbals, hi-hats, robots, clangs | `metal` (the 808 recipe: six inharmonic squares through two bandpasses) | The metallic quality is designed in from inharmonic ratios. |
| Abstract UI, retro game tones, coins, blips | `osc` (with `unison` for width) | Clean, legible, cheap. Square and triangle give the chip-era palette. |
| Bright, bell-like or growling tones that change over time | `fm` (2–4 operators) | Brightness follows the index, so an index envelope gives a timbre sweep. |
| Air, impact texture, whooshes | `noise` behind a filter with a cutoff envelope | Band placement and envelope carry most of the character. |

A licensed recording can supply irregular contact detail while procedural layers supply an editable
body or tail. Use a prepared `sample` layer for that finite, unpitched SFX material; see
[hybrid sources](../skills/beeps-compose/references/hybrid-sources.md) for the import/preparation,
final-edit bundling order and privacy boundary. Samples are not song instruments or looping beds.

Layer when one method cannot do both jobs. A `hit` is often a `noise` transient over a `modal` or
`osc` body. Keep the transient short and quiet (see `attack-floor`).

## 2. Level and loudness

- **Patches never carry a loudness.** `gainDb` balances layers against each other. The renderer
  measures the authored sound, then trims it to `project.targetLoudness` plus a per-family offset
  (`loudness-target`). A gain literal is not a loudness: a bandpass at Q 5 can pass a sliver of a
  "full-level" source.
- **Why max momentary loudness?** Integrated loudness (ITU-R BS.1770) gates in 400 ms blocks and
  drops incomplete ones, so a 100 ms beep has no integrated value at all. Game practice levels
  one-shots on Max Momentary (EBU Tech 3341's 400 ms window) instead.
- **The short-sound caveat.** A 400 ms window averages a 60 ms tick with 340 ms of silence. The
  ear integrates loudness over roughly the first 100–200 ms, and a 5 ms sound needs 10–19 dB more
  level to match a 200 ms one (Florentine, Buus & Poulsen 1996). Two ticks at the same target
  therefore will not sound equally loud. Trust the target to get the level roughly right. Fine
  balance is the audition's job.
- **Why trimmed targets and family offsets?** The default target is −18 LUFS max-momentary. UI
  sits lower (ui-hover −8 LU, ui-click and blip −6, confirm and no −3) and impacts sit higher
  (hit +1, explosion +2), so a mix has a built-in hierarchy before anyone touches a fader. Families
  outside the table (footstep, foley) sit at the full target; `familyOffsets` in the project file
  and a patch's `meta.loudnessOffsetDb` move them, e.g. footsteps 6 LU under a pick strike.
- **Ceilings.** The delivered sound stays at or below −1 dBTP true peak (`true-peak-ceiling`, EBU R
  128) and has no clipped samples (`no-clipping`) or DC offset (`no-dc`). The limiter is a safety
  net. If it works hard, the sound's crest is wrong.

For a recorded-source comparison, match the actual delivered max-momentary loudness and check true
peak rather than assuming equal layer gains make equal levels. Preparation gain creates headroom;
it cannot restore a flattened transient or remove distortion from a source that was already clipped.
The delivered ceiling guards the output and does not certify the original recording as unclipped.

## 3. Onsets, lengths and tails

- `attack-floor`: 4 ms or more per layer unless `meta.intent` is `click`. A step onset splatters
  energy across the spectrum as a click. A quiet layer (gainDb −9 or below) may be faster, which is
  how a soft noise tick adds bite without the click.
- `tick-length`: ui-click and blip must be done within 60 ms of energy. Ticks come several a
  second, and a ringing tick turns into a drone.
- `tail-ceiling`: tails follow how often a family fires. UI ends fast and an explosion may ring.
  A long tail from a frequent sound piles up into mud.
- `nyquist`: nothing declared at or above 0.45 × sample rate. That includes pitchEnv targets
  multiplied by partial, mode and operator ratios. The engine silently drops such partials, so
  the sound you declared is not the sound you get.

## 4. Key and scale

Pitched sources snap to `project.scale` (default C major pentatonic) when `snap` is on. Sounds that
overlap then share a key and do not beat. Partials a few hertz apart inside one critical band
produce roughness (Plomp & Levelt 1965). `key-consistency` checks the *measured* pitch of every
clearly pitched kit member against the scale, within 50 cents. Pentatonic is the default because it
has no semitones: its closest intervals are whole tones, which beat far less than semitones.

## 5. Variation and fatigue

Players pick up any distinctive sound that repeats identically. A coin, footstep or tick heard
hundreds of times becomes the thing they notice. `variation-on-repeating`: tag such patches
`repeating` and give them `variation`, either 3 or more `variants` or a `pitchCents` spread of at
least 20.

- `noRepeat` (on by default) keeps the same variant from playing twice in a row.
- `weights` is Halo-style permutation weighting. Give a distinctive variant a low weight so it
  stays rare. The right number is found by ear, so tune it in audition with repeat ×75.
- Keep the spread small enough that the class label survives. A coin is still the coin.

## 6. Blend, brightness and masking

- **To blend, be dark together. To stand out, be bright alone.** Blend falls as the combined
  spectral centroid rises and as the centroid difference grows. Similar attacks and consonant
  intervals fuse. Bright, noisy and impulsive sounds resist fusion.
- `sharpness-warn` (above 2.2 acum) and `roughness-warn` (above 0.6 asper) name the tinny and
  grating defects. They are indicators, not verdicts. Tag the patch `bright` or `gritty` when the
  quality is intended.
- `masking-risk`: two kit sounds whose dominant octave band is the same and whose centroids are
  within a third of an octave can hide each other if they play together. Fix it in the arrangement
  first by moving one of them in register. Reach for EQ only after that.
- `family-consistency`: within a family, centroids stay within one octave. A family is a class
  label, and its members should sound related.

## 7. One "no", and one meaning per sound

- `one-no`: the kit has exactly one sound in family `no`, and every refusal uses it. Illegal move,
  locked door, no funds: the player learns it once and knows it everywhere. Make it a soft falling
  figure, not a buzzer. Its job is to make the player look at the screen, which is saying the same
  thing in words.
- `one-meaning-per-sound` (judgement): if the player hears it, something happened. Every sound has
  one cause in the world. Sounds that play as texture teach the player to ignore sound.
- `silent-not-quiet` (judgement): a gated bed (intent `bed`) stops when its cause stops. A tool
  that hums while doing nothing loses the only job it has.

## 8. Priority

`priority` is 1 (most important) to 5, following FMOD's convention that a smaller number wins.
Priority decides voice stealing absolutely, and loudness only breaks ties within a level.
`priority-levels` caps a kit at five distinct levels, because fine-grained priority means loud,
noticeable sounds get stolen. A reasonable default: 1 for the "no" and critical alerts, 2 for
rewards and confirmations, 3 for player actions, 4 for world events, 5 for UI hover and ambience.

## 9. Reading the look image

You cannot hear. `beeps look` gives you a waveform, a log spectrogram and a feature strip. Check:

- **Waveform:** onset shape (a vertical wall means a click), a sensible decay with no
  truncated tail and no ringing after the energy is gone, and no flat-topped peaks.
- **Spectrogram:** where the energy sits compared with the family's intent (a "dark" thud should
  not have a bright band), a pitch sweep going the way the name says (powerup up, powerdown down),
  horizontal lines where noise should be (accidental pitch), and energy against the top edge
  (aliasing or harshness).
- **Feature strip:** centroid, sharpness and roughness against sections 3 and 6, the trim applied
  (a trim far above +12 dB means the source is starved), and pitch strength on sounds that should
  be unpitched.
- **Contact sheet:** members of one family should look like siblings. If one looks nothing like the
  others, it will not sound like them either.

## 10. Music (`craft/music-rules.json`)

Songs follow the same pattern as sounds. The auto rules are checked by `beeps song lint` and by
every `beeps song render`. The judgement rules are yours to apply.

- **Level on integrated loudness** (`song-loudness-target`). A song is a programme, so it is
  levelled with BS.1770 integrated loudness rather than max momentary. No games loudness standard
  exists. Reported platform practice is −24 to −23 LUFS for console, and measured shipped games
  average about −18.5 LUFS. The −20 LUFS default keeps music under the −18 LUFS one-shots so sound
  effects read over it. A song that lands more than 2 LU under target is **peak-limited**: a drum
  accent or a bright transient caps the level. Soften the accent. Do not add gain.
- **Dynamics between sections** (`song-loudness-range`). PlayStation staff report a maximum
  loudness range of 20 LU for a game mix. The 3 LU floor is this plugin's own. A long piece with no
  contour is the first thing a listener tires of. Contour comes from the arrangement: parts enter
  and leave, and a section thins or opens its filter with `ramp`.
- **Loops** (`song-loop-seam`, `song-loop-length`). The render folds the tail onto the start, so
  the seam is continuous in time. What can still be heard is a jump in level or density, so end the
  form the way it begins. Collins finds loop length set by how long the player stays in a place.
  Exploration and level music gets the longest loops and boss music the shortest.
- **Register and masking** (`song-register`, `song-register-bands`). Robjohns' order of fixes is
  arrangement first, level hierarchy second, EQ last and gently. Give each part its own register
  band, or leave it rhythmic gaps. Notes below E1 are almost always an octave slip.
- **Written pitch** (`song-written-pitch`). A song retunes the whole instrument to each written
  note, so a patch built far from the notes written for it no longer sounds as built (a 3300 Hz
  chime written D4 plays at 293 Hz). Play it at its own pitch with the track's `fixed`, name the
  note it sounds at with `root`, or shift it with `transpose`.
- **Long-play fatigue** (`song-fatigue`). Composers of reused cues reduce dramatic melody so the
  cue survives repetition. Silence and slow fades in are the leading remedies. Keep exploration
  melodies understated, vary sections, and leave space.
- **Reading a song's look.** The orange line is loudness per second at playback level. It should
  rise and fall where the plan says. Section bands sit above the waveform, and the spectrogram
  bottom shows bass: a solid bright floor across the whole song means the bass is too loud or too
  low. The number rows give per-section level and brightness, so you can check that a "thin"
  section really is quieter or darker.

## 11. Guitar-driven rock and metal (process notes, no lint rules)

This section is a record of one project, not a cited rule set: it adds no entry to `rules.json` or `music-rules.json`, and the
numbers come from measurements of that project's songs. A listener's ear graded it, and where it was not yet heard, the text
says so. The how-to (instrument recipes, riff notation, per-level variation, pitfalls) is in
`skills/beeps-music/references/guitar-and-metal.md`.

- **A guitar is a chain, so build the chain.** In a layer `drive` sits before the filter and is `tanh(kx)` with
  `k = 1 + 20 * drive`: past about 0.3 more drive changes little. The tone is decided by what goes in (one `additive` layer
  holding the whole power chord, so the saturation intermodulates the notes, with partials that each decay at their own rate) and
  by the filter after it (the cabinet). The same chord as separately driven saws measured twice as rough (0.26 against 0.12). The
  pick transient, a clipped-harmonic sizzle layer and double-tracked rhythm guitars (two tracks, hard-panned, each humanized) are
  what separate a guitar from a synth patch. A listener judged this tone good in the verse and lift; the rest of
  the first draft was not judged on tone.
- **Pitch and timing are not what makes a metal song read as something else.** The first draft was on the grid and in tune and a
  listener still heard a fantasy-RPG overworld. The cause was the writing: relative-major chords (i - VI - III - VII), an
  arpeggiated melody in the fifth octave on a smooth lead, and sustained stabby chords with bright eighth-note hats. Metal
  gets its weight from a low minor or phrygian root, the flat second, flat sixth, flat seventh and the tritone, a chug that keeps
  going under held chords, a lead that holds long notes lower and darker, and accented sixteenth hats. If a section sounds light
  with the right notes, look at the harmony, melody shape, register and articulation before touching the tone.
- **Some moods have no melody.** The art direction was a lawless combat-racing game in black, white and red (dark but high
  energy, like driving for your life, surviving by shooting rivals off your tail), and a listener rejected the lead outright as
  the wrong mood. A melody over a scored chorus reads as a keytar however it is voiced, and a wailing, siren-like sweep reads as
  police, the wrong world for a lawless setting. The lead-less, siren-free tracks that followed were well received: the engine and
  the guns are the music. Constant sixteenth-note chugs work as engine and machine-gun cadence, kick and snare land like gunfire,
  a kick, tom and chug war-drum stomp carries the heavy sections, and junkyard clanks, wind, a low pedal and one static held
  feedback note sit under the quiet parts.
- **Contrast beats build.** For a black, white and red art direction the lift ends in two beats of silence in every part and the
  chorus lands on the downbeat with a crash; the look image shows a black gap. Atmosphere (wind, a low pedal, junkyard
  clanks, one static feedback note; not a siren) goes under the intro, breakdown and outro only, and needs much more gain than feels right (it measured 18 to 32 LU under the mix before it
  was audible). Stop it a bar or two before the loop point or `song-loop-seam` fires.
- **The low end is where metal mixes fail the lint.** A sub-octave partial in the guitar chord, plus the kick and bass, took the
  low-end share to 56% (`song-low-end` warns above 40%). Without the partial, with guitar highpass at 90-110 Hz and the bass about
  3 dB lower, it was 24-33%. Check with `beeps song stems`: the chords were first within 3 LU of the whole mix while the hats
  were 27 LU under it. Without a lead the share rose again (52-69% on the five lead-less tracks); a listener approved those by ear
  with the lint left in place, so the warning measured masking risk the listener did not hear in that mix. An octave-up guitar
  double and a higher guitar highpass were planned to bring it down and were not tried.
- **One song per level means five songs.** The first attempt kept one song's form and material and varied the key, the riff cells,
  the atmosphere and a transformed hook and solo (inverted, stretched, compressed). A listener heard one song in five
  arrangements and asked for five fresh ones. Write each level's riffs, groove and form from scratch: a thrash gallop with a
  hard-cut lift; a kick, tom and chug war-drum stomp with a drum-only breakdown; a tremolo-picked tritone chase on a d-beat; slow
  crushing riffs over double kick and sixteenth hats; a punk d-beat blitz with a short intro and a long final run. What stays
  shared is only what the game needs: the tempo and a bar count chosen to fit a loop slot (104 bars here), and the tuned instruments. Move
  the key with each track's `transpose`, lifting the bass an octave whenever the shift would take it below E1.
- **What the measurements could not say, and what listeners said.** The tools catch low-end share, seam, hierarchy and inaudible
  parts, not realism or mood. Listeners heard: the first draft (verse and lift good, the rest "too light, whimsical, plucky"); the
  noir take (the siren "isn't working", the keytar solos the wrong mood); and five lead-less tracks written from the
  brief above, which were well received. Nothing here shows what a guitar sounds like to anyone else.
