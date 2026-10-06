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
| `archetypes`, `generate` | 18 SFX archetypes; diverse lint-clean candidate sets |
| `new`, `batch`, `list` | save patches; atomic create/set/remove/delete with `--dry-run` |
| `render`, `measure`, `look`, `lint`, `export` | render + trim, full features, look images and contact sheets, craft rules, WAV |
| `set create` | render patches you already authored into a candidate set (audition a hand-made kit with `--flow explore`) |
| `mutate`, `crossover` | direction-steered variations; blend two patches |
| `kit list/add/remove/check` | the project's shipped sounds and kit-level rules |
| `predict`, `audition open/wait/round/status/list/close/stats` | the owner's listening loop |
| `serve` | the LAN audition server (idempotent; `--stop`) |
| `taste show/fit/stats` | the learned taste profile and prediction hit rates |
| `instruments` | bundled instrument patches songs can name |
| `song new/list/check/render/lint/export` | compose, outline, render (parallel), lint and export music |
| `album open/feedback/list` | progressive LAN song playback: love/keep/dud, tags, whole-track and timestamped moment notes |
| `bundle <dir>` | collect export sidecars under a directory into `index.json`, the game player's catalog |
| `compress <dir> <outDir>` | re-encode an exported bundle as Ogg Opus (about 30x smaller), verify frame counts, alignment and loop wraps, write `<outDir>/index.json`; needs ffmpeg (`ffmpeg-static` optional dependency, `BEEPS_FFMPEG`, or the PATH) |
| `loopcheck <files...>` | decode encoded audio and report frame count against its sidecar and the loop wrap (tick size, level step) |
| `song states <song>` | adaptive songs: judge every state as its own piece (loudness, trim, range, seam, register overlaps among its tracks, lint) |
| `song compat <songs...>` | plan crossfades between songs without rendering: tempo relation, phase-lock, estimated key, harmony agreement per pair |
| `player export <dir>` | vendor the browser game player (voice budget, priorities, crossfades, adaptive layers, safety clipper) into `<dir>/beeps-player/` |

Every command prints JSON; failures print `{"error":{code,message,pointer?,hint?}}` to stderr and
exit non-zero.

For game integration, add `--manifest` to `beeps export <patch> --wav audio/cue.wav` or
`beeps song export <song> --wav audio/theme.wav`. It writes an adjacent `<wav>.json` with the
asset's label, description, relative WAV filename, loop flag, exact duration, sample rate,
channels, render identity and measured delivered loudness/true peak. Roles default to `sfx`
for patches and `music` for songs; `--role ambience` overrides the role and requires `--manifest`.
Only songs authored with `loop: true` are labeled as loops. The sidecar marks
`normalizationAlreadyApplied: true`: play the WAV at its delivered level, without reapplying
the render's trim. Loudness names its metric (`momentary-max` for patches, `integrated` for songs).
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
after failed loads (e.g. on a sound toggle). Full API and error codes:
`skills/beeps-compose/references/game-player.md`.

## Sound engine

Seven source types (`osc` with unison, `noise`, `fm` operators, `additive` partials, `modal`
resonators, Poisson `grains`, the 808 `metal` voice), per-layer pitch/amp/filter envelopes, LFO,
drive and pan, a generated-impulse reverb and a delay, and a transparent safety clipper. Pitched
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

## Install / Claude Code plugin

```text
/plugin install agent-beeps@hartye-plugins
/agent-beeps:beeps-setup
```

Setup installs the runtime and Chromium into `~/.agent-beeps/releases/<version-hash-platform>`
(`AGENT_BEEPS_HOME` moves it) and every skill runs that release through
`scripts/run-managed.js`. Rerun setup after each plugin update.

Skills: `beeps-setup`, `beeps-compose`, `beeps-craft`, `beeps-audition`, `beeps-taste`, `beeps-music`.

## Requirements

Node.js 24 or newer with npm. Chromium is downloaded by setup. The audition server listens on port
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

Specs and plans are in `docs/superpowers/`.
