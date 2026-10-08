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
  (hit +1, explosion +2), so a mix has a built-in hierarchy before anyone touches a fader.
- **Ceilings.** The delivered sound stays at or below −1 dBTP true peak (`true-peak-ceiling`, EBU R
  128) and has no clipped samples (`no-clipping`) or DC offset (`no-dc`). The limiter is a safety
  net. If it works hard, the sound's crest is wrong.

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
