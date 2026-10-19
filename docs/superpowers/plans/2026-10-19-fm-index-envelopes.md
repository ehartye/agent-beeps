# FM Index Envelopes Implementation Plan

> Use h-superpowers:subagent-driven-development for isolated implementation and two-stage review.

**Goal:** Add source-level FM timbre envelopes and a live, level-matched SFX study.

**Architecture:** Validate optional operator `indexEnv` in the existing patch schema; schedule it
on the existing modulation depth GainNodes in `sources.js`. Offline and runtime share that code.
Flux extends the public booth with static/enveloped pairs, measured with existing patch pipelines.

**Tech stack:** Node 24, Zod, browser Web Audio, Vitest, Playwright, existing static Pages build.

1. [x] Inspect wiki/current engine; create isolated worktree; run focused baseline.
2. [x] Write failing schema and graph tests; implement validation and depth automation.
3. [x] Add native spectral, unity/legacy, onset/overlap and runtime-parity verification.
4. [x] Independently review spec compliance, then code quality; fix and reverify findings.
5. [x] Compose/render three paired Flux effects, inspect looks and measured levels, wire existing UI.
6. [x] Document API; discover/ingest primary FM evidence and prepare wiki architecture/roadmap updates.
7. [x] Bump release/capability version, verify legacy identity changes are intentional, run full checks.
8. [ ] Review delivery, rebase/squash merge, verify Pages, synchronize catalog/wiki and local main.

Release verification: 1,006 tests passed, five skipped across 103 files; typecheck passed. The
golden matrix has 546 cases, including all 510 unchanged legacy cases. Native checks cover
sideband motion, repeat/unity equality, runtime parity, unsafe Float32 endpoints and atomic
startup failure. Flux's worst pair difference is 0.0059 LU, with a highest peak of −9.92 dBTP
and no lint errors/warnings at its explicit comparison target. The 63-hash site build and
Pages-subpath desktop/mobile playback checks pass. Owner listening remains pending.
