# beeps/song@1

`beeps capabilities` prints the full JSON Schema (`songSchema`); this is the working summary.

```json
{ "schema": "beeps/song@1", "name": "drift", "title": "Drift", "tags": ["exploration"],
  "bpm": 76, "meter": 4, "swing": 0, "loop": true, "seed": 1,
  "progressions": { "a": [["Dm9", 8], ["Bbmaj7", 8], ["Fmaj7", 8], ["C6/9", 8]] },
  "tracks": {
    "pad":  { "instrument": "glass-pad", "gainDb": -6, "sends": { "reverb": -8 }, "spread": 0.5 },
    "bass": { "instrument": "sub-bass", "gainDb": -12 },
    "arp":  { "instrument": "soft-pluck", "gainDb": -14, "sends": { "delay": -8 }, "humanize": 0.4 },
    "hat":  { "instrument": "hat", "gainDb": -22 } },
  "patterns": {
    "pad-a":  { "bars": 8, "chords": { "progression": "a", "octave": 4 } },
    "bass-a": { "bars": 8, "bass": { "progression": "a", "octave": 2 } },
    "arp-a":  { "bars": 8, "arp": { "progression": "a", "rate": 2, "shape": "updown", "octaves": 2 } },
    "hat-a":  { "bars": 1, "steps": "..x. ..x. ..x. .xx." },
    "lead-a": { "bars": 4, "notes": [[0, "A4", 3], [3, "C5", 1, 0.8], [4, "D5", 8]] } },
  "sections": {
    "intro": { "bars": 8, "play": { "pad": "pad-a" }, "mix": { "pad": { "gainDb": -14, "cutoff": 900 } } },
    "a":     { "bars": 16, "play": { "pad": "pad-a", "bass": "bass-a", "arp": "arp-a", "hat": "hat-a" },
               "mix": { "pad": { "gainDb": -6, "cutoff": 8000 } }, "ramp": true } },
  "form": ["intro", "a", "a"],
  "master": { "reverb": { "preset": "space", "returnDb": -2 }, "delay": { "beats": 0.75, "feedback": 0.4 } } }
```

## Time and pitch

- Beats are quarter notes; a bar is `meter` beats. Pattern times are beats from the pattern start.
- Notes are names (`A4`, `F#3`, `Bb2`); C4 is middle C. Octave arguments put the root of the
  chord/bass in that octave: `octave: 2` bass starts at C2-B2 (65-123 Hz); `octave: 1` is sub-sonic
  for most roots. Exceptions: `voicing: "spread"` places the root one octave *below* `octave`, and
  a slash chord adds its bass note below the voicing. `beeps song check` prints every chords
  pattern's voicings, so check the lowest note there.
- `transpose` (semitones) shifts a pattern; `vel` (0-1) scales its velocity.

## Instruments

A track's `instrument` is resolved in this order: the song's own `instruments` block, project
patches (`beeps new`), then the library (`beeps instruments`). Any of these forms works in either
place:

```json
"instruments": {
  "soft-pad": { "duration": 1, "layers": [ ... ] },
  "high-warm": { "base": "warm-pad", "set": { "/layers/1/source/pitch": "C5", "/layers/0/filter/cutoff": 900 } }
},
"tracks": { "pad": { "instrument": "soft-pad" }, "keys": { "instrument": { "base": "glass-pad", "set": { "/layers/0/amp/attack": 0.3 } } } }
```

An inline patch may leave out `schema`, `name` and `family`. `set` keys are JSON pointers into the
base patch. `beeps instruments` shows each instrument's root and where its layers sound: `osc -12`
means a layer an octave below the written note, which counts toward that part's register. In
`beeps song check`, a track's `range` is the notes written and `sounds` is the span every layer
reaches (a pluck with an octave-up layer shows `sounds` an octave higher at the top): it is not a
transposition.

### Which pitch the instrument plays

