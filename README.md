# agent-beeps

A procedural sound composer for coding agents. Agents build game and UI sounds as Web Audio
patches (JSON), render them in real Chromium, measure what came out (loudness, true peak, attack,
length, brightness, sharpness, roughness, pitch), check them against cited craft rules, and put a
diverse set in front of the owner on a listening page served to the local network. The owner keeps,
duels and refines by ear; every explicit choice trains a taste model that ranks and predicts the next
set, and every audition scores how well the agent predicted the pick.

No sample files, no AI audio: every sound is a small, editable patch that games can also play live
through the same engine, with seeded variations so repeated sounds do not fatigue.

Agents also compose **music**: a `beeps/song@1` document plays those same patches as instruments
through chord progressions (voice-led from chord symbols), arps, bass lines, step drums (including
Euclidean rhythms such as `x(3,8)`), melodies, sections and mix moves, from loops to one-shot jingles.
Songs render to loopable, loudness-matched WAVs, are linted against cited
music craft rules, and go to the owner on a LAN album page. `library/songs/sci-fi-exploration/`
holds a 13-track example library; `library/instruments/` holds 25 instrument patches.

[`library/sounds/sci-fi/`](library/sounds/sci-fi/) contains 18 approved effects across Expedition,
Arcade and Oddities, with purpose labels, playback seeds and measured kit levels.

## Workflow

