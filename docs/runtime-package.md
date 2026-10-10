# The slim runtime package

A game that plays beeps patches live imports `runtime/engine/index.js`, which reaches 13 files (plus the schema types) and needs no
dependency at all (its types borrow the schema's, which are `zod`'s). Installing `agent-beeps` itself from git would
also install every dependency of the CLI (playwright, commander, ffmpeg-static), because npm installs a git
dependency's whole `dependencies` list and cannot install a subdirectory of a repository.

So the runtime is also available as its own package, `agent-beeps-runtime`, generated from this repository:

```
node scripts/build-runtime-package.mjs --out <dir>     write the package (the closure of its entries, package.json, LICENSE, README)
node scripts/build-runtime-package.mjs --check <dir>   exit 1 unless <dir> equals what would be generated
node scripts/build-runtime-package.mjs --publish       commit it onto the local `runtime` branch (never pushes)
```

Every file is byte-identical to its source; only `package.json` and `README.md` are written.

| Entry | Import | What it is | Run-time dependencies |
|---|---|---|---|
| `.` | `agent-beeps-runtime` | `build`, `parseCue`, `createReverbBus`, `defaultParams`, `createPicker`, `patchLength`, cache limits, `ENGINE_VERSION`, with `.d.ts` | none |
| `./schema` | `agent-beeps-runtime/schema` | `parsePatch`, `PatchSchema`, `runtimeIssues`: validate raw patch JSON and its `xRuntime` bindings (TypeScript source; use a bundler or runner that accepts `.ts`) | `zod` |

Most games load **cues** (`<id>.runtime.json`, written by `beeps build`), which are already parsed, and never import
`./schema`. A game that stores raw patches imports it at build time to run `parsePatch`, which fills the defaults
`build` expects.

`tests/runtime/package.test.ts` fails if the engine closure ever reaches a package at run time (or the schema entry reaches
anything but `zod`), if a stale or hand-edited copy is not reported, and it installs the generated tree as a dependency to
check that it imports in Node, builds the same graph as the repository, bundles, and type-checks a consumer (and rejects a
consumer that misuses the API).

## The `runtime` branch

`runtime` is an append-only branch whose tree is the generated package. A game pins a commit of it:

```
"agent-beeps-runtime": "github:ehartye/agent-beeps#<commit on runtime>"
```

Refresh it after a change that the runtime reaches (run on a clean checkout of `main`, then push):

```
node scripts/build-runtime-package.mjs --publish
git push origin runtime
```

`--publish` refuses to run while a runtime file has uncommitted changes (the commit message names the source commit). Never
force-push `runtime`: games pin its commits. Nothing is published to an npm registry. The CLI, the audition page and the
managed plugin install (`scripts/managed-runtime.js`) still use the root `package.json` and are unchanged.

## Versioning

The package version is the repository's. What a game must watch is `ENGINE_VERSION` (`runtime/engine/version.js`): a cue
records the engine it was measured with, `parseCue` refuses a cue from another engine, and a game that pins a new
`runtime` commit rebuilds its audio (`beeps build --allow-toolchain-change`, then commit the lock) in the same change.
