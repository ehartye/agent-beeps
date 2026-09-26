# agent-beeps Plan 2 — Generation loop, audition, taste, skills

> **For Claude:** REQUIRED SUB-SKILL: Use h-superpowers:subagent-driven-development, h-superpowers:team-driven-development, or h-superpowers:executing-plans to implement this plan (ask user which approach). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop: agents generate diverse candidate sets, predict a favourite, open an audition the owner judges on hal9000 (lineup → duel → refine → ship), and every explicit judgement trains a layered taste model that ranks, steers and predicts.

**Architecture:** Builds on Plan 1. `src/taste/` is pure TS (verdict log, Bradley-Terry fit, active pair selection, summary). `src/audition/` holds session state (append-only `events.jsonl` folded at read time) and a `node:http` server that serves `runtime/audition/` (static page importing the same engine) plus a token-guarded JSON API. The CLI is the agent's whole contract; the server is the owner's.

**Tech Stack:** as Plan 1. No new dependencies.

**Evidence folded in (wiki research 2026-09-25):**
- Ties shrink error bars but bias BT differences → "same" answers are logged, **excluded from the fit**, and used only to deprioritise that pair in active selection.
- Choose the next duel by uncertainty (active pair selection beats sorting) → duel order = pair with P(win) closest to ½ weighted by σ.
- Best-worst style lineup answers settle many pairs per click → ♥/✗ expand to implied pairs at weight ⅓.
- Loudness-match before comparison, randomise positions, cap fatigue (MUSHRA practice) → trims from Plan 1, left/right randomised per duel, lineup ≤ 8.
- jsfxr/bfxr mutate: each parameter 50 % chance of a ±5 % (normalised) nudge; waveform never mutated → `mutate` follows this, with archetype ranges as the normalisation.
- Audition shapes preference → replays are engagement, never verdicts.

---

### Task 1: Generate (sets)
**Files:** `src/generate.ts`, `src/commands/generate.ts`, `tests/generate.test.ts`.
- [ ] `farthestPoint(vectors: number[][], k, start)` (z-scored per dimension) — unit-tested on synthetic points.
- [ ] `generate(host, p, {archetype, count=6, seed, prompt?, near?})`: sample 4·count via `sampleArchetype`, `renderAndMeasure`, drop error-level `lintPatch` failures, z-score `featureVector`s, start from the candidate nearest the taste model's best (or the median when the model has < 10 verdicts), farthest-point select `count`, write `sets/<id>/set.json` `{schema:'beeps/set@1', id, archetype, prompt, createdAt, candidates:[{index, name, key, trimDb, features, wav, look}]}` + `sets/<id>/candidates/<name>.json` + `sets/<id>/sheet.png`. `id = <archetype>-<yyyymmdd-hhmm>-<4hex>`.
- [ ] CLI `generate <archetype> [--count 6] [--seed] [--prompt] [--near <ref>]` → set JSON + sheet path. Browser test: 4 candidates, all lint-clean, pairwise feature distance > 0.

### Task 2: Mutate and crossover
**Files:** `src/mutate.ts`, `src/commands/generate.ts`, `tests/mutate.test.ts`.
- [ ] `DIRECTIONS` (spec §4) as feature-name weight maps over `FEATURE_NAMES`.
- [ ] `perturb(patch, rng, archetype?)`: every numeric leaf (except structure: `schema`, `start` offsets, `variants`, `priority`, tuple indices of algorithms) has a 50 % chance of a nudge of ±5 % of its archetype range (log-space for log ranges) or ×2^(±0.1) when no range; clamp to schema bounds and archetype ranges; never change enums (waveforms); re-validate.
- [ ] `mutate(host, p, {ref, toward, count=4, seed})`: 6·count perturbations → render/measure → score `Σ_dir w·Δz` (+ taste utility when the model is confident) → keep top count with score > 0, flag `weak` otherwise → new set with `parent`.
- [ ] `crossover(a, b, t)`: shared numeric leaves interpolated (log for Hz/seconds), structure from `a`.
- [ ] Tests: 200 perturbations stay valid and keep waveforms; direction scoring ranks correctly; crossover(t=0) ≡ a.

