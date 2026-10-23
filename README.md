# agent-beeps

A sound composer for coding agents. Agents build procedural and recorded-source hybrid game and UI sounds as Web Audio
patches (JSON), render them in real Chromium, measure what came out (loudness, true peak, attack,
length, brightness, sharpness, roughness, pitch), check them against cited craft rules, and put a
diverse set in front of the owner on a listening page served to the local network. The owner keeps,
duels and refines by ear; every explicit choice trains a taste model that ranks and predicts the next
set, and every audition scores how well the agent predicted the pick.

Sounds are editable patches: synthesize them from scratch or combine prepared recordings with
procedural layers. Games can bake a WAV/Opus file or play the same graph live with verified sample
buffers. Import and preparation are local; portable bundles share only the source material you select.

**[Listen to Matter →](https://ehartye.github.io/agent-beeps/)** — an original 94-second procedural
reel in the existing listening booth, with nine scenes and eight effects synthesized live in your
browser. [Score, patches, measurements and build instructions](showcase/README.md).

**[Three playlists →](https://ehartye.github.io/agent-beeps/playlists/)** — thirty original instrumental tracks for hosting and dinner prep, study and focus, and getting pumped, each a JSON score you can read ([playlists/](playlists/)).

[Hear Fuse: recording, procedural body, hybrid](https://ehartye.github.io/agent-beeps/#fuse) ·
[Metal example](library/examples/fuse/README.md) · [Tommy five-burst example](library/examples/fuse-tommy/README.md) ·
[M16 sustained-burst example](library/examples/fuse-m16/README.md)

[Install for Codex or Claude Code](#install) · [Workflow](#workflow) · [Commands](#commands)

Agents also compose **music**: a `beeps/song@1` document plays those same patches as instruments
through chord progressions (voice-led from chord symbols), arps, bass lines, step drums (including
Euclidean rhythms such as `x(3,8)`), melodies, sections and mix moves, from loops to one-shot jingles.
Songs render to loopable, loudness-matched WAVs, are linted against cited
music craft rules, and go to the owner on a LAN album page. `library/songs/sci-fi-exploration/`
holds a 13-track example library; `library/instruments/` holds 25 instrument patches.

For expressive phrasing, notes can carry pitch bends and brightness curves, and tracks can map
velocity to an instrument's tone and envelopes as well as volume.
[Expressive notes and a working score](skills/beeps-music/references/song-format.md#expressive-notes)
use the same song renderer and listening workflow.

[`library/sounds/sci-fi/`](library/sounds/sci-fi/) contains 18 approved effects across Expedition,
Arcade and Oddities, with purpose labels, playback seeds and measured kit levels.
[`library/sounds/colony-sfx/`](library/sounds/colony-sfx/) and
[`library/songs/colony-ambient/`](library/songs/colony-ambient/) are a second worked example kit, with
nine effects, four ambience beds and three songs, that you can hear on the
[listening booth](https://ehartye.github.io/agent-beeps/#colony).

## Workflow

1. **Compose**: `beeps generate coin --count 6 --prompt "coin pickup for a cozy platformer"`
   oversamples an archetype, renders and measures each candidate, drops lint failures, and keeps a
   diverse set (ranked by the owner's taste once it has data). The agent looks at the contact sheet.
2. **Predict**: `beeps predict --set <id> --pick 3 --shortlist 3,5 --why "..."` seals the agent's
   guess before the owner hears anything.
3. **Audition**: `beeps audition open --set <id>` prints a link like
   `http://<hostname>:47301/s/<id>?t=<token>`. The owner works through
   - **Lineup**: keep and dud, loudness-matched, with ×5 / ×75 repeat, play-with-kit, a pad bed and
     laptop/phone speaker simulation.
   - **Duel**: A vs B, sides randomised, next pair chosen where the model is least sure.
   - **Refine**: brighter, darker, punchier, softer, shorter, longer, less harsh, more character,
     more like #k, surprise.
   - **Ship**.

   For a sampler of different sound roles, use `beeps audition open --set <id> --flow explore`.
   It offers labeled playback without duels, voting, or predictions. Pads show the patch name
   and `meta.description` (intended use), in exploration and comparison views alike.

4. **Refine rounds**: `beeps audition wait` hands the agent each refine request; `beeps mutate
   <champion> --toward darker` breeds variations that measurably move that way; `beeps audition
   round` adds them. In hand-off mode the server breeds rounds itself.
5. **Ship**: the champion is saved to `.agent-beeps/patches/` and the kit at its measured loudness
   trim; the reveal shows whether the agent and the taste model called it.

## Commands

The table below groups the commands you reach for most. [`docs/cli.md`](docs/cli.md) lists every command with its description, generated from the CLI itself (`node scripts/gen-cli-docs.mjs --write` after adding one), and `beeps capabilities` returns the same list as JSON.

| Command | Does |
|---|---|
| `capabilities` | schema, source types, archetypes, directions, error codes |
| `init` | create `.agent-beeps/` (scale, loudness target) |
| `archetypes`, `generate` | 26 archetypes (18 SFX, 8 creature voices); diverse lint-clean candidate sets |
| `family` | one template patch + a table (JSON/CSV/`--row`) -> N validated patches: `{{param}}` placeholders, `/pointer` columns, seeded `a..b` ranges and `--jitter`, `--lint`, `--set`, `--out`, `--dry-run` |
| `new`, `sync`, `batch`, `list` | save patches; mirror a directory of committed patch files into the project (`sync <dir>`, validates all first); atomic create/set/remove/delete with `--dry-run` |
| `render`, `measure`, `look`, `lint`, `export` | render + trim, full features, look images and contact sheets, craft rules, WAV |
| `analyze <audio...>`, `compare <ref> <candidate>` | measure any audio file (WAV, or MP3/Ogg/FLAC through ffmpeg; no project needed): the patch features plus where the sound is, whether and how it repeats (onsets, rate, regularity, level between events, per-band decay of the mean event) and its spectrum; `compare` gives signed deltas and hints for matching a reference ([guide](skills/beeps-compose/references/matching-a-reference.md)) |
| `set create` | render patches you already authored into a candidate set (audition a hand-made kit with `--flow explore`) |
| `mutate`, `crossover` | direction-steered variations; blend two patches |
| `kit list/add/remove/check` | the project's shipped sounds and kit-level rules |
| `predict`, `audition open/wait/round/status/list/close/stats` | the owner's listening loop |
| `audition formats <bundle\|wav...>`, `audition formats-status` | blind-audition delivery formats: encodes the sounds through the compress presets (MP3 CBR/VBR, Ogg Opus) beside a hidden lossless reference and a low-pass anchor, serves a lettered rating page with a device decode check, writes `results.json`, and projects catalog bytes per preset ([guide](docs/delivery-format-audition.md)) |
| `serve` | the LAN audition server (idempotent; `--stop`) |
| `taste show/fit/stats/import` | the learned taste profile and prediction hit rates; `import` logs a game page's thumbs, or a delivery-format audition's `results.json` as delivery preferences (kept apart from the sound model) |
| `instruments`, `instruments rebase <name>` (`--by N` or `--to NOTE`) | bundled instrument patches songs can name; `rebase` prints the song-instrument override that builds one at another register, moving its pitched layers and scaling their filter cutoffs |
| `song new/list/check/render/lint/export` | compose, outline, render (parallel), lint and export music |
| `album open/feedback/list` | progressive LAN song playback: love/keep/dud, tags, whole-track and timestamped moment notes |
| `bundle <dir>` | collect export sidecars under a directory into `index.json`, the game player's catalog |
| `compress <dir> <outDir>` | re-encode an exported bundle as Ogg Opus (about 30x smaller) or, with `--format mp3`, as gapless MP3 for browsers without Ogg Opus, verify frame counts, alignment and loop wraps, write `<outDir>/index.json`; needs ffmpeg (`ffmpeg-static` optional dependency, `BEEPS_FFMPEG` set to the ffmpeg executable's path, or the PATH) |
| `loopcheck <files...>` | decode encoded audio and report frame count against its sidecar and the loop wrap (tick size, level step, and seam metrics: boundary step and slope jump in dB against a typical sample step, last zero-crossing phase, with a warning when the delivered seam is 3 dB worse than the source's); `--engines chromium,firefox,webkit` also decodes each file with `decodeAudioData` in those browsers at 48000 and 44100 Hz and reports frame delta and start lead against the source (the lead needs the source WAV beside the file or `--source`; without one it reads `n/a`, not a number) (non-zero exit on a delta; an engine that is not installed or has no Web Audio is reported, never passed) |
| `song states <song>` | adaptive songs: judge every state as its own piece (loudness, trim, range, seam, register overlaps among its tracks, lint) |
| `song compat <songs...>` | plan crossfades between songs without rendering: tempo relation, phase-lock, estimated key, harmony agreement per pair |
| `build` | incremental audio build from `beeps.build.json`: render, export, compress and bundle only assets whose input hash differs from the committed `audio.lock.json` (or whose outputs are missing or modified); `--check` renders nothing and exits 1 listing what is stale; `--only`, `--all`, `--target web-universal` (default), `web-mp3` or `wav-master`, `--pull` / `--push` with `--store dir:<path>` or `release:<owner/repo>`, `--adopt` (also re-keys a lock of an older toolchain without rendering), `--allow-toolchain-change`, `--verify-determinism` (render each song twice and fail the asset if the renders differ); a recipe's `delivery` (`baked`, `runtime`, `both`) also writes the runtime cue ([docs](docs/build-lock-and-store.md)) |
| `runtime export`, `check`, `verify`, `parity`, `perf`, `live`, `look` | the runtime path: write a patch's cue, lint it at its input corners, verify cues are current, compare baked and live voices (`--engines chromium,firefox`), time voice builds (`--bus`, `--plays N`), move an input mid-note, look at both renders ([docs](docs/runtime.md)) |
| `verify [dir or lock]` | outputs against the lock (sha256), the catalog, and Opus/MP3 container headers (length, tag, encoder id); `--decode` adds the loop checks |
| `store push/pull/status` | the content-addressed audio store (one tar per asset, named by input hash, immutable): a `dir:` directory or GitHub `release:` assets |
| `ci export <dir>` | vendor a zero-dependency `fetch.mjs`: `node fetch.mjs` materialises the audio from the store by hash and verifies it against the lock, no beeps, Chromium or ffmpeg |
| `player export <dir>` | vendor the browser game player (voice budget, priorities, crossfades, adaptive layers, safety clipper) into `<dir>/beeps-player/` |
| `player selftest [dir]` | write `<dir>/beeps-selftest/`: a static page that decodes a known 2 s loop (WAV control, Ogg Opus, MP3) through the vendored player's loader in a realtime and in 48000 and 44100 Hz offline contexts and prints frame delta and lead, with a copyable result; `--serve` serves it on the LAN to open on a real iPhone or Safari |

Every command prints JSON. An error that stops a command prints `{"error":{code,message,pointer?,hint?}}` to stderr
and exits 1, or 2 for a usage error (`E_USAGE`, including an option value that does not parse). A command that
works through several items (a batch render, a set, a family) reports each one in its stdout JSON, with `ok: false`
and an `error` for the ones that failed, and exits 1 if any did. `E_RENDER` is work that ran and failed;
`E_INTERNAL` is a bug in beeps (a `TypeError` or `ReferenceError`), not your input: rerun with `BEEPS_DEBUG=1` to
add the stack, and report it.

`beeps export <patch>` writes the render's own stereo WAV. `--channels 1` writes one channel (identical
channels keep their samples exactly; channels that differ, from the stereo reverb or a panned layer, are averaged and the
command warns), and `--trim-tail <dBFS>` (e.g. `-60`) cuts the near-silent end after the last sample at
that level, with a 10 ms fade over the kept quiet samples; both default off, and the sidecar's
`channels`, `frames` and `durationSec` describe the written file. `beeps build` does not apply them yet.

For game integration, add `--manifest` to `beeps export <patch> --wav audio/cue.wav` or
`beeps song export <song> --wav audio/theme.wav`. It writes an adjacent `<wav>.json` with the
asset's label, description, relative WAV filename, loop flag, exact duration, sample rate,
channels, render identity and measured delivered loudness/true peak. Roles default to `sfx`
for patches and `music` for songs; `--role ambience` overrides the role and requires `--manifest`.
Only songs authored with `loop: true` are labeled as loops. The sidecar marks
`normalizationAlreadyApplied: true`: play the WAV at its delivered level, without reapplying
the render's trim. Loudness names its metric (`momentary-max` for patches, `integrated` for songs).
A sound whose loudness target was moved off its family's stock offset (project `familyOffsets`, patch
`meta.loudnessOffsetDb`) carries `loudnessOffsetDb` (LU, already applied in the samples; informational).
Keep each WAV and its sidecar together when moving them. Without `--manifest`, export is unchanged.
Repeat `--manifest` when updating a previously manifested WAV; an ordinary export leaves any existing sidecar untouched.

`beeps export <patch> --variants --manifest` writes every declared variant as `<stem>.<i>.wav` (there
is no `<wav>` file itself; the sidecar is `<wav>.json`), and that sidecar lists them, their weights,
no-repeat and the patch priority; `beeps bundle` resolves the variant list from the sidecar. `beeps
song export <song> --layers --manifest` also writes each adaptive layer (`<stem>.<layer>.wav`,
loop-folded at the mix's trim) and reports `nullResidualDb`, how closely the layers sum back to the
mix.

## Game player

Export SFX and music sidecars into one folder (e.g. `public/audio/`), then `beeps bundle
public/audio` (writes `index.json`) and `beeps player export src/vendor` (vendors
`src/vendor/beeps-player/`). Import it and unlock it from a user gesture:

    import { createPlayer } from './vendor/beeps-player/player/player.js';
    const player = createPlayer({ catalog: '/audio/index.json' }); // wherever the server serves public/audio/
    button.onclick = () => player.unlock();
    document.addEventListener('visibilitychange', () => player.setHidden(document.hidden));

`player.play(id)`, `player.music(id)`/`player.ambience(id)` (crossfading beds) and
`player.setState(state)` (adaptive layers) do the rest: voice budget, priorities and crossfades are
automatic, and the master never hard-limits below its -1.5 dBFS knee. `player.retry()` re-fetches
after failed loads (e.g. on a sound toggle). For long music on phones, `memoryBudgetBytes`, `layerLoading: 'state'`,
`prefetch(ids)`, `unload(id)` and `memory()` bound the decoded audio kept in memory. Full API and error codes:
`skills/beeps-ship/references/game-player.md`.

## Shipping audio

For an app with many recipes, `beeps build` replaces hand-written export loops: a `beeps.build.json`
names the recipes, the output folder and a committed `audio.lock.json`; a build renders and encodes only
what changed, a store keeps every asset by input hash, and CI runs a vendored `fetch.mjs` instead of
rendering. Mechanism, lock schema and failure modes: [`docs/build-lock-and-store.md`](docs/build-lock-and-store.md);
the recipe an agent follows: the `beeps-ship` skill.

### Calling beeps from your own build script

A game repo that keeps its patches in a folder and drives beeps from a script (instead of `beeps build`)
usually runs `beeps sync <patchDir>`, `beeps kit add` per sound, `beeps lint`, `beeps kit check` and
`beeps export ... --seed 1` in turn. Three things to know:

- **Windows**: `beeps` on the PATH is an npm `.cmd` shim, so `spawnSync('beeps', args)` fails without
  `shell: true`, and `shell: true` with an args array prints Node's DEP0190 warning (arguments are not
  escaped). Run the CLI's own script with Node instead: no shell, no quoting, same on every OS.
  ```js
  import { spawnSync } from 'node:child_process';
  import { join } from 'node:path';
  const root = spawnSync('npm root -g', { shell: true, encoding: 'utf8' }).stdout.trim(); // a fixed string: no DEP0190
  const BEEPS_JS = join(root, 'agent-beeps', 'scripts', 'beeps.mjs');
  const beeps = (...args) => spawnSync(process.execPath, [BEEPS_JS, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
  ```
- **Exit codes**: every command prints its JSON on stdout. `lint` exits 1 only when a patch has an
  error (a warning alone exits 0), so a gate that also wants warnings reads `errors` and `warnings`
  from the JSON; `notes` lines are informational. Usage errors caught while parsing options exit 2, other failures 1, with
  `{"error":{code,category,retryable,...}}` on stderr (`retryable` is true only for `E_LOCK`, `E_SERVER` and `E_STORE`).
  A command that changed, clamped or ignored something adds a `notices` array; both tables are in [`docs/notices.md`](docs/notices.md).
- **Seeds**: `export` uses `--seed`, else the seed an audition ship recorded in the kit, else 1. `kit add`
  records no seed, so pass `--seed` explicitly when the build must not depend on audition history.
  Renders are bit-exact for a seed (since 0.8.0, on one Chromium build): exporting an unchanged patch
  twice gives the same samples, so a diff of committed WAVs means an input or the toolchain changed.

## Sound engine

Nine source types (`osc` with unison, `noise`, `fm` operators, `additive` partials, `modal`
resonators, Poisson `grains`, the 808 `metal` voice, formant `voice`, and prepared `sample`), per-layer pitch/amp/filter envelopes, LFO,
drive and pan, a generated-impulse reverb and a delay, an opt-in DC blocker (`fx.dcBlock`), and a
transparent safety clipper. Pitched
sources snap to the project scale. The engine is plain browser JavaScript
(`runtime/engine/patch.js`): games can import it and call
`buildPatch(audioContext, patch, { trimDb, variant, seed })`. For a game, prefer `build` from the runtime package
([Runtime path](#runtime-path)): named inputs, live handles and a shared reverb bus on top of the same graph.

Songs use `runtime/engine/song.js`: `buildSong(ctx, song, instruments, { lazy: true })` returns
`advance(t)`, which builds only the notes that start before `t`. Call it a couple of seconds ahead
of the playhead. Offline renders do this with `OfflineAudioContext.suspend()`, and it keeps a
multi-minute song's graph small. Songs are trimmed to `project.musicLoudness` (integrated, −20 LUFS
by default).

`beeps song render aurora-station --sections return` extracts that passage from the full delivered
WAV, preserving inherited mix settings, effects and level. The first request renders the whole
song; later excerpts reuse its cache. `--only pad --sections return` previews the full-length solo's
passage, labeled as a solo. Use `song stems` for parts at the full mix's trim.

## What changed in 0.32.0

`beeps build` judges expectations for assets it did not rebuild. No sound changes; no render key or hash moves.

- **The gap:** an `xExpect` block is deliberately not part of an asset's input hash (editing one must not re-bake the sound), so a built asset was "unchanged" and was never re-judged: tightening a brief on a built sound passed the build until the sound next changed. The build now renders (from the cache when it is warm, so usually without starting a browser) each unchanged patch that has a block and fails with `E_VERIFY` naming each asset, check and measured value. `build --check` stays render-free and does not judge.
- **Environment:** the dev dependencies this repo declares (`@noble/hashes`) and the optional `ffmpeg-static` were missing from the maintainer's checkout, which hid seven tests behind "known failures" for eleven releases; with `npm install` they pass, and the full suite is green.

## What changed in 0.31.0

`generate` candidates say what they render. No sound changes for a candidate that was already in the scale; no render key or golden hash moves.

- **Scale-snapped sampling:** the archetype sampler draws free frequencies, and the project scale then moved them at render time, so every pitched candidate arrived with `N_SCALE_SNAP` notices (793.33 Hz written, G5 rendered). `sampleArchetype` now takes the project scale (`generate` passes it) and snaps each numeric source pitch and pitch-envelope target to the nearest note of it, so the patch says what it plays. Only the pitches move: every other sampled parameter is exactly what the same seed drew before, and with `scale.snap` off, or with no scale given (the engine graph goldens, `hook prepare`), the output is unchanged. A seeded `generate` set therefore differs from 0.30.0 in its pitches, by at most half a scale step, and is otherwise the same.

## What changed in 0.30.0

Opt-in notification sounds for an agent session. Nothing plays unless you turn it on. No sound or music changes to existing sounds; no render key moves.

- **`beeps hook`:** `prepare` renders four short, quiet sounds (done, success, failure, attention) from library archetypes into the beeps home folder, once, with Chromium; `settings` prints the `settings.json` fragment that runs `beeps hook event` on Stop, Notification and Bash results (the plugin ships no `hooks.json`, because a plugin hook runs for everyone who installs it); `enable` and `disable` write `hooks.json` in the beeps home folder, and `BEEPS_HOOKS=1` or `0` overrides it; `play <name>` and `status` do what they say.
- **Evidence, not hope:** `hook event` maps Stop to done and Notification to attention. A Bash result plays success only for an explicit exit status of 0 and failure only for an explicit non-zero one, and only for build, test and lint commands; a result with no exit status, or any other command, is silent with the reason in the JSON. It always exits 0, plays detached (no waiting) and skips a sound that follows another within 400 ms.
- **Players:** PowerShell's `SoundPlayer` on Windows, `afplay` on macOS, `paplay`, `aplay` or `play` on Linux; with none found it says so and does nothing.
## What changed in 0.29.0

Five archetypes the target use cases were missing. No change to any existing sound; no render key moves.

- **`notification`** (a soft two-note chime, rounder and longer than `confirm`), **`stinger`** (a hard hit with a bell tail), **`fanfare`** (four stepped sawtooth notes, the last held), **`riser`** (noise and a tone that climb together and cut off, 1.5 to 3 s) and **`transition`** (a swell of filtered air over a low body, 0.6 to 1.4 s). Each has its own family, a `recipe` sentence, and is in [`docs/reference.md`](docs/reference.md).
- Each was sampled across 40 seeds and rendered and linted in a test: all 40 pass every error-level craft rule, so `generate` keeps a full set. I looked at their contact sheets; the owner's listen is still the acceptance for how they sound.
- The engine graph golden file gains 60 hashes (546 to 606) for the new archetypes; no existing hash moved.
- Known: `generate` candidates carry `N_SCALE_SNAP` notices, because the sampler draws free frequencies that the project scale then moves (true of every pitched archetype, not only these).

## What changed in 0.28.0

Text readback, a spectrogram difference and a golden-kit gate. The spec had these as 0.28.0 and 0.29.0; they shipped together. No sound or music changes; no render, hash or cache key moves.

- **`beeps song roll <song>`:** a song as text for an agent that cannot view the look image, built from the notes the renderer will play. A step grid for rhythm parts and a piano roll for pitched ones (highest pitch first, one column per sixteenth, `o` starts a note, `#` holds it), 8 bars per call by default (`--section`, `--track`, `--bars 9-16`), with `next` naming the following window and `rowsOmitted` when a part has more than 18 pitches.
- **`beeps sample digest <id|file>`:** the text twin of `sample overview`: one row per time window (`--windows`, 24 by default) with rms and peak dB, centroid, a steady pitch and the events that start in it; `--start` and `--end` narrow it.
- **`beeps diff <a> <b>`:** a signed spectrogram difference between two patches (rendered at their kit seeds) or audio files. The JSON gives mean dB per octave band over the whole sound and per third of it, the feature deltas and hints; the image (`--out`, or under `.agent-beeps/renders/diffs`) is blue-white-red on a frequency by time grid, red where the second sound has more energy.
- **`beeps kit golden bless|check`:** a blessed render of each kit sound in `.agent-beeps/golden/` and a check that classifies today's render as `identical` (same samples), `equivalent` (different samples, every measure inside its tolerance) or `different` (with what moved, by how much, and the timbre distance in dB). Tolerances are in the file and can be overridden per sound. Exit 1 on `different`, on a sound with no blessing and on one that will not render.

## What changed in 0.27.0

Safer outputs, a generated reference, worked examples. No sound or music changes; no render, hash or cache key moves.

- **Path safety:** a command that writes a path it was given checks it first (`src/path-safety.ts`). An output that is, or sits around, an input, or that differs from an existing file only in case (one file on Windows and macOS), is `E_CONFLICT` before anything is written; the wrong extension is `E_USAGE`. Applied to `export` and `song export` (`--wav`), `look --out`, `sample overview --out`, `compress` (the output folder may not be, contain or sit inside the source), `song stems --out`, `family --out` and `runtime export --out`. `compress` now checks before it looks for ffmpeg.
- **Reference:** [`docs/reference.md`](docs/reference.md) is generated from the files: the archetypes with how each is built, the sound collections, the instruments and every craft rule. Every archetype file now carries a required `recipe` sentence (also in `beeps archetypes`); a drift test keeps the page current.
- **Worked examples:** `beeps-compose` opens with the four-step loop and links three complete runs (a UI chime, an impact that must stay short, a training-video bed) with the fields to read at each step; a test checks their commands and flags against the CLI.
- **Song notices:** `N_PARTIAL_ABOVE_NYQUIST` (an instrument partial at the highest written note would sound at or above 0.45 of the sample rate) and `N_CUTOFF_CAPPED` (a keytracked cutoff would pass the engine's 22 kHz cap) in `song check` and `song render`, computed from the document without changing the engine. These were the two items deferred in 0.25.0.

## What changed in 0.26.0

Strict schemas: the step after the warning. **Breaking for a file that carries a key the format does not know.** No sound or music changes; no render, hash or cache key moves.

- **Unknown keys are errors.** For four releases (0.22.0 to 0.25.0) a stray key in `project.json`, an instrument override (`{base, set}`) or a batch operation was stripped and reported as `N_UNKNOWN_KEY`. Now each is `E_SCHEMA`, with the `pointer` of the key and the key as `received`, and every command that reads the project stops on it. A misspelled `scale`, `snap` or `value` can no longer leave a default in silence. Fix: correct or remove the key; the error names it.
- **Song recipes:** `variants` or `seed` on a song recipe in the build config is `E_SCHEMA` (`/<id>/seed`), where it was hashed and never read. Remove it from the recipe; patch recipes are unchanged. A song recipe that carried a non-default `seed` rebuilds once without it, because the seed was part of its hash.
- **Code:** the `N_UNKNOWN_KEY` notice, the tolerant parse that backed it and the queue that carried project-file notices into a command's JSON are gone. `N_OPTION_IGNORED` stays for `init`.

## What changed in 0.25.0

Honest feedback, Phase 3: the small places a command told the caller less than it did. No sound or music changes; no render, hash or cache key moves.

- **Reasons for missing numbers:** a pitch that is `null` carries `pitchReason`; `generate` and `mutate` print the `seed` they used (the random one when none was given); a render with samples that are NaN or infinite fails with the count instead of writing silence or clicks; `taste` says whether it read the project or the global profile only.
- **Lists that left things out:** `album list` names albums it could not read (`unreadable`); `bundle` lists symbolic links and hidden directories holding sidecars that it did not search (`skipped`); `audition status` and `wait` count log lines that could not be read (`malformedEvents`) and say when the agent cursor was unreadable and restarted (`cursorReset`); `lint` notes project patch files that are not valid patches and so were left out of the sibling checks; `family` warns about CSV rows with fewer cells than the header; `audition formats` lists the presets it added (`addedPresets`, the hidden WAV reference).
- **Things that were accepted and did nothing:** `N_UNUSED_FIELD` for `hitBeats` and `note` on a pattern with no `steps` and for extra numbers on a note tuple (`song new`, `song check`, `song render`); `export` reports `replaced` and lists variant files an earlier export left beside the new one (`stale`); `--jobs 0` and `--worst 0` are usage errors instead of a quiet 1 or "all"; `instruments rebase` counts the cutoffs it held at the edge of the range (`clampedCutoffs`).
- **Runtime inputs:** a baked render of a patch with an `xRuntime` block says it used each input at its default (`N_RUNTIME_AT_DEFAULTS`, info).
- **Not changed, on purpose:** keytracked cutoffs capped inside the engine, and song partials above 0.45 of the sample rate, would need per-note engine instrumentation and are covered by `song-register` and the patch-level `nyquist` rule; a set candidate with a project patch's name still resolves to the project patch first (documented in the `loadPatch` hint); archetype sampling redraws are deterministic and fail loudly after ten.

## What changed in 0.24.0

Patch expectations, second step: write the numbers for an existing sound, and keep refinement inside the brief. No sound or music changes; no render, hash or cache key moves.

- **`lint --derive-expect`:** prints, per patch, `derived.xExpect`: a block the sound passes as it measures now, with room around each number (duration 25 % over, attack and tail 50 % over with a floor, centroid within a third of an octave, pitch within 50 cents, direction as measured). Edit it and save it into the patch to hold a sound still. The rules are in [`docs/expectations.md`](docs/expectations.md).
- **`mutate`:** checks every child against the `xExpect` block of the patch it was bred from and drops the ones that miss; the set's `report` counts them (`dropped` with reason `expectation` and the kinds missed, and `expectationMisses`). Children do not carry the block. A direction that contradicts it drops everything and fails with `E_RENDER` and a hint; `--ignore-expect` keeps the children.
- **Skill:** `beeps-compose` mentions both.

## What changed in 0.23.0

Patch expectations: a patch can say how the sound must measure, and the tools that already render it check the claim. No sound or music changes; no render, hash or cache key moves, and no library patch gains an expectation.

- **`xExpect`:** an optional block of strict checks on a patch (`duration`, `attack`, `energy-length`, `tail`, `centroid`, `flatness`, `crest`, `pitch`, `pitch-direction`, `true-peak`, `no-clipping`, `peak-limited`), each reading a feature `beeps measure` already prints, in fixed units. An unknown kind or field, `min` above `max`, or a pitch with no target is an `E_SCHEMA` error with a pointer. Kinds, fields and units: [`docs/expectations.md`](docs/expectations.md), generated from the check registry. Like `xRuntime`, it is not part of a render key and a runtime cue leaves it out, so editing an expectation never re-bakes a sound.
- **The verdict:** `beeps lint` and `beeps kit check` add an `expectations` object per patch that has a block: `passed`, and one check per entry with `outcome` (`pass`, `fail`, or `unmeasurable`, which fails because a contract that cannot be checked is not met), `expected`, `actual`, `unit`, the `pointer` of the entry and a `hint` on which parameters move the measurement. Every declared variant is checked and a failure names the first one that fails. A failed expectation exits 1; it is not a lint error or warning, because lint rules cite sources and an author's brief has none.
- **`build`:** a recipe whose patch fails its expectations is not shipped (`E_VERIFY`, with the verdict in `details`) when the build renders that asset.
- **`capabilities`** lists the kinds (`expectKinds`). **Skills:** `beeps-compose` has a short "Say what the sound must be" section, `patch-format.md` documents the field, and `beeps-craft` says how an expectation differs from a rule.
- **Fix:** `kit check` reported the wrong seed for a sound that came after one that failed to render (0.21.0); each result now carries its own.

## What changed in 0.22.0

Honest feedback, fourth step: unknown keys and the places a song loses something are reported. No sound or music changes; no render, hash or cache key moves.

- **Unknown keys:** the project, an instrument override (`{base, set}`) and a batch operation are strict schemas now. For this release a stray key is stripped and reported (`N_UNKNOWN_KEY`, with a pointer) so an existing file still loads; a misspelled `scale` or `value` no longer leaves a default in silence. From 0.25.0 it is an `E_SCHEMA` error. A project-file notice appears in the `notices` of whichever command read the project.
- **Songs:** `song new`, `song check` and `song render` report a pattern that runs past its section (`N_PATTERN_TRUNCATED`) and a master delay whose tail the render caps at 8 s (`N_DELAY_TAIL_CAPPED`, also for a patch delay in `render`, `export` and `lint`). `song stems` lists `omitted` tracks and marks a silent stem `silent: true` instead of a bare `null`; a silent adaptive state is `silent: true` with `null` levels instead of -99.
- **Build and albums:** `build` returns `warnings` (song-layer sums, channels that differ) and `notices` for `variants` and `seed` set on a song recipe, which were hashed and never used. `album open` ends its progress with the `failures` (index, name, error); `album list` counts `ready` and `failed`.
- **Skill:** the notice guide covers the new codes.

## What changed in 0.21.0

Honest feedback, third step: the state behind a result is reported. No sound or music changes; no render, hash or cache key moves.

- **Loudness trim:** a sound whose trim hit its limit (+24 / -36 dB for patches and songs, +-12 dB for an adaptive state) now says so: `N_TRIM_CLAMPED` in `render`, `measure`, `look`, `lint`, `export`, `kit check` and `song render`, `features.delivered.trimClamped` in the render's `meta.json`, and a warning from a song export with `--layers`. Before, `trimDb` quietly showed the limit.
- **Runtime inputs:** `runtime look` and `runtime live` check `--set` / `--input` / `--to` before rendering anything: a value that is not a number, or an input the patch does not declare, is a usage error. A value outside the declared range is clamped and says so (`N_INPUT_CLAMPED`); `params` echoes what was used.
- **Kit and seeds:** `render`, `measure`, `look`, `lint` and `kit check` now use the seed recorded in the kit for a kit sound, as `export` already did (an explicit `--seed` still wins), and report it; they used seed 1, so a checked sound could differ from the one that shipped. `kit add` on an existing entry keeps its audition seed, returns the entry it replaced as `replaced`, and warns (`N_KIT_REPLACED`) when its priority or trim changed.
- **Names:** a project patch or song with a library name hides the library one; `instruments` marks `shadowedBy`, `song list` marks `shadows`, and `song check` and `song render` warn when a song plays a shadowing patch (`N_NAME_SHADOWED`).
- **Skill:** the notice guide moved to `skills/beeps-compose/references/notices.md`, linked from `beeps-compose`.

## What changed in 0.20.0

Honest feedback, second step: candidate sets and the commands around them now say what they dropped or ignored. No sound or music
changes; no render, hash or cache key moves.

- **`generate` and `mutate`:** the result carries a `report` (`requested`, `kept`, `tried`, `dropped` with a reason each, `notSelected`; `mutate` adds `unchanged` and, with `--like`, `blendFallbacks`) and always `tried = kept + notSelected + dropped.length`. `N_SHORT_SET` says the set is smaller than asked for; `N_STEERING_CANCELLED` and `N_STEERING_UNUSED` say when prompt words steered nothing. A set with nothing in it is `E_RENDER` (with the first drops in `details`), not an empty result. `mutate --count` is checked (1 to 8), and a parent that does not render is an error instead of a quiet "no direction".
- **`batch`:** removing an array entry that is not an index in range is an error naming the operation (it used to remove the first entry); removing a key the patch does not have is listed under `noops`, not `changed`.
- **`init`:** on an existing project, `--scale` and `--target` change nothing and the result says so (`existing`, `ignored`, `N_OPTION_IGNORED`).
- **`look`:** with one ref, `--out` now writes the image there.
- **`compress`, `player selftest`:** a bitrate that is 0 or not a number, and a `--port` that is not an integer, are usage errors instead of quietly using the default.
- **Skill:** `beeps-compose` names the new codes in its "read the notices" block.

## What changed in 0.19.0

Honest feedback: the places where a command quietly did something other than what the caller asked now say so. No sound or
music changes; no render, hash or cache key moves.

- **Notices:** a structured `notices` array (`code`, `severity`, `message`, and `pointer`, `requested`, `applied`, `hint` where they apply), listed in [`docs/notices.md`](docs/notices.md) and `beeps capabilities`. `N_SCALE_SNAP` reports a pitch the project scale moved (in `render`, `measure`, `look`, `lint`, `export` and `kit check`); `N_VARIANTS_IDENTICAL` and `N_NO_VARIANTS` report variants that cannot differ. The `warnings` and `notes` arrays stay.
- **Errors:** every error carries a `category` (`input`, `environment`, `outcome`, `transient`, `bug`) and `retryable`; a patch that fails the schema echoes the rejected value as `received`. Usage errors from option parsing carry them too.
- **`crossover`:** `--t` must be a number from 0 to 1; a blend that is not a valid patch is `E_SCHEMA` instead of a renamed copy of the first parent; an existing name needs `--force` (`E_CONFLICT`); the result lists `parents` and `t`.
- **`kit check`:** a sound that fails to render stays in `sounds` as `ok: false` with its error, and the command exits 1. It used to vanish from the list and the kit rules.
- **Variants:** `measure --variant` and `export --variant` reject an index the patch does not declare (`E_USAGE`); before, they rendered the patch as written.
- **Skill:** `beeps-compose` opens with what to read in `notices` before describing a result.

## What changed in 0.18.1

Fixes and tooling from an internal architecture review; no new sound or music features.

- **Lint:** `reverb-preset-only` accepts every preset the schema does, including `space`.
- **Errors:** a malformed option value is `E_USAGE` (exit 2) instead of `E_RENDER`; a bug in beeps (`TypeError`, `ReferenceError`) is `E_INTERNAL`, with the stack behind `BEEPS_DEBUG=1`. Pointer, rebase and runtime-verification failures carry codes.
- **Discoverability:** `beeps capabilities` lists every runnable command (75, not 37), [`docs/cli.md`](docs/cli.md) is generated from the CLI, every command is mentioned in the README or a skill (tested), and the delivery references now live under the `beeps-ship` skill.
- **Engine:** an unknown source type throws instead of building silence.
- **Game player:** `player.dispose()` stops everything, aborts in-flight loads and clears timers; the loader's `fetcher` receives `{ signal }`.
- **Internals:** Chromium opens lazily (a fully cached `render` no longer starts a browser), one worker pool, one render-cache helper, one JSON-pointer module, shared pitch math and sample limits in the engine.
- **Repository:** tests run under one temp root that is removed afterwards, `docs/RELEASING.md` and `scripts/release-check.mjs` describe and check a release, and a ship eval case joins the evals.

## What changed in 0.18.0

The `song-written-pitch` lint now leads with the cure that keeps the sound: build the instrument at the register it plays, in the song's `instruments` block, with its filter cutoffs scaled to match. `beeps instruments rebase <name> --to F4` (or `--by -12`) prints that override. `fixed`, `root` and `transpose` stay, but the advice now says they change what you hear. Test-suite fixes: a media-position race in the booth browser tests and a justified timeout for the slowest render test.

## What changed in 0.17.0

`beeps sample overview <normalizedId|file>` shows the shape of a recording of up to 120 seconds before
you crop it: an image (waveform, loudness arc, spectrogram, numbered segments) and a list of natural
segments, each at most ten seconds, with peak, loudness, event count and rate, clipping and cut flags
and a ready `sample prepare` line. `--start`/`--end` zoom into a stretch; `--no-image` skips the
browser. It proposes; the owner's ear chooses. [Long recordings](skills/beeps-compose/references/hybrid-sources.md).

## What changed in 0.16.0

Recorded sources can now supply the contact detail in a procedural SFX patch. `beeps sample import`
retains the original and a canonical 48 kHz snapshot; `sample prepare` crops, fades and applies gain
with a replayable frame recipe. Prepare a named patch, add/edit procedural layers, save and
render/lint/look, then `sample bundle` the **final edited patch**. `sample sync` restores it elsewhere.
Bundles default to prepared dependencies only. Explicit `--include-preparation` adds normalized
source snapshots and replay recipes (possibly including outtakes), never original encoded imports,
import receipts or private local paths. [Hybrid workflow and limits](skills/beeps-compose/references/hybrid-sources.md).

The limit is eight layers per patch; a prepared source is 1–480000 frames at 48 kHz, mono/stereo
(up to ten seconds). Imports are at most 64 MiB and normalized snapshots at most 120 seconds.
Samples are finite, unpitched one-shots: sample pitch envelopes/pitch LFOs, loops, stretching and
song sample instruments are unsupported. Gain/cutoff LFOs remain available. Attenuation and an output
true-peak ceiling cannot restore an already clipped recording's transient.

Engine 4 adds verified dependency loading to live cues: resume the context in a user gesture, await
`loadCueAssets`, then build a fresh voice per play. Build/store/standalone Node 20 fetch carry each
cue's prepared source closure; baked delivery uses the existing player contract. Rebuild locks/cues
on upgrade. Legacy procedural PCM and golden graphs are unchanged; render keys and cue metadata
change. [Runtime API](docs/runtime.md) · [Delivery](docs/build-lock-and-store.md).

[Hear Fuse](https://ehartye.github.io/agent-beeps/#fuse): three rows and nine takes in the existing
booth, comparing a recording, procedural body and hybrid at measured max-momentary loudness.
[Metal](library/examples/fuse/README.md), [Tommy five bursts](library/examples/fuse-tommy/README.md)
and [M16 one sustained burst](library/examples/fuse-m16/README.md) include portable sources and recipes.
Measurements do not imply owner listening approval.

## What changed in 0.15.0

FM operators now have optional normalized breakpoint envelopes for their modulation index:
linear ramps, steps and exponential decays, independent of the audible amp envelope. The reusable
browser scheduler is the foundation; FM depth is its first application. [Authoring reference](skills/beeps-compose/references/patch-format.md#fm-index-envelopes).

[Hear Flux](https://ehartye.github.io/agent-beeps/#flux): three pairs synthesized live in the existing
booth, with measured max-momentary loudness matching. Download the static and shaped recipes.

Engine 3 prevents an older runtime from silently accepting an enveloped cue. Rebuild audio
locks/cues on upgrade; legacy patch PCM and golden graphs are unchanged. Recorded/hybrid asset
preparation, source resolution and delivery are a separate workflow.

## What changed in 0.14.0

Notes can carry their own pitch and brightness curves. Tracks can map performed velocity to an
instrument's `xRuntime` input, shaping tone, FM index or envelopes as well as loudness. Existing
note tuples still work. [Author expressive notes](skills/beeps-music/references/song-format.md#expressive-notes),
or hear [Touch: eight bars, two performances](https://ehartye.github.io/agent-beeps/#touch).

Song pipeline 7 invalidates cached song renders; rebuild song locks with the new toolchain.
The sound-effect engine version remains 2. MIDI/MPE import and live controller input are future work.

## What changed in 0.13.1

Documentation only (#54): no code, schema, engine or pipeline change, so no render key or lock hash moves.

- `craft/GUIDE.md` section 11 and `skills/beeps-music/references/guitar-and-metal.md`: process notes from building a guitar-driven
  metal score, labeled as notes (no new lint rule). The guitar amp chain (`drive` is `tanh(kx)`, so the input spectrum and the
  filter after it decide the tone, and a power chord is one additive layer), double-tracking, riff notation, the bass floor when
  moving a key, and the render, look and stems loop with the traps it found.
- Craft notes from listening, recorded as heard: a metal draft read as a JRPG overworld because of the writing (relative-major
  chords, an arpeggiated lead), not the pitch or timing; a wailing siren reads as police; a lead over a scored chorus reads as a
  keytar, so some moods want no melody at all; and five variants of one song are not five songs.

## What changed in 0.13.0

Two read-only commands for matching a recording you were given (#52). Additive: `ENGINE_VERSION` stays 2 and
`SONG_PIPELINE_VERSION` stays 6, so no render key and no lock hash changes.

- `beeps analyze <audio...>` measures any audio file, with no project. WAV (16-bit or float) is read directly; MP3, Ogg,
  FLAC and 24-bit WAV go through ffmpeg (`ffmpeg-static`, `BEEPS_FFMPEG` or the PATH) and are resampled to 48 kHz, with
  `sourceSampleRate` saying what the file was. It reports the `measure` features plus the active span, repeated events
  (onsets, per-event level, rate, interval regularity, the level in the gaps between events, repeat strength), the mean
  event per band (peak time, time to fall 10 and 20 dB) and the octave-band spectrum. Rate, interval and gap-level fields
  are `null` when nothing repeats (repeat strength under 0.12) or when the signal above 800 Hz is under -50 dBFS, so an
  engine or drone reports no rate.
- `beeps compare <reference> <candidate>` gives signed deltas (candidate minus reference) and plain-language hints: gap
  level, rate, timing regularity, crest, band share, per-band decay, clipping. Export a patch or song first, then compare
  the WAV. The thresholds come from gunfire clips and synthetic trains; treat the hints as indicators.
- `readWav` accepts `WAVE_FORMAT_EXTENSIBLE`, the header ffmpeg writes for float output.
- Skill guide: `skills/beeps-compose/references/matching-a-reference.md` (what an analysis holds, which patch lever answers
  which number, and how to build a burst of repeating events as a song).

## What changed in 0.10.0

Songs now render reproducibly (#45). Before, one song with one input hash could render several ways (one example song:
five distinct mixes in eight renders, differing by up to 0.08 of full scale). Chromium's garbage collector
ran mid-render, since songs are built while the context is suspended, and disposed nodes the render still needed (a modal
drum's resonators, a delay's feedback loop), while bus filters lost their state when the channel count flipped.
Offline renders now keep their nodes alive and pin each bus's channel count.

- `SONG_PIPELINE_VERSION` is 6 (`ENGINE_VERSION` stays 2). Song render keys change; sound effects keep their render keys,
  and a song-pipeline bump no longer changes a sound effect's lock hash after this one release re-keys them.
  `beeps build` stops with `E_TOOLCHAIN` until you pass `--allow-toolchain-change` or `--adopt`.
- Hash impact, measured on 28 songs from a game project: all 28 now render identically over four renders, two of them with a
  collection forced every 50 ms. The old engine gave 3 to 8 variants per song in eight renders on a loaded machine; the new
  render equals the old most frequent one for 23 of 28 songs and some old variant for 27 of 28. A locked song may therefore
  hold a variant other than the canonical one.
- Migration: `beeps build --adopt` re-keys the lock to the new toolchain with no rendering, keeping the locked files. To
  move songs to the canonical render: `beeps build --only <song ids> --all --allow-toolchain-change --verify-determinism`,
  commit the lock, `--push`. Files change only for songs that held another variant.
- `--verify-determinism` on `build`, `song render` and `song export` renders each song twice and fails with
  `E_NONDETERMINISTIC` when the two differ. Reproducible means bit-identical on one machine and Chromium build; see
  `docs/build-lock-and-store.md`.
- `loopcheck --engines` reports the lead as `n/a` when no source WAV is beside the file; `BEEPS_FFMPEG` errors say it must
  be the path of the executable.

## What changed in 0.9.0

Additive tools from a game project's friction ledger and the delivery backlog (#31 to #43). No engine or pipeline
constant changed (`ENGINE_VERSION` 2, `PIPELINE_VERSION`, `SONG_PIPELINE_VERSION` and `EXPORT_PIPELINE_VERSION`
unchanged), and every new field is optional, so existing patches and songs keep their render keys and bytes.

- Songs: track `fixed` and `transpose`, and a `song-written-pitch` lint (#32).
- Patches: opt-in `stereo` for `noise` and `grains` (#31); a `voice` source and eight `creature*` archetypes (#35);
  a layer `highpass` and a precise `no-dc` fix (#38); project `familyOffsets` and `meta.loudnessOffsetDb` (#40).
- Authoring: `beeps family`, N validated patches from a template and a param table (#34).
- Player (player 4): `memoryBudgetBytes` with LRU eviction, `unload`, `prefetch`, `layerLoading: 'state'`, `memory()` (#37).
- Delivery: `loopcheck --engines` (#33), seam metrics (#36), `player selftest` and encode-rate checks (#41),
  `audition formats` for a blind A/B of delivery formats (#39), `song export --trim-tail` and crest-aware `song stems` (#43),
  and the web delivery guide in the beeps-music skill (#42).

## What changed in 0.8.0

Renders are now bit-exact for a seed (#29). Before, any sound where three or more signals meet in one node
(three or more layers; `metal`, unison, `additive`, `modal` or multi-modulator `fm` sources; reverb plus delay;
every song) could come out 1 LSB different in a few samples from one render to the next, because Chromium sums
the connections into a node in an order that changes between runs. The engine now sums each of those points
through a fixed chain of two-input gains, and song notes through a pool of voice slots.

- `ENGINE_VERSION` is 2, so every render key changes: render caches re-render once, export sidecars and
  manifests carry new `renderKey`s, and `beeps build` stops with `E_TOOLCHAIN` until you pass
  `--allow-toolchain-change` (or `--pull` assets someone already built).
- Existing patches can differ from their 0.7.0 renders by rounding only: 1 LSB in a handful of samples, loudness
  and true peak unchanged to 0.001 dB. Re-exporting is optional; committing the new files once makes later
  re-exports reproduce them byte for byte on the same Chromium build.

## What changed in 0.7.0

Fixes for friction found building a game's audio (#24 to #27). Defaults are unchanged: existing patches render
exactly as before, and engine, pipeline and export versions are not bumped, so render caches and `beeps build`
locks stay valid.

- `beeps sync <dir>` mirrors a folder of committed patch files into the project (adds, replaces changed,
  validates all first, `--dry-run`). `new` is unchanged.
- `variation-on-repeating` counts hand-made sibling patches (`<stem>-<n>` names in one family, or a shared new
  optional `meta.variantOf`), found in the project or on the command line.
- `package.json` approves `ffmpeg-static@5.3.0`'s install script (`allowScripts`), so npm 11 no longer warns.
- `no-dc` names the fixes that work and the likely layers (new pointer `/layers/<i>`); new opt-in
  `fx.dcBlock: true` adds a 10 Hz DC blocker on the layer mix.
- `render`, `look` and `export` summaries carry `features.peakLimited`.
- `lint` output gains an optional top-level `notes` array (informational; never changes the exit code):
  `kit-rules` when a patch is in the kit or has family members (kit-level rules run only in `kit check`), and
  `effect-tail` when reverb or delay leaves 0.2 s or more of near-silence.
- `tail-ceiling` and `no-dc` messages are longer (rule ids and severities unchanged).
- `export --channels 1` (mono; identical channels keep their samples) and `export --trim-tail <dBFS>`
  (cuts a near-silent end); both off by default.
- Docs: calling beeps from a script on Windows, lint exit codes, the export seed rule.

## Install

Install **Git** and **Node.js 24 or newer with npm** first. Use a Codex CLI with
`codex plugin add` support, or a Claude Code version with plugin support. Choose one source per
client to avoid duplicate skill listings. Both sources install the same agent-beeps plugin.

### With hartye-plugins

The [Hartye marketplace](https://github.com/ehartye/hartye-claude-plugins) includes agent-beeps
alongside the other Hartye tools. Adding the catalog does not install all its plugins.

**Codex** — run in your terminal:

```sh
codex plugin marketplace add ehartye/hartye-claude-plugins
codex plugin add agent-beeps@hartye-plugins
```

Start a new Codex session in your game or app project, then ask:

```text
$agent-beeps:beeps-setup
```

**Claude Code** — run inside a Claude Code session:

```text
/plugin marketplace add ehartye/hartye-claude-plugins
/plugin install agent-beeps@hartye-plugins
/reload-plugins
/agent-beeps:beeps-setup
```

- **Time** — First setup takes a few minutes to install dependencies and Chromium.
- **Risk** — A stale marketplace catalog can delay access to a new release.
- **Complexity** — One shared catalog manages your Hartye plugins.
- **Best practice** — Install and update through the client's plugin manager.
- **Maintainability** — Refresh the shared catalog, update agent-beeps, then rerun setup.

### Without hartye-plugins

This repository contains its own single-plugin marketplace, named `agent-beeps`.
Register it directly to install agent-beeps independently of the Hartye collection.

**Codex** — run in your terminal:

```sh
codex plugin marketplace add ehartye/agent-beeps
codex plugin add agent-beeps@agent-beeps
```

Start a new Codex session in your game or app project, then ask:

```text
$agent-beeps:beeps-setup
```

**Claude Code** — run inside a Claude Code session:

```text
/plugin marketplace add ehartye/agent-beeps
/plugin install agent-beeps@agent-beeps
/reload-plugins
/agent-beeps:beeps-setup
```

- **Time** — First setup takes the same few minutes; it installs the same runtime.
- **Risk** — Installs and catalog refreshes depend on this repository being reachable.
- **Complexity** — A dedicated catalog contains just agent-beeps.
- **Best practice** — Use the client's plugin manager with the repository's bundled catalog.
- **Maintainability** — Refresh the `agent-beeps` catalog, update the plugin, then rerun setup.

### Setup and first use

Setup installs the runtime and Chromium into `~/.agent-beeps/releases/<version-hash-platform>`
(`AGENT_BEEPS_HOME` moves it) and every skill runs that release through
`scripts/run-managed.js`. Rerun `beeps-setup` after each plugin update. No separate `npm install`
inside the plugin cache is needed.

In your game or app project, ask the agent to compose a sound or a piece of music. For example:

> Use beeps-compose to make a small set of soft UI clicks and open an audition so I can choose.

The agent creates the project's `.agent-beeps/` directory with `beeps init` and runs the managed
CLI. Available skills: `beeps-setup`, `beeps-compose`, `beeps-craft`, `beeps-audition`, `beeps-taste`,
`beeps-music`, `beeps-ship`.

For local Claude Code development, load a checkout for one session with
`claude --plugin-dir /absolute/path/to/agent-beeps`, then run `/agent-beeps:beeps-setup`.
Keep the whole checkout together: the skills resolve scripts and references relative to its root.

Installation syntax was checked with Codex CLI 0.163.0 and Claude Code 2.1.303. Host references:
[OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins),
[Claude Code plugin installation](https://code.claude.com/docs/en/discover-plugins), and
[Claude Code local plugin development](https://code.claude.com/docs/en/plugins).

## Requirements

Node.js 24 or newer with npm. Chromium is downloaded by setup; `node scripts/setup.js --browsers firefox,webkit` also installs those engines for `beeps loopcheck --engines`. The audition server listens on port
47301 on all interfaces. Links use the machine's hostname and its LAN addresses (physical LAN first,
then Tailscale; WSL/Hyper-V adapters are skipped). Other machines need the firewall to allow Node
inbound.

## Development

```text
npm install
npm test          # vitest; browser tests run when Playwright's Chromium is installed
npm run typecheck
node scripts/beeps.mjs capabilities
node scripts/gen-cli-docs.mjs --write        # docs/cli.md, after adding or renaming a command
claude plugin eval . --runs 2 --no-publish   # paired with/without-skill evals in evals/
```

Specs and plans are in `docs/superpowers/`; the build lock and store are in `docs/build-lock-and-store.md`. Cutting a release: `docs/RELEASING.md` (and `node scripts/release-check.mjs`).

## Runtime path

A patch ships baked (a file the game plays) or as a **cue** the game plays live in its own AudioContext, with named inputs
(speed, size, distance) bound to patch parameters through the optional `xRuntime` block of `beeps/patch@1`, a seed, a shared
reverb bus, and live `set()` while it sounds. Recipes in `beeps.build.json` choose `delivery: baked | runtime | both`; the lock
pins the cue; `beeps verify --parity` proves the cue plays as its bake (bit-exact in Chromium, within 1 LU and 30 Hz of centroid
across browsers). The game installs only the engine, as the generated slim package `agent-beeps-runtime`.

```js
import { build, parseCue, loadCueAssets } from 'agent-beeps-runtime';
const cue = parseCue(cueJson);
// Inside each play button's user-gesture handler:
await ctx.resume();
const samples = await loadCueAssets(ctx, cue, { baseURL: cueURL, signal });
const voice = build(ctx, ctx.destination, cue, { samples }).start(); // fresh on every play
```

Stop/replacement must abort pending loads and guard late completions; cache verified buffers, never
an already-started voice. The complete cancellable handler is in [`docs/runtime.md#playing-it`](docs/runtime.md#playing-it).
`build` remains synchronous with no I/O. `beeps runtime export | check | verify | parity | perf | live | look` author and measure it. When to pick which delivery, the
API, the input format, the measured costs and the compatibility notes: [`docs/runtime.md`](docs/runtime.md). The package and its
`runtime` branch: [`docs/runtime-package.md`](docs/runtime-package.md).
