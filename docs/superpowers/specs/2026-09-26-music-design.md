# agent-beeps music (beeps/song@1)

**Status:** owner asked (2026-09-26) for "a beautiful sci-fi exploration theme library of at least 12
tracks", used as the test bed that grows the plugin: missing capability goes into the plugin, friction
gets refined. This spec is the capability that request needs; v1 deferred music to its own spec.

## Goals

- An agent can write a multi-minute, loopable piece of music as one JSON document, render it in the
  same Chromium engine, measure it, look at it, and export a WAV.
- Instruments are ordinary `beeps/patch@1` patches, so every source type, envelope, filter and
  variation already built plays notes. No second synthesis engine.
- Musical intent is written the way composers think: chord symbols, voice-led chords, arpeggios,
  bass lines from the chord roots, step-sequenced drums, explicit melodies, sections and a form.
- The owner listens on the LAN (hal9000 and the machine's LAN IP, never localhost-only links), keeps
  or rejects tracks and leaves notes; the agent reads that back.

## Non-goals (this spec)

Adaptive/stem-switching runtime, MIDI import/export, OGG/MP3 encoding, a music taste model (feedback is
recorded so a later model can learn from it).

## Document

```jsonc
{ "schema": "beeps/song@1", "name": "drift-signal", "title": "Drift Signal",
  "bpm": 84, "meter": 4, "swing": 0, "loop": true, "seed": 1,
  "progressions": { "a": [["Dm9", 4], ["Bbmaj7", 4], ["Fmaj7", 4], ["C6/9", 4]] },
  "tracks": {
    "pad":  { "instrument": "glass-pad", "gainDb": -4, "pan": 0, "sends": { "reverb": -6 } },
    "bass": { "instrument": { ...inline patch }, "keytrack": 0.5 } },
  "patterns": {
    "pad-a":  { "bars": 4, "chords": { "progression": "a", "octave": 4 } },
    "arp-a":  { "bars": 4, "arp": { "progression": "a", "rate": 8, "shape": "updown", "octaves": 2, "octave": 4 } },
    "bass-a": { "bars": 4, "bass": { "progression": "a", "octave": 2, "rhythm": "x..x..x." } },
    "hat-a":  { "bars": 1, "steps": "..x...x...x...xx" },
    "lead-a": { "bars": 4, "notes": [[0, "A4", 2], [2, "C5", 1.5, 0.8]] } },
  "sections": { "intro": { "bars": 8, "play": { "pad": "pad-a" } },
                "a": { "bars": 16, "play": { "pad": "pad-a", "arp": "arp-a", "bass": "bass-a" },
                       "mix": { "pad": { "gainDb": -8, "cutoff": 1800 } }, "ramp": true } },
  "form": ["intro", "a", "a"],
  "master": { "reverb": { "preset": "space" }, "delay": { "beats": 0.75, "feedback": 0.4 } } }
```

- **Instruments**: a project patch name, a library instrument (`library/instruments/`), or an inline
  patch. A note transposes every pitch in the patch by `note / root`, where `root` is the first pitched
  layer's source pitch (track `root` overrides). Project scale snapping is off inside songs: the notes
  are the composition. `keytrack` 0–1 scales filter cutoffs with pitch.
- **Note length**: notes, chords, arps and bass hold for their length × `gate`; step patterns use the
  patch's own duration (`gate: "patch"`) so drums ring naturally.
- **Patterns** loop to fill their section; a section may play a list of patterns in sequence.
- **Steps**: `X` 1.0, `x` 0.7, `o` 0.4, `.` rest, `_` extends the previous hit; `stepsPerBeat` default 4.
- **Chords**: symbols (maj, m, 7, maj7, m7, m9, maj9, 6/9, sus2/4, add9, m7b5, dim, aug, 11, 13,
  #11, slash bass) voice-led from chord to chord around `octave` (smallest total movement).
- **Mix**: per-track `gainDb`, `pan`, lowpass `cutoff`, `sends.reverb|delay`; sections can set new
  values that jump or `ramp` across the section. `master` has one reverb and one tempo-synced delay.
- **Humanize** (track, 0–1): seeded timing and velocity jitter.
- **Loop**: the render's tail folds back onto the start, so the WAV loops without a gap or a cut tail.

## Rendering and measurement

One stereo OfflineAudioContext per song; the page keeps the buffer and the CLI pulls it in chunks
(a 3-minute song is ~70 MB of float PCM, too big for one evaluate call). Node applies the loudness
trim and the same safety clipper curve the SFX path uses. Songs target **integrated** loudness
(`project.musicLoudness`, default −20 LUFS, under the −18 LUFS max-momentary SFX), capped so true peak
stays ≤ −1 dBTP. Noise buffers are cached per context so hundreds of hats do not allocate hundreds of
2-second buffers.

Song features: duration, integrated/short-term max loudness, loudness range, true peak, centroid,
bands, stereo width, low-end share, and a per-section arc (loudness and centroid per section) so an
agent can see whether a piece builds and breathes. Loop songs report the seam step (level jump across
the loop point). The song look image marks sections over waveform and spectrogram.

## Listening

`beeps album open <songs...>` renders what is stale, registers an album with the running LAN server
and prints hostname and IP links. The page streams each WAV (Range requests, so seeking works), loops
loop songs, and records love / keep / dud, quick tags and a note per track. `beeps album feedback`
prints them for the agent.

## CLI

`beeps song new|list|render|look|export|lint`, `beeps instruments`, `beeps album open|feedback|list`.
Errors keep the v1 shape: stable code, JSON pointer, hint.