### Task 3: Taste store and model
**Files:** `src/taste/verdicts.ts`, `src/taste/model.ts`, `src/taste/select.ts`, `src/taste/summary.ts`, `tests/taste/*.test.ts`.
- [ ] Verdict row `{schema:'beeps/verdict@1', at, project, session, kind:'duel'|'implied'|'bothBad'|'tie', winner?:{name,family,x:number[]}, loser?:{...}, a?, b?, weight, tags:string[]}` — `x` is `featureVector` z-scored within family at write time using family stats from the candidate set (stored alongside as `stats`). Append to `<project>/.agent-beeps/taste/verdicts.jsonl` and `~/.agent-beeps/taste/verdicts.jsonl` (`AGENT_BEEPS_HOME`). `readVerdicts(file)` tolerates and counts malformed lines.
- [ ] `fitBT(rows, {lambda=1, prior?: number[]})`: logistic regression without intercept on `d = x_w − x_l` (label 1, weight w), plus the mirrored row (label 0) for symmetry; Newton-Raphson with L2 toward `prior`; returns `{w, cov (Laplace: inverse Hessian), n}`. Ties skipped. bothBad rows: winner = family-mean reference (x = 0 vector), weight ½.
- [ ] `fitLayered(globalRows, projectRows)`: global fit; project fit only when project rows ≥ 15, with prior = global w and lambda 3 (shrinkage); `utility(x) = w·x`, `sigma(x) = sqrt(xᵀ C x)`, `pWin(a,b) = σ((w·(a−b)))`.
- [ ] `nextDuel(candidates, model, asked)`: among unasked pairs of the shortlist, maximise `uncertainty = (1 − |2p−1|) · (1 + σ_diff)`; pairs already tied get ×0.25.
- [ ] `summarize(model)` → per feature: direction words (e.g. brightness + → "brighter", sharpness − → "less sharp"), effect in σ units, confidence `strong` (|w| > 2·se), `weak` (> 1·se), `unknown`; writes `summary.md` with counts and the top 5 preferences in plain words.
- [ ] Tests: a simulated listener with hidden weights produces 200 noisy duels (logistic noise) → fitted weights correlate > 0.8 with truth and held-out accuracy > 70 %; project layer stays near global with < 15 rows; ties do not move weights; nextDuel picks the most uncertain pair; summary names the strongest true preference.

### Task 4: Sessions, predictions and events
**Files:** `src/audition/session.ts`, `tests/audition/session.test.ts`.
- [ ] Session dir `sessions/<id>/`: `session.json {schema:'beeps/session@1', id, setId, prompt, createdAt, mode:'live'|'handoff', context:{kit:boolean, bed:string|null}, candidates:[{index,name,key,trimDb,features}]}`; `prediction.json` (agent's `{pick, shortlist, why, at}` + model's `{pick, shortlist, probabilities}`) — never served before ship; `events.jsonl`.
- [ ] Events (spec §7): `play`, `dud`, `love`, `duel {a,b,outcome:'a'|'b'|'tie'|'bothBad',tags,position}`, `refine {champion, directions}`, `round {n, candidates}`, `ship {champion}`, `abandon`. `appendEvent` validates with zod and appends one line. `foldSession(dir)` → `{stage:'lineup'|'duel'|'refine'|'shipped'|'abandoned', loved, duds, champion, rounds, duels, pending:{refine?}}`.
- [ ] `recordVerdicts(event, session)` expands to verdict rows: duel → 1 row (w 1) / tie → tie row / bothBad → 2 rows (w ½); love-vs-dud → implied rows (w ⅓) written when the lineup is submitted (event `lineup {loved, duds}`).
- [ ] `openSession(p, setId, {prompt, mode, context, requirePrediction})` — refuses with `E_PREDICTION_REQUIRED` when no agent prediction exists for the set and `--no-predict` was not given; model prediction = argmax utility (+ shortlist top 3).
- [ ] `reveal(session)` after ship: `{agent:{pick, hit, shortlistHit}, model:{pick, hit}, champion}` appended to `~/.agent-beeps/taste/predictions.jsonl` for stats.
- [ ] `stats({project?, since?})` → agent top-pick hit rate, shortlist hit rate, model hit rate, counts, per-window (last 10 / 50 / all).