A song retunes the instrument to each written note: every pitched layer, pitch envelope and glide
moves by (written note - the track's `root`), where `root` defaults to the patch's first pitched
layer. So an instrument built at 3300 Hz and written `D4` sounds at 293 Hz, and a drone built at
`A2` and written `D4` is retuned 17 semitones up (two such layers no longer beat as built). Three track fields control it, none
changes a song that does not set them:

- `"fixed": true` plays the instrument at its own pitch whatever is written (a 3300 Hz chime stays
  3300 Hz; the notes only time the hits). Pair a drone with `fixed` to stop it detuning.
- `"root": "D4"` says which written note the patch sounds at as built; write around it and the
  instrument follows the notes from there.
- `"transpose": -12` moves the track that many semitones from where it would sound. A pattern's
  own `transpose` shifts that pattern only.

`beeps song check` flags a track whose written notes sit more than an octave from the root it
plays from (`song-written-pitch`). `range`/`sounds` follow `fixed`, `root` and `transpose`.

The three fields above change what you hear. To keep the sound and still write far from the root, build
the instrument at the register it plays: `beeps instruments rebase soft-pluck --to F4` prints a
`{ "base", "set" }` override that moves every pitched layer (and `pitchEnv` target) to the new root and
scales those layers' filter cutoffs by the same ratio (`--filters keep` leaves them). Put it in the
song's `instruments` block under a new name, point the track at it, then write the part near the new
root. Noise, grain and metal layers keep their own filters.

## Tracks

| field | meaning |
|---|---|
| `instrument` | library name (`beeps instruments`), project patch name, or inline patch (schema/name/family optional) |
| `gainDb`, `pan` | balance (-60..12 dB) and position |
| `cutoff` | track lowpass (Hz); sections can move it |
| `sends.reverb`, `sends.delay` | send levels (dB) to the master reverb/delay |
| `keytrack` | 0-1: how far instrument filter cutoffs follow the note |
| `root` | the note the instrument patch sounds at as written (default: its first pitched layer) |
| `transpose` | semitones (-48..48) the track sounds above the written note; default 0 |
| `fixed` | `true`: the instrument always sounds at its own pitch (plus `transpose`); written notes only time the hits |
| `humanize` | 0-1: seeded timing (to 12 ms) and velocity (to ±20%) looseness |
| `velocityInput` | optional instrument `xRuntime` input name; maps performed velocity to its declared range at note onset (see Expressive notes) |
| `spread` | 0-1: chord voices fan across the stereo field |
| `swing` | this track's swing (overrides the song's) |
| `highpass` | track highpass (Hz): trims an instrument's low layers without editing it |

## Patterns (exactly one kind each; they loop to fill a section)

| kind | fields | notes |
|---|---|---|
| `notes` | tuples `[beat, note, beats, vel?]` or objects `{at, note, beats, vel?, expression?}`; forms can mix | melodies, drones, one-off hits; objects add per-note expression |
| `chords` | `progression`, `octave` (4), `voicing` lead\|spread\|close\|drop2\|open, `slash` (true), `rhythm` steps, `strum` s | voice-led chords; `rhythm` restrikes, else each chord holds. A slash chord (`G/F`) adds its bass note below the voicing unless `slash: false`, so one progression can feed the bass and the pads. `drop2` and `open` widen the voicing |
| `arp` | `progression`, `rate` notes/beat (2), `shape` up\|down\|updown\|random\|converge, `octaves`, `octave`, `rhythm`, `slash` (false) | the note order restarts on each chord; each `rhythm` character is one arp step (at `rate`) and the mask keeps counting across chords |
| `bass` | `progression`, `octave` (2), `rhythm` steps, `tones` [0 root, 1 third, 2 fifth...] | slash chords put their bass note first |
| `steps` | `"x..x ..x."`, `stepsPerBeat` (4), `note` | `X` 1.0, `x` 0.7, `o` 0.4, `?` plays half the time (seeded), `.` rest, `_` hold; spaces and `\|` ignored. Euclidean `x(3,8)` spreads 3 hits evenly over 8 steps (`x..x..x.`); the glyph sets every hit's weight, a third number rotates left (`X(5,16,2)`), and tokens mix with literal steps in any rhythm field (`X... x(3,5)`). Steps 1-64, hits 1 to steps, no spaces inside the parentheses |

