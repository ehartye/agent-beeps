# Source overview Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use h-superpowers:subagent-driven-development, h-superpowers:team-driven-development, or h-superpowers:executing-plans to implement this plan (ask user which approach). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `beeps sample overview <id|file>` images a recording of up to 120 s and lists natural segments of at most ten seconds, each with the numbers and a ready `sample prepare` command.

**Architecture:** A pure analysis module (`src/samples/overview.ts`) cuts a mono mix into segments at gaps and measures each with the existing measure/event code. A thin runner (`src/samples/overview-run.ts`) resolves the source (sample object or audio file), applies the view range, and draws the image by reusing `host.songPcmLook` / `renderSongLook`. `src/commands/samples.ts` only parses options.

**Tech Stack:** TypeScript (Node 24, ESM, `.ts` imports), commander, vitest, Playwright Chromium for the PNG.

Spec: `docs/superpowers/specs/2026-10-20-source-overview-design.md`. Work in the worktree `<worktree>` (branch `feat/source-overview`); every command below runs there. Commit trailer on every commit: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

Refinements to the spec found while planning (Task 6 updates the spec to match):
- The image defaults to `.agent-beeps/renders/overviews/<key>.png`, not `samples/overviews`: `renders/` is gitignored derived output, `samples/` holds committed immutable objects.
- A file source reports `source.normalizedId`, the ID `sample import` will give it (same decode, same bytes), so every `prepare` line is real. A hint says to import first.
- Times are exact: seconds are `frame / 48000` rounded to 6 decimals and `startFrame`/`endFrame` are reported too, so `prepare` round-trips to the same frames.
- No byte-identical song-look *test* (it needs a baseline PNG that depends on the Chromium build); Task 4 compares look hashes manually on main and the branch instead.

## File structure

| File | Responsibility |
|---|---|
| `src/samples/overview.ts` (create) | Pure: `segmentMono`, `overviewAudio`, `overviewLook`, `sec`. No I/O. |
| `src/samples/overview-run.ts` (create) | `runOverview`: resolve source, validate range, call analysis, write image, build the JSON. |
| `src/samples/prepare.ts` (modify) | Export `MAX_ORIGINAL_BYTES`. |
| `src/commands/samples.ts` (modify) | Register `sample overview`. |
| `runtime/look.js` (modify) | `renderSongLook` footer when `f.source` is set. |
| `tests/samples/overview.test.ts` (create) | Segmenter and analysis unit tests. |
| `tests/samples/overview-cli.test.ts` (create) | CLI tests (file, ID, errors, image). |
| skills, docs, capabilities, README, version files | Task 5. |

---

### Task 1: Segmenter

**Files:**
- Create: `src/samples/overview.ts`
- Test: `tests/samples/overview.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/samples/overview.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { segmentMono } from '../../src/samples/overview.ts';
import { SR, sine, whiteNoise } from '../helpers/signals.ts';

const DEFAULTS = { gapDb: 40, minGapMs: 200 };
/** Silence of `total` seconds with each part copied in at its start time. */
const layout = (total: number, parts: [number, Float32Array][]) => {
  const out = new Float32Array(Math.round(total * SR));
  for (const [t, x] of parts) out.set(x, Math.round(t * SR));
  return out;
};

describe('segmentMono', () => {
  it('cuts three bursts at their gaps, 20 ms before each onset', () => {
    const x = layout(7, [[1, sine(440, 0.5)], [3, sine(440, 0.5)], [5, sine(440, 0.5)]]);
    expect(segmentMono(x, DEFAULTS)).toEqual([
      { startFrame: 47040, endFrame: 72000, cutAt10s: false },
      { startFrame: 143040, endFrame: 168000, cutAt10s: false },
      { startFrame: 239040, endFrame: 264000, cutAt10s: false },
    ]);
  });

  it('bridges a gap shorter than --min-gap and splits at exactly --min-gap', () => {
    const bridged = layout(3, [[1, sine(440, 0.5)], [1.6, sine(440, 0.5)]]); // 100 ms apart
    expect(segmentMono(bridged, DEFAULTS)).toEqual([{ startFrame: 47040, endFrame: 100800, cutAt10s: false }]);
    const split = layout(3, [[1, sine(440, 0.5)], [1.7, sine(440, 0.5)]]); // 200 ms apart
    expect(segmentMono(split, DEFAULTS)).toHaveLength(2);
  });

  it('drops a click shorter than 50 ms', () => {
    const click = new Float32Array(1); click[0] = 0.5;
    const x = layout(6, [[2, click], [4, sine(440, 0.5)]]);
    expect(segmentMono(x, DEFAULTS)).toEqual([{ startFrame: 191040, endFrame: 216000, cutAt10s: false }]);
  });

  it('keeps a quiet burst until --gap-db excludes it', () => {
    const x = layout(5, [[1, sine(440, 0.5)], [3, sine(440, 0.01)]]); // about 34 dB under the loud one
    expect(segmentMono(x, DEFAULTS)).toHaveLength(2);
    expect(segmentMono(x, { gapDb: 20, minGapMs: 200 })).toHaveLength(1);
  });

  it('returns nothing for silence or a signal under -70 dBFS', () => {
    expect(segmentMono(new Float32Array(SR), DEFAULTS)).toEqual([]);
    expect(segmentMono(Float32Array.from({ length: SR }, () => 1e-4), DEFAULTS)).toEqual([]);
  });

  it('cuts continuous sound into pieces of at most ten seconds at quiet frames', () => {
    const x = whiteNoise(25, 1, 0.3);
    const cuts = segmentMono(x, DEFAULTS);
    expect(cuts.length).toBeGreaterThanOrEqual(3);
    expect(cuts.length).toBeLessThanOrEqual(4);
    expect(cuts[0].startFrame).toBe(0);
    expect(cuts[cuts.length - 1].endFrame).toBe(25 * SR);
    cuts.forEach((c, i) => {
      expect(c.endFrame - c.startFrame).toBeLessThanOrEqual(10 * SR);
      expect(c.cutAt10s).toBe(i < cuts.length - 1);
      if (i < cuts.length - 1) {
        expect(cuts[i + 1].startFrame).toBe(c.endFrame); // contiguous
        expect(c.endFrame - c.startFrame).toBeGreaterThanOrEqual(6 * SR);
      }
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/samples/overview.test.ts`
Expected: FAIL, `Cannot find module '../../src/samples/overview.ts'` (or `segmentMono is not a function`).

