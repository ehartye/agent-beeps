# Incremental audio builds: the lock and the store

`beeps build` turns a project's audio recipes into the files a game loads, and renders, exports and
encodes **only what changed**. A committed **lock** (`audio.lock.json`) records, per recipe, the hash of
everything that went into it and the sha256 of every file that came out. A **store** keeps those files
by hash, so another machine (CI, a teammate) fetches them instead of rendering. How an app wires this
together is the `beeps-ship` skill; this page is the mechanism.

## Why not re-render

Two measured facts shape the design:

- **Renders are bit-exact for a seed on one Chromium build, since engine 2 (agent-beeps 0.8.0).** Before
  that they were not: one song rendered four times from empty caches gave four WAVs that differ in 33 to
  50 of 786,516 samples, and a sound with three or more layers, or a `metal`, unison, `additive`,
  `modal` or multi-modulator `fm` source, or both reverb and delay, differed in 0 to 8 samples per render,
  all by one 16-bit step. Chromium sums the connections into one node input in an order that changes
  between runs (float addition of three or more terms depends on order); engine 2 sums every such point
  through a fixed chain of two-input gains (`runtime/engine/sum.js`). An input that already has an output
  is still **never rendered again**: another Chromium build can round differently, and a re-render costs
  time for nothing. The lock records output hashes, not just input hashes.
- **Encoding is deterministic.** The same WAV through the same ffmpeg build gives the same Opus bytes.
  So everything after the render (export, encode, bundle, lock) can be repeated and compared byte for
  byte, and a rebuild from the render cache reproduces the lock exactly.

## The algorithm

For every recipe, with no browser and no ffmpeg run:

```
inputHash = sha256( { renders, export, toolchain, delivery } )   each part itself a sha256
  renders    the beeps render keys the asset needs (patch: one per variant; song: the mix)
  export     id, role, kind, seed, variants, layers
  toolchain  ENGINE, PIPELINE, SONG_PIPELINE and EXPORT_PIPELINE versions, Chromium, Playwright, sample rate
  delivery   format, this role's kbps (an adaptive song also the mix kbps), encoder flags, ffmpeg build
```

- **Render keys are transitive.** `renderKey` hashes the canonical JSON of the patch, or of the song
  with its resolved instruments (project patches, library instruments and overrides inlined), plus the
  options, engine version, sample rate and loudness targets. Editing an instrument changes exactly the
  songs that resolve it. An adaptive song's layers are renders of the same song, so its mix key covers
  them: a song and its layers are one asset, rendered once.
- **Versions are the audio-affecting ones**, not the package version, so a release that does not change
  sound changes no hash. `EXPORT_PIPELINE_VERSION` (`src/export-manifest.ts`) is bumped when the export
  step changes what lands in a deliverable (layer sum, state trims, sidecar fields, file naming).
- **Delivery is per role**: changing the sfx bitrate rebuilds the sfx and nothing else; changing the
  format, the encoder flags or the ffmpeg build rebuilds everything. ffmpeg is identified by its version
  and libavcodec line (libopus and LAME are statically linked, so the build identifies them).

An asset is **stale** when it is not in the lock, its `inputHash` differs, or any output is missing or no
longer hashes to the lock. Stale assets are rebuilt: render (or the render cache), export into a staging
directory, encode, verify (decode check, container headers), then install each file atomically
(temp file and rename, skipping files whose bytes already match) and write the lock. The lock is
rewritten after **every** asset, so a build killed at minute 39 keeps its progress. Unchanged assets are
never touched; `index.json` is regenerated deterministically and rewritten only if its bytes change.

`beeps build --check` does none of this: it renders and writes nothing, lists every stale asset with the
reason (`new`, `inputs changed (renders|export|toolchain|delivery)`, `output missing: f`,
`output modified: f`, `removed from the recipes`), any lock or catalog drift, and exits 1. A byte
estimate (locked sizes, scaled by a bitrate change; duration x bitrate for new assets) is in every
report, and `budgetBytes` fails a build before the first render.

## Config: `beeps.build.json`

```json
{
  "recipes": "asset-src/audio/recipes.json",
  "out": "public/audio",
  "lock": "asset-src/audio/audio.lock.json",
  "project": "asset-src/audio/project.json",
  "workDir": ".local/audio-build",
  "target": "web-universal",
  "kbps": { "music": 44 },
  "budgetBytes": 60000000,
  "store": "release:owner/audio-store"
}
```

