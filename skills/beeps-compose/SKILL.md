---
name: beeps-compose
description: Compose procedural or recorded-source hybrid game and UI sounds with agent-beeps - generate diverse candidates from archetypes, author or edit JSON patches, render, measure and look at them, and export loudness-matched WAVs.
when_to_use: Use when asked for a sound effect, UI sound, a cue of a few seconds or less, coin, jump, hit, laser, explosion, click, notification or "a sound for X" in a game or app, when editing an existing beeps patch or designing an instrument patch for a song, when the owner supplies a recording or clip to match, reproduce or combine with synthesis, when a recording is longer than ten seconds and a crop must be chosen, or when a beeps patch command fails with E_SCHEMA and a pointer. Music, themes and loops are beeps-music.
---

# Compose sounds

`beeps` means `node "<plugin-root>/scripts/run-managed.js"`; run the beeps-setup skill first if it
is not installed. Work from the project root; `beeps init` creates `.agent-beeps/` once.

You cannot hear. You can read measurements and **look** at each render's `look.png` (waveform,
spectrogram, feature strip). The owner's ear is the judge: finish by auditioning (beeps-audition).

## The loop (start here)

1. `beeps taste show`, then `beeps generate <archetype> --count 6 --prompt "<what it is for>"`. Archetypes, with how each is built: [reference](../../docs/reference.md).
2. **Look** at the contact sheet it prints; read the `report` and any `notices` ([notices](references/notices.md)).
3. `beeps lint <names> --brief`; fix every error, justify every warning.
4. `beeps predict` then `beeps audition open` (beeps-audition): the owner decides. Export the winner and run `beeps kit check`.

Three complete runs (a UI chime, a stinger, a training-video bed) with the fields to read at each step: [worked examples](references/worked-examples.md).
Choosing a method or judging a render: beeps-craft. Everything below is for when the loop is not enough.

## Read the `notices` before you describe a result

A command that changed, dropped or ignored something you asked for says so in `notices` (and `generate`/`mutate` in a `report`). Match on
`code`; never call a sound "as written", or a set the size you asked for, while one says otherwise. The codes and what to do about each:
[notices](references/notices.md). You cannot hear: state what the measurements and the look image show, not what the sound "feels" like.

## Recorded-source or hybrid SFX

A recording used in a patch: read [hybrid sources](references/hybrid-sources.md) first. Import, prepare a named sample patch, add procedural
layers, save, render/lint/look, then **bundle the final edited patch** (a bundle made before the edit is stale). A recording over ten seconds:
`beeps sample overview <normalizedId|file>` images it and proposes crop windows with a ready `prepare` line each; `beeps sample digest` is the same view as a text table
(level, brightness, steady pitch, events per window) for when you cannot view the image. Songs are beeps-music.

## Generate first, author second

- `beeps archetypes` lists the starting points with their family and recipe (the table is also in [reference](../../docs/reference.md)). The `creature`
  family is voice-source animal calls: `creature` samples all of them, or pick `creature-yip`, `-growl`, `-bleat`, `-low`, `-cluck`, `-huff`, `-hiss`
  instead of hand-building one from oscillators and noise.
- `beeps generate <archetype> --count 6 --prompt "<what it is for>"` oversamples, renders, drops
  lint failures, and keeps a diverse set (taste-ranked once the model has data). Words in the prompt
  steer it (soft, warm, dark, bright, short, punchy...; `steering` shows what it read). It prints the
  set id, per-candidate features, and `sheet` - **open the contact sheet and look at it**.
- Nothing fits? Write a patch (`references/patch-format.md`) and `beeps new sound.json`, or edit one
  atomically with `beeps batch ops.json [--dry-run]` (ops: create, set, remove, delete; a failure
  reports `operationIndex` and a JSON pointer).
- Many similar patches (12 footsteps, a gap-fill kit)? Don't hand-type JSON: write one template with
  `{{param}}` placeholders and a table, then `beeps family step.json --table surfaces.csv --lint
  [--out audio/patches] [--set steps] [--dry-run]`. Rows are validated per patch (E_SCHEMA names the
  row and pointer), output is deterministic, `--lint` prints the brief summary. See `references/family.md`.
- Variations of one sound: `beeps mutate <name> --toward darker,shorter --count 4`; blend two with
  `beeps crossover <a> <b> --name <new> --t 0.5`.
- Repo keeps its patches in a folder (e.g. `audio/patches/*.json`)? `beeps sync audio/patches` mirrors
  it into the project (adds new, replaces changed, validates all first); rerun it after every edit
  instead of `beeps new --force` per file. `beeps build` reads recipe paths directly and needs no sync.
- Variants of a repeating sound: if they differ only in pitch, gain or seed, declare `variation` in
  one patch (the player picks variants with no-repeat). If they need different layers or sources,
  author 3+ sibling patches in one family named `<stem>-<n>` (or sharing `meta.variantOf`); lint
  counts siblings it finds in the project or on the same command line for `variation-on-repeating`,
  and the game picks among them.

## Say what the sound must be

Wrote a brief ("a 200 ms confirm chime, bright, rising, short tail")? Put it in the patch as `xExpect` so a tool checks it: `lint`, `kit check` and
`build` return an `expectations` verdict (pass, fail or unmeasurable, with the measured value, a pointer to the entry and a hint) and exit 1 on a miss.
Use it for a regenerated or refined sound (`mutate` can drift out of the brief) and for a regression gate. It is not a craft rule: rules are
general and cited, an expectation is this sound's own contract. Kinds and units: `docs/expectations.md`. No numbers yet? `lint <name> --derive-expect`
prints a block the sound passes as it measures now: edit it and save it. `mutate` drops children that miss the parent's block (`--ignore-expect` keeps them).