### Task 5: Audition server
**Files:** `src/audition/server.ts`, `src/commands/audition.ts`, `tests/audition/server.test.ts`.
- [ ] `~/.agent-beeps/server.json {pid, port, token, host, startedAt}`; `serve` is idempotent (probe `GET /api/health` with token; reuse), `--stop` kills pid and removes the file; default host `0.0.0.0`, default port 47301 (next free if busy); printed links use `os.hostname()` (e.g. `http://hal9000:47301/s/<id>?t=<token>`).
- [ ] Routes: `GET /` queue page; `GET /s/<id>` audition page; static `runtime/**` (engine, look, audition assets); `GET /api/health`; `GET /api/sessions` (per project, with stage); `GET /api/session/<id>` (candidates with patch JSON and trims, context kit patches + trims, bed patch — **no predictions**); `POST /api/session/<id>/event` (token required; zod-validated; size cap 64 KB; ids `^[a-z0-9-]+$`); `GET /api/session/<id>/reveal` (404 until shipped). Multi-project: the server is started with `--project <dir>` roots it knows (stored in server.json `projects[]`; `audition open` registers its project).
- [ ] Hand-off auto-mutation: on a `refine` event when `session.mode === 'handoff'`, the server runs `mutate` in-process (lazy render host) and appends a `round` event.
- [ ] CLI: `serve [--host] [--port] [--stop]`, `predict --set <id> --pick n [--shortlist a,b] --why "..."`, `audition open --set <id> --prompt ".." [--mode live|handoff] [--context kit,bed] [--no-predict]` → `{url, session}`, `audition status --id`, `audition wait --id [--timeout 900]` (polls events.jsonl every 500 ms; returns first new actionable event after the last one the agent consumed — cursor stored in `sessions/<id>/agent-cursor`), `audition list`, `audition close --id` (abandon), `audition round --id --set <newSetId>` (agent answers a refine with its own set).
- [ ] Tests (no browser): serve/stop lifecycle; token enforcement (401); path traversal refused; event validation; wait returns refine; reveal hidden until ship.

### Task 6: Audition page
**Files:** `runtime/audition/index.html`, `runtime/audition/app.js`, `runtime/audition/style.css`, `runtime/audition/queue.html`, `tests/audition/page.test.ts` (Playwright).
- [ ] One AudioContext on first gesture; candidates play via `buildPatch(ctx, patch, {trimDb, variant, seed})` (live engine, loudness-matched by stored trims), `createPicker` for repeats.
- [ ] Context bar: single · ×5 @ 0.4 s · ×75 · stop; ⇄ with kit (interleaves kit sounds and the candidate 0.5 s apart); bed (loops the bed patch under at −10 LU); speaker full/laptop/phone (laptop: HP 180 Hz + LP 14 kHz; phone: HP 450 Hz + peaking +4 dB @ 2.5 kHz + LP 9 kHz).
- [ ] Lineup: cards (index, look thumbnail, measured words from features: bright/dark, short/long, soft/punchy, pitched/noisy), keys 1–8 play, H love, X dud, "Duel my ♥" submits `lineup`. Duel: A/B with randomised sides, Space plays A then B, ←/→/↓(same)/↑(both bad), why-tags; next pair from `/api/session/<id>` `nextDuel` (server computes via `select.ts`). Refine: direction chips + "more like #k" + "surprise me"; waiting spinner until a `round` event arrives (poll 1 s). Ship: confirm → reveal panel.
- [ ] Mobile-friendly layout (hal9000 from phone), dark/light, keyboard help overlay.
- [ ] Playwright e2e: open session → love 2 / dud 2 → duel → refine → (test acts as agent: appends `round`) → ship → reveal shows predictions; events.jsonl and verdicts.jsonl contain the expected rows.

### Task 7: Kit commands and taste CLI
**Files:** `src/commands/kit.ts`, `src/commands/taste.ts`.
- [ ] `kit list|add <ref> [--priority]|remove <name>|check` (check renders members and runs `lintKit`).
- [ ] `lint <refs...>` → per patch `lintPatch` report (+ judgement list).
- [ ] `taste show [--project-only]` (weights, σ, summary text, counts), `taste fit` (refit + write model.json + summary.md), `taste stats`.

### Task 8: Skills (then yoda)
**Files:** `skills/beeps-setup/SKILL.md`, `skills/beeps-compose/SKILL.md` (+ `references/patch-format.md`, `references/synthesis-methods.md`), `skills/beeps-craft/SKILL.md`, `skills/beeps-audition/SKILL.md`, `skills/beeps-taste/SKILL.md`, `tests/skills.test.ts` (exact list, frontmatter, standalone).
- [ ] Each skill: `name`, one-sentence `description`, `when_to_use` "Use when…" with trigger phrases and error strings; 30–150 lines; `<plugin-root>` resolution + `beeps` launcher convention from agent-vids; a Done bar.
- [ ] Run `hartye-skills:yoda` on each skill and on the library; apply its feedback.

### Task 9: README, simulated-listener acceptance, release prep
- [ ] README (agent-vids structure). Simulated-listener e2e: 5 sessions driven through the HTTP API by a hidden-weight listener → model hit rate > chance (1/count) by the last sessions. Full `npm test` + `typecheck`. Version stays 0.1.0 until the owner's first listening session.