1. **Compose**: `beeps generate coin --count 6 --prompt "coin pickup for a cozy platformer"`
   oversamples an archetype, renders and measures each candidate, drops lint failures, and keeps a
   diverse set (ranked by the owner's taste once it has data). The agent looks at the contact sheet.
2. **Predict**: `beeps predict --set <id> --pick 3 --shortlist 3,5 --why "..."` seals the agent's
   guess before the owner hears anything.
3. **Audition**: `beeps audition open --set <id>` prints a link like
   `http://hal9000:47301/s/<id>?t=<token>`. The owner works through
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

| Command | Does |
|---|---|
| `capabilities` | schema, source types, archetypes, directions, error codes |
| `init` | create `.agent-beeps/` (scale, loudness target) |
| `archetypes`, `generate` | 26 archetypes (18 SFX, 8 creature voices); diverse lint-clean candidate sets |
| `family` | one template patch + a table (JSON/CSV/`--row`) -> N validated patches: `{{param}}` placeholders, `/pointer` columns, seeded `a..b` ranges and `--jitter`, `--lint`, `--set`, `--out`, `--dry-run` |
| `new`, `sync`, `batch`, `list` | save patches; mirror a directory of committed patch files into the project (`sync <dir>`, validates all first); atomic create/set/remove/delete with `--dry-run` |
| `render`, `measure`, `look`, `lint`, `export` | render + trim, full features, look images and contact sheets, craft rules, WAV |
| `set create` | render patches you already authored into a candidate set (audition a hand-made kit with `--flow explore`) |
| `mutate`, `crossover` | direction-steered variations; blend two patches |
| `kit list/add/remove/check` | the project's shipped sounds and kit-level rules |
| `predict`, `audition open/wait/round/status/list/close/stats` | the owner's listening loop |
| `audition formats <bundle\|wav...>`, `audition formats-status` | blind-audition delivery formats: encodes the sounds through the compress presets (MP3 CBR/VBR, Ogg Opus) beside a hidden lossless reference and a low-pass anchor, serves a lettered rating page with a device decode check, writes `results.json`, and projects catalog bytes per preset ([guide](docs/delivery-format-audition.md)) |
| `serve` | the LAN audition server (idempotent; `--stop`) |
| `taste show/fit/stats/import` | the learned taste profile and prediction hit rates; `import` logs a game page's thumbs, or a delivery-format audition's `results.json` as delivery preferences (kept apart from the sound model) |
| `instruments` | bundled instrument patches songs can name |
| `song new/list/check/render/lint/export` | compose, outline, render (parallel), lint and export music |
| `album open/feedback/list` | progressive LAN song playback: love/keep/dud, tags, whole-track and timestamped moment notes |
| `bundle <dir>` | collect export sidecars under a directory into `index.json`, the game player's catalog |
| `compress <dir> <outDir>` | re-encode an exported bundle as Ogg Opus (about 30x smaller) or, with `--format mp3`, as gapless MP3 for browsers without Ogg Opus, verify frame counts, alignment and loop wraps, write `<outDir>/index.json`; needs ffmpeg (`ffmpeg-static` optional dependency, `BEEPS_FFMPEG` set to the ffmpeg executable's path, or the PATH) |
| `loopcheck <files...>` | decode encoded audio and report frame count against its sidecar and the loop wrap (tick size, level step, and seam metrics: boundary step and slope jump in dB against a typical sample step, last zero-crossing phase, with a warning when the delivered seam is 3 dB worse than the source's); `--engines chromium,firefox,webkit` also decodes each file with `decodeAudioData` in those browsers at 48000 and 44100 Hz and reports frame delta and start lead against the source (the lead needs the source WAV beside the file or `--source`; without one it reads `n/a`, not a number) (non-zero exit on a delta; an engine that is not installed or has no Web Audio is reported, never passed) |
| `song states <song>` | adaptive songs: judge every state as its own piece (loudness, trim, range, seam, register overlaps among its tracks, lint) |
| `song compat <songs...>` | plan crossfades between songs without rendering: tempo relation, phase-lock, estimated key, harmony agreement per pair |
| `build` | incremental audio build from `beeps.build.json`: render, export, compress and bundle only assets whose input hash differs from the committed `audio.lock.json` (or whose outputs are missing or modified); `--check` renders nothing and exits 1 listing what is stale; `--only`, `--all`, `--target web-universal` (default), `web-mp3` or `wav-master`, `--pull` / `--push` with `--store dir:<path>` or `release:<owner/repo>`, `--adopt` (also re-keys a lock of an older toolchain without rendering), `--allow-toolchain-change`, `--verify-determinism` (render each song twice and fail the asset if the renders differ) ([docs](docs/build-lock-and-store.md)) |
| `verify [dir or lock]` | outputs against the lock (sha256), the catalog, and Opus/MP3 container headers (length, tag, encoder id); `--decode` adds the loop checks |
| `store push/pull/status` | the content-addressed audio store (one tar per asset, named by input hash, immutable): a `dir:` directory or GitHub `release:` assets |
| `ci export <dir>` | vendor a zero-dependency `fetch.mjs`: `node fetch.mjs` materialises the audio from the store by hash and verifies it against the lock, no beeps, Chromium or ffmpeg |
| `player export <dir>` | vendor the browser game player (voice budget, priorities, crossfades, adaptive layers, safety clipper) into `<dir>/beeps-player/` |
| `player selftest [dir]` | write `<dir>/beeps-selftest/`: a static page that decodes a known 2 s loop (WAV control, Ogg Opus, MP3) through the vendored player's loader in a realtime and in 48000 and 44100 Hz offline contexts and prints frame delta and lead, with a copyable result; `--serve` serves it on the LAN to open on a real iPhone or Safari |

Every command prints JSON; failures print `{"error":{code,message,pointer?,hint?}}` to stderr and
exit non-zero.

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
`skills/beeps-compose/references/game-player.md`.

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
  from the JSON; `notes` lines are informational. Usage errors exit 2, other failures 1, with
  `{"error":{code,...}}` on stderr.
- **Seeds**: `export` uses `--seed`, else the seed an audition ship recorded in the kit, else 1. `kit add`
  records no seed, so pass `--seed` explicitly when the build must not depend on audition history.
  Renders are bit-exact for a seed (since 0.8.0, on one Chromium build): exporting an unchanged patch
  twice gives the same samples, so a diff of committed WAVs means an input or the toolchain changed.

## Sound engine

Seven source types (`osc` with unison, `noise`, `fm` operators, `additive` partials, `modal`
resonators, Poisson `grains`, the 808 `metal` voice), per-layer pitch/amp/filter envelopes, LFO,
drive and pan, a generated-impulse reverb and a delay, an opt-in DC blocker (`fx.dcBlock`), and a
transparent safety clipper. Pitched
sources snap to the project scale. The engine is plain browser JavaScript
(`runtime/engine/patch.js`): games can import it and call
`buildPatch(audioContext, patch, { trimDb, variant, seed })`.

Songs use `runtime/engine/song.js`: `buildSong(ctx, song, instruments, { lazy: true })` returns
`advance(t)`, which builds only the notes that start before `t`. Call it a couple of seconds ahead
of the playhead. Offline renders do this with `OfflineAudioContext.suspend()`, and it keeps a
multi-minute song's graph small. Songs are trimmed to `project.musicLoudness` (integrated, −20 LUFS
by default).

`beeps song render aurora-station --sections return` extracts that passage from the full delivered
WAV, preserving inherited mix settings, effects and level. The first request renders the whole
song; later excerpts reuse its cache. `--only pad --sections return` previews the full-length solo's
passage, labeled as a solo. Use `song stems` for parts at the full mix's trim.

## What changed in 0.10.0

Songs now render reproducibly (#45). Before, one song with one input hash could render several ways (Fallow Valley's
`mus-desert`: five distinct mixes in eight renders, differing by up to 0.08 of full scale). Chromium's garbage collector
ran mid-render, since songs are built while the context is suspended, and disposed nodes the render still needed (a modal
drum's resonators, a delay's feedback loop), while bus filters lost their state when the channel count flipped.
Offline renders now keep their nodes alive and pin each bus's channel count.

- `SONG_PIPELINE_VERSION` is 6 (`ENGINE_VERSION` stays 2). Song render keys change; sound effects keep their render keys,
  and a song-pipeline bump no longer changes a sound effect's lock hash after this one release re-keys them.
  `beeps build` stops with `E_TOOLCHAIN` until you pass `--allow-toolchain-change` or `--adopt`.
- Hash impact, measured on 28 Fallow Valley songs: all 28 now render identically over four renders, two of them with a
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

Additive tools from the Fallow Valley friction ledger and the delivery backlog (#31 to #43). No engine or pipeline
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

## Install / Claude Code plugin

```text
/plugin install agent-beeps@hartye-plugins
/agent-beeps:beeps-setup
```

Setup installs the runtime and Chromium into `~/.agent-beeps/releases/<version-hash-platform>`
(`AGENT_BEEPS_HOME` moves it) and every skill runs that release through
`scripts/run-managed.js`. Rerun setup after each plugin update.

Skills: `beeps-setup`, `beeps-compose`, `beeps-craft`, `beeps-audition`, `beeps-taste`, `beeps-music`, `beeps-ship`.

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
claude plugin eval . --runs 2 --no-publish   # paired with/without-skill evals in evals/
```

Specs and plans are in `docs/superpowers/`; the build lock and store are in `docs/build-lock-and-store.md`.
