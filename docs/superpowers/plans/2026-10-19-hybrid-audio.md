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
- [x] Task2B: production offline host transport, project render context and real runtime
  parity (including a changed-source negative control).
- [x] Task3A: CLI import/prepare/bundle/sync, explicit preparation-history portability and
  replay after relocation (project render context is established in Task2B).
- [x] Task3B: existing audition preloading with cancellation guards, sample-aware lint and
  actual sample-only/hybrid set playback in the current UI.
- [x] Task4A: cue-owned sample delivery in standalone export/build/lock, shared delivered
  dependency validation, delivered-byte parity, ownership cleanup and fixed-byte budgets.
- [x] Task4B: use that validation in store push/pull/status, build --pull and standalone
  zero-dependency CI fetch; prove fetched static runtime and baked-player playback.
- [x] Task5A/5B: licensed public hybrid studies in the existing booth: metal contact,
  the owner-selected CC0 Tommy gun (five bursts), and M16 (one sustained burst and room tail).
  Recording / procedural body / hybrid comparisons use actual matched levels, provenance,
  portable metal downloads and desktop/mobile/subpath browser verification. The owner's
  later selection removes the extra indoor-machine-gun row from the public inventory.
- [ ] Task5C: make the existing live equalizer the sticky panel and give its shared transport
  play/pause and previous/next behavior for the active Matter, bench, Touch, Flux or Fuse
  section. Preserve true pause position, native source playback, cancellation and source PCM.
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

Task2B verification: coordinator31tests/7files pass with no skips, typecheck and whitespace
checks pass. Independent spec review approved with72tests/11files and unchanged546goldens;
independent quality approved with29tests/6files, no skips, plus malformed-transport probes.
Native maximum10second stereo transport and exact PCM pass after a real V8 regex stack
overflow regression was fixed. Per-operation snapshots bound duplicate source transport
across variants; fresh operations still reject missing/corrupt objects before warm caches.
Production/runtime tap parity, changed-content controls and actual CLI render/measure/export/
runtime check/parity/perf/look/live are verified. Portable cue delivery remains Task4.

Task3A tests first: CLI roundtrip sample-only/hybrid import ->prepare ->new ->render ->bundle
->sync in relocated project; corrupt bundle or destination immutable object writes nothing.
Defaults export prepared dependencies only. Explicit --include-preparation exports matching
receipts and normalized source closure, never original files/import receipts/generated paths.
Replay saved recipes/receipts through CLI after original removal; verify exact output identity.
CLI seconds round to nearest48k frame and durable recipe controls remain explicit integers.
Preflight requested patch-name conflicts and receipt identity before preparation publication.
Bundle validates strict manifest/file closure and containment; fresh-directory publication or
identical repeat avoids leftover outtakes. A small pure preparation helper may be factored
from Task1 so sync/receipt validation can recompute output before destination writes; preserve
existing arithmetic and all Task1 tests. Existing patch-only sync retains its contract.

Task3A verification: coordinator53tests/6files pass with ffmpeg enabled and no skips;
typecheck and whitespace checks pass. Independent spec review approved, including actual
directory/dangling-link named-patch CLI reproductions and normal forced replacement. Fresh
quality review approved with39tests/3files and no skips. The complete real CLI sample-only
and hybrid relocation chains produce identical rendered WAVs. Exact raw-byte patch hashes,
destination/ancestor preflight and immutable publication-winner checks reject the reproduced
integrity failures before reporting success or publishing preparation files. Default bundles
retain only prepared dependencies; explicit preparation bundles replay saved recipes after
original removal. Existing audition and delivered runtime dependencies remain Tasks3B/4.

Task3B tests first: normal sets contain sample-only and hybrid candidates; current audition
plays both and Stop/selection change cancels pending loads. Use actual HTTP/auth routes and
the existing UI. Prepared fades must not trigger a declarative amp attack warning, while a
measured abrupt sample onset still receives the applicable craft warning. No fabricated owner
judgement or duplicate listening application.

Task3B verification: coordinator101tests/13files pass with no skips, typecheck and whitespace
checks pass. Independent spec approved with64tests/5files after sanitizing sample-store HTTP
errors; independent quality approved with60tests/4files, both no skips. Actual CLI sets feed
the existing authenticated page. Native48k PCM matches production renders for sample-only,
hybrid, repeat/kit and phone filtering; actual delayed HTTP and pending-resume tests prove
Stop/new selection cannot start obsolete audio or record its play. Genuine errors retry,
warm corrupt/missing/oversized objects fail without local path disclosure, and actual measured
onset lint distinguishes prepared fades from abrupt PCM. SERVER_API6 replaces older listeners;
package/engine identity and complete shipping/public release remain later tasks.

Task4A tests first: runtime-only/both outputs contain cue-owned samples; verify detects deleted,
tampered, mismatched and escaping dependencies; warm build cannot hide bad source; store/fetch
roundtrip follows in Task4B. Rebuilding one cue leaves another intact. Include a 60-character
valid cue ID: hashed owner/content filenames must still fit the existing store's 100-byte
ustar limit. Verify parity from delivered bytes with the authoring store removed. Share a
small dependency validator rather than repeating closure/hash/canonical/metadata checks in
each Node path. Runtime source WAV and cue bytes remain fixed when baked bitrate changes.

