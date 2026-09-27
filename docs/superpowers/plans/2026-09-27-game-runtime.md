# Game Runtime and Adaptive Layers Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use h-superpowers:subagent-driven-development, h-superpowers:team-driven-development, or h-superpowers:executing-plans to implement this plan (ask user which approach). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a vendored, dependency-free Web Audio player that games use to play exported agent-beeps audio. The player adds voice management, mix protection, crossfades and adaptive vertical layers. Space to Grow is then migrated onto it.

**Architecture:**
- **Pure logic in small modules.** These live in `runtime/player/` and are unit-tested with vitest and the existing `FakeContext`: the voice manager, bar timing and the lifecycle queue.
- **One composing module.** `runtime/player/player.js` holds the Web Audio graph. It reuses the engine's safety clipper (`runtime/engine/fx.js`) and variant picker (`runtime/engine/variation.js`).
- **CLI side.** Export sidecars gain optional fields. `beeps export --variants`, `beeps song export --layers`, `beeps bundle` and `beeps player export` produce everything a game loads.

**Tech Stack:** TypeScript on Node 24 (no build step), Zod 4, Commander, vitest, Playwright Chromium, and plain ES modules with JSDoc types in `runtime/`. `checkJs` is strict there.

**Spec:** `docs/superpowers/specs/2026-09-27-game-runtime-design.md`.

**Priority direction:** `priority` 1 is the most important and 5 the least. This is the FMOD convention already used by `meta.priority`, `src/kit.ts` and `patch-format.md`. A new sound may steal only a voice whose number is strictly *larger*, that is, a less important voice.

**Amendments to the spec, made while planning.** Task 0 records them in the spec.
1. **The player is vendored as a directory, not a single inlined file.** `beeps player export <dir>` writes `<dir>/beeps-player/{player,engine}/*.js` and keeps the runtime's relative imports. That needs no bundler and has no risk of name collisions. The header and `VERSION.json` still record the versions.
2. **`song export --layers` is a flag, not `--layers <dir>`.** Layer WAVs are written next to `--wav` as `<stem>.<layer>.wav`, so the sidecar can name them relative to itself.
3. **Stems and layers render the full song with an `only` track filter.** This was revised during Task 6. Every note, chance roll and noise seed then matches the mix, full-render output and cache keys stay unchanged, and `ENGINE_VERSION` stays 1. The plan's first approach used `soloSong`, which removes plays. That changed the shared random stream: `?` hits, random arps and noise seeds came out differently, and layers nulled at only -23 dB. `song render --only` uses the same filter, with its own solo trim and `loop: false`.
4. **The player's catalog keys are the asset ids.** It accepts any `{ assets: { <key>: <sidecar> } }`: both `beeps/audio-bundle@1` and the hand-built manifests games already have. Space to Grow keys its assets by game ids such as `music-garden`, which differ from the sidecar ids.
5. **The per-sound instance cap replaces the sound's own oldest instance.** It does not drop the new request. A repeated sound, such as footsteps, keeps sounding current.

**Conventions:**
- **Tests.** Run `npx vitest run <file>`; the full suite is `npm test`. Typecheck with `npx tsc --noEmit`. Browser and render tests use `it.skipIf(!hasChromium)`, with `hasChromium = await chromiumAvailable()` from `src/render/host.ts`.
- **Git.** Work on a feature branch or worktree, never `main`. Commit after each task. End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Debugging.** If a test fails for a reason the plan did not predict, use @h-superpowers:systematic-debugging before changing code. Do not loosen thresholds to make a test pass.

---

## File map

| File | Responsibility |
|---|---|
| `src/export-manifest.ts` (modify) | the sidecar schema gains optional fields; `writeExportManifest` takes `extra` and `path` |
| `src/commands/patches.ts` (modify) | `export --variants [n]` |
| `src/schema/song.ts` (modify) | the `adaptive` block and its cross-checks |
| `craft/music-rules.json`, `src/song-lint.ts` (modify) | the `song-adaptive-states` judgement rule, in scope only for adaptive songs |
| `src/render/layers.ts` (create) | `renderLayers`, `nullResidualDb`, `readChannels` |
| `src/commands/songs.ts` (modify) | `song export --layers` |
| `src/bundle.ts` (create) | `bundleDir`: sidecars → `index.json` |
| `src/commands/player.ts` (create) | `bundle <dir>`, `player export <dir>`, `exportPlayer` |
| `src/cli.ts` (modify) | register the player commands |
| `runtime/player/voices.js` (create) | the pure voice manager |
| `runtime/player/timing.js` (create) | `nextBarTime` |
| `runtime/player/lifecycle.js` (create) | the serialized resume/suspend queue |
| `runtime/player/player.js` (create) | `createPlayer`: the graph, buses, clipper, SFX, beds, adaptive layers |
| `tests/helpers/fake-context.ts` (modify) | `decodeAudioData`, `resume`/`suspend`/`state`, `disconnect` |
| `tests/player/*.test.ts` (create) | the tests below |
| `skills/beeps-music/SKILL.md`, `skills/beeps-music/references/song-format.md`, `skills/beeps-compose/SKILL.md`, `README.md` (modify) | docs |
| room2grow `src/audio.mjs`, `tests/audio.test.mjs`, `scripts/build.mjs`, `src/vendor/beeps-player/**` | migration (Task 13) |

---

### Task 0: Record the planning amendments in the spec

**Files:**
- Modify: `docs/superpowers/specs/2026-09-27-game-runtime-design.md` (end of file)

- [ ] **Step 1: Append the amendments section**

Append this to the end of the spec:

