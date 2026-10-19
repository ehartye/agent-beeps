# Hybrid Audio Implementation Plan

> Use h-superpowers:subagent-driven-development for implementation with spec then quality
> review per task. The user's goal authorizes the complete workflow; execute continuously.

**Goal:** Deliver recorded and procedural SFX through preparation, shared playback, existing
audition, portable source exchange, baked exports and self-contained runtime cue dependencies.

**Architecture:** Immutable canonical WAV objects + preparation receipts; explicit Node
resolver and async browser loading before synchronous shared graph construction. Extend current
pipelines, listening UI and build/store rather than introducing parallel systems.

**Tech stack:** Node24, existing ffmpeg decoder, Zod, browser Web Audio, Vitest and Playwright.

- [x] Isolate feat/hybrid-audio from1accc6a; npm ci;33 focused baseline tests pass.
- [x] Inspect current decoder, graph, pipeline, cue and build boundaries; write the design.
- [x] Task1: canonical codec, bounded decode, immutable import/preparation and resolver.
- [x] Task2A: strict sample source, synchronous graph preflight/buffers and async browser
  cue preparation with verified local hashing, including native and HTTP LAN checks.
- [ ] Task2B: production offline host transport, project render context and real runtime
  parity (including a changed-source negative control).
- [ ] Task3: CLI import/prepare/bundle/sync, existing audition preloading with cancellation
  guards and sample-aware lint (project render context is established in Task2B).
- [ ] Task4: portable cue assets in standalone export/build/lock/verify/store/fetch/budgets.
- [ ] Task5: licensed public hybrid study in existing booth, actual measured comparisons,
  portable downloads, provenance and desktop/mobile/subpath browser verification.
- [ ] Task6: capability/version identity, legacy compatibility, full regression tests,
  independent reviews, wiki/docs/catalog, squash merge and hosted verification.

## Task1 interfaces and checks

Create `runtime/engine/sample-wav.js`: `readSampleWav(bytes,{maxFrames?})` returns
`{sampleRate:48000,frames:number,channels:Float32Array[]}`. Canonical header and complete
data length checked before allocation; default prepared maximum480000 frames. Node normalized
source parsing may explicitly raise the bound to5760000. No Node imports.

Create `src/samples/store.ts`: `samplePaths(projectOrDir)`, `sampleId(bytes)`,
`readSampleObject(objectsDir,id,{maxFrames?})`, `patchSampleIds(patch)`,
`resolvePatchSamples(patch,objectsDir)`. Resolver returns verified objects including id, bytes,
rate/channels/frames and canonical WAV Buffer. No references returns an empty result without
filesystem access. Missing => E_NOT_FOUND, malformed/schema => E_SCHEMA, hash mismatch=>E_VERIFY.

Create `src/samples/prepare.ts`: strict recipe parser/type `SamplePrep`; `importSample(project,
file,{origin?,license?})` and `prepareSample(project,recipe)`. Import returns original/source
IDs, canonical metadata and receipt. Preparation returns recipe/output IDs, exact metadata,
object path and receipt. Files immutable; validate all inputs before writes. Preserve original
bytes and normalized snapshot independently. Reuse `src/audio/decode.ts` and `writeWav(...32)`;
extend decoder bounds only as necessary and retain default legacy decode behavior.

Tests: `tests/samples/store.test.ts`, `tests/samples/prepare.test.ts`, native codec tests as
needed. First write and run failing tests for corruption/missing objects, malformed canonical
header, finite/frame bounds, mono/stereo channel preservation, original retention, exact crop
and linear fade endpoints, single-frame fade, gain, repeat identity, invalid recipe atomicity,
relocation/original removal and provenance coexistence. Verify red for the intended behavior,
then implement and run those tests plus existing WAV/decode tests and typecheck. Do not create
schema/CLI/graph integration in Task1. Coordinator handles integration after reviewed contract.

Task1 verification: coordinator63tests/5files pass with ffmpeg enabled and no skips; typecheck
and whitespace checks pass. Independent spec review approved after ADPCM fallback, automatic
stream selection and returned receipt corrections. Quality review approved after four
interrupted/concurrent-write publication regressions; its broader69tests/6files pass. No new
CLI or graph integration is claimed by this checkpoint.

## Subsequent task checks

Task2 tests first: sample schema rejects pitch semantics; graph fake/native checks actual
sample PCM, offset and buffer sharing; missing later sample creates no earlier sources;
async fetch/hash errors cannot enter the synchronous graph. Native offline/cue/audition taps
and changed-content negative control. Read actual Node render call sites before modifying.
Native lifetime regressions must yield while suspended so voice end callbacks actually run.
Preserve the authored amp/release lifetime for nonheld samples and finite automatic release
for held ones; earlier stop preserves attack history and later stop cannot restart a release.

Task2A verification: coordinator114tests/9files pass with no skips, typecheck, reproducible
local hash bundle and whitespace checks pass. Independent spec review approved after fixing
a callback-dispatched resonant-filter tail truncation; its exact native reproduction now
preserves identical PCM. Independent quality review approved with166tests/10files, no skips.
All546 existing graph goldens remain unchanged. Production render transport, cache/source
context and harness integration remain Task2B; this checkpoint is not a hybrid release.

Task3 tests first: CLI roundtrip sample-only/hybrid import ->prepare ->new/set ->render ->bundle
->sync in relocated project; corrupt bundle writes nothing; current audition plays both and
Stop/selection change cancels pending loads. Use actual HTTP/auth routes and existing UI.

Task4 tests first: runtime-only/both outputs contain cue-owned samples; verify detects deleted,
tampered, mismatched and escaping dependencies; warm build cannot hide bad source; store/fetch
roundtrip; rebuilding one cue leaves another intact; actual static runtime consumes fetched
outputs. Include a 60-character valid cue ID: hashed owner/content filenames must still fit
the existing store's 100-byte ustar limit. Baked game player consumes normal hybrid export.

Task5/6: use existing renderer/measurement/looks and current booth styles. Inspect licensed
source artifacts and rendered PNGs. Match comparisons by actual delivered max momentary and
enforce peaks. Keep existing Matter/Touch/Flux behavior. Run full suite and typecheck once
source stable, then hosted Pages checks after squash merge. Update wiki as built only when
verified; retain provenance and real listening status.
