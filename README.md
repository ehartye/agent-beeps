# agent-beeps

A procedural sound composer for coding agents. Agents build game and UI sounds as Web Audio
patches (JSON), render them in real Chromium, measure what came out (loudness, true peak, attack,
length, brightness, sharpness, roughness, pitch), check them against cited craft rules, and put a
diverse set in front of the owner on a listening page served to the local network. The owner keeps,
duels and refines by ear; every explicit choice trains a taste model that ranks and predicts the next
set, and every audition scores how well the agent predicted the pick.

No sample files, no AI audio: every sound is a small, editable patch that games can also play live
through the same engine, with seeded variations so repeated sounds do not fatigue.

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
| `archetypes`, `generate` | 16 SFX archetypes; diverse lint-clean candidate sets |
| `new`, `batch`, `list` | save patches; atomic create/set/remove/delete with `--dry-run` |
| `render`, `measure`, `look`, `lint`, `export` | render + trim, full features, look images and contact sheets, craft rules, WAV |
| `mutate`, `crossover` | direction-steered variations; blend two patches |
| `kit list/add/remove/check` | the project's shipped sounds and kit-level rules |
| `predict`, `audition open/wait/round/status/list/close/stats` | the owner's listening loop |
| `serve` | the LAN audition server (idempotent; `--stop`) |
| `taste show/fit/stats` | the learned taste profile and prediction hit rates |

Every command prints JSON; failures print `{"error":{code,message,pointer?,hint?}}` to stderr and
exit non-zero.

## Sound engine

Seven source types (`osc` with unison, `noise`, `fm` operators, `additive` partials, `modal`
resonators, Poisson `grains`, the 808 `metal` voice), per-layer pitch/amp/filter envelopes, LFO,
drive and pan, a generated-impulse reverb and a delay, and a transparent safety clipper. Pitched
sources snap to the project scale. The engine is plain browser JavaScript
(`runtime/engine/patch.js`): games can import it and call
`buildPatch(audioContext, patch, { trimDb, variant, seed })`.

## Install / Claude Code plugin

```text
/plugin install agent-beeps@hartye-plugins
/agent-beeps:beeps-setup
```

Setup installs the runtime and Chromium into `~/.agent-beeps/releases/<version-hash-platform>`
(`AGENT_BEEPS_HOME` moves it) and every skill runs that release through
`scripts/run-managed.js`. Rerun setup after each plugin update.

Skills: `beeps-setup`, `beeps-compose`, `beeps-craft`, `beeps-audition`, `beeps-taste`.

## Requirements

Node.js 24 or newer with npm. Chromium is downloaded by setup. The audition server listens on port
47301 on all interfaces; other machines need the firewall to allow Node inbound.

## Development

```text
npm install
npm test          # vitest; browser tests run when Playwright's Chromium is installed
npm run typecheck
node scripts/beeps.mjs capabilities
```

Specs and plans are in `docs/superpowers/`.