```markdown
## Amendments made while planning (2026-09-27)

1. The player is vendored as a directory, `<dir>/beeps-player/{player,engine}/*.js`, which keeps
   the runtime's relative imports. It is not a single inlined file. No bundler is needed and names
   cannot collide. The header and `VERSION.json` record the versions.
2. `song export --layers` is a flag. Layer WAVs are written next to `--wav` as `<stem>.<layer>.wav`.
3. `song stems` already renders loop-folded solos at the mix trim, and layers reuse that path.
4. The player uses catalog keys as asset ids and accepts any `{ assets: {...} }` object, including
   hand-built game manifests whose keys differ from the sidecar ids.
5. The per-sound instance cap replaces that sound's oldest instance rather than dropping the new
   request.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-09-27-game-runtime-design.md
git commit -m "docs: record game runtime planning amendments"
```

---

### Task 1: Sidecar schema fields and `writeExportManifest` extras

**Files:**
- Modify: `src/export-manifest.ts`
- Test: `tests/player/manifest-fields.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/player/manifest-fields.test.ts
import { describe, expect, it } from 'vitest';
import { ExportManifestSchema } from '../../src/export-manifest.ts';

const base = {
  schema: 'beeps/audio-asset@1', id: 'coin', label: 'Coin', description: '', role: 'sfx', file: 'coin.wav', loop: false,
  durationSec: 0.3, sampleRate: 48000, channels: 2, renderKey: 'k', loudness: { metric: 'momentary-max', lufs: -18 },
  truePeakDb: -3, normalizationAlreadyApplied: true,
};

describe('audio asset sidecar fields', () => {
  it('still accepts sidecars written before the optional fields existed', () => {
    expect(ExportManifestSchema.safeParse(base).success).toBe(true);
  });

  it('accepts priority, variants, no-repeat, tempo and adaptive layers', () => {
    const r = ExportManifestSchema.safeParse({
      ...base, priority: 4, noRepeat: true, variants: [{ file: 'coin.0.wav', weight: 2 }, { file: 'coin.1.wav' }],
      bpm: 120, meter: 4, layers: [{ name: 'bed', file: 'theme.bed.wav' }], states: { calm: ['bed'] }, initialState: 'calm',
    });
    expect(r.success).toBe(true);
  });

  it('rejects an out-of-range priority and an empty variant list', () => {
    expect(ExportManifestSchema.safeParse({ ...base, priority: 9 }).success).toBe(false);
    expect(ExportManifestSchema.safeParse({ ...base, variants: [] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/player/manifest-fields.test.ts`
Expected: FAIL. The second test fails because the schema is strict and rejects the unknown `priority` key. The third passes only by accident.

- [ ] **Step 3: Extend the schema and the writer**

In `src/export-manifest.ts`, replace the `ExportManifestSchema` definition with:

```ts
const Variant = z.strictObject({ file: z.string().min(1), weight: z.number().min(0).optional() });
const LayerFile = z.strictObject({ name: z.string().min(1), file: z.string().min(1) });
export const ExportManifestSchema = z.strictObject({
  schema: z.literal('beeps/audio-asset@1'),
  id: z.string().min(1), label: z.string().min(1), description: z.string(),
  role: Role, file: z.string().min(1), loop: z.boolean(),
  durationSec: z.number().positive(), sampleRate: z.number().int().positive(), channels: z.number().int().positive(),
  renderKey: z.string().min(1),
  loudness: z.strictObject({ metric: z.enum(['momentary-max', 'integrated']), lufs: z.number() }),
  truePeakDb: z.number(), normalizationAlreadyApplied: z.literal(true),
  // Optional, additive: sidecars written before these existed stay valid.
  priority: z.number().int().min(1).max(5).optional(),
  variants: z.array(Variant).min(1).optional(),
  noRepeat: z.boolean().optional(),
  bpm: z.number().positive().optional(),
  meter: z.number().int().positive().optional(),
  layers: z.array(LayerFile).min(1).optional(),
  states: z.record(z.string(), z.array(z.string())).optional(),
  initialState: z.string().optional(),
});
export type ExportManifest = z.infer<typeof ExportManifestSchema>;
```

Change `writeExportManifest` in these ways:
- Its signature and the `parse` call gain `extra` and `path`.
- Patches record their priority.
- Songs record their tempo and meter.

```ts
/** Called after the WAV copy. Internal exports use writeWav's canonical 44-byte PCM header. */
export function writeExportManifest(wav: string, rendered: Rendered | RenderedSong, role: ExportRole, extra: Partial<ExportManifest> = {}, path = `${wav}.json`): string {
```

Keep the header checks and the existing object as they are. Then, in the object passed to `ExportManifestSchema.parse`, add these entries after `normalizationAlreadyApplied: true,`:

```ts
    ...(song ? { bpm: song.bpm, meter: song.meter } : { priority: (rendered as Rendered).patch.meta?.priority ?? 3 }),
    ...extra,
```

Delete the line `const path = \`${wav}.json\`;`, because `path` is now a parameter. The `writeFileSync(path, ...)` and `return path;` lines stay.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/player/manifest-fields.test.ts tests/export-manifest.test.ts`
Expected: PASS. The existing export-manifest tests use `toMatchObject`, so the added fields do not break them.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/export-manifest.ts tests/player/manifest-fields.test.ts
git commit -m "feat: optional priority, variant, tempo and layer fields in export sidecars"
```

---

### Task 2: `beeps export --variants [n]`

**Files:**
- Modify: `src/commands/patches.ts:99-118` (the `export <ref>` command)
- Test: `tests/player/variants-export.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/player/variants-export.test.ts
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { initProject, savePatch } from '../../src/project.ts';
import { chromiumAvailable } from '../../src/render/host.ts';
import { coin } from '../helpers/patches.ts';

const bin = join(import.meta.dirname, '..', '..', 'scripts/beeps.mjs');
const hasChromium = await chromiumAvailable();
function run(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  return { ...r, data: r.stdout.trim() ? JSON.parse(r.stdout) : undefined };
}

it.skipIf(!hasChromium)('exports every declared variant with one sidecar listing them', () => {
  const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-variants-')));
  savePatch(p, { ...coin(), variation: { pitchCents: 30, gainDb: 1, variants: 3, noRepeat: true, weights: [2, 1, 1] }, meta: { priority: 4, intent: 'oneshot' } });
  const r = run(p.paths.root, 'export', 'coin', '--wav', 'audio/coin.wav', '--variants', '--manifest');
  expect(r.status, r.stderr).toBe(0);
  expect(r.data.wavs.map((f: string) => basename(f))).toEqual(['coin.0.wav', 'coin.1.wav', 'coin.2.wav']);
  const m = JSON.parse(readFileSync(join(p.paths.root, 'audio/coin.wav.json'), 'utf8'));
  expect(m).toMatchObject({ id: 'coin', file: 'coin.0.wav', priority: 4, noRepeat: true,
    variants: [{ file: 'coin.0.wav', weight: 2 }, { file: 'coin.1.wav', weight: 1 }, { file: 'coin.2.wav', weight: 1 }] });

  const two = run(p.paths.root, 'export', 'coin', '--wav', 'audio/two.wav', '--variants', '2');
  expect(two.status, two.stderr).toBe(0);
  expect(two.data.wavs).toHaveLength(2);

  const bad = run(p.paths.root, 'export', 'coin', '--wav', 'audio/bad.wav', '--variants', '0');
  expect(bad.status).not.toBe(0);
  expect(JSON.parse(bad.stderr).error.code).toBe('E_USAGE');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/player/variants-export.test.ts`
Expected: FAIL. Commander rejects the unknown option `--variants`.

- [ ] **Step 3: Implement**

In `src/commands/patches.ts`:
- Change the `node:path` import to `import { basename, dirname, join, resolve } from 'node:path';`.
- Add the option after `.option('--variant <n>', ...)` on the `export <ref>` command:

```ts
    .option('--variants [n]', 'export variants 0..n-1 (default: every declared variant) as <wav-stem>.<i>.wav; the sidecar lists them')
```

Change the action's `opts` type to include `variants?: boolean | string`. Then insert this at the top of the action, after `const seed = ...`:

```ts
      if (opts.variants !== undefined) {
        const patch = loadPatch(p, ref);
        const n = opts.variants === true ? (patch.variation?.variants ?? 1) : Number(opts.variants);
        if (!Number.isInteger(n) || n < 1 || n > 16) throw new BeepsError('E_USAGE', '--variants takes a count from 1 to 16');
        const outs = await withHost(host => renderAndMeasure(host, Array.from({ length: n }, (_, variant) => ({ patch, seed, variant })), { project: p.project, rendersDir: p.paths.renders }));
        const ok = outs.map(o => { if (!o.ok) throw new BeepsError('E_RENDER', o.error); return o; });
        const dest = resolve(opts.wav), stem = dest.replace(/\.wav$/i, '');
        mkdirSync(dirname(dest), { recursive: true });
        const wavs = ok.map((o, i) => { const f = `${stem}.${i}.wav`; copyFileSync(o.wavPath, f); return f; });
        const weights = patch.variation?.weights;
        const manifest = opts.manifest
          ? writeExportManifest(wavs[0], ok[0], role, { variants: wavs.map((f, i) => ({ file: basename(f), weight: weights?.[i] ?? 1 })), noRepeat: patch.variation?.noRepeat ?? true }, `${dest}.json`)
          : undefined;
        io.emit({ ...summary(ok[0]), wavs, ...(manifest ? { manifest } : {}) });
        return;
      }
```

The rest of the action does not change. `loadPatch`, `renderAndMeasure`, `withHost`, `summary`, `copyFileSync` and `mkdirSync` are already imported in this file. Check the import lines and add any that are missing.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/player/variants-export.test.ts tests/export-manifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/commands/patches.ts tests/player/variants-export.test.ts
git commit -m "feat: export every patch variant with one sidecar"
```

---

### Task 3: The song `adaptive` block

**Files:**
- Modify: `src/schema/song.ts` (the `SongSchema` object and `crossCheck`)
- Test: `tests/player/adaptive-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/player/adaptive-schema.test.ts
import { describe, expect, it } from 'vitest';
import { parseSong } from '../../src/schema/song.ts';
import { songInput } from '../helpers/songs.ts';

const adaptive = { layers: { bed: ['pad'], pulse: ['hat'] }, states: { calm: ['bed'], full: ['bed', 'pulse'] }, initial: 'calm' };
const issues = (over: Record<string, unknown>) => { const r = parseSong(songInput(over)); return r.ok ? [] : r.issues; };

describe('adaptive songs', () => {
  it('accepts layers that partition the tracks, states over those layers and an initial state', () => {
    expect(issues({ loop: true, adaptive })).toEqual([]);
  });

  it('requires a loop', () => {
    expect(issues({ adaptive })).toContainEqual(expect.objectContaining({ pointer: '/adaptive', message: expect.stringMatching(/loop/) }));
  });

  it('puts every track in exactly one layer', () => {
    const twice = issues({ loop: true, adaptive: { ...adaptive, layers: { bed: ['pad', 'hat'], pulse: ['hat'] } } });
    expect(twice).toContainEqual(expect.objectContaining({ pointer: '/adaptive/layers/pulse/0', message: expect.stringMatching(/already in layer "bed"/) }));
    const none = issues({ loop: true, adaptive: { ...adaptive, layers: { bed: ['pad'] }, states: { calm: ['bed'] } } });
    expect(none).toContainEqual(expect.objectContaining({ pointer: '/adaptive/layers', message: 'track "hat" is in no layer' }));
    const unknown = issues({ loop: true, adaptive: { ...adaptive, layers: { bed: ['pad', 'lead'], pulse: ['hat'] } } });
    expect(unknown).toContainEqual(expect.objectContaining({ pointer: '/adaptive/layers/bed/1', message: 'no track "lead"' }));
  });

  it('checks state layers and the initial state', () => {
    expect(issues({ loop: true, adaptive: { ...adaptive, states: { calm: ['bed', 'drums'] } } }))
      .toContainEqual(expect.objectContaining({ pointer: '/adaptive/states/calm/1', message: 'no layer "drums"' }));
    expect(issues({ loop: true, adaptive: { ...adaptive, initial: 'boss' } }))
      .toContainEqual(expect.objectContaining({ pointer: '/adaptive/initial', message: 'no state "boss"' }));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/player/adaptive-schema.test.ts`
Expected: FAIL. The strict schema rejects the unknown key `adaptive`.

- [ ] **Step 3: Implement**

In `src/schema/song.ts`, add this above `export const SongSchema`:

```ts
/** Vertical layers a game fades in and out by state: every track in one layer, states name layers. */
const Adaptive = z.strictObject({
  layers: z.record(Name, z.array(z.string()).min(1)).describe('layer name -> the tracks it contains; every track is in exactly one layer'),
  states: z.record(Name, z.array(z.string()).min(1)).describe('state name -> the layers that play in it'),
  initial: z.string().describe('the state the song starts in'),
}).describe('adaptive vertical layers for the game player; needs loop: true');
```

In `SongSchema`, add `adaptive: Adaptive.optional(),` as the last property, after `master: ...`.

In `crossCheck`, insert this before `// Inline patches validate here;`:

```ts
  if (s.adaptive) {
    const a = s.adaptive;
    if (!s.loop) out.push({ pointer: at('adaptive'), message: 'adaptive layers need "loop": true', hint: 'layers loop under gameplay; set "loop": true' });
    const owner = new Map<string, string>();
    for (const [layer, tracks] of Object.entries(a.layers)) tracks.forEach((t, i) => {
      if (!(t in s.tracks)) out.push({ pointer: at('adaptive', 'layers', layer, i), message: `no track "${t}"`, hint: `tracks: ${Object.keys(s.tracks).join(', ')}` });
      else if (owner.has(t)) out.push({ pointer: at('adaptive', 'layers', layer, i), message: `track "${t}" is already in layer "${owner.get(t)}"`, hint: 'every track belongs to exactly one layer' });
      else owner.set(t, layer);
    });
    for (const t of Object.keys(s.tracks)) if (!owner.has(t)) out.push({ pointer: at('adaptive', 'layers'), message: `track "${t}" is in no layer`, hint: 'every track belongs to exactly one layer' });
    for (const [state, layers] of Object.entries(a.states)) layers.forEach((l, i) => {
      if (!(l in a.layers)) out.push({ pointer: at('adaptive', 'states', state, i), message: `no layer "${l}"`, hint: `layers: ${Object.keys(a.layers).join(', ')}` });
    });
    if (!(a.initial in a.states)) out.push({ pointer: at('adaptive', 'initial'), message: `no state "${a.initial}"`, hint: `states: ${Object.keys(a.states).join(', ')}` });
  }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/player/adaptive-schema.test.ts tests/music`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/schema/song.ts tests/player/adaptive-schema.test.ts
git commit -m "feat: adaptive layer and state block in songs"
```

---

### Task 4: The `song-adaptive-states` judgement rule

**Files:**
- Modify: `craft/music-rules.json` (append a rule to `rules`)
- Modify: `src/song-lint.ts` (the `inScope` filter)
- Test: `tests/music/song-lint.test.ts` (append a test)

- [ ] **Step 1: Write the failing test**

Append this inside the first `describe('song lint', ...)` block of `tests/music/song-lint.test.ts`:

```ts
  it('asks for each adaptive state to stand alone only when the song is adaptive', () => {
    const adaptive = song({ loop: true, adaptive: { layers: { bed: ['pad'], pulse: ['hat'] }, states: { calm: ['bed'], full: ['bed', 'pulse'] }, initial: 'calm' } });
    expect(lintSong(adaptive, good(), project).judgement).toContain('song-adaptive-states');
    expect(lintSong(song(), good(), project).judgement).not.toContain('song-adaptive-states');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/music/song-lint.test.ts`
Expected: FAIL. `judgement` does not contain `song-adaptive-states`.

- [ ] **Step 3: Implement**

Append this rule object to the `rules` array in `craft/music-rules.json`, after the `song-fatigue` rule:

```json
    {
      "id": "song-adaptive-states",
      "statement": "Every adaptive state is music on its own: the calm state may be all the player hears for minutes, so render and listen to each state's layers alone, not only the full mix.",
      "check": "judgement",
      "severity": "warn",
      "appliesTo": "song",
      "sources": [
        {
          "title": "Collins, Game Sound (MIT Press, 2008), ch. 8: variable mixing (layering of instruments)",
          "url": "https://direct.mit.edu/books/monograph/2460/Game-SoundAn-Introduction-to-the-History-Theory"
        }
      ]
    }
```

In `src/song-lint.ts`, replace the line
`const inScope = rules.filter(r => r.id !== 'song-fatigue' || heardLong);`
with:

```ts
  const inScope = rules.filter(r => (r.id !== 'song-fatigue' || heardLong) && (r.id !== 'song-adaptive-states' || !!song.adaptive));
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/music tests/lint.test.ts`
Expected: PASS. The first song-lint test still expects `['song-register-bands', 'song-fatigue']` for a plain song.

- [ ] **Step 5: Commit**

```bash
git add craft/music-rules.json src/song-lint.ts tests/music/song-lint.test.ts
git commit -m "feat: judgement rule asking adaptive states to stand alone"
```

---

### Task 5: Layer rendering and the null test

**Files:**
- Create: `src/render/layers.ts`
- Test: `tests/player/null-residual.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/player/null-residual.test.ts
import { describe, expect, it } from 'vitest';
import { nullResidualDb } from '../../src/render/layers.ts';

const sine = (n: number, amp: number, phase = 0) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(i / 7 + phase));

describe('null residual', () => {
  it('is -Infinity when the layers sum exactly to the mix', () => {
    const a = sine(1000, 0.2), b = sine(1000, 0.1, 1);
    const mix = Float32Array.from(a, (x, i) => x + b[i]);
    expect(nullResidualDb([mix, mix], [[a, a], [b, b]])).toBe(-Infinity);
  });

  it('measures a missing layer relative to the mix', () => {
    const a = sine(1000, 0.2), b = sine(1000, 0.02, 1);
    const mix = Float32Array.from(a, (x, i) => x + b[i]);
    // Leaving out b (a tenth of a's amplitude) leaves roughly -20 dB of residual.
    expect(nullResidualDb([mix], [[a]])).toBeGreaterThan(-21);
    expect(nullResidualDb([mix], [[a]])).toBeLessThan(-19);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/player/null-residual.test.ts`
Expected: FAIL, because `src/render/layers.ts` does not exist.

- [ ] **Step 3: Implement**

```ts
// src/render/layers.ts
// Adaptive layers: each layer rendered alone the way song stems are (loop-folded, at the mix's
// trim), so a game can fade them independently and their sum is still the approved mix.
import { readFileSync } from 'node:fs';
import { BeepsError } from '../errors.ts';
import { readWav } from '../audio/wav.ts';
import { soloSong } from '../music.ts';
import { renderSong, type RenderedSong } from './song-pipeline.ts';
import type { RenderHost } from './host.ts';
import type { Song } from '../schema/song.ts';
import type { Patch } from '../schema/patch.ts';
import type { Project } from '../schema/project.ts';

export async function renderLayers(host: RenderHost, song: Song, instruments: Record<string, Patch>, mix: RenderedSong, opts: { project: Project; rendersDir: string }): Promise<Record<string, RenderedSong>> {
  if (!song.adaptive) throw new BeepsError('E_USAGE', `song "${song.name}" has no adaptive block`);
  const out: Record<string, RenderedSong> = {};
  // The full song filtered to the layer's tracks (renderSong's `only`): every note, chance roll and
  // noise seed matches the mix, so the layers sum back to it. Reuse the mix's trim.
  for (const [name, tracks] of Object.entries(song.adaptive.layers)) out[name] = await renderSong(host, song, instruments, { ...opts, only: tracks, trimDb: mix.trimDb });
  return out;
}

/** Energy of (mix - sum of layers) relative to the mix, in dB; -Infinity when they cancel exactly. */
export function nullResidualDb(mix: Float32Array[], layers: Float32Array[][]): number {
  let signal = 0, residual = 0;
  for (let c = 0; c < mix.length; c++) {
    const m = mix[c];
    for (let i = 0; i < m.length; i++) {
      let sum = 0;
      for (const layer of layers) sum += layer[c]?.[i] ?? 0;
      const d = m[i] - sum;
      signal += m[i] * m[i];
      residual += d * d;
    }
  }
  return residual === 0 ? -Infinity : 10 * Math.log10(residual / signal);
}

export const readChannels = (wavPath: string): Float32Array[] => readWav(readFileSync(wavPath)).channels;
```

If `RenderHost` is not the exported name of the host type in `src/render/host.ts`, check the file. `renderSong`'s first parameter is typed `RenderHost` in `src/render/song-pipeline.ts`, so import the type from wherever that file imports it.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/player/null-residual.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/render/layers.ts tests/player/null-residual.test.ts
git commit -m "feat: render adaptive layers and measure their null residual"
```

---

### Task 6: `song export --layers`

**Files:**
- Modify: `src/commands/songs.ts` (the `song.command('export <ref>')` block)
- Test: `tests/player/layers-export.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/player/layers-export.test.ts
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../../src/project.ts';
import { chromiumAvailable } from '../../src/render/host.ts';
import { songInput } from '../helpers/songs.ts';

const bin = join(import.meta.dirname, '..', '..', 'scripts/beeps.mjs');
const hasChromium = await chromiumAvailable();
function run(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  return { ...r, data: r.stdout.trim() ? JSON.parse(r.stdout) : undefined };
}

it.skipIf(!hasChromium)('exports adaptive layers next to the mix and they sum back to it', () => {
  const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-layers-')));
  writeFileSync(join(p.paths.root, 'adaptive.json'), JSON.stringify(songInput({ name: 'adaptive-demo', loop: true,
    adaptive: { layers: { bed: ['pad'], pulse: ['hat'] }, states: { calm: ['bed'], full: ['bed', 'pulse'] }, initial: 'calm' } })));
  writeFileSync(join(p.paths.root, 'plain.json'), JSON.stringify(songInput()));
  for (const f of ['adaptive.json', 'plain.json']) { const s = run(p.paths.root, 'song', 'new', f); expect(s.status, s.stderr).toBe(0); }

  const r = run(p.paths.root, 'song', 'export', 'adaptive-demo', '--wav', 'audio/theme.wav', '--layers', '--manifest');
  expect(r.status, r.stderr).toBe(0);
  expect(r.data.nullResidualDb).toBeLessThan(-60);
  for (const f of ['theme.wav', 'theme.bed.wav', 'theme.pulse.wav']) expect(existsSync(join(p.paths.root, 'audio', f)), f).toBe(true);
  expect(JSON.parse(readFileSync(join(p.paths.root, 'audio/theme.wav.json'), 'utf8'))).toMatchObject({
    loop: true, bpm: 120, meter: 4, layers: [{ name: 'bed', file: 'theme.bed.wav' }, { name: 'pulse', file: 'theme.pulse.wav' }],
    states: { calm: ['bed'], full: ['bed', 'pulse'] }, initialState: 'calm',
  });

  const plain = run(p.paths.root, 'song', 'export', 'test-song', '--wav', 'audio/plain.wav', '--layers');
  expect(plain.status).not.toBe(0);
  expect(JSON.parse(plain.stderr).error.code).toBe('E_USAGE');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/player/layers-export.test.ts`
Expected: FAIL, with the error `unknown option '--layers'`.

- [ ] **Step 3: Implement**

In `src/commands/songs.ts`:
- Change the path import to `import { basename, dirname, join, resolve } from 'node:path';`.
- Add `import { nullResidualDb, readChannels, renderLayers } from '../render/layers.ts';`.
- Replace the whole `song.command('export <ref>')` block with:

```ts
  song.command('export <ref>')
    .description('write the loudness-trimmed WAV of a song')
    .requiredOption('--wav <path>', 'output WAV path')
    .option('--manifest', 'write a portable <wav>.json sidecar for game integration')
    .option('--role <role>', 'manifest role: music (default), ambience or sfx; requires --manifest')
    .option('--layers', 'adaptive songs: also write each layer as <wav-stem>.<layer>.wav (loop-folded, at the mix trim) and list them in the sidecar')
    .action(async (ref: string, opts: { wav: string; manifest?: boolean; role?: string; layers?: boolean }) => {
      const role = exportRole(opts.role, opts.manifest, 'music');
      const p = openProject(io.projectDir());
      const s = loadSong(p, ref);
      if (opts.layers && !s.adaptive) throw new BeepsError('E_USAGE', `song "${s.name}" has no "adaptive" block`, { hint: 'add adaptive.layers, adaptive.states and adaptive.initial (see references/song-format.md)' });
      const instruments = resolveInstruments(p, s);
      const rendered = await withHost(async host => {
        const r = await renderSong(host, s, instruments, { project: p.project, rendersDir: p.paths.renders });
        const layers = opts.layers ? await renderLayers(host, s, instruments, r, { project: p.project, rendersDir: p.paths.renders }) : undefined;
        return { r, layers };
      });
      const { r } = rendered;
      const dest = resolve(opts.wav);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(r.wavPath, dest);
      let layerFiles: Record<string, string> | undefined, residual: number | undefined;
      if (rendered.layers) {
        const stem = dest.replace(/\.wav$/i, '');
        layerFiles = Object.fromEntries(Object.entries(rendered.layers).map(([name, lr]) => { const f = `${stem}.${name}.wav`; copyFileSync(lr.wavPath, f); return [name, f]; }));
        residual = nullResidualDb(readChannels(r.wavPath), Object.values(rendered.layers).map(lr => readChannels(lr.wavPath)));
      }
      const extra = layerFiles && s.adaptive
        ? { layers: Object.entries(layerFiles).map(([name, f]) => ({ name, file: basename(f) })), states: s.adaptive.states, initialState: s.adaptive.initial }
        : {};
      const manifest = opts.manifest ? writeExportManifest(dest, r, role, extra) : undefined;
      // The layers must sum to the approved mix; far above the 16-bit floor means a layer diverged.
      const warnings = residual !== undefined && residual > -60 ? [`layers differ from the mix by ${Math.round(residual)} dB: a layer does not sum back to the approved mix`] : [];
      io.emit({ name: s.name, wav: dest, renderedWav: r.wavPath, loop: s.loop, durationSec: r.features.durationSec,
        ...(layerFiles ? { layers: layerFiles, nullResidualDb: Math.round((residual ?? 0) * 10) / 10 } : {}),
        ...(manifest ? { manifest } : {}), ...(warnings.length ? { warnings } : {}) });
    });
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/player/layers-export.test.ts tests/export-manifest.test.ts`
Expected: PASS, with `nullResidualDb` far below -60 (16-bit quantization sits near -90 dB).

If the residual is above -60, **do not raise the threshold**. Use @h-superpowers:systematic-debugging. The likely cause is state that depends on which tracks are present. For example, noise and grain seeds are pooled per track (`SEED_POOL` in `runtime/engine/song.js`), and a seed could be derived from a track's index among the playing tracks. Compare a one-layer render against the same track's `song stems` output to find the source.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/commands/songs.ts tests/player/layers-export.test.ts
git commit -m "feat: export adaptive layers that null against the mix"
```

---

### Task 7: `beeps bundle` and `beeps player export`

**Files:**
- Create: `src/bundle.ts`
- Create: `src/commands/player.ts` (the commands; `exportPlayer` is completed in Task 11, once the player files exist)
- Modify: `src/cli.ts` (register the commands)
- Test: `tests/player/bundle.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/player/bundle.test.ts
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleDir } from '../../src/bundle.ts';

const sidecar = (id: string, file: string, extra: Record<string, unknown> = {}) => ({
  schema: 'beeps/audio-asset@1', id, label: id, description: '', role: 'sfx', file, loop: false, durationSec: 0.3,
  sampleRate: 48000, channels: 2, renderKey: 'k', loudness: { metric: 'momentary-max', lufs: -18 }, truePeakDb: -3,
  normalizationAlreadyApplied: true, ...extra,
});

describe('beeps bundle', () => {
  it('collects sidecars into one catalog with paths relative to the bundle directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-bundle-'));
    mkdirSync(join(dir, 'sfx'));
    writeFileSync(join(dir, 'sfx', 'coin.wav.json'), JSON.stringify(sidecar('coin', 'coin.0.wav', { variants: [{ file: 'coin.0.wav' }, { file: 'coin.1.wav' }] })));
    writeFileSync(join(dir, 'theme.wav.json'), JSON.stringify(sidecar('theme', 'theme.wav', { role: 'music', loop: true, layers: [{ name: 'bed', file: 'theme.bed.wav' }] })));
    const r = bundleDir(dir);
    expect(r.assets.sort()).toEqual(['coin', 'theme']);
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    expect(index.schema).toBe('beeps/audio-bundle@1');
    expect(index.assets.coin).toMatchObject({ file: 'sfx/coin.0.wav', variants: [{ file: 'sfx/coin.0.wav' }, { file: 'sfx/coin.1.wav' }] });
    expect(index.assets.theme.layers).toEqual([{ name: 'bed', file: 'theme.bed.wav' }]);
  });

  it('refuses duplicate ids and names both files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-bundle-dup-'));
    writeFileSync(join(dir, 'a.wav.json'), JSON.stringify(sidecar('coin', 'a.wav')));
    writeFileSync(join(dir, 'b.wav.json'), JSON.stringify(sidecar('coin', 'b.wav')));
    expect(() => bundleDir(dir)).toThrow(/"coin" is in both a\.wav\.json and b\.wav\.json/);
  });

  it('refuses a file that is not a sidecar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-bundle-bad-'));
    writeFileSync(join(dir, 'x.wav.json'), JSON.stringify({ hello: 1 }));
    expect(() => bundleDir(dir)).toThrow(/x\.wav\.json: not a beeps\/audio-asset@1 sidecar/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/player/bundle.test.ts`
Expected: FAIL, because `src/bundle.ts` does not exist.

- [ ] **Step 3: Implement `src/bundle.ts`**

```ts
// src/bundle.ts
// One catalog for the game player: every export sidecar under a directory, keyed by asset id, with
// file paths made relative to that directory.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix, sep } from 'node:path';
import { BeepsError } from './errors.ts';
import { ExportManifestSchema, type ExportManifest } from './export-manifest.ts';

export function bundleDir(dir: string): { index: string; assets: string[] } {
  const sidecars = readdirSync(dir, { recursive: true }).map(f => String(f).split(sep).join('/')).filter(f => f.endsWith('.wav.json')).sort();
  const assets: Record<string, ExportManifest> = {};
  const from: Record<string, string> = {};
  for (const rel of sidecars) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(join(dir, rel), 'utf8')); } catch (e) { throw new BeepsError('E_SCHEMA', `${rel}: ${(e as Error).message}`); }
    const r = ExportManifestSchema.safeParse(raw);
    if (!r.success) throw new BeepsError('E_SCHEMA', `${rel}: not a beeps/audio-asset@1 sidecar (${r.error.issues[0].message})`, { pointer: '/' + r.error.issues[0].path.join('/') });
    const m = r.data;
    if (m.id in assets) throw new BeepsError('E_CONFLICT', `asset id "${m.id}" is in both ${from[m.id]} and ${rel}`, { hint: 'rename one sound or song, or bundle the directories separately' });
    const at = (f: string) => posix.join(posix.dirname(rel), f);
    assets[m.id] = {
      ...m, file: at(m.file),
      ...(m.variants ? { variants: m.variants.map(v => ({ ...v, file: at(v.file) })) } : {}),
      ...(m.layers ? { layers: m.layers.map(l => ({ ...l, file: at(l.file) })) } : {}),
    };
    from[m.id] = rel;
  }
  const index = join(dir, 'index.json');
  writeFileSync(index, JSON.stringify({ schema: 'beeps/audio-bundle@1', assets }, null, 2) + '\n');
  return { index, assets: Object.keys(assets) };
}
```

- [ ] **Step 4: Register the `bundle` command**

Create `src/commands/player.ts`:

```ts
// src/commands/player.ts
import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { bundleDir } from '../bundle.ts';

export function registerPlayerCommands(program: Command, io: Io) {
  program.command('bundle <dir>')
    .description('collect the export sidecars (*.wav.json) under a directory into <dir>/index.json, the catalog the game player loads')
    .action((dir: string) => io.emit(bundleDir(resolve(dir))));
}
```

In `src/cli.ts`:
- Add `import { registerPlayerCommands } from './commands/player.ts';` next to the other `register*` imports.
- Add `registerPlayerCommands(program, io);` after `registerSongCommands(program, io);` in `buildProgram`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/player/bundle.test.ts tests/cli.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/bundle.ts src/commands/player.ts src/cli.ts tests/player/bundle.test.ts
git commit -m "feat: beeps bundle collects export sidecars into a game catalog"
```

---

### Task 8: Voice manager (pure)

**Files:**
- Create: `runtime/player/voices.js`
- Test: `tests/player/voices.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/player/voices.test.ts
import { describe, expect, it } from 'vitest';
import { createVoiceManager } from '../../runtime/player/voices.js';

const opts = (priority = 3, over = {}) => ({ priority, cooldownSec: 0, cap: 3, ...over });

describe('voice manager', () => {
  it('grants voices up to the budget, then drops equally or less important requests', () => {
    const vm = createVoiceManager({ budget: 2 });
    expect(vm.request('a', opts(), 0)).toMatchObject({ steal: null });
    expect(vm.request('b', opts(), 0.1)).toMatchObject({ steal: null });
    expect(vm.request('c', opts(3), 0.2)).toBeNull();
    expect(vm.request('c', opts(5), 0.3)).toBeNull();
    expect(vm.size).toBe(2);
  });

  it('lets a more important sound (smaller number) steal the oldest less important voice', () => {
    const vm = createVoiceManager({ budget: 2 });
    // a is the oldest less important voice; b is less important still but newer: the rule picks age.
    const a = vm.request('a', opts(2), 0)!;
    vm.request('b', opts(4), 0.1);
    const hit = vm.request('hit', opts(1), 0.2)!;
    expect(hit.steal).toBe(a.key);
    expect(vm.has(a.key)).toBe(false);
    expect(vm.size).toBe(2);
  });

  it('holds a cooldown per sound', () => {
    const vm = createVoiceManager({ budget: 8 });
    expect(vm.request('coin', opts(3, { cooldownSec: 0.05 }), 1)).not.toBeNull();
    expect(vm.request('coin', opts(3, { cooldownSec: 0.05 }), 1.02)).toBeNull();
    expect(vm.request('coin', opts(3, { cooldownSec: 0.05 }), 1.06)).not.toBeNull();
  });

  it('replaces the oldest instance of a sound at its instance cap', () => {
    const vm = createVoiceManager({ budget: 8 });
    const first = vm.request('step', opts(3, { cap: 2 }), 0)!;
    vm.request('step', opts(3, { cap: 2 }), 0.1);
    const third = vm.request('step', opts(3, { cap: 2 }), 0.2)!;
    expect(third.steal).toBe(first.key);
    expect(vm.size).toBe(2);
  });

  it('frees a slot on release and on clear', () => {
    const vm = createVoiceManager({ budget: 1 });
    const a = vm.request('a', opts(), 0)!;
    vm.release(a.key);
    expect(vm.request('b', opts(), 0.1)).not.toBeNull();
    vm.clear();
    expect(vm.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/player/voices.test.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement**

```js
// runtime/player/voices.js
// Which sound effects may sound: a voice budget, strict-priority stealing, a cooldown and an
// instance cap per sound. Priority 1 is the most important (FMOD convention, as in meta.priority).
// Pure bookkeeping on a caller-supplied clock; the player does the audio.

/**
 * @typedef {{ key: number, id: string, priority: number, startedAt: number }} Voice
 * @typedef {{ priority: number, cooldownSec: number, cap: number }} VoiceRequest
 */

/** @param {Voice[]} voices */
const oldest = voices => voices.reduce((a, b) => (b.startedAt < a.startedAt || (b.startedAt === a.startedAt && b.key < a.key) ? b : a));

/** @param {{ budget?: number }} [opts] */
export function createVoiceManager({ budget = 8 } = {}) {
  /** @type {Voice[]} */
  let active = [];
  /** @type {Map<string, number>} */
  const lastStart = new Map();
  let nextKey = 1;
  return {
    /**
     * Ask to start sound `id` at time `now` (seconds). Null means drop it; `steal` names a voice
     * the caller must stop first.
     * @param {string} id
     * @param {VoiceRequest} req
     * @param {number} now
     * @returns {{ key: number, steal: number | null } | null}
     */
    request(id, { priority, cooldownSec, cap }, now) {
      const last = lastStart.get(id);
      if (last !== undefined && now - last < cooldownSec) return null;
      /** @type {Voice | null} */
      let steal = null;
      const same = active.filter(v => v.id === id);
      if (same.length >= cap) steal = oldest(same);
      else if (active.length >= budget) {
        const lessImportant = active.filter(v => v.priority > priority);
        if (!lessImportant.length) return null;
        steal = oldest(lessImportant);
      }
      if (steal) active = active.filter(v => v !== steal);
      const voice = { key: nextKey++, id, priority, startedAt: now };
      active.push(voice);
      lastStart.set(id, now);
      return { key: voice.key, steal: steal ? steal.key : null };
    },
    /** @param {number} key */
    release(key) { active = active.filter(v => v.key !== key); },
    /** @param {number} key */
    has(key) { return active.some(v => v.key === key); },
    clear() { active = []; },
    get size() { return active.length; },
  };
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run tests/player/voices.test.ts && npx tsc --noEmit`
Expected: PASS, with no type errors.

- [ ] **Step 5: Commit**

```bash
git add runtime/player/voices.js tests/player/voices.test.ts
git commit -m "feat: player voice manager with strict-priority stealing"
```

---

### Task 9: Bar timing and the lifecycle queue (pure)

**Files:**
- Create: `runtime/player/timing.js`, `runtime/player/lifecycle.js`
- Test: `tests/player/timing.test.ts`, `tests/player/lifecycle.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/player/timing.test.ts
import { describe, expect, it } from 'vitest';
import { nextBarTime } from '../../runtime/player/timing.js';

describe('next bar time', () => {
  // 120 bpm in 4/4: one bar is 2 s.
  it('is the start before the music starts and on a bar line', () => {
    expect(nextBarTime(1, 0.5, 120, 4)).toBe(1);
    expect(nextBarTime(1, 1, 120, 4)).toBe(1);
    expect(nextBarTime(1, 3, 120, 4)).toBe(3);
  });

  it('rounds up to the next bar line', () => {
    expect(nextBarTime(1, 1.2, 120, 4)).toBe(3);
    expect(nextBarTime(1, 3.0001, 120, 4)).toBe(5);
  });

  it('restarts the bar grid at each loop when the loop is not whole bars', () => {
    // 5 s loop: bars at 0, 2, 4 then the loop restarts at 5.
    expect(nextBarTime(0, 4.5, 120, 4, 5)).toBe(5);
    expect(nextBarTime(0, 5.5, 120, 4, 5)).toBe(7);
  });
});
```

```ts
// tests/player/lifecycle.test.ts
import { expect, it } from 'vitest';
import { createLifecycle } from '../../runtime/player/lifecycle.js';

function context() {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const ctx = {
    state: 'suspended',
    async resume() { calls.push('resume'); this.state = 'running'; },
    async suspend() { calls.push('suspend'); await gate; this.state = 'suspended'; },
  };
  return { ctx, calls, release };
}

it('applies rapid hide and show in order, ending in the latest state', async () => {
  const { ctx, calls, release } = context();
  const life = createLifecycle(ctx as unknown as BaseAudioContext);
  await life.reconcile();
  const hide = life.setHidden(true);
  const show = life.setHidden(false);
  release();
  await Promise.all([hide, show]);
  expect(calls).toEqual(['resume', 'suspend', 'resume']);
  expect(ctx.state).toBe('running');
});

it('allow() re-enables without resuming until the next reconcile', async () => {
  const { ctx, calls, release } = context();
  release();
  const life = createLifecycle(ctx as unknown as BaseAudioContext, { enabled: false });
  await life.reconcile();
  life.allow();
  expect(life.running).toBe(true);
  expect(calls).toEqual(['suspend']);
  await life.reconcile();
  expect(calls).toEqual(['suspend', 'resume']);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/player/timing.test.ts tests/player/lifecycle.test.ts`
Expected: FAIL, because the modules are not found.

- [ ] **Step 3: Implement**

```js
// runtime/player/timing.js
/**
 * The next bar line at or after `now` for music that started at `startTime`. When `loopSec` is
 * given and is not a whole number of bars, the grid restarts at every loop point.
 * @param {number} startTime
 * @param {number} now
 * @param {number} bpm
 * @param {number} meter beats per bar
 * @param {number} [loopSec]
 */
export function nextBarTime(startTime, now, bpm, meter, loopSec = Infinity) {
  if (now <= startTime) return startTime;
  const bar = (60 / bpm) * meter;
  const looped = Number.isFinite(loopSec) && loopSec > 0;
  const loopStart = looped ? startTime + Math.floor((now - startTime) / loopSec) * loopSec : startTime;
  const next = Math.ceil((now - loopStart) / bar - 1e-9) * bar;
  return looped && next > loopSec - 1e-9 ? loopStart + loopSec : loopStart + next;
}
```

```js
// runtime/player/lifecycle.js
// Resume and suspend strictly in order: rapid hide/show or off/on can never leave the context
// suspended behind a stale request.

/**
 * @param {{ resume(): Promise<void>, suspend(): Promise<void> }} ctx
 * @param {{ enabled?: boolean, hidden?: boolean }} [initial]
 */
export function createLifecycle(ctx, { enabled = true, hidden = false } = {}) {
  const state = { enabled, hidden };
  /** @type {Promise<void>} */
  let chain = Promise.resolve();
  const reconcile = () => {
    chain = chain.catch(() => {}).then(() => (state.enabled && !state.hidden ? ctx.resume() : ctx.suspend()));
    return chain;
  };
  return {
    get running() { return state.enabled && !state.hidden; },
    /** @param {boolean} value */
    setEnabled(value) { state.enabled = !!value; return reconcile(); },
    /** @param {boolean} value */
    setHidden(value) { state.hidden = !!value; return reconcile(); },
    /** Enable without resuming: the next reconcile (an unlock, on a user gesture) resumes. */
    allow() { state.enabled = true; },
    reconcile,
  };
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run tests/player/timing.test.ts tests/player/lifecycle.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add runtime/player/timing.js runtime/player/lifecycle.js tests/player/timing.test.ts tests/player/lifecycle.test.ts
git commit -m "feat: player bar timing and serialized lifecycle"
```

---

### Task 10: `createPlayer`

**Files:**
- Modify: `tests/helpers/fake-context.ts` (additions only)
- Create: `runtime/player/player.js`
- Test: `tests/player/player.test.ts`

- [ ] **Step 1: Extend the fake context**

In `tests/helpers/fake-context.ts`:
- In `class FakeNode`, add `disconnect() {}` after `stop(...)`.
- In `class FakeContext`, add these after `destination: FakeNode;`:

```ts
  state = 'suspended';
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  async decodeAudioData(_: ArrayBuffer) { return this.createBuffer(2, 4800, 48000); }
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/player/player.test.ts
import { describe, expect, it } from 'vitest';
import { createPlayer } from '../../runtime/player/player.js';
import { clipperCurve } from '../../runtime/engine/fx.js';
import { asCtx, FakeContext, FakeParam } from '../helpers/fake-context.ts';

const catalog = { assets: {
  coin: { file: 'coin.wav', loop: false, priority: 3 },
  hit: { file: 'hit.wav', loop: false, priority: 1 },
  step: { file: 'step.0.wav', loop: false, noRepeat: true, variants: [{ file: 'step.0.wav' }, { file: 'step.1.wav' }] },
  calm: { file: 'calm.wav', loop: true },
  storm: { file: 'storm.wav', loop: true },
  theme: { file: 'theme.wav', loop: true, bpm: 120, meter: 4, durationSec: 16,
    layers: [{ name: 'bed', file: 'theme.bed.wav' }, { name: 'pulse', file: 'theme.pulse.wav' }, { name: 'threat', file: 'theme.threat.wav' }],
    states: { calm: ['bed'], explore: ['bed', 'pulse'], danger: ['bed', 'pulse', 'threat'] }, initialState: 'explore' },
} };
type Gate = { url: string; open: () => void };

function setup(over: Record<string, unknown> = {}, { failing = [] as string[], gated = [] as string[] } = {}) {
  const ctx = new FakeContext();
  const fetched: string[] = [];
  const errors: { code: string }[] = [];
  const gates: Gate[] = [];
  let contexts = 0;
  const player = createPlayer({
    catalog: '/audio/index.json', voices: 8, defaults: { cooldownSec: 0 },
    contextFactory: () => { contexts++; return asCtx(ctx) as AudioContext; },
    fetcher: async (url: string) => {
      fetched.push(url);
      if (gated.some(g => url.endsWith(g))) await new Promise<void>(open => gates.push({ url, open }));
      return { ok: !failing.some(f => url.endsWith(f)), json: async () => catalog, arrayBuffer: async () => new ArrayBuffer(8) };
    },
    onError: (e: { code: string }) => errors.push(e),
    ...over,
  });
  return { ctx, player, fetched, errors, gates, contexts: () => contexts };
}
const settle = () => new Promise(r => setTimeout(r, 0));
const sources = (ctx: FakeContext) => ctx.nodes('bufferSource');

describe('player graph', () => {
  it('routes every bus through the master into the safety clipper, never a compressor', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    const [shaper] = ctx.nodes('shaper');
    expect(Array.from(shaper.curve as Float32Array)).toEqual(Array.from(clipperCurve()));
    expect(shaper.oversample).toBe('none');
    expect(shaper.outputs).toContain(ctx.destination);
    const [master, ...buses] = ctx.nodes('gain');
    expect(master.outputs).toContain(shaper);
    expect(buses.slice(0, 3).every(b => b.outputs.includes(master))).toBe(true);
    expect(ctx.count('compressor')).toBe(0);
  });

  it('creates no context and plays nothing before unlock', () => {
    const { player, contexts } = setup();
    expect(player.play('coin')).toBeNull();
    expect(contexts()).toBe(0);
  });

  it('clamps levels and ignores non-numbers', () => {
    const { player } = setup();
    player.setLevel('music', 5); player.setLevel('sfx', -1); player.setLevel('ambience', NaN); player.setLevel('nope', 0.5);
    expect(player.inspect().levels).toEqual({ music: 1, ambience: 1, sfx: 0, master: 1 });
  });
});

describe('sound effects', () => {
  it('warns once about an unknown asset', async () => {
    const { player, errors } = setup();
    await player.unlock();
    expect(player.play('nope')).toBeNull();
    expect(player.play('nope')).toBeNull();
    expect(errors.filter(e => e.code === 'E_UNKNOWN_ASSET')).toHaveLength(1);
  });

  it('keeps to the voice budget and lets only a more important sound steal', async () => {
    const { ctx, player } = setup({ voices: 2 });
    await player.unlock();
    const a = player.play('coin')!; ctx.currentTime = 0.1;
    const b = player.play('coin')!; ctx.currentTime = 0.2;
    await Promise.all([a.ready, b.ready]);
    expect(player.play('coin')).toBeNull();
    const hit = player.play('hit')!;
    expect(await hit.ready).toBe(true);
    expect(sources(ctx)[0].stoppedAt).toBeDefined();
    expect(player.inspect().voices).toBe(2);
  });

  it('never repeats a variant back to back', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    const files: string[] = [];
    for (let i = 0; i < 6; i++) { ctx.currentTime = i; files.push(player.play('step')!.file); }
    for (let i = 1; i < files.length; i++) expect(files[i]).not.toBe(files[i - 1]);
  });

  it('reports a failed load, stays silent, and retries only once', async () => {
    const { ctx, player, errors, fetched } = setup({}, { failing: ['coin.wav'] });
    await player.unlock();
    for (let i = 0; i < 3; i++) { ctx.currentTime = i; const h = player.play('coin'); expect(await h!.ready).toBe(false); }
    expect(errors.filter(e => e.code === 'E_LOAD')).toHaveLength(2);
    expect(fetched.filter(u => u.endsWith('coin.wav'))).toHaveLength(2);
    expect(sources(ctx)).toHaveLength(0);
  });
});

describe('music and ambience beds', () => {
  it('crossfades to a new bed and ignores a repeat request', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    expect(await player.music('calm')).toBe(true);
    expect(await player.music('calm')).toBe(true);
    expect(sources(ctx)).toHaveLength(1);
    expect(sources(ctx)[0].loop).toBe(true);
    await player.music('storm');
    expect(sources(ctx)).toHaveLength(2);
    expect(sources(ctx)[0].stoppedAt).toBeDefined();
    expect(player.inspect().music).toMatchObject({ id: 'storm' });
  });

  it('starts only the latest of overlapping requests', async () => {
    const { ctx, player, gates } = setup({}, { gated: ['calm.wav'] });
    await player.unlock();
    const first = player.music('calm');
    await settle();
    await player.music('storm');
    gates.forEach(g => g.open());
    expect(await first).toBe(false);
    expect(sources(ctx)).toHaveLength(1);
    expect(player.inspect().music).toMatchObject({ id: 'storm' });
  });

  it('queues a bed requested before unlock and starts it on unlock', async () => {
    const { ctx, player } = setup();
    await player.ambience('calm');
    expect(sources(ctx)).toHaveLength(0);
    await player.unlock();
    expect(sources(ctx)).toHaveLength(1);
    expect(player.inspect().ambience).toMatchObject({ id: 'calm' });
  });

  it('stops everything and cancels pending loads when disabled', async () => {
    const { ctx, player, gates } = setup({}, { gated: ['storm.wav'] });
    await player.unlock();
    await player.music('calm');
    const pending = player.ambience('storm');
    await settle();
    player.setEnabled(false);
    gates.forEach(g => g.open());
    expect(await pending).toBe(false);
    await settle();
    expect(sources(ctx).every(s => s.stoppedAt !== undefined)).toBe(true);
    expect(ctx.state).toBe('suspended');
    expect(player.inspect().music).toBeNull();
  });
});

describe('adaptive layers', () => {
  it('starts every layer together, looping, in the initial state', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    await player.music('theme');
    const started = sources(ctx).map(s => s.startedAt);
    expect(started).toHaveLength(3);
    expect(new Set(started).size).toBe(1);
    expect(sources(ctx).every(s => s.loop)).toBe(true);
    expect(player.inspect().music).toMatchObject({ state: 'explore', layers: { bed: 1, pulse: 1, threat: 0 } });
  });

  it('fades layers at the next bar line when asked', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    await player.music('theme');
    const start = sources(ctx)[0].startedAt as number;
    ctx.currentTime = start + 1;
    expect(player.setState('danger', { at: 'bar', fadeSec: 1 })).toBe(true);
    const threat = ctx.nodes('gain').find(g => g.outputs.length && (g.gain as FakeParam).events.some(e => e.kind === 'linear' && e.value === 1 && Math.abs(e.time - (start + 3)) < 1e-9));
    expect(threat).toBeDefined();
    expect(player.inspect().music).toMatchObject({ state: 'danger', layers: { bed: 1, pulse: 1, threat: 1 } });
  });

  it('reports unknown and non-adaptive states', async () => {
    const { player, errors } = setup();
    await player.unlock();
    await player.music('calm');
    expect(player.setState('danger')).toBe(false);
    await player.music('theme');
    expect(player.setState('boss')).toBe(false);
    expect(errors.map(e => e.code)).toEqual(expect.arrayContaining(['E_NOT_ADAPTIVE', 'E_UNKNOWN_STATE']));
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run tests/player/player.test.ts`
Expected: FAIL, because `runtime/player/player.js` is not found.

- [ ] **Step 4: Implement `runtime/player/player.js`**

```js
// runtime/player/player.js
// Game-side playback of exported agent-beeps audio: a voice-managed SFX bus, crossfading music and
// ambience beds, adaptive layers, and the renderer's safety clipper on the master. Importing it has
// no side effects; an AudioContext is created on the first unlock().
import { clipperCurve } from '../engine/fx.js';
import { createPicker } from '../engine/variation.js';
import { createVoiceManager } from './voices.js';
import { nextBarTime } from './timing.js';
import { createLifecycle } from './lifecycle.js';

export const PLAYER_VERSION = '1';
const RAMP = 0.02; // seconds: no level change is instant, so nothing clicks
/** @type {readonly ['music', 'ambience']} */
const BEDS = ['music', 'ambience'];

/**
 * @typedef {{ file: string, weight?: number }} VariantFile
 * @typedef {{ name: string, file: string }} LayerFile
 * @typedef {{ file: string, loop?: boolean, priority?: number, cooldownSec?: number, cap?: number,
 *   variants?: VariantFile[], noRepeat?: boolean, bpm?: number, meter?: number, durationSec?: number,
 *   layers?: LayerFile[], states?: Record<string, string[]>, initialState?: string }} Asset
 * @typedef {{ code: string, message: string, id?: string }} PlayerError
 * @typedef {{ ok: boolean, json(): Promise<any>, arrayBuffer(): Promise<ArrayBuffer> }} FetchResponse
 * @typedef {{ src: AudioBufferSourceNode, gain: GainNode, target: number }} Node
 * @typedef {{ id: string, asset: Asset, group: GainNode, layers: Map<string, Node>, startTime: number, state: string | null }} Bed
 */

/**
 * @param {{
 *   catalog: string | { assets: Record<string, Asset> },
 *   baseUrl?: string,
 *   voices?: number,
 *   defaults?: { cooldownSec?: number, cap?: number },
 *   onError?: (e: PlayerError) => void,
 *   context?: AudioContext,
 *   contextFactory?: () => AudioContext,
 *   fetcher?: (url: string) => Promise<FetchResponse>,
 *   seed?: number,
 * }} opts
 */
export function createPlayer(opts) {
  const { catalog, voices = 8, defaults = {}, onError = () => {}, seed = 1 } = opts;
  const contextFactory = opts.contextFactory ?? (() => opts.context ?? new AudioContext());
  const fetcher = opts.fetcher ?? (url => fetch(url));
  const base = opts.baseUrl ?? (typeof catalog === 'string' ? catalog.slice(0, catalog.lastIndexOf('/') + 1) : '');
  const vm = createVoiceManager({ budget: voices });
  /** @type {Record<'music' | 'ambience' | 'sfx' | 'master', number>} */
  const levels = { music: 1, ambience: 1, sfx: 1, master: 1 };
  const warned = new Set();
  /** @type {Map<string, Promise<AudioBuffer | null>>} */
  const buffers = new Map();
  /** @type {Map<string, number>} */
  const failures = new Map();
  /** @type {Map<string, { next(): number }>} */
  const pickers = new Map();
  /** @type {Map<number, Node>} */
  const live = new Map();
  /** @type {Record<'music' | 'ambience', Bed | null>} */
  const beds = { music: null, ambience: null };
  /** @type {Record<'music' | 'ambience', { id: string | null, fadeSec: number } | undefined>} */
  const pending = { music: undefined, ambience: undefined };
  const tokens = { music: 0, ambience: 0 };
  /** @type {string | null} */
  let pendingState = null;
  let enabled = true, hidden = false;
  /** @type {AudioContext | null} */
  let ctx = null;
  /** @type {ReturnType<typeof createLifecycle> | null} */
  let lifecycle = null;
  /** @type {GainNode | null} */
  let master = null;
  /** @type {Record<'music' | 'ambience' | 'sfx', GainNode> | null} */
  let buses = null;
  /** @type {Record<string, Asset> | null} */
  let assets = null;
  /** @type {Promise<Record<string, Asset> | null> | null} */
  let catalogLoad = null;

  /** @param {string} code @param {string} message @param {string} [id] */
  const report = (code, message, id) => {
    try { onError({ code, message, ...(id !== undefined ? { id } : {}) }); } catch { /* a game's handler must not break audio */ }
  };
  /** @param {string} code @param {string} message @param {string} id */
  const warnOnce = (code, message, id) => {
    const k = `${code}:${id}`;
    if (!warned.has(k)) { warned.add(k); report(code, message, id); }
  };
  /** @param {unknown} e */
  const text = e => String((/** @type {any} */ (e))?.message ?? e);
  /** @param {AudioParam} param @param {number} to @param {number} [sec] @param {number} [at] */
  const ramp = (param, to, sec = RAMP, at = /** @type {AudioContext} */ (ctx).currentTime) => {
    param.cancelScheduledValues(at);
    param.setValueAtTime(param.value, at);
    param.linearRampToValueAtTime(to, at + Math.max(RAMP, sec));
  };
  const running = () => !!lifecycle && lifecycle.running;

  function loadCatalog() {
    if (assets) return Promise.resolve(assets);
    if (typeof catalog !== 'string') { assets = catalog.assets ?? {}; return Promise.resolve(assets); }
    catalogLoad ??= fetcher(catalog)
      .then(r => { if (!r.ok) throw new Error(`catalog ${catalog} unavailable`); return r.json(); })
      .then(j => { assets = j.assets ?? {}; return assets; })
      .catch(e => { catalogLoad = null; report('E_CATALOG', text(e)); return null; });
    return catalogLoad;
  }

  /** @param {string} file @returns {Promise<AudioBuffer | null>} */
  function load(file) {
    const url = base + file;
    const cached = buffers.get(url);
    if (cached) return cached;
    if ((failures.get(url) ?? 0) >= 2) return Promise.resolve(null); // one retry, then silence
    const p = Promise.resolve()
      .then(() => fetcher(url))
      .then(r => { if (!r.ok) throw new Error(`${url} unavailable`); return r.arrayBuffer(); })
      .then(b => /** @type {AudioContext} */ (ctx).decodeAudioData(b))
      .catch(e => { buffers.delete(url); failures.set(url, (failures.get(url) ?? 0) + 1); report('E_LOAD', text(e), file); return null; });
    buffers.set(url, p);
    return p;
  }

  function build() {
    const c = contextFactory();
    ctx = c;
    const shaper = c.createWaveShaper();
    shaper.curve = clipperCurve();
    shaper.oversample = 'none';
    master = c.createGain();
    master.gain.value = levels.master;
    master.connect(shaper);
    shaper.connect(c.destination);
    const m = master;
    /** @param {'music' | 'ambience' | 'sfx'} b */
    const bus = b => { const g = c.createGain(); g.gain.value = levels[b]; g.connect(m); return g; };
    buses = { music: bus('music'), ambience: bus('ambience'), sfx: bus('sfx') };
    lifecycle = createLifecycle(c, { enabled, hidden });
  }

  /** @param {AudioBuffer} buffer @param {AudioNode} out @param {{ loop?: boolean, gainDb?: number, pan?: number, level?: number }} o @returns {Node} */
  function source(buffer, out, { loop = false, gainDb = 0, pan = 0, level } = {}) {
    const c = /** @type {AudioContext} */ (ctx);
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.loop = loop;
    const gain = c.createGain();
    const target = level ?? 10 ** (gainDb / 20);
    gain.gain.value = target;
    src.connect(gain);
    if (pan) { const p = c.createStereoPanner(); p.pan.value = pan; gain.connect(p); p.connect(out); } else gain.connect(out);
    return { src, gain, target };
  }

  /** @param {Node} n @param {number} [fadeSec] */
  function stopNode(n, fadeSec = RAMP) {
    const t = /** @type {AudioContext} */ (ctx).currentTime;
    ramp(n.gain.gain, 0, fadeSec, t);
    try { n.src.stop(t + Math.max(RAMP, fadeSec)); } catch { /* already stopped */ }
  }

  /** @param {Bed} bed @param {number} [fadeSec] */
  function stopBed(bed, fadeSec = RAMP) {
    const t = /** @type {AudioContext} */ (ctx).currentTime;
    ramp(bed.group.gain, 0, fadeSec, t);
    for (const n of bed.layers.values()) { try { n.src.stop(t + Math.max(RAMP, fadeSec)); } catch { /* already stopped */ } }
  }

  /**
   * Play a sound effect. Null when dropped (before unlock, hidden, unknown, voice budget, cooldown).
   * @param {string} id
   * @param {{ pan?: number, gainDb?: number, cooldownSec?: number, cap?: number }} [o]
   */
  function play(id, { pan = 0, gainDb = 0, cooldownSec, cap } = {}) {
    if (!ctx || !running() || !assets || !buses) return null;
    const asset = assets[id];
    if (!asset) { warnOnce('E_UNKNOWN_ASSET', `no asset "${id}"`, id); return null; }
    if (asset.loop) { warnOnce('E_NOT_SFX', `"${id}" loops: play it with music() or ambience()`, id); return null; }
    const grant = vm.request(id, {
      priority: asset.priority ?? 3,
      cooldownSec: cooldownSec ?? asset.cooldownSec ?? defaults.cooldownSec ?? 0.05,
      cap: cap ?? asset.cap ?? defaults.cap ?? 3,
    }, ctx.currentTime);
    if (!grant) return null;
    if (grant.steal !== null) { const v = live.get(grant.steal); live.delete(grant.steal); if (v) stopNode(v); }
    const files = asset.variants?.length ? asset.variants : [{ file: asset.file }];
    let picker = pickers.get(id);
    if (!picker) {
      picker = createPicker(/** @type {any} */ ({ variation: { variants: files.length, weights: files.map(f => f.weight ?? 1), noRepeat: asset.noRepeat ?? true } }), seed);
      pickers.set(id, picker);
    }
    const file = files[picker.next()].file;
    const sfx = buses.sfx;
    const handle = {
      id, file, stopped: false,
      /** @type {Promise<boolean>} */
      ready: Promise.resolve(false),
      /** @param {number} [fadeSec] */
      stop(fadeSec = RAMP) {
        handle.stopped = true;
        const v = live.get(grant.key);
        live.delete(grant.key);
        vm.release(grant.key);
        if (v) stopNode(v, fadeSec);
      },
    };
    handle.ready = load(file).then(buffer => {
      if (!buffer || handle.stopped || !running() || !vm.has(grant.key)) { vm.release(grant.key); return false; }
      const v = source(buffer, sfx, { gainDb, pan });
      live.set(grant.key, v);
      v.src.onended = () => {
        if (live.get(grant.key) === v) { live.delete(grant.key); vm.release(grant.key); }
        try { v.src.disconnect(); v.gain.disconnect(); } catch { /* already disconnected */ }
      };
      v.src.start(/** @type {AudioContext} */ (ctx).currentTime);
      return true;
    });
    return handle;
  }

  /**
   * Crossfade a bed to `id` (null fades it out). Resolves true once it plays, false when superseded,
   * queued before unlock, or unavailable.
   * @param {'music' | 'ambience'} bus
   * @param {string | null} id
   * @param {{ fadeSec?: number }} [o]
   * @returns {Promise<boolean>}
   */
  function bed(bus, id, { fadeSec = 2 } = {}) {
    const token = ++tokens[bus];
    if (!ctx || !running() || !buses) { pending[bus] = { id, fadeSec }; return Promise.resolve(false); }
    const cur = beds[bus];
    if (cur && cur.id === id) return Promise.resolve(true);
    if (id === null) { if (cur) stopBed(cur, fadeSec); beds[bus] = null; return Promise.resolve(true); }
    const out = buses[bus];
    return loadCatalog().then(a => {
      if (!a || token !== tokens[bus]) return false;
      const asset = a[id];
      if (!asset) { warnOnce('E_UNKNOWN_ASSET', `no asset "${id}"`, id); return false; }
      const parts = asset.layers?.length ? asset.layers : [{ name: '', file: asset.file }];
      return Promise.all(parts.map(p => load(p.file))).then(bufs => {
        if (token !== tokens[bus] || !running() || bufs.every(b => !b)) return false;
        const c = /** @type {AudioContext} */ (ctx);
        const t = c.currentTime + 0.05; // one shared start: layers stay sample-aligned
        const group = c.createGain();
        group.gain.value = 0;
        group.connect(out);
        group.gain.setValueAtTime(0, t);
        group.gain.linearRampToValueAtTime(1, t + Math.max(RAMP, fadeSec));
        const adaptive = !!asset.layers?.length;
        const wanted = pendingState && asset.states?.[pendingState] ? pendingState : null;
        const state = adaptive ? (bus === 'music' && wanted ? wanted : asset.initialState ?? null) : null;
        const on = state ? new Set(asset.states?.[state] ?? []) : null;
        /** @type {Map<string, Node>} */
        const layers = new Map();
        parts.forEach((p, i) => {
          const b = bufs[i];
          if (!b) return;
          const n = source(b, group, { loop: asset.loop !== false, level: !on || on.has(p.name) ? 1 : 0 });
          n.src.start(t);
          layers.set(p.name, n);
        });
        const previous = beds[bus];
        beds[bus] = { id, asset, group, layers, startTime: t, state };
        if (bus === 'music') pendingState = null;
        if (previous) stopBed(previous, fadeSec);
        return true;
      });
    });
  }

  /**
   * Fade the current music's layers to a state, now or at the next bar line.
   * @param {string} state
   * @param {{ fadeSec?: number, at?: 'now' | 'bar' }} [o]
   */
  function setState(state, { fadeSec = 1.5, at = 'now' } = {}) {
    const cur = beds.music;
    if (!cur || !ctx) { pendingState = state; return false; }
    const { asset } = cur;
    if (!asset.layers?.length) { warnOnce('E_NOT_ADAPTIVE', `"${cur.id}" has no adaptive layers`, cur.id); return false; }
    const on = asset.states?.[state];
    if (!on) { warnOnce('E_UNKNOWN_STATE', `"${cur.id}" has no state "${state}"`, state); return false; }
    const when = at === 'bar' && asset.bpm ? nextBarTime(cur.startTime, ctx.currentTime, asset.bpm, asset.meter ?? 4, asset.durationSec) : ctx.currentTime;
    for (const [name, n] of cur.layers) {
      const target = on.includes(name) ? 1 : 0;
      const param = n.gain.gain;
      param.cancelScheduledValues(when);
      param.setValueAtTime(n.target, when);
      param.linearRampToValueAtTime(target, when + Math.max(RAMP, fadeSec));
      n.target = target;
    }
    cur.state = state;
    return true;
  }

  /** @param {string} bus @param {number} value */
  function setLevel(bus, value) {
    if (!(bus in levels) || !Number.isFinite(value)) return;
    const b = /** @type {'music' | 'ambience' | 'sfx' | 'master'} */ (bus);
    levels[b] = Math.min(1, Math.max(0, value));
    if (ctx && master && buses) ramp(b === 'master' ? master.gain : buses[b].gain, levels[b]);
  }

  /** @param {number} [fadeSec] */
  function stopAll(fadeSec = RAMP) {
    for (const b of BEDS) {
      tokens[b]++;
      pending[b] = undefined;
      const cur = beds[b];
      if (cur && ctx) stopBed(cur, fadeSec);
      beds[b] = null;
    }
    pendingState = null;
    if (ctx) for (const n of live.values()) stopNode(n, fadeSec);
    live.clear();
    vm.clear();
  }

  /** Call from a user gesture: creates or resumes the context, then starts queued beds. */
  async function unlock() {
    if (!enabled || hidden) return false;
    if (!ctx) build();
    const life = /** @type {ReturnType<typeof createLifecycle>} */ (lifecycle);
    try { await life.reconcile(); } catch (e) { report('E_CONTEXT', text(e)); return false; }
    await loadCatalog();
    if (!running()) return false;
    for (const b of BEDS) {
      const p = pending[b];
      pending[b] = undefined;
      if (p) await bed(b, p.id, { fadeSec: p.fadeSec });
    }
    return running();
  }

  /** @param {boolean} value */
  function setEnabled(value) {
    enabled = !!value;
    if (!enabled) {
      stopAll();
      if (lifecycle) void lifecycle.setEnabled(false).catch(e => report('E_CONTEXT', text(e)));
    } else if (lifecycle) lifecycle.allow(); // resuming needs a gesture: the next unlock() does it
  }

  /** @param {boolean} value */
  function setHidden(value) {
    hidden = !!value;
    if (lifecycle) void lifecycle.setHidden(hidden).catch(e => report('E_CONTEXT', text(e)));
  }

  /** A snapshot for tests, debugging and game UI. */
  function inspect() {
    const m = beds.music, a = beds.ambience;
    return {
      running: running(), voices: vm.size, levels: { ...levels },
      music: m ? { id: m.id, state: m.state, layers: Object.fromEntries([...m.layers].filter(([name]) => name).map(([name, n]) => [name, n.target])) } : null,
      ambience: a ? { id: a.id } : null,
    };
  }

  return {
    unlock, play, setState, setLevel, setEnabled, setHidden, stopAll, inspect,
    /** @param {string | null} id @param {{ fadeSec?: number }} [o] */
    music: (id, o) => bed('music', id, o),
    /** @param {string | null} id @param {{ fadeSec?: number }} [o] */
    ambience: (id, o) => bed('ambience', id, o),
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/player/player.test.ts`
Expected: PASS.

If a test fails, use @h-superpowers:systematic-debugging. Change the implementation, not the expectation, unless the expectation contradicts the spec.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. `checkJs` is strict over `runtime/`. If JSDoc casts are needed, fix them with casts like the ones above. Do not add `// @ts-nocheck`.

- [ ] **Step 7: Commit**

```bash
git add runtime/player/player.js tests/player/player.test.ts tests/helpers/fake-context.ts
git commit -m "feat: game player with voice budget, clipper master, beds and adaptive layers"
```

---

### Task 11: `beeps player export` and a closed file set

**Files:**
- Modify: `src/commands/player.ts`
- Test: `tests/player/player-export.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/player/player-export.test.ts
import { expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportPlayer, PLAYER_FILES } from '../../src/commands/player.ts';

it('vendors the player with every module it imports and a version header', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeps-vendor-'));
  const r = exportPlayer(dir);
  expect(r.root).toBe(join(dir, 'beeps-player'));
  for (const f of PLAYER_FILES) {
    const file = join(r.root, f);
    const imports = [...readFileSync(file, 'utf8').matchAll(/from '(\.[^']+)'/g)].map(m => resolve(dirname(file), m[1]));
    for (const i of imports) expect(existsSync(i), `${f} imports ${i}`).toBe(true);
  }
  const player = readFileSync(join(r.root, 'player/player.js'), 'utf8');
  expect(player.split('\n')[0]).toMatch(/^\/\/ Vendored by agent-beeps \d+\.\d+\.\d+ \(player 1, engine \d+\)/);
  expect(JSON.parse(readFileSync(join(r.root, 'VERSION.json'), 'utf8'))).toMatchObject({ player: '1' });
  const mod = await import(pathToFileURL(join(r.root, 'player/player.js')).href);
  expect(typeof mod.createPlayer).toBe('function');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/player/player-export.test.ts`
Expected: FAIL, because `exportPlayer` is not exported.

- [ ] **Step 3: Implement**

Replace `src/commands/player.ts` with:

```ts
// src/commands/player.ts
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { bundleDir } from '../bundle.ts';
import { RUNTIME_DIR } from '../render/host.ts';
import { ENGINE_VERSION } from '../../runtime/engine/version.js';
import { PLAYER_VERSION } from '../../runtime/player/player.js';

/** Runtime files the vendored player needs (relative to runtime/): its modules and the engine modules they import. */
export const PLAYER_FILES = [
  'player/player.js', 'player/voices.js', 'player/timing.js', 'player/lifecycle.js',
  'engine/fx.js', 'engine/rng.js', 'engine/variation.js', 'engine/notes.js',
];

/** Copy the player into <dir>/beeps-player/, keeping relative imports; games import player/player.js. */
export function exportPlayer(dir: string): { root: string; files: string[]; version: string } {
  const root = join(resolve(dir), 'beeps-player');
  const pkg = JSON.parse(readFileSync(join(RUNTIME_DIR, '..', 'package.json'), 'utf8')) as { version: string };
  for (const f of PLAYER_FILES) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    cpSync(join(RUNTIME_DIR, f), join(root, f));
  }
  const player = join(root, 'player', 'player.js');
  const header = `// Vendored by agent-beeps ${pkg.version} (player ${PLAYER_VERSION}, engine ${ENGINE_VERSION}). Regenerate with "beeps player export"; do not edit.\n`;
  writeFileSync(player, header + readFileSync(player, 'utf8'));
  writeFileSync(join(root, 'VERSION.json'), JSON.stringify({ agentBeeps: pkg.version, player: PLAYER_VERSION, engine: ENGINE_VERSION }, null, 2) + '\n');
  return { root, files: PLAYER_FILES.map(f => join(root, f)), version: pkg.version };
}

export function registerPlayerCommands(program: Command, io: Io) {
  program.command('bundle <dir>')
    .description('collect the export sidecars (*.wav.json) under a directory into <dir>/index.json, the catalog the game player loads')
    .action((dir: string) => io.emit(bundleDir(resolve(dir))));
  const player = program.command('player').description('the browser runtime games use to play exported audio');
  player.command('export <dir>')
    .description('vendor the player into <dir>/beeps-player/ (import beeps-player/player/player.js)')
    .action((dir: string) => io.emit(exportPlayer(dir)));
}
```

- [ ] **Step 4: Run the tests, typecheck and try the CLI**

Run: `npx vitest run tests/player && npx tsc --noEmit && node scripts/beeps.mjs player export "$TMPDIR/vendor-check"`
Expected: the tests PASS, and the JSON output lists 8 files under `beeps-player/`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/player.ts tests/player/player-export.test.ts
git commit -m "feat: beeps player export vendors the game player"
```

---

### Task 12: Browser verification in Chromium

**Files:**
- Test: `tests/player/browser.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/player/browser.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromiumAvailable, serveStatic } from '../../src/render/host.ts';
import { exportPlayer } from '../../src/commands/player.ts';
import { writeWav } from '../../src/audio/wav.ts';

const hasChromium = await chromiumAvailable();
let browser: Browser | undefined, site: { server: Server; url: string } | undefined;
const tone = (sec: number, hz: number) => {
  const n = Math.round(48000 * sec), c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = 0.25 * Math.sin((2 * Math.PI * hz * i) / 48000);
  return writeWav([c, c], 48000);
};

beforeAll(async () => {
  if (!hasChromium) return;
  const dir = mkdtempSync(join(tmpdir(), 'beeps-player-site-'));
  exportPlayer(dir);
  mkdirSync(join(dir, 'audio'));
  for (const [f, sec, hz] of [['coin.wav', 0.3, 880], ['theme.wav', 4, 110], ['theme.bed.wav', 4, 110], ['theme.pulse.wav', 4, 220], ['theme.threat.wav', 4, 330]] as const) {
    writeFileSync(join(dir, 'audio', f), tone(sec, hz));
  }
  writeFileSync(join(dir, 'audio', 'index.json'), JSON.stringify({ schema: 'beeps/audio-bundle@1', assets: {
    coin: { file: 'coin.wav', loop: false, priority: 3 },
    theme: { file: 'theme.wav', loop: true, bpm: 120, meter: 4, durationSec: 4,
      layers: [{ name: 'bed', file: 'theme.bed.wav' }, { name: 'pulse', file: 'theme.pulse.wav' }, { name: 'threat', file: 'theme.threat.wav' }],
      states: { calm: ['bed'], danger: ['bed', 'pulse', 'threat'] }, initialState: 'calm' },
  } }));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>player</title>');
  site = await serveStatic(dir);
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
});
afterAll(async () => { await browser?.close(); site?.server.close(); });

it.skipIf(!hasChromium)('plays a bundle through the vendored player in Chromium', async () => {
  const page = await browser!.newPage();
  await page.goto(`${site!.url}/index.html`);
  const result = await page.evaluate(async () => {
    const { createPlayer } = await import('/beeps-player/player/player.js');
    const errors: unknown[] = [];
    const player = createPlayer({ catalog: '/audio/index.json', voices: 4, onError: (e: unknown) => errors.push(e) });
    await player.unlock();
    const started = await player.music('theme', { fadeSec: 0.1 });
    const played = await player.play('coin').ready;
    const before = player.inspect();
    player.setState('danger', { fadeSec: 0.1 });
    return { started, played, before, after: player.inspect(), errors };
  });
  expect(result.errors).toEqual([]);
  expect(result).toMatchObject({
    started: true, played: true,
    before: { running: true, voices: 1, music: { id: 'theme', state: 'calm', layers: { bed: 1, pulse: 0, threat: 0 } } },
    after: { music: { state: 'danger', layers: { bed: 1, pulse: 1, threat: 1 } } },
  });
});

it.skipIf(!hasChromium)('the master clipper passes signals below its knee through unchanged', async () => {
  const page = await browser!.newPage();
  await page.goto(`${site!.url}/index.html`);
  const maxDiff = await page.evaluate(async () => {
    const { clipperCurve } = await import('/beeps-player/engine/fx.js');
    const ctx = new OfflineAudioContext(1, 48000, 48000);
    const buf = ctx.createBuffer(1, 48000, 48000);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = 0.8 * Math.sin((2 * Math.PI * 441 * i) / 48000); // under the -1.5 dBFS knee (0.841)
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const shaper = ctx.createWaveShaper();
    shaper.curve = clipperCurve();
    shaper.oversample = 'none';
    src.connect(shaper).connect(ctx.destination);
    src.start();
    const out = (await ctx.startRendering()).getChannelData(0);
    let m = 0;
    for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(out[i] - d[i]));
    return m;
  });
  expect(maxDiff).toBeLessThan(1e-6);
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/player/browser.test.ts`
Expected: PASS. It is skipped without Chromium; run `npx playwright install chromium` if needed. The test passes because Tasks 10 and 11 exist. That is fine for a verification test, since it checks real-browser behavior the fakes cannot.

If `await import('/beeps-player/...')` fails to typecheck, give the evaluate body `// @ts-ignore` on that single line only. The file is served at runtime, so there is no module at that path at type-check time.

- [ ] **Step 3: Full suite, typecheck, commit**

```bash
npm test && npx tsc --noEmit
git add tests/player/browser.test.ts
git commit -m "test: vendored player plays a bundle in Chromium; clipper is transparent below its knee"
```

---

### Task 13: Documentation

**Files:**
- Modify: `skills/beeps-music/references/song-format.md`, `skills/beeps-music/SKILL.md`, `skills/beeps-compose/SKILL.md`, `README.md`

- [ ] **Step 1: Song format reference**

Append this section to `skills/beeps-music/references/song-format.md`:

```markdown
## Adaptive layers (for the game player)

`adaptive` splits a loop into layers the game fades by state. Every track is in exactly one layer,
and the song must have `"loop": true`.

    "adaptive": {
      "layers": { "bed": ["pad", "bass"], "pulse": ["arp", "hat"], "threat": ["drums", "lead"] },
      "states": { "calm": ["bed"], "explore": ["bed", "pulse"], "danger": ["bed", "pulse", "threat"] },
      "initial": "explore"
    }

`beeps song export <name> --wav audio/theme.wav --layers --manifest` writes:

- the mix
- `theme.<layer>.wav` for each layer, loop-folded and at the mix's trim
- one sidecar listing the layers and states

`nullResidualDb` reports how closely the layers sum to the mix. Anything under -60 dB is exact up to
16-bit rounding.
```

- [ ] **Step 2: beeps-music skill**

In `skills/beeps-music/SKILL.md`, add this paragraph at the end of "## 6. Hand to the owner", before "## Never":

```markdown
For a game that should react to play, add an `adaptive` block (layers and states;
`references/song-format.md`) and export with `--layers --manifest`. Listen to each state's layers
alone as well as the full mix (`song-adaptive-states`).
```

Check with `npx vitest run tests/skills.test.ts`. The file must stay at 150 lines or fewer.

- [ ] **Step 3: beeps-compose skill**

In `skills/beeps-compose/SKILL.md`, replace the bullet that begins `` `beeps export <name> --wav assets/sfx/<name>.wav [--variant n]` `` with:

```markdown
- `beeps export <name> --wav assets/sfx/<name>.wav --manifest` writes a WAV plus a sidecar; add
  `--variants` to export every declared variant for no-repeat playback. For a web game, run
  `beeps bundle assets/audio` (one `index.json` catalog) and `beeps player export src/vendor`, then
  `createPlayer({ catalog: '/audio/index.json' })`. The player handles the voice budget, priorities,
  crossfades and adaptive music states, and it never hard-limits below its -1.5 dBFS knee. Engines
  that are not web games use the WAVs and sidecars directly.
```

- [ ] **Step 4: README**

In the `## Commands` table of `README.md`:
- Change `` 16 SFX archetypes `` to `` 18 SFX archetypes ``. `beeps capabilities` lists 18.
- Add these two rows after the `album open/feedback/list` row:

```markdown
| `bundle <dir>` | collect export sidecars under a directory into `index.json`, the game player's catalog |
| `player export <dir>` | vendor the browser game player (voice budget, priorities, crossfades, adaptive layers, safety clipper) into `<dir>/beeps-player/` |
```

Then append this paragraph after the existing paragraph that ends `...leaves any existing sidecar untouched.`:

```markdown
`beeps export <patch> --variants --manifest` writes every declared variant (`<stem>.<i>.wav`) and one
sidecar listing them, their weights, no-repeat and the patch priority. `beeps song export <song>
--layers --manifest` also writes each adaptive layer (`<stem>.<layer>.wav`, loop-folded at the mix's
trim) and reports `nullResidualDb`, how closely the layers sum back to the mix.
```

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run tests/skills.test.ts && npx tsc --noEmit
git add skills README.md
git commit -m "docs: game player, variants, bundles and adaptive layers"
```

---

### Task 14: Migrate Space to Grow onto the player (acceptance)

This happens in a **separate repository**, `C:/Users/ehart/repos/room2grow`. Create a feature branch there first.

**Files (room2grow):**
- Create: `src/vendor/beeps-player/**` (generated)
- Modify: `src/audio.mjs`, `tests/audio.test.mjs` (the harness only), `scripts/build.mjs`

- [ ] **Step 1: Vendor the player**

```bash
cd C:/Users/ehart/repos/room2grow && git switch -c feat/beeps-player
node C:/Users/ehart/repos/agent-beeps/scripts/beeps.mjs player export src/vendor
```

Expected: `src/vendor/beeps-player/player/player.js` exists.

- [ ] **Step 2: Give the test harness a wave shaper**

In `tests/audio.test.mjs`, inside `harness`, add this entry to the `context` object after `createDynamicsCompressor:...`:

```js
    createWaveShaper:()=>({connect(){},disconnect(){}}),
```

- [ ] **Step 3: Replace `createSoundscape` with a facade over the player**

Keep `SCENES` and `sceneFor` exactly as they are. Replace the whole `createSoundscape` function with:

```js
import {createPlayer} from './vendor/beeps-player/player/player.js';

export function createSoundscape({contextFactory=()=>new AudioContext(),fetcher=fetch,onError=()=>{}}={}){
  let player=null,enabled=false,hidden=false,unlocked=false,scene='garden',reported=false;
  const levels={music:.6,ambience:.6,effects:1};
  const report=()=>{if(!reported){reported=true;onError('Some sounds could not load. Your garden is still playable. Toggle sound to try again.');}};
  const busOf=bus=>bus==='effects'?'sfx':bus;
  function make(){
    // Six effect voices, dropped when full (equal priority), a .12 s retrigger cooldown: the previous behaviour.
    player=createPlayer({catalog:'/audio/manifest.json',voices:6,defaults:{cooldownSec:.12,cap:6},contextFactory,fetcher,onError:report});
    player.setLevel('master',.8);
    for(const [bus,level] of Object.entries(levels))player.setLevel(busOf(bus),level);
    return player;
  }
  async function sync(){
    if(!player||!enabled||!unlocked)return;
    const selection=SCENES[scene];
    await Promise.all([player.music(selection.music,{fadeSec:2}),player.ambience(selection.ambience,{fadeSec:2})]);
  }
  async function unlock(){
    if(!enabled||hidden)return;
    try{
      player??=make();
      const ok=await player.unlock();
      if(!ok||!enabled||hidden)return;
      if(!unlocked){unlocked=true;await sync();}
    }catch{report();}
  }
  function setEnabled(value){
    value=Boolean(value);if(enabled===value)return;enabled=value;reported=false;
    player?.setEnabled(enabled);
    if(!enabled)unlocked=false;
    // Enabling does not create or resume a context: the caller supplies the gesture.
  }
  function update(state){const next=sceneFor(state);if(scene!==next){scene=next;void sync();}}
  function setHidden(value){hidden=Boolean(value);player?.setHidden(hidden);}
  function setLevel(bus,value){if(!(bus in levels)||!Number.isFinite(value))return;levels[bus]=Math.max(0,Math.min(1,value));player?.setLevel(busOf(bus),levels[bus]);}
  async function play(id){
    if(!player||!enabled||hidden||!unlocked)return;
    try{const handle=player.play(id);if(handle)await handle.ready;}catch{report();}
  }
  function snapshot(){
    const s=player?.inspect();
    return {enabled,scene,title:SCENES[scene].title,levels:{...levels},playing:[s?.music?.id,s?.ambience?.id].filter(Boolean)};
  }
  return {setEnabled,unlock,update,setHidden,setLevel,play,snapshot};
}
```

Put the `import` line at the top of the file with the other code, not in the middle. Also delete the old comment about the limiter.

- [ ] **Step 4: Ship the vendored files in the build**

In `scripts/build.mjs`:
- Change the first import to `import { mkdir, copyFile, cp, readFile, readdir } from 'node:fs/promises';`.
- After the line `files.push('src/audio.mjs','public/audio/manifest.json');`, add:

```js
for(const file of await readdir(resolve(root,'src/vendor/beeps-player'),{recursive:true}))if(/\.(js|json)$/.test(file))files.push(`src/vendor/beeps-player/${file.replaceAll('\\','/')}`);
```

- [ ] **Step 5: Run the game's tests and build**

Run: `npm test && npm run build`
Expected:
- All 10 audio tests pass unchanged apart from the harness line, along with the rest of the suite.
- The build output includes `dist/src/vendor/beeps-player/player/player.js`.

If an audio test fails, use @h-superpowers:systematic-debugging. The facade's contract is exactly what those tests assert. Change the facade or the player, not the assertions.

- [ ] **Step 6: Commit and hand to the owner for a listen**

```bash
git add src/audio.mjs src/vendor tests/audio.test.mjs scripts/build.mjs
git commit -m "feat: play audio through the agent-beeps game player"
```

Open a PR. The acceptance bar is the owner's listen: the same scenes, 2-second transitions, settings levels and action sounds.

State this in the PR: the master now uses agent-beeps' safety clipper instead of the previous `DynamicsCompressor` (threshold -8 dB, ratio 12). Measured in v1, that compressor lowered level by 1-3 dB even far below threshold. So removing it may make the game audibly slightly louder. That is the expected, intended change. The master gain stays at 0.8.

---

## Self-review notes

- **Spec coverage.**
  - Player API: Task 10.
  - Catalog and optional fields: Tasks 1, 2 and 7.
  - Voice manager: Task 8.
  - Buses and the clipper: Tasks 10 and 12.
  - Lifecycle: Task 9.
  - Adaptive authoring: Tasks 3 and 4.
  - Export and null test: Tasks 5 and 6.
  - Runtime layers and bar quantization: Tasks 9 and 10.
  - Errors: Task 10 (unknown asset or state, failed load with one retry, pre-unlock rules, stale tokens).
  - Browser test: Task 12.
  - Space to Grow acceptance: Task 14.
  - Out-of-scope items stay out.
- **Names used across tasks:**
  - `createVoiceManager().request/release/has/clear/size`
  - `nextBarTime(startTime, now, bpm, meter, loopSec)`
  - `createLifecycle(ctx, {enabled, hidden}).setEnabled/setHidden/allow/reconcile/running`
  - `createPlayer(...).unlock/play/music/ambience/setState/setLevel/setEnabled/setHidden/stopAll/inspect`
  - `play()` returns `{ id, file, ready, stop }`
  - `exportPlayer`, `PLAYER_FILES`, `bundleDir`, `renderLayers`, `nullResidualDb`, `readChannels`
  - `writeExportManifest(wav, rendered, role, extra, path)`