`gate`: held notes last length × gate (defaults: notes/chords 1, arp 0.9, bass 0.95); steps default
to `"patch"`, the instrument's own duration (drums ring naturally).

A rhythm hit (in `steps`, `bass` and chord `rhythm`) lasts **one step** unless `_` holds extend it,
so `"x......."` on a bass is a click-length note. Set the pattern's `hitBeats` (e.g. `0.5`) for
longer hits; each `_` still adds a step.

Chord qualities: (none) maj m min 5 dim aug sus sus2 sus4 6 m6 6/9 69 m6/9 7 maj7 M7 m7 mmaj7 m7b5
dim7 7sus4 7sus2 7b9 add9 madd9 add11 maj7#11 9 maj9 m9 9sus4 11 m11 maj11 13 m13 maj13, plus `/bass`.
Songs never snap to the project scale: the notes you write are the notes that play.

## Expressive notes

Object notes use `at` (beat from the pattern start), `note` (such as `D4`), `beats` (authored
length, greater than 0 and at most 64), and optional `vel` (0–1, default 1). Existing tuple notes
keep their behavior. Add `expression.pitch`, `expression.brightness`, or both to an object note:

```json
{"at": 0, "note": "D4", "beats": 2, "vel": 0.7,
 "expression": {"pitch": [[0, -2], [0.25, 0]],
                "brightness": [[0, -1], [1, 0.5], [2, 0, "step"]]}}
```

- Each point is `[beatOffset, value, arrivalCurve?]`. Offsets are beats from this note's onset,
  not seconds or pattern positions. A curve has 1–64 points, starts at offset 0, uses strictly
  increasing offsets and finite values, and ends within the authored `beats` length.
- `pitch` is a semitone offset from the played pitch, limited to −24…24. It affects the
  instrument's pitched layers and preserves their pitch envelopes and LFOs. The instrument
  must contain a pitched source.
  `song check` pitch ranges and register warnings use written notes and static instrument spans;
  they do not include gestures or velocity-dependent retuning. Inspect the rendered spectrum too.
- `brightness` is an octave offset, limited to −4…4: `1` doubles filter frequency and `-1`
  halves it. It affects existing **layer filters**, preserving their filter envelopes and
  LFOs; the track's `cutoff` is separate. At least one layer filter must exist.
- The optional third value describes arrival at that point. `linear` (the default) ramps from
  the previous value; `step` holds the previous value until this point, then jumps. The first
  point sets the initial value immediately. Values are interpolated in semitones or octaves.
- Numeric `gate` and section ends shorten the actual hold. Curves are clipped there, using the
  interpolated value for a linear segment or the held value for a step segment. The last value
  holds through release. Gate does not stretch the curve's times. `gate: "patch"` cannot be
  used with expression, and an empty `expression: {}` is invalid.

### Velocity changes tone and envelopes

Set a track's `velocityInput` to a declared, bound input in its instrument's `xRuntime` block.
The final velocity, including pattern scaling and humanization, maps 0–1 across the input's
`min`…`max` range at note onset. Ordinary velocity output gain still applies. This also works
with generated chords, arps, bass and step patterns; explicit curves belong to object notes.

Bindings use the existing runtime rules: the authored patch is the value at the input's
`default`, and the binding applies a delta from there. For frequency and envelope-time targets,
the default unit is octaves (`+1` doubles the value); plain numeric targets such as FM index
add the delta. `live: true` bindings also take the velocity value at onset; this does not make
velocity a continuous pressure control. All mapped values must remain valid patch values.
Use layer parameters or output macros. Bindings to `/fx/` are rejected because song effects
are shared. See [runtime parameter bindings](../../../docs/runtime.md) for target/unit rules.