- [ ] **Step 3: Implement the segmenter**

Create `src/samples/overview.ts`:

```ts
// A long recording's overview: where the sound is, cut into natural segments of at most ten seconds, each with the numbers an
// agent needs to choose a crop for `beeps sample prepare`. Pure: no files, no browser.
import { PREPARED_MAX_FRAMES } from './store.ts';

export const SR = 48000;
/** One 10 ms analysis frame. */
export const FRAME = 480;
const FLOOR_DB = -70;
const LEAD_FRAMES = 2;      // 20 ms before the first loud frame, so an onset is not clipped
const MIN_RUN_FRAMES = 5;   // under 50 ms of sound is a click
const SPLIT_FROM = 6 * SR;  // a ten-second cut is made at the quietest frame 6 to 10 s into the piece

export interface SegmentOptions { gapDb: number; minGapMs: number }
/** Frames are 48 kHz sample indices into the analysed signal, end-exclusive. */
export interface Cut { startFrame: number; endFrame: number; cutAt10s: boolean }

function frameLevels(x: Float32Array): Float64Array {
  const out = new Float64Array(Math.ceil(x.length / FRAME));
  for (let f = 0; f < out.length; f++) {
    const a = f * FRAME, b = Math.min(x.length, a + FRAME);
    let e = 0;
    for (let i = a; i < b; i++) e += x[i] * x[i];
    out[f] = 10 * Math.log10(e / (b - a) + 1e-12);
  }
  return out;
}

/** Cut one run longer than ten seconds at the quietest frame boundary 6 to 10 s in, repeatedly. */
function splitLong(levels: Float64Array, start: number, end: number): Cut[] {
  const out: Cut[] = [];
  while (end - start > PREPARED_MAX_FRAMES) {
    const lo = Math.ceil((start + SPLIT_FROM) / FRAME), hi = Math.floor((start + PREPARED_MAX_FRAMES) / FRAME);
    let at = lo;
    for (let f = lo + 1; f <= hi; f++) if (levels[f] < levels[at]) at = f;
    out.push({ startFrame: start, endFrame: at * FRAME, cutAt10s: true });
    start = at * FRAME;
  }
  out.push({ startFrame: start, endFrame: end, cutAt10s: false });
  return out;
}

/**
 * Segments of a mono signal. A gap is `minGapMs` or more of frames `gapDb` under the loudest frame (floor -70 dBFS);
 * segments are the stretches between gaps, 20 ms early, at most ten seconds each.
 */
export function segmentMono(x: Float32Array, { gapDb, minGapMs }: SegmentOptions): Cut[] {
  const levels = frameLevels(x);
  let top = -Infinity;
  for (const v of levels) if (v > top) top = v;
  if (!(top > FLOOR_DB)) return [];
  const threshold = Math.max(top - gapDb, FLOOR_DB), minGap = Math.max(1, Math.ceil(minGapMs / 10));
  const raw: { a: number; b: number }[] = [];
  for (let f = 0; f < levels.length; f++) {
    if (levels[f] < threshold) continue;
    const last = raw[raw.length - 1];
    if (last && last.b === f - 1) last.b = f; else raw.push({ a: f, b: f });
  }
  const runs: { a: number; b: number }[] = [];
  for (const r of raw) {
    const last = runs[runs.length - 1];
    if (last && r.a - last.b - 1 < minGap) last.b = r.b; else runs.push({ ...r });
  }
  const cuts: Cut[] = [];
  let previousEnd = 0;
  for (const r of runs) {
    if (r.b - r.a + 1 < MIN_RUN_FRAMES) continue;
    const start = Math.max(previousEnd, (r.a - LEAD_FRAMES) * FRAME), end = Math.min(x.length, (r.b + 1) * FRAME);
    cuts.push(...splitLong(levels, start, end));
    previousEnd = end;
  }
  return cuts;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/samples/overview.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/samples/overview.ts tests/samples/overview.test.ts
git commit -m "feat: segment a recording at its gaps

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Segment statistics, cap, hints, view range

**Files:**
- Modify: `src/samples/overview.ts`
- Test: `tests/samples/overview.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/samples/overview.test.ts` (add `overviewAudio` to the existing import from `overview.ts`):

```ts
import { overviewAudio } from '../../src/samples/overview.ts';

const square = (hz: number, dur: number, amp: number) => Float32Array.from({ length: Math.round(dur * SR) }, (_, i) => (i % Math.round(SR / hz) < SR / hz / 2 ? amp : -amp));

