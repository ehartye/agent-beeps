# agent-beeps v1 — Engine, Audition and Taste (design)

**Status:** approved in brainstorming 2026-09-25 (sections 1–3 explicitly; 4–5 under the owner's "full auto" goal)
**Scope of this spec:** sub-projects 1 (core engine) + 2 (audition & taste) + a thin slice of 3 (SFX archetypes and craft rules).
**Deferred to their own specs:** music (sequencer, loops, jingles, adaptive layers), delivery (game runtime API polish, sound sprites, OGG, engine exports). **Claude Code hook beeps are deferred indefinitely** (owner: "not sure I want that").

## 1. Purpose

A procedural sound composer whose primary user is a coding agent and whose final judge is the owner's ear. The agent generates, renders, measures and looks at sounds; the owner auditions them on a LAN page (hal9000) and every explicit judgement trains a persistent taste model that ranks, steers and predicts future candidates. It is **mixed-initiative**: the agent does bulk generation, the owner steers. Evidence in the owner's wiki says players rarely hear procedural depth but do value choosing — the value of this tool is in the choosing loop.

Procedural only: no sample files, no AI audio models.

## 2. Architecture

- **Plugin repo** follows agent-vids/agent-meshes: TypeScript run by Node ≥ 24 (no build step for the CLI), npm with committed lockfile, exact-pinned deps, vitest, `tsc --noEmit`. Managed runtime trio `scripts/setup.js`, `scripts/managed-runtime.js`, `scripts/run-managed.js`; managed home `~/.agent-beeps` (`AGENT_BEEPS_HOME`), releases keyed `version-hash16-platform-arch-nodeABI`, Playwright Chromium installed into the release. Skills call `node "<plugin-root>/scripts/run-managed.js"` (written `beeps`).
- **One engine, three hosts.** `src/engine/` is plain browser-safe ES modules (no Node APIs, no deps) that turn a patch into a Web Audio graph on any `BaseAudioContext`. It is served as `runtime/` to: headless Chromium (`OfflineAudioContext`, CLI renders), the audition page (live playback), and games (optional live playback with variation). The measured graph is the shipped graph ("a measurement of a re-implementation measures the re-implementation").
- **Render host:** one Playwright Chromium per CLI invocation renders the whole batch in one page served from a local static server; PCM returns to Node as Float32. Renders are keyed by `sha256(canonical patch JSON + engine version + seed + sampleRate)` and cached under `.agent-beeps/cache/`.
- **Measurement in Node** (`src/measure/`): pure TS DSP over Float32 PCM.
- **Project state** `.agent-beeps/` (committable except `cache/`): `project.json` (scale, key, target loudness, defaults), `patches/*.json`, `kit.json`, `sessions/<id>/` (session.json, candidates, `events.jsonl`), `taste/verdicts.jsonl`, `renders/` (WAV + features + PNG per render hash).
- **Global state** `~/.agent-beeps/`: `taste/verdicts.jsonl` (all projects), `taste/model.json` (fitted), `taste/summary.md`, `server.json` (port, token), `releases/`.
- **Audition server** `beeps serve`: Node `http` (no framework), binds `0.0.0.0` by default (`--host` to override), persistent token in `server.json`, links printed with the machine hostname (e.g. `http://hal9000:47301/s/<id>?t=<token>`). Idempotent start (`serve` when already running prints the existing URL). Pages are static HTML/JS that import the same `runtime/` engine.

```
agent ──beeps generate/batch/mutate──▶ CLI ──batch──▶ Chromium(OfflineAudioContext + engine) ──PCM──▶ measure ──▶ renders/
agent ──beeps predict──▶ session (sealed)            beeps serve ──▶ audition page (engine live) ──verdicts/refine──▶ events.jsonl
events.jsonl ──▶ taste verdict logs (project + global) ──▶ Bradley-Terry fit ──▶ rank · steer · auto-predict · summary.md
agent ◀──beeps audition wait── events.jsonl
```

## 3. Patch format (`beeps/patch@1`)

Validated by zod; JSON Schema and examples exported by `beeps capabilities`.

```json
{ "schema": "beeps/patch@1", "name": "coin", "family": "pickup", "tags": ["bright"],
  "duration": 0.4,
  "layers": [
    { "source": { "type": "osc", "wave": "square", "pitch": "E6" },
      "pitchEnv": [{ "at": 0.06, "to": "B6", "curve": "step" }],
      "amp": { "attack": 0.004, "decay": 0.18, "sustain": 0, "release": 0.05 },
      "filter": { "type": "lowpass", "cutoff": 6000, "resonanceDb": 0 } },
    { "source": { "type": "noise", "color": "white" }, "amp": { "attack": 0.002, "decay": 0.03 }, "gainDb": -18 }
  ],
  "fx": { "reverb": { "sendDb": -20, "preset": "small" } },
  "variation": { "pitchCents": 40, "gainDb": 1.5, "variants": 4, "noRepeat": true },
  "meta": { "priority": 3 } }
```

**Sources** (each maps to named Web Audio nodes; all explained in `beeps-craft`):
- `osc` — sine/square/sawtooth/triangle, `unison` {voices, detuneCents} (phases spread, because in-phase unison *adds*).
- `noise` — white/pink/brown, from a seeded generated buffer (deterministic; long enough not to acquire pitch).
- `fm` — 2–4 operators with a routing `algorithm` (carrier/modulator graph), per-operator ratio, index envelope.
- `additive` — partial list `[ratio, gainDb, decay]` (the only method listeners could not tell from recordings).
- `modal` — bank of resonant bandpass modes `[freq|ratio, q, gainDb]` excited by `impulse` or `noiseBurst` (PhISAM: bells, wood, metal strikes).
- `grains` — Poisson-timed stochastic grains (rate, grain decay, bandpass centre/Q, rate envelope) (PhISEM: shakers, rain, debris, crackle).
- `metal` — six inharmonic squares through two bandpasses (the 808 recipe), `bands` and `decay`.

**Per layer:** `start` offset, `gainDb`, `pitchEnv` (points with curve linear/exp/step), `amp` ADSR, `filter` (`lowpass|highpass` take `resonanceDb` — Chromium's LP/HP Q *is* dB; `bandpass|notch|peaking` take a true `q`) with optional cutoff envelope, `lfo` (target pitch|gain|cutoff, rate, depth), `drive` (waveshaper amount), `pan`.

**Master:** `fx.delay` {time, feedback, sendDb}, `fx.reverb` {preset small|room|hall|cave, sendDb} — generated-IR convolver built once per preset from seeded noise with descending lowpass (never a DelayNode FDN); always-on safety stage. *(As built: a stateless WaveShaper soft clipper - identity below −3 dBFS, tanh into a −1 dBFS ceiling, no oversampling - because Chromium's DynamicsCompressorNode shifted level by 1–3 dB even 40 dB under threshold, and 4× oversampling overshot the ceiling on hard clips. The loudness trim is also capped so the delivered true peak stays ≤ −1.5 dBTP.)*

**Pitch:** note names (`E6`) or Hz; `project.json` `scale` (default major pentatonic in C) with `snap: true` so pitched sources land in key and overlapping sounds don't clash.

**Level:** patches never carry a loudness literal. The renderer measures the *authored (pre-limiter)* tap and computes a trim so the sound meets `project.targetLoudness` (default **−18 LUFS max-momentary** for one-shots, per-family offsets from craft rules). The trim is stored with the render and applied by the runtime. ("A gain literal is not a loudness.")

**Variation:** `pitchCents`, `gainDb`, `variants` N (seeded parameter perturbation within declared ranges), `noRepeat`, and `weights` (Halo-style permutation weighting / skip fraction). The runtime picks variants with its own seeded RNG.

**Validation errors** carry a JSON pointer (`/layers/1/filter/q`) and a hint ("lowpass takes resonanceDb, not q").

## 4. Archetypes and generation

`library/archetypes/*.json`: a template patch plus parameter **ranges** and constraints. v1 set (16): `coin`, `pickup`, `jump`, `land`, `hit`, `explosion`, `laser`, `powerup`, `powerdown`, `ui-click`, `ui-hover`, `confirm`, `no` (soft falling figure, never a buzzer), `blip` (text), `whoosh`, `alarm`. `coin` and `pickup` are separate families on purpose (a recurring sound is a class label).

`beeps generate <archetype> --count 8 [--seed] [--near <patch>] [--prompt "..."]`:
1. sample 4× count candidates from ranges (seeded),
2. render + measure all (one browser),
3. choose `count` by farthest-point selection in normalized feature space (diversity), with the taste model's utility as a tie-weight when the model has confidence,
4. write them as a candidate set under `.agent-beeps/sets/<id>/`.

Agents may also author patches directly (`beeps new`, `beeps batch ops.json`), and use `beeps mutate <patch> --toward brighter,shorter --count 4` (steps parameters, re-measures, keeps mutations whose feature deltas move in the requested direction and are taste-favoured) and `beeps crossover <a> <b>`.

Refine directions map to features: brighter/darker → centroid & sharpness; punchier/softer → attack & crest; shorter/longer → energy length; less harsh → sharpness & roughness down; more character → roughness/fluctuation/pitch movement up; "more like #k" → crossover toward k.

## 5. Measurement (`src/measure/`)

Per render, from PCM (authored tap and delivered tap):
- peak, true peak (4× oversampled), DC offset, clipping count
- loudness: BS.1770 K-weighting; momentary (400 ms) max, short-term, integrated (reported but flagged unreliable < 1 s)
- attack time (10→90 % of envelope peak), energy length (to −40 dB below peak), tail length (to −60 dB)
- spectral centroid (mean & at peak), spectral flatness (noisiness), band energies (log-spaced)
- sharpness (DIN 45692 approximation over Zwicker-style specific loudness), roughness (asper approximation, envelope AM analysis around 70 Hz in critical bands), fluctuation strength (~4 Hz AM), tonality/pitch strength and pitch track (YIN) with pitch direction
- Nyquist/alias guard: flags partial energy declared above 0.45·fs

Also a **look** image per render: waveform + log spectrogram + feature strip PNG (rendered in the same Chromium page via canvas), and a contact sheet for a set. The agent cannot hear; it can look and read numbers.

Psychoacoustic metrics are **indicators, not verdicts**; they diagnose named defects and feed the taste model — the owner's ear grades.

## 6. Craft rules (`craft/rules.json`, `craft/GUIDE.md`)

agent-vids pattern: `{id, statement, value, unit, check: "auto"|"judgement", severity: "error"|"warn", sources: [...]}`, citing primary sources directly (the plugin never references the owner's wiki). `beeps lint <patch|set|kit>`; judgement rules are listed as "applied by judgement", never silently skipped. v1 rules include: true peak ≤ −1 dBTP; attack ≥ 4 ms unless `click` intent; no declared partial above Nyquist; energy length ceilings per family (ticks ≤ 60 ms); sharpness warn threshold; roughness warn; no DC; variation present on any patch tagged `repeating`; one `no` per kit; priority uses ≤ 5 levels; gated beds are silent when idle; family consistency (pickup family centroid spread bound); reverb via preset convolver only.

`beeps kit check`: family consistency, key consistency, masking/critical-band overlap between kit members, priority levels, missing/duplicate "no".

## 7. Audition (the feedback loop)

**Open:** `beeps audition open --set <id> --prompt "coin for a cozy platformer" [--context kit|bed|both] [--mode live|handoff]`. Requires a sealed agent prediction first: `beeps predict --set <id> --pick 3 --shortlist 2,3,5 --why "..."` (the open command refuses without it unless `--no-predict` is given, which is recorded). The taste model also records its own sealed prediction.

**Page** (`/s/<id>`; queue at `/`): three stages, one context bar.
- **Context bar:** single · repeat ×5 @ 0.4 s · repeat ×75 (variation on) · stop; ⇄ interleave with kit sounds; bed on/off (project bed patch, or built-in neutral bed); speaker sim full/laptop/phone (filter + level curves); all candidates loudness-matched by measured trim.
- **① Lineup** (default 6, max 8; keys 1–8 play, H ♥, X ✗): ✗ the duds, ♥ 2–3.
- **② Duel** winner-stays over ♥: A better / same / both bad / B better; optional why-tags (brighter, darker, punchier, softer, shorter, longer, less harsh, more character). Left/right position randomized per duel (position bias).
- **③ Refine** chips on the champion post a `refine` event; next round is 4 mutations vs the champion (generated by the waiting agent, or by the server's auto-mutator if the agent handed off).
- **Ship** writes the champion to `patches/` and `kit.json`, then **reveals** agent and model predictions and running agreement.

**Events** (`sessions/<id>/events.jsonl`, append-only): `play` (engagement only — never a verdict), `dud`, `love`, `duel {a,b,outcome,tags,position}`, `refine {champion,directions}`, `round {n,candidates}`, `ship {champion}`, `abandon`. Verdicts expand: duel → one pair (weight 1; tie = ½; bothBad → both lose to a family-mean reference, weight ½); love vs dud → implied pairs (weight ⅓). Each verdict row stores both feature vectors so the log alone refits the model.

**Loop modes:** `beeps audition wait --id <id> [--timeout]` blocks until the next actionable event (`refine`, `ship`, `abandon`) and prints it as JSON — used for live waiting (agent runs it in the background / via Monitor and reacts). Hand-off mode: agent posts the link and ends its turn; `beeps audition status` reads results later; the server auto-mutates refine requests. Pending sessions persist.

## 8. Taste model (`src/taste/`)

- **Feature vector** per render (section 5), z-scored within family (so "bright for a coin" is relative to coins).
- **Model:** Bradley-Terry / logistic on feature differences, L2 prior toward 0 (neutral until data), weighted verdicts, ties as ½. Fit by Newton/IRLS in plain TS.
- **Layers:** global weights `w_g` from `~/.agent-beeps/taste/verdicts.jsonl`; project offset `w_p` from the project log once it has ≥ 15 verdicts (shrunk toward 0). Utility = `(w_g + w_p)·x`, with σ from the Laplace approximation.
- **Always refit from logs** (`beeps taste fit` idempotent; `model.json` is a cache).
- **Uses:** candidate tie-weighting in generate, mutation acceptance, model's sealed prediction, `beeps taste show` (JSON + `summary.md` in plain words with confidence: strong / weak / unknown per feature).
- **Stats:** `beeps taste stats` — agent top-pick hit rate, shortlist hit rate, model hit rate, over time windows, per project and global.

## 9. CLI contract

`beeps <command>`; JSON to stdout (`--quiet` for machine use), one-line JSON error `{code, message, pointer?, hint?}` to stderr, non-zero exit. Commands: `capabilities`, `init`, `new`, `batch [--dry-run]`, `generate`, `mutate`, `crossover`, `render`, `measure`, `look`, `lint`, `kit list|add|remove|check`, `predict`, `audition open|status|wait|list|close`, `serve [--stop] [--host] [--port]`, `taste show|fit|stats`, `export <patch> --wav <path> [--variant n]`. Stable error codes: `E_SCHEMA`, `E_NOT_FOUND`, `E_RENDER`, `E_BROWSER_MISSING`, `E_RUNTIME_MISSING`, `E_SERVER`, `E_PREDICTION_REQUIRED`, `E_CONFLICT`.

## 10. Skills

New-style frontmatter (`name` = dir, one-sentence `description`, `when_to_use` starting "Use when…"), 30–150 lines, overflow in `references/`. Every skill gets a `hartye-skills:yoda` audit before release.

| Skill | Job |
|---|---|
| `beeps-setup` | install/check managed runtime + Chromium; version sync |
| `beeps-compose` | init a project, generate/author/mutate patches, the render→look→lint loop, synthesis-method choice |
| `beeps-craft` | SFX craft: loudness, attack floor, key, variation/fatigue, "one no", silent-not-quiet, family/class-label sounds, blend, priority; which synthesis method for which material |
| `beeps-audition` | predict first, open, live-wait or hand off, answer refine events, ship, read the reveal |
| `beeps-taste` | read the taste profile before composing; interpret stats |

## 11. Errors and robustness

- Chromium missing → `E_BROWSER_MISSING` naming `beeps-setup`.
- A failed patch in a batch fails only that item (per-item `{ok:false,error}`), batch exit code non-zero if any failed.
- Offline render gotcha: voice-admission counters must not be pre-reserved before `startRendering()` (reservations keyed by scheduled time) — else later events are silently dropped.
- Server: idempotent start, stale `server.json` detection (PID/port probe), token required on all mutating endpoints, request bodies size-capped, file paths never taken from the client (ids only, validated `^[a-z0-9-]+$`).
- Append-only logs written with a single `appendFile` per event (line-atomic for our sizes); fits tolerate and report malformed lines.

## 12. Testing and verification

- **Unit (vitest):** schema accept/reject with pointers; note/scale snapping; canonical hashing; measurement on synthetic signals with known answers (sine centroid = f; white-noise flatness ≈ 1; 1 kHz −20 dBFS sine momentary loudness ≈ −23.3 LUFS per BS.1770 reference; attack/tail on synthetic envelopes; AM at 70 Hz raises roughness vs unmodulated); Bradley-Terry recovers known weights from a **simulated listener** and beats chance on held-out pairs; verdict expansion rules; event log fold; archetype sampling within ranges; farthest-point diversity.
- **Browser integration** (Chromium, skipped with a clear message if not installed): renders are deterministic for a seed; Chromium facts hold (sawtooth at 6 kHz peaks ≈ 0.74; bandpass at Q 5 attenuates off-band); every archetype renders without clipping at the true-peak ceiling and passes lint; loudness trim lands within ±1 LU of target.
- **End-to-end:** server + Playwright drive a full session lineup→duel→refine→ship; events and verdicts written; `audition wait` returns the refine; reveal shows predictions; a simulated listener run over several sessions shows model agreement rising above chance.
- **Skills test:** exact skill list, frontmatter rules, standalone (no wiki links).
- **Definition of done** excludes subjective quality: the owner's listening is acceptance; numbers are evidence of signal behaviour only.

## 13. Out of scope for v1

Music sequencing, jingles, adaptive layers, sound sprites/OGG/engine exporters, game-runtime voice manager (priority metadata is recorded now; enforcement ships with delivery), Claude Code hook sounds, AI audio, MIDI/soundfonts.