Save this complete one-bar score as `expressive.json`, then run `beeps song check expressive.json`
and `beeps song render expressive.json` from an initialized project:

```json
{
  "schema": "beeps/song@1", "name": "expressive", "bpm": 90, "loop": false,
  "instruments": {
    "reed": {
      "duration": 1,
      "layers": [{
        "source": {"type": "osc", "wave": "sawtooth", "pitch": "D4"},
        "amp": {"attack": 0.06, "decay": 0.2, "sustain": 0.65, "release": 0.25},
        "filter": {"type": "lowpass", "cutoff": 1200, "resonanceDb": 0}
      }],
      "xRuntime": {
        "inputs": {"touch": {"min": 0, "max": 1, "default": 0.5}},
        "bind": [
          {"input": "touch", "target": "/layers/0/filter/cutoff", "range": [-1, 1]},
          {"input": "touch", "target": "/layers/0/amp/attack", "range": [0.5, -0.5]}
        ]
      }
    }
  },
  "tracks": {"lead": {"instrument": "reed", "velocityInput": "touch", "gainDb": -12}},
  "patterns": {"phrase": {"bars": 1, "notes": [
    {"at": 0, "note": "D4", "beats": 2, "vel": 0.45,
     "expression": {"pitch": [[0, -2], [0.25, 0]], "brightness": [[0, -0.5], [1.5, 0.5]]}},
    [2.5, "F4", 1, 0.9]
  ]}},
  "sections": {"a": {"bars": 1, "play": {"lead": "phrase"}}},
  "form": ["a"]
}
```

The harder second note has a brighter onset and a shorter attack as well as higher velocity
gain. For an A/B, duplicate the score, remove `velocityInput` and `expression`, and keep notes,
velocities, instruments and mix identical. Render both, inspect their looks and peaks, then
compare them in the album at matched listening levels before judging the phrasing.

## Sections and form

- `play`: track → pattern name, a list played in sequence, or `null`. Unlisted tracks are silent.
- `mix`: track → `{gainDb, cutoff, pan, sends: {reverb, delay}}` from this section on. With
  `"ramp": true` the change glides across the whole section; `"ramp": {"bars": 4, "at": "end"}`
  glides over the last 4 bars (an outro fade), `"at": "start"` over the first 4 (a fade-in).
  Without `ramp` the change lands at the section start with a 50 ms glide. A move normally starts
  from the value the track already has; `"from": {"gainDb": -30}` starts it elsewhere (a fade-in out
  of near-silence without a ghost track). Mix values persist into later sections; with
  `"mixScope": "section"` the section's moves are undone when it ends (a dip that comes back).
- `form`: section names in order. Held notes are cut at section ends (their release still rings).
- `loop: true` folds the reverb and release tail onto the start: the WAV loops seamlessly. End the
  form at the density and level it starts with.

## Master

`reverb.preset` small|room|hall|cave|space (7 s), `returnDb`; `delay.beats` (0.75 = dotted eighth),
`feedback` (≤ 0.9), `cutoff` (each repeat is darkened), `returnDb`. The delay feeds the reverb.

## Working files and output

- Draft anywhere: `beeps song check draft.json` and `beeps song render draft.json` work on a path.
  `beeps song new draft.json` saves it to `.agent-beeps/songs/`.
- `trimDb` in render output is the gain the renderer applied to reach `project.musicLoudness`. It
  says how loud the raw mix was, and nothing needs to change because of it.
- `beeps song render <name> --sections intro` copies all matching passages from the full delivered
  render, with their original automation, effects and level. It needs the full render once, then
  reuses the cache. Output `excerpt` records the source key and original ranges; whole-song lint
  does not apply to an excerpt. Selected passages are joined in form order, without crossfades.
