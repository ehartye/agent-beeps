---
name: beeps-compose
description: Compose procedural game and UI sounds with agent-beeps - generate diverse candidates from archetypes, author or edit JSON patches, render, measure and look at them, and export loudness-matched WAVs.
when_to_use: Use when asked for a sound effect, UI sound, a cue of a few seconds or less, coin, jump, hit, laser, explosion, click, notification or "a sound for X" in a game or app, when editing an existing beeps patch or designing an instrument patch for a song, or when a beeps patch command fails with E_SCHEMA and a pointer. Music, themes and loops are beeps-music.
---

# Compose sounds

`beeps` means `node "<plugin-root>/scripts/run-managed.js"`; run the beeps-setup skill first if it
is not installed. Work from the project root; `beeps init` creates `.agent-beeps/` once.

You cannot hear. You can read measurements and **look** at each render's `look.png` (waveform,
spectrogram, feature strip). The owner's ear is the judge: finish by auditioning (beeps-audition).

## Read before composing

1. `beeps capabilities --no-schema` - source types, archetypes, refine directions and short notes.
2. `beeps taste show` - what this owner has preferred so far (skip nothing marked `strong`).
3. The beeps-craft skill when choosing a synthesis method or checking a sound "feels right".

## Generate first, author second

- `beeps archetypes` lists the 16 starting points (coin, pickup, jump, land, hit, explosion, laser,
  powerup, powerdown, ui-click, ui-hover, confirm, no, blip, whoosh, alarm).
- `beeps generate <archetype> --count 6 --prompt "<what it is for>"` oversamples, renders, drops
  lint failures, and keeps a diverse set (taste-ranked once the model has data). Words in the prompt
  steer it (soft, warm, dark, bright, short, punchy...; `steering` shows what it read). It prints the
  set id, per-candidate features, and `sheet` - **open the contact sheet and look at it**.
- Nothing fits? Write a patch (`references/patch-format.md`) and `beeps new sound.json`, or edit one
  atomically with `beeps batch ops.json [--dry-run]` (ops: create, set, remove, delete; a failure
  reports `operationIndex` and a JSON pointer).
- Variations of one sound: `beeps mutate <name> --toward darker,shorter --count 4`; blend two with
  `beeps crossover <a> <b> --name <new> --t 0.5`.

## Render, measure, look

- `beeps render <name...> [--variants]` - loudness-trimmed renders with key features.
- `beeps look <name>` (one look.png) or `beeps look a b c` (a contact sheet). Check: the onset is
  where you expect, nothing rings past the energy length you intended, pitch moves the right way,
  noise sits in the band you meant.
- `beeps measure <name>` - every feature. `beeps lint <name...>` - cited craft rules; fix every
  error, justify every warning.
- `beeps export <name> --wav assets/sfx/<name>.wav --manifest` writes a WAV plus a sidecar; add
  `--variants` to export every declared variant for no-repeat playback. For a web game, run
  `beeps bundle assets/audio` (one `index.json` catalog) and `beeps player export src/vendor`, then
  `createPlayer({ catalog: '/audio/index.json' })`. The player handles the voice budget, priorities,
  crossfades and adaptive music states, and it never hard-limits below its -1.5 dBFS knee. Its voice
  priority follows `meta.priority` (1 = most important, 5 = least): a new sound may steal a voice only
  from one with a strictly larger number. Engines that are not web games use the WAVs and sidecars
  directly.

## Never

- Put a loudness literal in a patch: levels are trimmed to the project target (-18 LUFS by default,
  per-family offsets). Use `gainDb` only for balance between layers.
- Use `q` on a lowpass/highpass (`resonanceDb`) or `resonanceDb` on a bandpass (`q`).
- Hand the owner a single sound as "done". Offer a set and audition it.

## Done bar

The patch lints with zero errors, you have looked at its look image, and the owner shipped it in an
audition (or explicitly waived the audition).
