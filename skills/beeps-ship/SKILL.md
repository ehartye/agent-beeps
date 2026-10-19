---
name: beeps-ship
description: Ship an app's beeps audio - incremental builds with a committed lock, a content-addressed store, a CI that fetches instead of rendering, and the web codec traps (MP3 bitexact delay, WebKit padding, Opus determinism, YAML step names).
when_to_use: Use when wiring an app's audio into a build or CI, when a CI audio job is slow or re-renders everything, when asked to reduce audio churn or repo size, when choosing a delivery format, when shipping recorded-source hybrid SFX or a portable sample bundle, or when beeps build, verify, store or fetch.mjs reports a stale, missing, toolchain or sha256 problem.
---

# Ship audio

`beeps` means `node "<plugin-root>/scripts/run-managed.js"`. Mechanism, schema and failure modes:
`docs/build-lock-and-store.md` (read it before changing the setup; this skill is the recipe).

The rule: **an input that already has an output is never rendered again.** Patches have been bit-exact
for a seed on one Chromium build since engine 2, and songs since song pipeline 6 (before it, one song
rendered several ways: Chromium's garbage collector disposed nodes the render still needed). Bit-exact
means the same samples for the same `inputHash` on one machine and one Chromium build, not across
builds or CPUs: another can round differently, so a re-render elsewhere costs time and can change
shipped bytes for nothing. The author renders once, the lock records what was made, everyone else
fetches by hash. `beeps build --verify-determinism` renders each song twice and fails (`E_NONDETERMINISTIC`)
if they differ; use it when a song is new or a graph feature is, not on every build (it doubles song time).

## 1. Describe the project

`beeps.build.json` next to the app: `recipes` (`{ "<id>": { "source", "role" } }`), `out`
(e.g. `public/audio`), `lock` (committed), `project` (the
`beeps/project@1` file), `workDir` (gitignored: staging and the render cache), `target`, `store`.
Baked recipe ids may alias the patch or song `name`; keep the authored source name unchanged.
Effective `runtime`/`both` delivery requires the patch name, including inherited `xRuntime.delivery`;
explicit `delivery: "baked"` permits an alias. See the detailed id contract in `docs/build-lock-and-store.md`.
Targets: `web-universal` (Ogg Opus 44/48/72 kbps for music/ambience/sfx, 24 for the adaptive mix
preview; the default), `web-mp3`, `wav-master`. Override per role with `kbps`; set `budgetBytes`.

## 2. Build and commit the lock

```text
beeps build                  # only stale assets; writes outputs, audio.lock.json, index.json
beeps build --check          # renders nothing; exit 1 lists stale assets and why (the CI/pre-push test)
beeps build --only a,b       # just these recipes
beeps verify                 # sha256 vs lock, catalog, Opus/MP3 headers; --decode adds loop checks
```

Commit `audio.lock.json` with the recipe change; its diff is the changed assets only. Keep `out` out of
git for an active app (the store holds it); for a small app, committing `out` works and the lock is
then the stale test. A lock written by another tool: `beeps build --adopt` (verifies hashes, no render).

## 3. Publish and fetch

```text
beeps build --push --store release:<owner>/<store-repo>     # or dir:<path>; first writer wins, immutable
beeps build --pull --store ...                              # fetch stale assets by hash before rendering
beeps store status                                          # built here? in the store?
beeps ci export tools/audio                                 # vendors fetch.mjs: Node 20+, no deps
```

Writing to a release store needs `GITHUB_TOKEN`/`GH_TOKEN` (contents: write on the store repo) or `gh auth login`.
Public reads need no token; private reads need a token with access to that repo. The exported `fetch.mjs`
uses only `GITHUB_TOKEN`/`GH_TOKEN`; it does not automatically use `gh auth login`. In CI, no beeps, Chromium or ffmpeg:

```yaml
- name: Fetch audio from the store
  run: node tools/audio/fetch.mjs
```

`fetch.mjs` checks every file against the **lock**, so a bad store entry cannot reach the site; exit 1
names missing or invalid assets. A first-tag 404 without a token is ambiguous: the repo/tag may not exist,
or private reads may require `GITHUB_TOKEN`/`GH_TOKEN`. Verify the store address and access before concluding
an asset needs publishing; a successful authenticated lookup can still find a genuinely missing asset.
Key any Actions cache on the lock's hash
(`hashFiles('audio.lock.json')`), never on the recipe folder, and treat it as an accelerator only.
Add `beeps build --check` (needs ffmpeg for the encoder fingerprint, or trusts the lock's) to the test
job to fail on stale audio.

## Hybrid sources

Read [hybrid sources](../beeps-compose/references/hybrid-sources.md) directly for the source workflow,
privacy boundary and native lifecycle. Bundle **after** saving and validating the final hybrid edit;
`sample sync` restores prepared dependencies before build. Runtime/both outputs include the cue-owned
prepared WAV closure, locked and fetched with the cue. Budget those fixed bytes separately from encoded
audio. Baked files use the existing player; source bundles are authoring exchange, not a game catalog.

For baked-player Play/Stop controls, read [the player API](../beeps-compose/references/game-player.md).
Call `player.unlock()` within the play gesture and give the request a generation token; after
awaiting unlock, check that it succeeded and the token is still current before `player.play(id)`.
Stop/replacement increments the generation and stops the current handle, including while its
`ready` promise is pending. Guard late readiness/status callbacks too, so stopped or replaced work
cannot start playback or overwrite the current status.

## Runtime cues

A recipe may add `"delivery": "runtime"` or `"both"` (default `baked`; absent, the patch's `xRuntime.delivery`). `beeps build`
then writes `<id>.runtime.json` next to the baked files. It is in the lock (`parts.runtime`, `delivery`) and the store like any
output, a runtime-only asset encodes nothing and ignores bitrate changes, and editing a binding rebuilds the cue and not its bake.
The game installs only the engine, as `agent-beeps-runtime` (pin a commit of the repo's `runtime` branch;
`docs/runtime-package.md`), loads the cue with `parseCue`, resumes the context in a user gesture, awaits
`loadCueAssets(ctx, cue, { baseURL: cueURL, signal })`, then plays a fresh
`build(ctx, out, cue, { samples }).start()` per play, with a shared `createReverbBus` when voices have reverb.
Abort/generation guards prevent Stop or replacement from starting a late load; cache verified buffers,
not already-started voices. The complete handler is in `docs/runtime.md#playing-it`. Add **`beeps verify --parity chromium,firefox`** to a CI job that has the browsers:
bit-exact in Chromium, loudness within 1 LU and centroid within 30 Hz in Firefox; WebKit without `OfflineAudioContext` is a
warning, not a pass. A new engine version makes `parseCue` refuse old cues: rebuild with the toolchain change below. Which
delivery to pick: `docs/runtime.md`.

## 4. Toolchain changes

A new engine, pipeline, Chromium or ffmpeg changes every hash. `beeps build` stops with `E_TOOLCHAIN`
and the drift instead of re-rendering all; pull what exists (`--pull`), or pass
`--allow-toolchain-change` once, on purpose, on the author's machine, then `--push`. Never let CI do it.

A bump that cannot change the files you hold (the release notes say so; a song-pipeline bump leaves the
sound effects' hashes alone, and for songs that always rendered one way the bits are the same) needs no
render: `beeps build --adopt` verifies every locked output against its sha256, keeps the files and re-keys
the lock to the new toolchain (it refuses if the encoder or bitrate differs). Songs that used to render
several ways keep the variant you shipped; to move one to the canonical render, `beeps build --only <id>
--all --allow-toolchain-change --verify-determinism`, commit the lock, `--push`. Then `beeps build --check`
passes with no further renders, and a later re-render of those songs reproduces the committed files.

## Codec traps (web)

- **MP3 and `-fflags +bitexact`**: bitexact makes ffmpeg write the encoder id `Lavf lame`; the delay and
  padding are still in the tag, but Firefox then ignores the delay and decodes loops 1610 frames long.
  Chromium reads the delay from the frames and hides it, so a Chromium-only test passes.
  `beeps compress --format mp3` omits bitexact; `beeps verify` flags the id.
- **WebKit on Linux does not trim MP3 padding**: even a correct Xing tag does not make a short loop
  seamless there. Prefer Ogg Opus where the browser has it; test MP3 loops in the real engine.
- **Opus is byte-deterministic** for one WAV and one ffmpeg build (pre-skip and granule position carry
  the length, so every browser trims alike), which is why the lock can pin encoded bytes. A different
  ffmpeg build may change the bytes; the lock pins the build.
- **Vendored player** ends a loop at the catalog's `frames` when a decoder left extra frames and
  reports `W_LOOP_LENGTH` when a decode differs; it cannot recover audio a decoder cut.
- **YAML**: a workflow step `name:` containing a colon and a space (`name: Audio: fetch`) parses as a
  mapping and the whole workflow fails to load. Quote step names or leave the colon out.

## When something fails

| Message | Do |
|---|---|
| `build --check` exit 1 | run `beeps build`, commit the lock |
| `output modified: f` | someone edited a built file; rebuild (the render cache restores it) or `--pull` |
| `E_TOOLCHAIN` | section 4 |
| `E_NONDETERMINISTIC` | the song rendered two ways in one page: re-run once; if it repeats, report the song and the message (first frame, size). Nothing was built or locked |
| `BEEPS_FFMPEG ... does not exist` / `is a directory` | the variable is the path of the ffmpeg executable (`/usr/bin/ffmpeg`), never a command name or a folder |
| `E_LOCK` key scheme | `beeps build --adopt` |
| fetch.mjs: not in the store | check repo/tag and read access; if genuinely absent, the author publishes the locked assets with `beeps store push` |
| `E_STORE` sha256 / manifest | corrupt entry; rebuild the asset and push to a fresh store |
| `E_BUDGET` | lower kbps or raise `budgetBytes`; nothing was rendered |
| `E_VERIFY` | the encode failed its decode or header check; fix the source, not the check |
| `verify`: cue measured with engine N | its trim is stale; rebuild (`--allow-toolchain-change`) and commit the lock |
| `verify --parity`: tap differs | the voice no longer plays as the renderer (an engine or Chromium change); do not ship until it is bit-exact |