Task4A verification: coordinator65tests/4files pass with no skips after all fixes; typecheck
and whitespace checks pass. Spec and quality approved, including the shared required-cue
inventory guard and warm-budget corrections. Independent checks confirm unchanged546graph
goldens. Standalone runtime export/verify, baked/runtime/both builds, exact75-byte owned names,
60-character cue tar roundtrip, owner cleanup and native delivered-byte parity work. Warm
sample growth, procedural-to-sample and baked-to-both changes respect the current budget
before output/lock mutation; bitrate-only changes preserve fixed source/cue/sidecar bytes.
Actual missing-source/missing-cue/wrong-filename probes now reject. Compatibility checks have
one existing optional Firefox skip; actual Windows junction/nonregular checks ran, while file
symlink creation was unavailable. Store/fetch/static playback remain Task4B, not this checkpoint.

Task4B tests first: store and CI fetch reject hash-consistent but dangling/malformed cue
dependencies before installation, including already-present/--check paths and build --pull.
Keep the single exported fetch script portable on Node20 built-ins without the authoring
checkout, Chromium or ffmpeg. Share or reproducibly generate its dependency checks from the
same canonical semantics, preserving its project-defaults marker. Actually serve fetched
outputs and engine under a static project subpath, load verified assets and play native
runtime PCM; the baked game player consumes the normal hybrid export. Neither checkpoint
alone completes the shipping acceptance; Task4A and Task4B both precede the public release.

Task4B verification: spec and quality approved after fixing independently reproduced cross-owner
overwrite and retirement failures. The final13 ownership regressions pass without skips on actual
Node20, including Windows source/cue case aliases; independent spec reran overwrite, warm-build
and removed-recipe probes, and independent quality reran all13 tests. Reserved source outputs
equal the cue dependency set; retirement derives canonical owner/content names before writes.
Earlier104tests/4files spec,50tests/2files quality and33 new integration tests pass. Broader170
tests/8files pass with one existing optional Firefox skip. Typecheck, reproducible generator and
whitespace checks pass. Exported single-file fetch runs on Node20.20.2 with empty PATH and no
ffmpeg. Relocated baked/runtime/both delivery survives removal of authoring sources and the store;
native static playback exercises public cue loading and the existing baked player. A changed
source changes PCM. Invalid closures, names, nonregular files and locked byte counts fail before
installation. Task5 public examples and Task6 release remain pending.

Task5/6: use existing renderer/measurement/looks and current booth styles. Inspect licensed
source artifacts and rendered PNGs. Match comparisons by actual delivered max momentary and
enforce peaks. Keep existing Matter/Touch/Flux behavior. Run full suite and typecheck once
source stable, then hosted Pages checks after squash merge. Update wiki as built only when
verified; retain provenance and real listening status.

Task5A/5B verification: final three-row/nine-take native suite passes, including all six
recording/hybrid changed-source controls and actual five-burst/one-burst PCM groups. All150
manifest hashes,43 legacy assets, metal audio/recipes/cues/looks/quality and46 gun artifacts verify.
Independent spec approved actual original checksums, canonical decode/preparation replay,
strict portable bundles, delayed fetch/resume cancellation, desktop and390px playback.
Fresh quality approved controller/compose/render/delivery integration and reran file/portable
CLI/status/cases tests, typecheck and whitespace checks. The extra indoor row and obsolete
owned outputs are absent. Intentional long-form tail warnings remain documented. Owner
listening preferences are not inferred. Task5C and release are still pending.

Pre-commit packaging verification caught two manifest mismatches caused by Git normalizing
one CRLF in each editable metal README/provenance file. Those files and the test script now
use LF. The exact upstream Kenney license remains608 bytes with its original SHA256 and a
narrow binary Git attribute. Both metal archives were repacked: only README/provenance text
bytes change; parsed provenance, normalized README, every inner bundle entry and license
remain equivalent/exact. The final gate checks actual staged hashes and a fresh checkout's
real build and relocated portable CLI flow, rather than trusting only working-tree bytes.

## Task5C: shared equalizer and contextual transport

Owner request: replace the fixed Matter/Glass sticky panel with the equalizer, and give it
play/pause/skips appropriate to the playing section. Keep the existing booth's visual language.
Move the single live output `#scope` into the sticky panel; keep Matter's measured timeline,
seek and scene notes in the Matter body. Show a compact current section/take and actual state.
Idle copy is neutral; playing another section must never leave Matter/Glass as its title.

Shared controls follow Matter's nine scenes, the eight sound-bench pads, Touch's two takes,
Flux's six ordered comparisons, or Fuse's nine ordered takes. Previous/next activates that
section's adjacent item; Touch keeps its musical position when switching A/B. Space follows
the shared play/pause action. Stop/Esc and master volume retain their global behavior.
Keep repeat clearly scoped to Matter. Selection comes from playback actions, not scrolling.

Media playback pauses and resumes at its actual position. Live procedural/sample voices must
also truly pause and resume, preserving native graph position rather than retriggering or
quietly baking them. The existing shared AudioContext can suspend a live voice; pause any
concurrent media playheads consistently and restore them on resume. Cancel/recompute the
wall-clock completion timer around suspension so a paused voice cannot finish in the background.
Stop, skip or replacement while paused/loading must dispose/cancel obsolete work, and late
resume/load promises cannot restart it. Retain foreground voice ownership over background
music events and restore an actually playing background section after the voice finishes.

First demonstrate red with the current fixed transport. Verify actual native playback and
AudioContext/media time during pause/resume, no second source start when resuming a live voice,
timer survival across a pause, all section skip mappings, pending-load/resume cancellation,
stop/skip while paused, natural completion and errors. Keep the source PCM/cues/bundles unchanged.
Run the existing booth suite plus the new transport coverage. Inspect desktop and390px layouts,
sticky equalizer while scrolled, accurate accessible control labels, no duplicate canvas,
no overflow, no browser exceptions and no missing subpath assets.
