# Matching a reference sound

The owner hands you a recording ("make it like this", "a machine gun like these clips") or you want a measured target. You cannot hear
it, so measure it: `beeps analyze` reads any audio file, `beeps compare` says what a candidate lacks. Neither needs a project.

```
beeps analyze ref.mp3 other.wav            # one analysis per file
beeps export mine --wav out/mine.wav       # or: beeps song export burst --wav out/burst.wav --trim-tail -60
beeps compare ref.mp3 out/mine.wav         # signed deltas (candidate minus reference) + hints
```

WAV (16-bit or float) is read directly; MP3, Ogg, FLAC and 24-bit WAV go through ffmpeg (`ffmpeg-static`, `BEEPS_FFMPEG` or the PATH).
Everything is analysed at 48 kHz: a 24 kHz or 44.1 kHz file is resampled and `sourceSampleRate` says what it was (a 24 kHz preview has
nothing above 12 kHz, so do not chase that band).

## What an analysis holds

- `features`: the `measure` set (peaks, LUFS, crest, centroid, sharpness, roughness, clipping). Loudness is trimmed away in a patch, so
  never match `integratedLufs`; match `crestDb`, `centroidHz` and the shape.
- `spectrum`: energy share per octave-ish band, dB re total. Shares sum to 100 %, so a deficit in one band is a surplus elsewhere:
  fix the band that is most wrong first and re-measure before touching the others.
- `events` (when something repeats): `count`, `onsetsSec`, `levelsDb` (per event, re the loudest), `rpm` (from the median interval),
  `intervalCv` (0.05 = machine-regular, 0.3 = loose), `floorDb` (level in the gaps between events, re the event peak: how much tail
  or room there is) and `periodicity` (0-1; under 0.12 means nothing repeats and `rpm` is `null`).
- `profile`: the mean event per band (`low` 40-160 Hz ... `air` 6-12 kHz): where it peaks (ms after the onset) and `t10Ms` / `t20Ms`,
  the time to fall 10 / 20 dB (`null`: it never does before the next event, a sustained tail). The window is 90 ms, or 90 % of the median
  interval when events come closer (`profileWindowMs`).

Detected events can include a tail ring or an echo at the end of a clip: look at `levelsDb` and drop the ones 10 dB or more under the rest.

## From a measurement to a patch lever

| the numbers say | change |
|---|---|
| `floorDb` emptier than the reference | a layer that decays slowly under the crack (`amp.decay` is about the time to -60 dB, so -20 dB takes roughly a third of it); or a higher `fx.reverb.sendDb` |
| `crestDb` higher | more body and tail under the transient (the crack alone is the peak); lower the crack layer's `gainDb` against the others |
| `centroidHz` higher | lower the cutoffs of the noise layers, a wide `bandpass` (`q` 0.25-0.5) in place of a `highpass`, less air |
| a band share low or high | one bandpass layer centred in that band; a layer's own `highpass` trims a band its source leaks into |
| a band's `t20Ms` shorter | longer `amp.decay` on the layer that carries that band |
| `clippedSamples` in the reference, none in the candidate | `drive` 0.6-1 on the loud layers; the exporter still holds peaks at -1.5 dBFS |

Change two or three things per round and run `compare` again; a lever pulled twice overshoots (a longer low thump fixed the tail and
pushed 60-125 Hz up 8 dB).

## A burst of repeating events is a song, not a patch

A patch has at most 8 layers and no repeat. Make the single event a patch (`meta.intent: "click"` for a transient, tags `bright` and
`gritty` for a gunshot, `fx.dcBlock: true` for a heavy low end), then play it from a `beeps/song@1`:

- `tracks.x`: the patch, `"fixed": true` so written notes only time it, `humanize` 0.3-0.4 for timing and velocity looseness.
- `patterns.burst`: `steps` of `x` (every step is `stepsPerBeat` 4 per beat), as many `x` as shots and `.` to finish the bar.
- `bpm` = 60000 / (interval in ms x 4), e.g. a 690 rpm gun (87 ms) is `bpm` 172.4. Any bpm from 30 to 240 is allowed.
- Exact times are possible too: at `bpm` 60 a beat is a second, so a `notes` pattern `[[0.087, "C4", 0.03, 0.9], ...]` plays any
  measured onset list.
- Each note re-rolls noise layers, so repeats are not identical samples.
- `beeps song export <name> --wav out.wav --trim-tail -60` (non-loop) is what `compare` reads.

## Limits

- The hints are indicators: thresholds are 6 dB (floor), 4 dB (a band), 3 dB (crest), 5 % (rate), 8 ms and 2x (decay). A clean
  `compare` does not mean it sounds right; the owner's ear decides (beeps-audition).
- A reference with a noisy, lossy floor (a low-bitrate MP3) shows a sustained low band that a synthesised tail will not reproduce.
- `analyze` finds repeated events by their rise in the envelope above 800 Hz; a bass-only pulse (a kick drum) reads as nothing.
