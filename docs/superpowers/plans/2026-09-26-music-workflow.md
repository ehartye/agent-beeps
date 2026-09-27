# Music workflow implementation plan

**Goal:** Implement the four accepted workflow improvements, record their verified state in the wiki roadmap, then offer a sound-effects audition.

**Scope:** Work on the user's selected `feat/music` branch. Preserve existing albums, recordings and feedback. No revision A/B UI, automatic mixing or changes to compositions.

## 1. Progressive albums and moment notes

- [x] Add regression tests in `tests/audition/album.test.ts` for reading legacy ready tracks, pending/ready/failed transitions with stable indices, unavailable media, and notes tied to a valid position and render identity.
- [x] Extend `src/album.ts` additively; write album changes atomically. Store immutable render identity and timestamped annotations separately from whole-track notes.
- [x] Change `src/commands/songs.ts` album creation to create/register the album and emit the link before rendering. Keep rendering in the command, update completed tracks individually, and retain successes when another track fails. Emit progress without corrupting JSON results.
- [x] Update `src/audition/server.ts` and the existing album UI to expose statuses, poll pending albums without replacing playing audio or unsaved notes, skip unavailable tracks, and capture/list moment notes. Preserve existing visual language.
- [x] Run focused tests and typecheck; review behavior and error handling.

## 2. Faithful section previews

- [x] Test that previews contain exactly the samples from the full delivered render for every selected section occurrence, with no extra normalization; test invalid section selection.
- [x] Introduce a small cached excerpt helper under `src/render/`. Render the complete song first, then extract requested spans and rebase section metadata. Preserve full-mix trim and instrument/automation context.
- [x] Route `song render --sections` through that helper. For `--only`, render the selected tracks across the full form before excerpting and label the solo correctly; do not pretend solo is a full-mix sample match.
- [x] Verify Aurora Station's return excerpt against its cached full WAV; document first-render cost.

## 3. Concurrent register diagnostics

- [x] Add tests in `tests/music/song-lint.test.ts` for alternating notes (no warning), coincident pitched notes (warning), touching note boundaries, and repeated section occurrences.
- [x] Refine `registerOverlaps` in `src/song-lint.ts` to compare sounding pitch spans only while held note intervals coincide. Keep findings advisory, describe their limits (release tails, spectral masking), and preserve layer offsets.
- [x] Run focused tests and review time complexity.

## 4. Integration and handoff

- [x] Run `npm test` and `npm run typecheck`; fix regressions and have the complete diff reviewed.
- [x] Verify browser playback while tracks update, a failed track beside a ready track, and a saved/reloaded moment note. Verify existing album links still load.
- [x] Update `skills/beeps-music/SKILL.md`, song-format reference as needed, and README command behavior.
- [x] Record four individual wiki backlog items, current roadmap/architecture, verification and tradeoffs. Use wiki operations on main and sync per vault instructions.
- [x] Install/check the updated managed runtime. Generate and visually inspect a varied SFX set, seal a prediction and open a listening session. Leave music feedback unmodified.

Verified: 266 tests pass, typecheck and diff checks pass, independent code review complete. Aurora excerpt PCM matches the full delivered render exactly. Existing album links survive the server upgrade. Wiki main is synchronized at `53bef11d`. Managed runtime setup check passes. Three handoff samplers contain 18 rendered effects with zero lint errors; the occasional asteroid explosion retains an intentional sharpness warning. All three session payloads and all 18 preview images return HTTP 200.

The wiki owns the project roadmap; this repo document is the execution checklist. Completion means verified behavior and playable sound effects, not only passing unit tests.