Paths are relative to the file. `recipes` is `{ "<id>": { "source": "sfx/coin.json", "role": "sfx" } }`
or an array of `{ id, source, role }`; a recipe may add `seed` (default 1) and, for a patch, `variants`
(default: the patch's declared count). Roles `sfx`, `music`, `ambience`; an `sfx` is a patch, the others
songs (`kind` overrides). The recipe id must equal the patch or song `name` (the catalog keys assets by
it). `project` is a `beeps/project@1` file (scale and loudness targets); without it the nearest
`.agent-beeps/project.json` is used. `patches` is the directory of project patches songs may name as
instruments. `workDir` holds staging and the local render cache (`.agent-beeps/renders`); gitignore it.
`jobs` (default 3) is the number of parallel Chromium hosts.

### Delivery presets (`--target`)

| Preset | Output | kbps (music / ambience / sfx / mix) |
|---|---|---|
| `web-universal` (default) | Ogg Opus, VBR, `-application audio`, `+bitexact` | 44 / 48 / 72 / 24 |
| `web-mp3` | gapless MP3 (LAME, Xing tag, no `+bitexact`) | 80 / 64 / 96 / 32 |
| `wav-master` | the exported WAVs and sidecars | none |

`mix` is the preview file of an adaptive song, which the player does not load (it plays the layers).
`kbps` in the config overrides any role. `beeps compress --format mp3` still works on its own.

## The lock

`audio.lock.json`: sorted keys, two-space indent, LF, trailing newline, no timestamps, no beeps
package version. A rebuild with unchanged inputs writes the same bytes; one changed asset is a diff of its
block (about 25 lines) plus the catalog.

```json
{
  "assets": {
    "coin": {
      "inputHash": "sha256:dce9c669cc26edc4060fed5deb723cd7430c4342394376cbb3d1c437b2e07b8a",
      "outputs": [
        { "bytes": 1620, "file": "coin.0.ogg", "sha256": "2b0c...e91f" },
        { "bytes": 1384, "file": "coin.ogg.json", "sha256": "9d41...07aa" }
      ],
      "parts": { "delivery": "5f0e1a8c2b77", "export": "a1c9d03e44b2", "renders": "7e22b9f01c3d", "toolchain": "c8d5a6120f9e" },
      "role": "sfx",
      "source": "sfx/coin.json"
    }
  },
  "delivery": {
    "container": "ogg",
    "encoder": { "ffmpeg": "6.1.1-essentials_build-www.gyan.dev", "flags": "-map_metadata -1 -c:a libopus -vbr on -application audio -ar 48000 -fflags +bitexact -flags:a +bitexact", "libavcodec": "libavcodec60.31.102" },
    "format": "opus",
    "kbps": { "ambience": 48, "mix": 24, "music": 44, "sfx": 72 },
    "preset": "web-universal"
  },
  "keyScheme": "beeps-input@1",
  "schema": "beeps/build-lock@1",
  "toolchain": { "chromium": "153.0.8010.12@1243", "engine": "1", "exportPipeline": 1, "pipeline": 2, "playwright": "1.63.0", "sampleRate": 48000, "songPipeline": 5 }
}
```

- `outputs` lists every file of the asset (audio, sidecars) relative to `out`; `index.json` is not listed
  (it is regenerated from the sidecars).
- `parts` are 12-hex prefixes of the four hashes `inputHash` is made of; `--check` uses them to say
  *which* part changed.
- `keyScheme` names how `inputHash` was computed. A lock written by another tool (a game's wrapper) says
  so; `beeps build --adopt` verifies every output against the lock's sha256, re-keys it into
  `beeps-input@1` with **no rendering**, and keeps fields it does not know. Assets whose outputs differ
  are rebuilt.

## The store

A store holds one **tar per asset**, named by its input hash (`<64 hex>.tar`), containing the asset's
files and a `beeps-asset.json` manifest. The tar is deterministic (fixed owner and mtime, sorted).
Entries are **immutable and first writer wins**: a name that exists is never replaced. Reads are
untrusted: every file is checked against the lock's sha256 (and the tar's own manifest) before anything
is written, entry names are flat file names only, and a mismatch writes nothing.

| Backend | Spec | Notes |
|---|---|---|
| directory | `dir:<path>` | a shared or mounted directory; push links a temp file into place (atomic, fails if the name exists) |
| GitHub release assets | `release:<owner/repo>[@tag]` | the REST API with `GITHUB_TOKEN`/`GH_TOKEN` (or `gh auth token`) to write; a public repo needs no token to read |

Release limits (2 GiB per asset, 1000 assets per release) are respected: the chain is `audio-store`
(or the tag given), then `audio-store-1`, `audio-store-2`, ... A push goes to the first release with room
and creates the next numbered release when all are full; a lookup walks the chain. Reads without a token
use the public download URL (no API rate limit); with one, the API (private repos). A lost upload race
(HTTP 422) counts as the first writer winning.

Commands:

- `beeps build --pull --store <spec>`: before rendering, fetch each stale asset by its new `inputHash`.
  Only what the store lacks is rendered.
- `beeps build --push --store <spec>`: publish the assets this run built.
- `beeps store push|pull|status [--only ids]`: the lock's assets against the store. `push` publishes
  assets whose outputs verify; `pull` writes the lock's assets into `out` (verified against the lock) and
  regenerates the catalog; `status` says per asset whether it is built here and present in the store.
- `beeps ci export <dir>`: writes `fetch.mjs` (Node 20+ built-ins only) with this project's lock path,
  output path and store baked in as defaults (relative to the script). In CI,
  `node tools/audio/fetch.mjs` reads the committed lock, downloads missing assets by hash, checks every
  file's sha256 and size against the **lock**, writes them atomically and regenerates `index.json`
  byte-identically to `beeps bundle`. It needs no beeps, Chromium or ffmpeg; `--check` verifies without a
  store; `--only`, `--store` and `--lock`/`--out` override the defaults. Exit 1 names each asset the store
  lacks (`the author must run beeps build --push`) or that does not match the lock.

## `beeps verify [dir|lock]`

Outputs against the lock (size and sha256), the catalog (`index.json` lists every locked asset, every
listed file exists, `durationSec` is a whole number of frames) and static container checks, without
decoding:

- **Ogg Opus**: `OpusHead` and `OpusTags` present, end-of-stream page, channel count, and the length the
  last granule position implies (granule - pre-skip) equal to the sidecar's frame count.
- **MP3**: Xing/Info tag present; encoder id is not `Lavf lame` (the `+bitexact` trap, below); delay and
  padding imply the sidecar's frame count (a one-shot may decode up to one MPEG frame longer).
- **WAV**: header frame count.

`--decode` decodes every loop file and checks its frame count against the sidecar (a failure) and its wrap tick and level step (warnings: measured without the source WAV they also flag music that is quiet at its end); it needs
ffmpeg. Exit 1 lists each problem as `{ asset, file, problem }`.

## Catalog and player: exact length

Sidecars (and so `index.json`) carry `frames`, the exact integer length of the source, and, after
encoding, `encoding.lead`, the encoder lead-in the file's own headers state (Opus pre-skip, MP3 delay).
Vendored player 3 uses `frames` as a guard: when a loop's decoded buffer is longer, the loop ends at
`frames` (`loopEnd`), and any length that differs from the catalog is reported once through `onError` as
`W_LOOP_LENGTH`. It cannot restore audio a decoder trimmed, and it does not use `lead` (no real-Safari
measurement shows a leading offset yet).

## Failure modes

| Situation | What happens |
|---|---|
| Cache miss, evicted Actions cache | Nothing renders. CI fetches from the store; the cache is an accelerator. |
| Author forgot to push | `fetch.mjs` fails naming the assets. Run `beeps build --push` (or `store push`). |
| Tool version bump (engine, pipeline, Chromium, ffmpeg) | Every hash changes. `beeps build` stops with `E_TOOLCHAIN` listing the drift instead of silently re-rendering everything; pass `--allow-toolchain-change`, or `--pull` assets someone already built. Renders come from the render cache when it is warm, so a Chromium-only bump is minutes of encoding, not a render. |
| ffmpeg drift | The encoder fingerprint is in every hash, so another ffmpeg makes every asset stale (same guard). Use the ffmpeg the lock names, or accept the change on purpose. |
| Partial rebuild (killed, disk full) | Finished assets are committed; an interrupted asset keeps its old files and old lock entry (still valid). Its new files are installed one by one, so a crash in that window leaves that asset mismatching the lock: the next build sees `output modified` and redoes it from the render cache. `beeps verify` reports it. |
| Re-render of an unchanged input | Never done. On the same Chromium build a re-render reproduces the bytes (engine 2); after a Chromium change an asset rebuilt from scratch can differ by float rounding: equivalent, not identical. |
| Poisoned or corrupt store entry | Rejected by sha256 against the lock; nothing written. |
| Recipe removed | Its outputs and lock entry are deleted (not with `--only`). |

Unmeasured: Linux Opus byte identity against a Windows ffmpeg build (a lock pins one ffmpeg), and store
fetch time on a CI runner.