describe('overviewAudio', () => {
  it('measures each segment and reports exact frames and times', () => {
    const x = layout(7, [[1, sine(440, 0.5)], [3, sine(2000, 0.5)]]);
    const o = overviewAudio([x], DEFAULTS);
    expect(o.view).toEqual({ startFrame: 0, endFrame: 7 * SR, startSec: 0, endSec: 7 });
    expect(o.segments).toHaveLength(2);
    const [a, b] = o.segments;
    expect(a).toMatchObject({ index: 1, startFrame: 47040, endFrame: 72000, startSec: 0.98, endSec: 1.5, durationSec: 0.52, clippedSamples: 0, flags: [] });
    expect(a.peakDb).toBeCloseTo(-6, 0);
    expect(a.centroidHz).toBeGreaterThan(300);
    expect(a.centroidHz).toBeLessThan(600);
    expect(b.centroidHz).toBeGreaterThan(1500);
    expect(b.index).toBe(2);
    expect(o.peakDb).toBeCloseTo(-6, 0);
    expect(o.arc).toHaveLength(7);
    expect(o.omitted).toBe(0);
    expect(o.hints).toEqual([]);
  });

  it('flags clipped, short and cut-at-ten-seconds segments', () => {
    const x = layout(30, [[1, square(480, 0.1, 1)], [3, whiteNoise(15, 2, 0.3)]]);
    const o = overviewAudio([x], DEFAULTS);
    expect(o.segments[0].flags).toEqual(['clipped', 'short']);
    expect(o.segments[0].clippedSamples).toBeGreaterThan(0);
    const cut = o.segments.slice(1);
    expect(cut.length).toBeGreaterThanOrEqual(2);
    expect(cut[0].flags).toContain('cutAt10s');
    expect(cut[cut.length - 1].flags).not.toContain('cutAt10s');
  });

  it('works inside a view range and keeps source time', () => {
    const x = layout(7, [[1, sine(440, 0.5)], [3, sine(440, 0.5)], [5, sine(440, 0.5)]]);
    const o = overviewAudio([x], { ...DEFAULTS, startFrame: 2 * SR, endFrame: 6 * SR });
    expect(o.view).toMatchObject({ startSec: 2, endSec: 6 });
    expect(o.segments.map(s => s.startFrame)).toEqual([143040, 239040]);
    expect(o.arc).toHaveLength(4);
  });

  it('keeps the 64 loudest of more than 64 segments, in time order, and says so', () => {
    const parts: [number, Float32Array][] = Array.from({ length: 70 }, (_, i) => [0.1 + i * 0.36, sine(440, 0.06, 0.1 + i * 0.01)]);
    const o = overviewAudio([layout(26, parts)], DEFAULTS);
    expect(o.segments).toHaveLength(64);
    expect(o.omitted).toBe(6);
    expect(o.segments[0].startSec).toBeCloseTo(2.24, 2); // bursts 0 to 5 are the quietest
    expect(o.segments.map(s => s.index)).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
    expect(o.hints.join(' ')).toMatch(/--min-gap/);
  });

  it('hints at --gap-db and --min-gap when one continuous sound is cut at ten seconds', () => {
    const o = overviewAudio([whiteNoise(25, 1, 0.3)], DEFAULTS);
    expect(o.hints.join(' ')).toMatch(/--gap-db/);
  });

  it('hints when nothing is audible', () => {
    const o = overviewAudio([new Float32Array(SR)], DEFAULTS);
    expect(o.segments).toEqual([]);
    expect(o.hints.join(' ')).toMatch(/-70 dBFS/);
  });

  it('measures stereo sources without throwing', () => {
    const x = layout(3, [[1, sine(440, 0.5)]]);
    expect(overviewAudio([x, x], DEFAULTS).segments).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/samples/overview.test.ts`
Expected: FAIL, `overviewAudio is not a function`.

- [ ] **Step 3: Implement**

In `src/samples/overview.ts` replace the single import line at the top with:

```ts
import { clippedSamples, crestDb } from '../measure/envelope.ts';
import { findEvents } from '../measure/events.ts';
import { momentaryMax, samplePeakDb, toLufs, weightedPower } from '../measure/loudness.ts';
import { centroid, spectrum } from '../measure/spectral.ts';
import { PREPARED_MAX_FRAMES } from './store.ts';
```

Append at the end of the file:

```ts
export const MAX_SEGMENTS = 64;
const SHORT_SEC = 0.15;

/** Seconds as the exact 48 kHz frame: six decimals round-trip to the same frame through `prepare --start/--end`. */
export const sec = (frames: number): number => Math.round((frames / SR) * 1e6) / 1e6;
const r2 = (v: number): number => Math.round(v * 100) / 100;
const finite = (v: number): number | null => (Number.isFinite(v) ? r2(v) : null);

export type SegmentFlag = 'clipped' | 'cutAt10s' | 'short';
export interface OverviewSegment {
  index: number;
  startFrame: number; endFrame: number; startSec: number; endSec: number; durationSec: number;
  peakDb: number; momentaryMaxLufs: number | null; crestDb: number; centroidHz: number; clippedSamples: number;
  events: { count: number; rpm: number | null };
  flags: SegmentFlag[];
}
export interface Overview {
  view: { startFrame: number; endFrame: number; startSec: number; endSec: number };
  peakDb: number;
  segments: OverviewSegment[];
  omitted: number;
  hints: string[];
  /** Loudness (LUFS) of each whole second of the view, for the image. */
  arc: number[];
}

const mono = (channels: Float32Array[]): Float32Array => {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
};

function loudnessArc(channels: Float32Array[]): number[] {
  const power = weightedPower(channels, 0), arc: number[] = [];
  for (let s = 0; s + SR <= power.length; s += SR) {
    let sum = 0;
    for (let i = s; i < s + SR; i++) sum += power[i];
    arc.push(Math.round(Math.max(-70, toLufs(sum / SR)) * 10) / 10);
  }
  return arc;
}

function peakAbs(x: Float32Array, c: Cut): number {
  let p = 0;
  for (let i = c.startFrame; i < c.endFrame; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

/** Segment the view `[startFrame, endFrame)` of a source and measure each segment. Frames in the result are source frames. */
export function overviewAudio(channels: Float32Array[], opts: SegmentOptions & { startFrame?: number; endFrame?: number }): Overview {
  const total = channels[0]?.length ?? 0, v0 = opts.startFrame ?? 0, v1 = opts.endFrame ?? total;
  const view = channels.map(c => c.subarray(v0, v1)), x = mono(view);
  let cuts = segmentMono(x, opts);
  const hints: string[] = [];
  if (!cuts.length) hints.push('no sound above -70 dBFS in the view');
  else if (cuts.length > 1 && cuts.slice(0, -1).every(c => c.cutAt10s)) {
    hints.push(`no gap of ${opts.minGapMs} ms or more, ${opts.gapDb} dB under the loudest frame, splits this sound: the segments are ten-second cuts of one continuous sound; lower --gap-db or --min-gap to look for gaps`);
  }
  let omitted = 0;
  if (cuts.length > MAX_SEGMENTS) {
    const peaks = cuts.map(c => peakAbs(x, c));
    const keep = cuts.map((_, i) => i).sort((a, b) => peaks[b] - peaks[a] || a - b).slice(0, MAX_SEGMENTS).sort((a, b) => a - b);
    omitted = cuts.length - MAX_SEGMENTS;
    cuts = keep.map(i => cuts[i]);
    hints.push(`${omitted} quieter segments omitted: raise --min-gap to merge neighbours, or use --start and --end to look closer`);
  }
  const segments = cuts.map((c, i): OverviewSegment => {
    const parts = view.map(ch => ch.subarray(c.startFrame, c.endFrame)), m = x.subarray(c.startFrame, c.endFrame);
    const clipped = clippedSamples(parts), ev = findEvents(m, SR), durationSec = sec(c.endFrame - c.startFrame);
    const flags: SegmentFlag[] = [];
    if (clipped) flags.push('clipped');
    if (c.cutAt10s) flags.push('cutAt10s');
    if (durationSec < SHORT_SEC) flags.push('short');
    return {
      index: i + 1, startFrame: v0 + c.startFrame, endFrame: v0 + c.endFrame, startSec: sec(v0 + c.startFrame), endSec: sec(v0 + c.endFrame), durationSec,
      peakDb: r2(samplePeakDb(parts)), momentaryMaxLufs: finite(momentaryMax(parts, SR)), crestDb: r2(crestDb(m)),
      centroidHz: Math.round(centroid(spectrum(m, SR))), clippedSamples: clipped, events: { count: ev.count, rpm: ev.rpm }, flags,
    };
  });
  return {
    view: { startFrame: v0, endFrame: v1, startSec: sec(v0), endSec: sec(v1) },
    peakDb: r2(samplePeakDb(view)), segments, omitted, hints, arc: loudnessArc(view),
  };
}

/** The feature object `renderSongLook` draws: numbered segment bands over the view, the loudness arc, a source footer. */
export function overviewLook(o: Overview): object {
  return {
    sections: o.segments.map(s => ({ name: String(s.index), start: s.startSec - o.view.startSec, end: s.endSec - o.view.startSec, lufs: s.momentaryMaxLufs ?? -70, centroidHz: s.centroidHz })),
    arc: o.arc,
    source: { startSec: o.view.startSec, endSec: o.view.endSec, peakDb: o.peakDb },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/samples/overview.test.ts && npm run typecheck`
Expected: 13 tests PASS; typecheck clean. If the `startSec: 0.98` / `durationSec: 0.52` expectations differ by a rounding digit, print `o.segments[0]` and fix the test to the exact frame math (47040/48000 = 0.98, 72000-47040 = 24960 frames = 0.52).

- [ ] **Step 5: Commit**

```bash
git add src/samples/overview.ts tests/samples/overview.test.ts
git commit -m "feat: measure overview segments with flags, cap and hints

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The `sample overview` command (JSON, no image)

**Files:**
- Modify: `src/samples/prepare.ts` (export `MAX_ORIGINAL_BYTES`)
- Create: `src/samples/overview-run.ts`
- Modify: `src/commands/samples.ts`
- Test: `tests/samples/overview-cli.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/samples/overview-cli.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWav } from '../../src/audio/wav.ts';
import { initProject } from '../../src/project.ts';
import { sampleId } from '../../src/samples/store.ts';
import { SR, sine } from '../helpers/signals.ts';

const bin = join(import.meta.dirname, '../../scripts/beeps.mjs'), dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'beeps-overview-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const cli = (cwd: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  const json = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };
  return { status: r.status, out: json(r.stdout), err: json(r.stderr)?.error, stderr: r.stderr };
};
const layout = (total: number, parts: [number, Float32Array][]) => {
  const out = new Float32Array(Math.round(total * SR));
  for (const [t, x] of parts) out.set(x, Math.round(t * SR));
  return out;
};
const long = () => layout(12, [[1, sine(440, 0.5)], [4, sine(660, 0.5)], [8, sine(880, 0.5)]]);
const write = (d: string, name: string, pcm: Float32Array) => { const f = join(d, name); writeFileSync(f, writeWav([pcm], SR, { bits: 32 })); return f; };

describe('beeps sample overview', () => {
  it('overviews a file with no project and names the ID import will give it', () => {
    const d = dir(), pcm = long(), file = write(d, 'long.wav', pcm);
    const r = cli(d, 'sample', 'overview', file, '--no-image');
    expect(r.status, r.stderr).toBe(0);
    expect(r.out.image).toBeNull();
    expect(r.out.source).toMatchObject({ file: 'long.wav', durationSec: 12, channels: 1, sampleRate: 48000, normalizedId: sampleId(writeWav([pcm], SR, { bits: 32 })) });
    expect(r.out.segments.map((s: { startSec: number }) => s.startSec)).toEqual([0.98, 3.98, 7.98]);
    expect(r.out.hints.join(' ')).toMatch(/sample import/);
  });

  it('agrees with import, and its prepare lines run and give the segment frames', () => {
    const d = dir(); initProject(d);
    const file = write(d, 'long.wav', long());
    const imported = cli(d, 'sample', 'import', file).out;
    const byFile = cli(d, 'sample', 'overview', file, '--no-image').out;
    expect(byFile.source.normalizedId).toBe(imported.normalizedId);
    const byId = cli(d, 'sample', 'overview', imported.normalizedId, '--no-image');
    expect(byId.status, byId.stderr).toBe(0);
    expect(byId.out.source).toMatchObject({ normalizedId: imported.normalizedId });
    expect(byId.out.source.file).toBeUndefined();
    for (const s of byId.out.segments) {
      const [, , , id, , start, , end] = s.prepare.split(' ');
      expect(id).toBe(imported.normalizedId);
      const p = cli(d, 'sample', 'prepare', id, '--start', start, '--end', end);
      expect(p.status, p.stderr).toBe(0);
      expect(p.out.receipt.recipe).toMatchObject({ startFrame: s.startFrame, endFrame: s.endFrame });
    }
  });

  it('limits the view with --start and --end in source time', () => {
    const d = dir(), file = write(d, 'long.wav', long());
    const r = cli(d, 'sample', 'overview', file, '--no-image', '--start', '3', '--end', '9');
    expect(r.status, r.stderr).toBe(0);
    expect(r.out.source.view).toEqual({ startSec: 3, endSec: 9 });
    expect(r.out.segments.map((s: { startSec: number }) => s.startSec)).toEqual([3.98, 7.98]);
  });

  it('rejects bad arguments before doing work', () => {
    const d = dir(), file = write(d, 'long.wav', long());
    for (const args of [['--start', 'NaN'], ['--start', '13'], ['--end', '0'], ['--start', '5', '--end', '2'], ['--end', '13'], ['--gap-db', '0'], ['--gap-db', '101'], ['--min-gap', '5'], ['--min-gap', 'x']]) {
      const r = cli(d, 'sample', 'overview', file, '--no-image', ...args);
      expect(r.status, JSON.stringify(args)).not.toBe(0);
      expect(r.err.code, JSON.stringify(args)).toBe('E_SCHEMA');
    }
    expect(cli(d, 'sample', 'overview', 'sha256:abc', '--no-image').err.code).toBe('E_SCHEMA');
    expect(cli(d, 'sample', 'overview', join(d, 'missing.wav'), '--no-image').err.code).toBe('E_NOT_FOUND');
    expect(cli(d, 'sample', 'overview', file).err.code).toBe('E_USAGE'); // image wanted, no project, no --out
  });

  it('needs a project for an ID and refuses an unknown one', () => {
    const d = dir(), id = `sha256:${'0'.repeat(64)}`;
    expect(cli(d, 'sample', 'overview', id, '--no-image').err.code).toBe('E_PROJECT');
    initProject(d);
    expect(cli(d, 'sample', 'overview', id, '--no-image').err.code).toBe('E_NOT_FOUND');
  });

  it('rejects a source over 120 seconds', () => {
    const d = dir(), file = write(d, 'huge.wav', layout(121, [[1, sine(440, 0.5)]]));
    const r = cli(d, 'sample', 'overview', file, '--no-image');
    expect(r.status).not.toBe(0);
    expect(r.err.code).toBe('E_SCHEMA');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/samples/overview-cli.test.ts`
Expected: FAIL, commander `unknown command 'overview'` (`E_USAGE` where the tests expect other codes).

- [ ] **Step 3: Implement the runner and the command**

In `src/samples/prepare.ts` change `const MAX_ORIGINAL_BYTES = 64 * 1024 * 1024;` to `export const MAX_ORIGINAL_BYTES = 64 * 1024 * 1024;`.

Create `src/samples/overview-run.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { readSampleWav } from '../../runtime/engine/sample-wav.js';
import { decodeAudio } from '../audio/decode.ts';
import { writeWav } from '../audio/wav.ts';
import { BeepsError } from '../errors.ts';
import { canonicalJson, sha256 } from '../hash.ts';
import { openProject, type OpenProject } from '../project.ts';
import { openRenderHost } from '../render/host.ts';
import { overviewAudio, overviewLook, sec, SR } from './overview.ts';
import { MAX_ORIGINAL_BYTES } from './prepare.ts';
import { assertSampleId, readSampleObject, sampleId, samplePaths, SOURCE_MAX_FRAMES, type SampleId } from './store.ts';

export interface OverviewRequest {
  source: string; projectDir: string; gapDb: number; minGapMs: number; image: boolean;
  startSec?: number; endSec?: number; out?: string;
}

interface Loaded { channels: Float32Array[]; normalizedId: SampleId; file?: string }

function load(req: OverviewRequest, project: OpenProject | undefined): Loaded {
  if (req.source.startsWith('sha256:')) {
    assertSampleId(req.source);
    const object = readSampleObject(samplePaths(project!).objects, req.source, { maxFrames: SOURCE_MAX_FRAMES });
    return { channels: readSampleWav(object.wav, { maxFrames: SOURCE_MAX_FRAMES }).channels, normalizedId: object.id };
  }
  // The same decode `sample import` makes, so the normalized ID is the one import will report.
  const decoded = decodeAudio(resolve(req.source), { rate: 48000, maxSeconds: 120, maxFrames: SOURCE_MAX_FRAMES, maxChannels: 2, maxInputBytes: MAX_ORIGINAL_BYTES });
  return { channels: decoded.channels, normalizedId: sampleId(writeWav(decoded.channels, 48000, { bits: 32 })), file: basename(req.source) };
}

export async function runOverview(req: OverviewRequest) {
  if (!(req.gapDb > 0 && req.gapDb <= 100)) throw new BeepsError('E_SCHEMA', '--gap-db must be above 0 and at most 100');
  if (!(req.minGapMs >= 10 && req.minGapMs <= 10000)) throw new BeepsError('E_SCHEMA', '--min-gap must be 10 to 10000 ms');
  if (req.startSec !== undefined && req.startSec < 0) throw new BeepsError('E_SCHEMA', '--start must not be negative');
  if (req.endSec !== undefined && req.endSec <= (req.startSec ?? 0)) throw new BeepsError('E_SCHEMA', '--end must be after --start');
  const byId = req.source.startsWith('sha256:');
  let project: OpenProject | undefined;
  try { project = openProject(req.projectDir); }
  catch (e) { if (byId || !(e instanceof BeepsError) || e.code !== 'E_PROJECT') throw e; }
  if (req.image && !req.out && !project) throw new BeepsError('E_USAGE', 'outside a project the image needs --out <png> (or pass --no-image)');

  const loaded = load(req, project), total = loaded.channels[0].length;
  const startFrame = req.startSec === undefined ? 0 : Math.round(req.startSec * SR);
  const endFrame = req.endSec === undefined ? total : Math.round(req.endSec * SR);
  if (startFrame >= total) throw new BeepsError('E_SCHEMA', `--start is beyond the source length ${sec(total)} s`, { pointer: '/startFrame' });
  if (endFrame > total) throw new BeepsError('E_SCHEMA', `--end is beyond the source length ${sec(total)} s`, { pointer: '/endFrame' });

  const o = overviewAudio(loaded.channels, { gapDb: req.gapDb, minGapMs: req.minGapMs, startFrame, endFrame });
  const hints = [...o.hints];
  if (loaded.file !== undefined) hints.push(`the prepare lines use ${loaded.normalizedId}, the ID import will give this file: run beeps sample import ${JSON.stringify(req.source)} first and check the IDs match`);

  let image: string | null = null;
  if (req.image) {
    const key = sha256(canonicalJson({ id: loaded.normalizedId, startFrame, endFrame, gapDb: req.gapDb, minGapMs: req.minGapMs })).slice(0, 12);
    image = req.out ? resolve(req.out) : join(project!.paths.renders, 'overviews', `${key}.png`);
    const label = loaded.file ?? `${loaded.normalizedId.slice(0, 15)}...`;
    const host = await openRenderHost();
    let png: Buffer;
    try { png = await host.songPcmLook(loaded.channels.map(c => c.subarray(startFrame, endFrame)), overviewLook(o), label); } finally { await host.close(); }
    mkdirSync(dirname(image), { recursive: true });
    writeFileSync(image, png);
  }
  return {
    source: { ...(loaded.file !== undefined ? { file: loaded.file } : {}), normalizedId: loaded.normalizedId, durationSec: sec(total), sampleRate: 48000, channels: loaded.channels.length, view: { startSec: o.view.startSec, endSec: o.view.endSec } },
    image,
    segments: o.segments.map(s => ({ ...s, prepare: `beeps sample prepare ${loaded.normalizedId} --start ${s.startSec} --end ${s.endSec}` })),
    omitted: o.omitted,
    hints,
  };
}
```

In `src/commands/samples.ts` add the import `import { runOverview } from '../samples/overview-run.ts';` next to the other sample imports, and inside `registerSampleCommands` after the `prepare` command (before `bundle`) add:

```ts
  sample.command('overview <source>').description('image a recording of up to 120 s and list its natural segments (each at most ten seconds, with numbers and a ready prepare command); <source> is a sha256 sample ID or an audio file')
    .option('--start <seconds>', 'view range start (default 0)').option('--end <seconds>', 'view range end (default the whole source)')
    .option('--out <png>', 'image path (default .agent-beeps/renders/overviews/<key>.png; required outside a project)')
    .option('--gap-db <dB>', 'a gap is this far under the loudest frame (default 40)').option('--min-gap <ms>', 'shortest gap that splits segments (default 200)')
    .option('--no-image', 'JSON only: skip the browser')
    .action(async (source: string, options: { start?: string; end?: string; out?: string; gapDb?: string; minGap?: string; image: boolean }) => {
      io.emit(await runOverview({
        source, projectDir: io.projectDir(), image: options.image, out: options.out,
        startSec: options.start === undefined ? undefined : number(options.start, 'start'),
        endSec: options.end === undefined ? undefined : number(options.end, 'end'),
        gapDb: options.gapDb === undefined ? 40 : number(options.gapDb, 'gap-db'),
        minGapMs: options.minGap === undefined ? 200 : number(options.minGap, 'min-gap'),
      }));
    });
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/samples/overview-cli.test.ts tests/samples/overview.test.ts && npm run typecheck`
Expected: all PASS; typecheck clean. If `--end 13` on a 12 s file reports `E_SCHEMA` from the range check it passes; if a case reports a different code, fix the code in `overview-run.ts`, not the test (the spec says bad arguments are `E_SCHEMA`; the no-project/no-`--out` case is `E_USAGE`).

- [ ] **Step 5: Commit**

```bash
git add src/samples/prepare.ts src/samples/overview-run.ts src/commands/samples.ts tests/samples/overview-cli.test.ts
git commit -m "feat: add beeps sample overview

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The overview image

**Files:**
- Modify: `runtime/look.js` (the numbers line of `renderSongLook`)
- Test: `tests/samples/overview-cli.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/samples/overview-cli.test.ts` add imports `import { existsSync, readFileSync } from 'node:fs';` (merge with the existing `node:fs` import) and `import { chromiumAvailable } from '../../src/render/host.ts';`, then below the imports `const hasChromium = await chromiumAvailable();`. Add inside the `describe`:

```ts
  it.skipIf(!hasChromium)('writes a PNG, in the project renders folder by default and at --out otherwise', () => {
    const d = dir(); initProject(d);
    const file = write(d, 'long.wav', long());
    const byDefault = cli(d, 'sample', 'overview', file);
    expect(byDefault.status, byDefault.stderr).toBe(0);
    expect(byDefault.out.image.startsWith(join(d, '.agent-beeps', 'renders', 'overviews'))).toBe(true);
    const png = readFileSync(byDefault.out.image);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.length).toBeGreaterThan(5000);
    const elsewhere = join(d, 'out', 'shape.png');
    const r = cli(d, 'sample', 'overview', file, '--out', elsewhere, '--start', '3', '--end', '9');
    expect(r.status, r.stderr).toBe(0);
    expect(r.out.image).toBe(elsewhere);
    expect(existsSync(elsewhere)).toBe(true);
    const outside = dir(); const loose = write(outside, 'long.wav', long());
    expect(cli(outside, 'sample', 'overview', loose, '--out', join(outside, 'o.png')).status).toBe(0);
  });
```

- [ ] **Step 2: Run to confirm the image path works before the footer change**

Run: `npx vitest run tests/samples/overview-cli.test.ts -t "writes a PNG"`
Expected: PASS (the song look already draws from the features; the footer would say "played at" with blank numbers). If Chromium is missing the test is skipped: run `node scripts/beeps.mjs` setup per the beeps-setup skill, then re-run. This step proves the pipeline; the footer is the visible change.

- [ ] **Step 3: Source footer**

In `runtime/look.js`, in `renderSongLook`, replace

```js
  g.fillText(`${mmss(dur)}  played at ${fmt(f.delivered?.integratedLufs)} LUFS-I
```

with

```js
  g.fillText(f.source ? `${mmss(dur)}  source ${fmt(f.source.startSec, 1)}-${fmt(f.source.endSec, 1)} s  peak ${fmt(f.source.peakDb)} dBFS  ${(f.sections ?? []).length} segments` : `${mmss(dur)}  played at ${fmt(f.delivered?.integratedLufs)} LUFS-I
```

(only the start of that line changes; the rest of the original template literal and `, 8, ty + 40);` stay as they are).

- [ ] **Step 4: Look at the image**

Run, in a scratch folder, an overview of a real or synthetic long file and open the PNG with Read:

```bash
node -e "import('./src/audio/wav.ts').then(({writeWav})=>{const sr=48000,x=new Float32Array(sr*40);for(const [t,f,d] of [[2,440,3],[10,880,0.4],[14,220,6],[30,660,0.2]])for(let i=0;i<d*sr;i++)x[Math.round(t*sr)+i]=0.5*Math.sin(2*Math.PI*f*i/sr)*Math.exp(-i/sr/(d/3));require('fs').writeFileSync(process.env.TEMP+'/ov.wav',writeWav([x],sr,{bits:32}))})"
node scripts/beeps.mjs sample overview "$TEMP/ov.wav" --out "$TEMP/ov.png"
```

Read `$TEMP/ov.png`. Check: numbered bands 1..4 line up with the sounds, gaps are dark, the spectrogram shows the four tones, the footer reads `source 0.0-40.0 s peak … dBFS  4 segments`. Fix `overviewLook` or the footer if not. (If the `-e` one-liner fails on Windows quoting, write the same script to the scratchpad directory as a `.mjs` file.)

- [ ] **Step 5: Song looks are unchanged**

Run the song/look suites: `npx vitest run tests/music tests/render tests/summary.test.ts`
Expected: PASS.

Then compare a real song look on main and on the branch (the change must be byte-identical when `f.source` is absent):

```bash
S=$(ls library/songs | head -1); echo "$S"
mkdir -p "$TEMP/idm" && cd "$TEMP/idm" && node <repo>/scripts/beeps.mjs init >/dev/null 2>&1
cp <repo>/library/songs/$S .agent-beeps/songs/ 2>/dev/null
node <repo>/scripts/beeps.mjs song render "${S%.json}" >/dev/null && sha256sum .agent-beeps/renders/song-*/look.png
rm -rf .agent-beeps/renders
node <worktree>/scripts/beeps.mjs song render "${S%.json}" >/dev/null && sha256sum .agent-beeps/renders/song-*/look.png
```

Expected: the two hashes match. If the song needs instruments or arguments the commands above lack, run `beeps song render --help` and adapt; the point is two renders of the same song, one per checkout. If the hashes differ, stop: the footer edit changed the non-source path.

- [ ] **Step 6: Commit**

```bash
git add runtime/look.js tests/samples/overview-cli.test.ts
git commit -m "feat: draw the source overview image

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Skill support, capabilities, docs, version

**Files:**
- Modify: `skills/beeps-compose/references/hybrid-sources.md`, `skills/beeps-compose/references/matching-a-reference.md`, `skills/beeps-compose/SKILL.md`, `src/commands/capabilities.ts`, `docs/runtime-package.md`, `README.md`
- Modify (version): `package.json`, `package-lock.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
- Test: `tests/cli.test.ts`

- [ ] **Step 1: Failing capabilities test**

In `tests/cli.test.ts` add a test next to the existing capabilities one (reuse its CLI helper; if it is named differently use that name):

```ts
  it('lists sample overview in the capabilities', () => {
    const r = beeps('capabilities');
    expect(r.status).toBe(0);
    expect(JSON.stringify(r.out)).toContain('sample overview');
  });
```

Run: `npx vitest run tests/cli.test.ts -t "sample overview"`. Expected: FAIL. If `tests/cli.test.ts` has no `beeps` helper of that shape, copy the `cli` helper from `tests/samples/overview-cli.test.ts` into the test.

- [ ] **Step 2: Capabilities**

In `src/commands/capabilities.ts` change `commands: ['sample import', 'sample prepare', 'sample bundle', 'sample sync'],` to `commands: ['sample import', 'sample overview', 'sample prepare', 'sample bundle', 'sample sync'],` and, after the note starting `'Import retains exact originals`, add:

```ts
            'A recording longer than ten seconds: sample overview <normalizedId|file> [--start --end] images it and lists natural segments (peak, loudness, events, flags, a ready prepare line); it proposes, the owner chooses.',
```

Run the test again; expected PASS.

- [ ] **Step 3: Skill references**

In `skills/beeps-compose/references/hybrid-sources.md`, insert before `## What leaves the project`:

````markdown
## Long recordings: overview first

A recording can run to 120 seconds; a prepared source is at most ten. Look at the whole recording
before you crop it, from a normalized ID or straight from a file (no project needed):

```text
beeps sample overview <normalizedId>
beeps sample overview take.wav --out shape.png --start 40 --end 70   # zoom into a stretch
```

It writes a PNG (default `.agent-beeps/renders/overviews/<key>.png`; **open it**): waveform, the
per-second loudness arc and a spectrogram, with numbered bands for the segments. The JSON lists the
same segments: stretches between gaps (200 ms or more, 40 dB under the loudest frame), each cut to at
most ten seconds, with `peakDb`, `momentaryMaxLufs`, `crestDb`, `centroidHz`, `clippedSamples`,
`events` (count and rate), `flags` and a ready `prepare` line. Run that line, adding `--name`,
fades and gain as usual. Times are exact frames, so the crop is the segment.

- `clipped`: the segment has flattened peaks; lowering gain will not repair them. Prefer another.
- `cutAt10s`: the sound goes on past the cut. Choose a shorter window that ends where you want.
- `short`: under 150 ms. Fine for a click; check it is not a stray noise.
- `hints` say when nothing is audible, when a continuous sound had no gap to cut at (lower `--gap-db`
  or `--min-gap`), or when quieter segments were left out (raise `--min-gap`, or zoom with
  `--start`/`--end`). A 120-second image is about 86 ms per pixel: zoom to see transients.
- Nothing is ranked. The overview proposes windows; picking the sound is the owner's ear
  (beeps-audition). `--no-image` returns the JSON without starting a browser.
````

In `skills/beeps-compose/references/matching-a-reference.md`, append to the paragraph line `Matching by synthesis and using the licensed recording itself are different authoring choices.` the sentence ` A reference longer than ten seconds? Run \`beeps sample overview <file>\` first: it images the whole recording and lists its segments with event counts and rates, so you can pick the stretch to prepare (\`analyze\` still measures the whole file).`

In `skills/beeps-compose/SKILL.md` (127 lines now; the limit is 150): in the `when_to_use` line change `when the owner supplies a recording or clip to match, reproduce or combine with synthesis,` to `when the owner supplies a recording or clip to match, reproduce or combine with synthesis, when a recording is longer than ten seconds and a crop must be chosen,` and after the line `Keep ordinary procedural work on the generate path below; songs/music remain beeps-music.` add:

```
A recording longer than ten seconds? `beeps sample overview <normalizedId|file>` first: it images the
whole recording and proposes crop windows with a ready `prepare` line each (hybrid-sources.md).
```

- [ ] **Step 4: Docs and version**

`docs/runtime-package.md`: after the sentence `The authoring CLI accepts originals up to 64 MiB and normalized snapshots up to 120 seconds.` add ` \`beeps sample overview\` images a long recording and proposes ten-second windows.`

`README.md`: before `## What changed in 0.16.0` insert:

```markdown
## What changed in 0.17.0

`beeps sample overview <normalizedId|file>` shows the shape of a recording of up to 120 seconds before
you crop it: an image (waveform, loudness arc, spectrogram, numbered segments) and a list of natural
segments, each at most ten seconds, with peak, loudness, event count and rate, clipping and cut flags
and a ready `sample prepare` line. `--start`/`--end` zoom into a stretch; `--no-image` skips the
browser. It proposes; the owner's ear chooses. [Long recordings](skills/beeps-compose/references/hybrid-sources.md).

```

Version bump to 0.17.0:

```bash
sed -i '3s/0\.16\.0/0.17.0/' package.json .claude-plugin/plugin.json
sed -i '3s/0\.16\.0/0.17.0/;9s/0\.16\.0/0.17.0/' package-lock.json
sed -i '11s/0\.16\.0/0.17.0/' .claude-plugin/marketplace.json
git diff --stat
grep -n '0\.1[67]\.0' package.json package-lock.json .claude-plugin/*.json
```

Expected: five version lines now say 0.17.0 and none say 0.16.0.

- [ ] **Step 5: Run the suites that guard skills and docs**

Run: `npx vitest run tests/skills.test.ts tests/cli.test.ts tests/samples && npm run typecheck`
Expected: PASS (skills stay under 150 lines and contain no wiki references).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: document sample overview and release 0.17.0

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Spec update, full verification, wiki

**Files:**
- Modify: `docs/superpowers/specs/2026-10-20-source-overview-design.md`

- [ ] **Step 1: Bring the spec in line with the build**

In the spec: change the default image path to `.agent-beeps/renders/overviews/<key>.png` (derived, gitignored; say why); replace the file-source `prepare` text with: a file source reports `source.normalizedId` (the ID `sample import` gives that file) and every `prepare` line uses it, with a hint to import first; add `startFrame`/`endFrame` and 6-decimal seconds to the output description; replace the "song look is byte-identical" test line with "song look PNGs were compared by hash on main and the branch (manual, Chromium-dependent)".

- [ ] **Step 2: Full verification (superpowers verification-before-completion)**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; full suite passes (previously 865 passed, 5 skipped in 0.13.0; the count now is higher). Report the actual counts. Any failure: fix the cause, do not skip.

Run the real thing once more and Read the PNG: `node scripts/beeps.mjs sample overview "$TEMP/ov.wav" --out "$TEMP/ov.png"` and `... --start 8 --end 20`.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-10-20-source-overview-design.md
git commit -m "docs: align the source overview spec with the build

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Wiki (wiki-master)**

Invoke the `wiki-master:wiki-author` skill. Add under `wiki/authored/agent-beeps/`: a design page for the source overview (summarise the spec, link `hybrid-audio-design`), and a backlog item recording the friction that led here (`look` is patch-only, `prepare` cannot suggest windows) with status shipped in 0.17.0 once merged, and the deferred follow-ups from the spec's Out of scope list (`prepare --auto`, ranking, sources over 120 s). Update the agent-beeps overview/architecture pages where they describe the sample workflow. Follow the skill's operation and commit rules.

- [ ] **Step 5: Hand back for shipping**

Do not push or open a PR without the user: report the commit list, test counts and the image path, and offer `hartye-skills:ship-it`.

---

## Self-review

- **Spec coverage:** command and options (T3); sources, 120 s and 64 MiB bounds (T3); view range (T2, T3); `--no-image` (T3); gap rules, merge, click drop, ten-second cuts, cap (T1, T2); output fields and flags (T2, T3); image and footer (T4); skills, capabilities, README, docs, version (T5); wiki (T6); out-of-scope items untouched. Gaps found and recorded: image folder, file `normalizedId`, exact frames, song-look test (header and T6).
- **Placeholders:** none; every code step has code. The two scratch-script steps (T4) are commands to run and judge by eye, with expected outcomes.
- **Names:** `segmentMono`, `overviewAudio`, `overviewLook`, `sec`, `SR`, `runOverview`, `OverviewRequest`, `Cut`, `OverviewSegment`, `Overview` are used consistently across tasks; `Overview.peakDb` is defined in T2 and used in `overviewLook`; `MAX_ORIGINAL_BYTES` export added in T3 before use.
