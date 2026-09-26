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
  for most roots.
- `transpose` (semitones) shifts a pattern; `vel` (0-1) scales its velocity.

## Tracks

| field | meaning |
|---|---|
| `instrument` | library name (`beeps instruments`), project patch name, or inline patch (schema/name/family optional) |
| `gainDb`, `pan` | balance (-60..12 dB) and position |
| `cutoff` | track lowpass (Hz); sections can move it |
| `sends.reverb`, `sends.delay` | send levels (dB) to the master reverb/delay |
| `keytrack` | 0-1: how far instrument filter cutoffs follow the note |
| `root` | the note the instrument patch sounds at as written (default: its first pitched layer) |
| `humanize` | 0-1: seeded timing (to 12 ms) and velocity (to ±20%) looseness |
| `spread` | 0-1: chord voices fan across the stereo field |

## Patterns (exactly one kind each; they loop to fill a section)

| kind | fields | notes |
|---|---|---|
| `notes` | `[[beat, note, beats, vel?], ...]` | melodies, drones, one-off hits |
| `chords` | `progression`, `octave` (4), `voicing` lead\|spread\|close, `rhythm` steps, `strum` s | voice-led chords; `rhythm` restrikes, else each chord holds |
| `arp` | `progression`, `rate` notes/beat (2), `shape` up\|down\|updown\|random\|converge, `octaves`, `octave`, `rhythm` | restarts on each chord |
| `bass` | `progression`, `octave` (2), `rhythm` steps, `tones` [0 root, 1 third, 2 fifth...] | slash chords put their bass note first |
| `steps` | `"x..x ..x."`, `stepsPerBeat` (4), `note` | `X` 1.0, `x` 0.7, `o` 0.4, `.` rest, `_` hold; spaces and `\|` ignored |

`gate`: held notes last length × gate (defaults: notes/chords 1, arp 0.9, bass 0.95); steps default
to `"patch"`, the instrument's own duration (drums ring naturally).

Chord qualities: (none) maj m min 5 dim aug sus2 sus4 6 m6 6/9 7 maj7 m7 mmaj7 m7b5 dim7 7sus4
7sus2 7b9 add9 madd9 add11 maj7#11 9 maj9 m9 9sus4 11 m11 maj11 13 m13 maj13, plus `/bass`.

## Sections and form

- `play`: track → pattern name, a list played in sequence, or `null`. Unlisted tracks are silent.
- `mix`: track → `{gainDb, cutoff}` from this section on. With `"ramp": true` the change glides
  across the whole section (fade-ins, filter sweeps); otherwise it lands at the section start.
- `form`: section names in order. Held notes are cut at section ends (their release still rings).
- `loop: true` folds the reverb and release tail onto the start: the WAV loops seamlessly. End the
  form at the density and level it starts with.

## Master

`reverb.preset` small|room|hall|cave|space (7 s), `returnDb`; `delay.beats` (0.75 = dotted eighth),
`feedback` (≤ 0.9), `cutoff` (each repeat is darkened), `returnDb`. The delay feeds the reverb.