- Add `--only pad,bass` to excerpt the full-length solo render instead. Its title and `solo` output
  identify the selected tracks; it uses the solo's normalized level, not the full mix's trim. It
  renders the full song's tail length (the arrangement's natural release/reverb ring), not just where
  the selected tracks' own notes stop.
- `node <plugin-root>/scripts/format-song.mjs <song.json>` reformats a song to one line per
  progression, track, pattern and section (readable diffs; content unchanged).
- `beeps song stems <name>` renders every track alone at the full mix's trim and prints each one's
  level against the mix (`vsMixLu`), peak against the mix's (`peakVsMixDb`) and crest, brightness, low-end share and per-section
  level. It flags parts more than 18 LU under the mix whose peak is also more than 12 dB under (inaudible); a short, peaky part
  (a hat) that is far under by integrated level but near the mix's peak gets a `notes` entry instead, since it is heard as an
  accent and chasing it with gain buries the rest. It writes stem WAVs (`--out dir`) for layered playback.
- `beeps song export <name> --wav <path> --trim-tail -60` (non-loop songs, no `--layers`) drops the end after the last sample at or
  above that level with a 10 ms fade, so an opening that renders its whole reverb tail ends where it is audible; the sidecar
  length is the trimmed one and the result reports `trimmedTailSec`.

## Adaptive layers (for the game player)

`adaptive` splits a loop into layers the game fades by state. Every track is in exactly one layer,
and the song must have `"loop": true`.

    "adaptive": {
      "layers": { "bed": ["pad", "bass"], "pulse": ["arp", "hat"], "threat": ["drums", "lead"] },
      "states": { "calm": ["bed"], "explore": ["bed", "pulse"], "danger": ["bed", "pulse", "threat"] },
      "initial": "explore"
    }

`beeps song export <name> --wav audio/theme.wav --layers --manifest` writes:

- the mix
- `theme.<layer>.wav` for each layer, loop-folded and at the mix's trim
- one sidecar listing the layers and states

`nullResidualDb` reports how closely the layers sum to the mix. Anything under -60 dB is effectively
exact (inaudible). A residual at or above -60 dB is often the mix hitting the safety clipper: each
layer is rendered (and clipped) on its own, so if the *summed* mix reached above the clipper's
-1.5 dBFS knee while no single layer did on its own, the mix comes back nonlinearly reshaped near its
peaks and the layers no longer sum back to it exactly. A layer whose tracks never sound in any
section still exports (as a silent stem); the export warns rather than failing, since a silent layer
may be a placeholder for later material.

Stems and layers both render the full song filtered down to their own tracks, rather than a
stripped-down song, so every note, chance roll (`?`) and noise seed comes from the same shared
random stream as the mix and lines up sample-for-sample when summed. `song render --only` uses the
same filter, so a solo preview plays the mix's own notes, not a re-rolled solo performance.

Every state plays only some of the layers, so it is quieter than the full mix the trim was set on. The export therefore measures the sum of each state's layers and writes
`stateTrimDb` (state to dB, within ±12 and keeping the sum under -1.5 dBFS) and `stateLufs` into the sidecar; the player applies the trim to that state's layers, so every state plays at
the project's music loudness.

`beeps song states <name>` renders the layers and judges each state as its own piece: raw and delivered loudness, the trim, loudness range, seam, brightness, low end, the register
overlaps among only that state's tracks, and its lint. Read it instead of the full-mix lint for an adaptive song: the full mix (every layer at once) is never heard.

A score of several adaptive songs that must crossfade (biomes, times of day, fights) works best on one grid: the same bpm, a loop length that divides the others, one key.
`beeps song compat <songs...>` plans it from the written notes: tempo relation, whether the loops can be phase-locked, the estimated key, and the pitch-class agreement per pair.
The player then starts the new loop in the old one's phase (`music(id, { at: 'bar', sync: true })`; see game-player.md).

Play an adaptive song in a game with `beeps bundle` and `beeps player export` (README, "Game player"), and ship it with `beeps compress` (game-player.md).
