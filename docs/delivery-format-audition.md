# Delivery-format audition

`beeps audition` and `beeps album` stream lossless WAV masters, so the owner hears the best case. `beeps audition formats` lets them hear what a compressed delivery format actually costs, blind, on the device the game will play on.

```text
beeps audition formats public/audio-wav                       # a bundle directory (sidecars give role and loop)
beeps audition formats a.wav b.wav --role sfx                 # WAV files
beeps audition formats --set <set-id>  /  --album <album-id>  # candidates or songs already rendered
  --presets wav,mp3-64,mp3-96,mp3-v5,opus-32,opus-48,opus-64,anchor
  --catalog music=3600,sfx=400                                # seconds per role in the whole library
```

Presets: `wav` (the hidden reference, always present), `mp3-64/96/128` (CBR), `mp3-v5`, `mp3-v2` (VBR), `opus-32/48/64/96` (Ogg Opus) and `anchor` (the master low-passed at 3.5 kHz, a deliberately bad version used to screen the listener). MP3 CBR and Opus use the same encoder arguments as `beeps compress`; VBR uses `libmp3lame -q:a`, with the same Xing/Info header. Everything is written to `.agent-beeps/delivery/<id>/` (git-ignored scratch). Masters, the build store and export outputs are never written.

## The page

`/d/<id>?t=<token>` on the audition server (LAN and Tailscale addresses are printed as `ipUrls`; a phone uses one of those).

- Each sound has blind letters, shuffled per sound. A letter button switches versions while playing and carries on from the same moment: every letter is decoded with `decodeAudioData` (what a game does) and played on one Web Audio clock with a 6 ms crossfade. One sound plays at a time and other sounds' buffers are released.
- A device header lists, per format, `canPlayType` and the result of a real `decodeAudioData` probe (time, and decoded length against the expected frame count, so a gapless problem shows as a nonzero delta). A format that fails to decode on the device disables its letters.
- Each letter takes a 1 to 5 rating, a "sounds worse" flag and a note; ratings save as they change.
- **Reveal** locks the ratings and shows which version each letter was, its size, bytes per second per preset, projected library bytes per preset (when `--catalog` was given) and, per role, the smallest preset whose mean rating is within half a point of the hidden original with at most a fifth of its sounds flagged worse.

The page data never names a preset; the key (`/reveal`, `/results`) is served only after the owner reveals.

## Results and taste

Events append to `events.jsonl`; `results.json` (`beeps/delivery-results@1`) is rewritten on every event. `beeps audition formats-status --id <id>` summarizes it. Screening: per sound the hidden original must be rated above the anchor; otherwise the role is marked `reliable: false` and is left out of `beeps taste show`.

`beeps taste import <results.json>` writes one `beeps/delivery-preference@1` row per role and codec preset to `.agent-beeps/taste/delivery.jsonl` and the global `delivery.jsonl`, once per session. These are not pairwise verdicts (the same sound at two bitrates has identical taste features), so they never enter `verdicts.jsonl` and `beeps taste fit` cannot see them. No prediction is sealed for this mode: there is no candidate lineup for an agent to call, so `E_PREDICTION_REQUIRED` does not apply.

## Limits

A session is one owner on one device; the Safari question needs the owner to open the page on Safari. Levels are not re-matched per version (all versions encode the same delivered WAV). Adaptive layer stems are not auditioned individually; audition the mix file or the layers as WAV files.