## Render, measure, look

- `beeps render <name...> [--variants]` - loudness-trimmed renders with key features.
- Before and after a change (a refine round, an engine update): `beeps diff <a> <b>` gives the signed spectrogram difference as dB per band and per third of the
  sound, with an image; `beeps kit golden bless` then `check` tells you whether each kit sound is identical, equivalent within tolerances, or different.
- `beeps look <name>` (one look.png) or `beeps look a b c` (a contact sheet). Check: the onset is
  where you expect, nothing rings past the energy length you intended, pitch moves the right way,
  noise sits in the band you meant.
- Matching a recording the owner supplies ("like these clips")? `beeps analyze <audio...>` measures any file (rate, tail, band decay,
  spectrum) and `beeps compare <ref> <candidate.wav>` lists what to change: `references/matching-a-reference.md`.
- `beeps measure <name>` - every feature. `beeps lint <name...>` - cited craft rules; fix every
  error, justify every warning. Linting a whole batch? Add `--brief`: only patches with findings, the clean
  ones by name, and each judgement rule once. lint exits 1 only for errors (warnings exit 0) and
  always prints its JSON on stdout; `notes` lines are informational.
- Authoring a set (several sounds of one family, or a game's kit)? Kit-level rules (family-consistency,
  masking-risk, key-consistency, one-no, priority-levels) run only in `beeps kit check`, never in lint
  (lint's `notes` says so). `beeps kit add <name>` each sound as you draft it and rerun
  `beeps kit check` after every change, not at the end (`beeps kit list` shows the kit, `beeps kit remove <name>` drops a sound).
- `beeps export <name> --wav public/audio/<name>.wav --manifest` writes a WAV plus a sidecar; add
  `--variants` to export every declared variant for no-repeat playback. Exports are stereo and the
  full render length by default; `--channels 1` halves a sound whose channels are identical (no pan,
  no reverb) without changing a sample, and `--trim-tail -60` drops a near-silent effect end (lint's
  `effect-tail` note says when). The seed is `--seed`, else the one an audition ship recorded in
  the kit (`kit add` records none), else 1: pass `--seed` in build scripts. A seed renders
  bit-exactly (same samples every run on one Chromium build), so re-exporting an unchanged patch
  reproduces its WAV; a difference means the patch, seed, project or toolchain changed. For a web game, export every
  SFX and song into that one folder, then `beeps bundle public/audio` (writes `index.json`) and
  `beeps player export src/vendor` (vendors `src/vendor/beeps-player/`):
  ```js
  import { createPlayer } from './vendor/beeps-player/player/player.js';
  const player = createPlayer({ catalog: '/audio/index.json' }); // wherever the server serves public/audio/
  button.onclick = () => player.unlock(); // must run from a user gesture
  ```
  The player handles the voice budget, priorities, crossfades and adaptive music states, and it never
  hard-limits below its -1.5 dBFS knee. Its voice priority follows `meta.priority` (1 = most
  important, 5 = least): a new sound may steal a voice only from one with a strictly larger number.
  Engines that are not web games use the WAVs and sidecars directly. Full API, error codes and the
  required `visibilitychange` wiring: `skills/beeps-ship/references/game-player.md`.

Delivering to the web? Ogg Opus at 48 kHz is the default, MP3 (Xing tag, never `+bitexact`) only for Safari before 18.4,
and decoded memory is 26.3 MB per stereo 68.6 s layer however small the file. Check with `beeps verify` and
`beeps loopcheck <files> --engines chromium,firefox,webkit`; the full recipe is `skills/beeps-ship/references/web-delivery.md`.

Writing a build script that calls beeps (Windows `.cmd` shim, exit codes, seeds)? README, "Calling
beeps from your own build script": run `node <npm root -g>/agent-beeps/scripts/beeps.mjs` with an
args array and no shell.

## When the game plays it live

If the sound is a function of game state (an engine that follows speed, an impact that follows mass), declare named inputs in
an `xRuntime` block instead of baking dozens of variants: `beeps runtime check` lints the patch at every input corner,
`beeps runtime look` draws baked and live side by side, and `delivery` in the build recipe picks baked, runtime or both.
One-shots with no input stay baked. Decision table, binding targets and units, the checks and the traps:
`references/runtime-inputs.md`; the format and API: `docs/runtime.md`.

## Never

- Put a loudness literal in a patch: levels are trimmed to the project target (-18 LUFS by default,
  per-family offsets). Use `gainDb` only for balance between layers. To seat a family under the
  rest (footsteps, foley), set `familyOffsets` in `.agent-beeps/project.json` or one patch's
  `meta.loudnessOffsetDb`, not a layer gain.
- Use `q` on a lowpass/highpass (`resonanceDb`) or `resonanceDb` on a bandpass (`q`).
- Hand the owner a single sound as "done". Offer a set and audition it.
- Add `xRuntime` to a sound nothing in the game varies, or let an input's `default` drift from the value the authored patch sounds
  right at: the audition, the bake and the cue's level are all measured there.

## Done bar

The patch lints with zero errors, you have looked at its look image, and the owner shipped it in an
audition (or explicitly waived the audition).
