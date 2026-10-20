// A long recording's overview: where the sound is, cut into natural segments of at most ten seconds, each with the numbers an
// agent needs to choose a crop for `beeps sample prepare`. Pure: no files, no browser.
// Imported for one source of truth on the ten-second limit; this module does no I/O.
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
    const lo = Math.ceil((start + SPLIT_FROM) / FRAME);
    // the window also stops MIN_RUN_FRAMES short of the end, so the remainder is never under 50 ms
    const hi = Math.min(Math.floor((start + PREPARED_MAX_FRAMES) / FRAME), Math.floor((end - MIN_RUN_FRAMES * FRAME) / FRAME));
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
