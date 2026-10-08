# Delivering to the web

What a browser game must do with a rendered loop after `beeps song export` / `beeps export`. The measurements behind every number
here are in the agent-beeps research note "Web audio formats and gapless loops" (Chromium 153 and Firefox 155 measured; real Safari
and iOS **not** measured). Read that note for evidence; this file is the recipe. Tools: `beeps build` / `beeps compress` encode,
`beeps verify` checks headers, `beeps loopcheck` decodes, `beeps player selftest` checks a real device (skill `beeps-ship` has the
build, lock and CI side).

## Which format

| Need | Format | Why |
|---|---|---|
| Default for a new game | Ogg Opus (`beeps build --target web-universal`, `beeps compress`) | exact length and gapless in Chromium and Firefox; smallest at equal quality |
| Must reach Safari before 18.4 / macOS before 15.4 | MP3 (`--format mp3`, `--target web-mp3`) | every browser decodes it; length is exact only if the Xing/Info tag is intact |
| Safari 17.4 to 18.3 and Opus wanted | WebM Opus | decodes there, but the container is not what `beeps` writes: test it yourself |
| Anything that must be sample exact and size does not matter | WAV | exact everywhere; 10 to 15 MB per music loop |
| Never for a loop | AAC / M4A, ADTS, Opus in MP4, Vorbis in WebM, ADPCM WAV | priming errors of tens to thousands of frames, or `decodeAudioData` rejects it |

Host **one** format when you can; a second doubles the files to verify. Ogg Opus needs Safari 18.4 (and macOS 15.4): an older Safari
plays nothing, silently, so decide who you must reach.

## Exact settings (do not improvise)

- Sample rate **48 kHz**, the project rate. Encoding at 44.1 kHz made a decode 50 frames longer once a context resampled it.
  `beeps compress` encodes MP3 at the source WAV's rate and fails an Opus encode of a non-48 kHz source; `beeps verify` fails an
  encode whose rate differs from its sidecar.
- Ogg Opus: `libopus`, `-vbr on -application audio`, kbps by role (music 44 to 56, ambience 48, sfx 72). The decoder trims the
  pre-skip and stops at the final granule position, so every browser returns the source length.
- MP3: `libmp3lame` CBR (music 80, ambience 64, sfx 96 by default; 64 for pads if you have listened), `-write_xing 1`,
  `-id3v2_version 0`, `-map_metadata -1`.
- **The MP3 tag trap**: never `-fflags +bitexact` / `-flags:a +bitexact` for MP3, never `-write_xing 0`. Bitexact writes the
  encoder id `Lavf lame`, and Firefox then ignores the tag's delay and decodes the file 1610 frames long with the loop point 576
  frames late; Chromium reads the delay from the frames and hides it, so a Chromium-only test passes. No Xing/Info tag at all
  is +2139 frames in both. `beeps verify` flags both statically; `beeps loopcheck --engines` proves it in the browser.
- Loops are exact: the decoded frame count must equal `round(durationSec * sampleRate)`. A one-shot MP3 may run one MPEG frame (1152)
  long (a silent tail); a loop may not.

## Memory (the real mobile risk)

`decodeAudioData` returns float32: **frames x channels x 4 bytes**, whatever the file format. A stereo 48 kHz layer of 68.571 s is
**26.3 MB**; a five-layer song is 131.6 MB; all the layers of a score resident can be over a gigabyte. Download size is not the
constraint, decoded size is. Load only the layers of the playing state, mono where a layer's channels are identical
(`beeps export --channels 1`), and cap the player; see `skills/beeps-compose/references/game-player.md` ("Memory") for the
player's budget option.

## Check before you ship

```text
beeps verify                                  # headers: Opus granule length, MP3 tag, encoder id, rate vs sidecar
beeps loopcheck out/*.ogg --engines chromium,firefox,webkit   # decode in real engines at 48000 and 44100 Hz
beeps player selftest site --serve            # open on a real iPhone / Mac Safari, tap Run, copy the result
```

`loopcheck --engines` exits 1 on a frame delta and prints the start lead; an engine that is not installed or has no Web Audio
(Playwright's Windows WebKit) is reported as unavailable, never as a pass. Install Firefox and WebKit with
`node <plugin-root>/scripts/setup.js --browsers firefox,webkit`. Seam metrics (`seam` in loopcheck, `song-loop-boundary-step` in
lint) show whether the codec made the wrap worse than the source. Safari itself is unverified until the self-test page has been run on
a device: say so rather than claiming Safari support.
