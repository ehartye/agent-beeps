// A long recording's overview: where the sound is, cut into natural segments of at most ten seconds, each with the numbers an
// agent needs to choose a crop for `beeps sample prepare`. No I/O of its own: no files, no browser.
import { mixToMono } from '../audio/mono.ts';
import { SAMPLE_RATE } from '../hash.ts';
import { clippedSamples, crestDb } from '../measure/envelope.ts';
import { findEvents } from '../measure/events.ts';
import { loudnessArc, momentaryMax, samplePeakDb, weightedPower } from '../measure/loudness.ts';
import { centroid, spectrum } from '../measure/spectral.ts';
// Imported for one source of truth on the ten-second limit; this module does no I/O.
import { PREPARED_MAX_FRAMES } from './store.ts';

export const SR = SAMPLE_RATE;
/** Samples in one 10 ms level-analysis window; not a sample frame like `startFrame`. */
const LEVEL_FRAME = 480;
const FLOOR_DB = -70;
const LEAD_FRAMES = 2;      // 20 ms before the first loud frame, so an onset is not clipped
const MIN_RUN_FRAMES = 5;   // under 50 ms of sound is a click
const SPLIT_FROM = 6 * SR;  // a ten-second cut is made at the quietest frame 6 to 10 s into the piece

export interface SegmentOptions { gapDb: number; minGapMs: number }
/** A cut of the analysed signal: sample frames, end-exclusive. */
export interface Cut { startFrame: number; endFrame: number; cutAt10s: boolean }

function frameLevels(x: Float32Array): Float64Array {
  const out = new Float64Array(Math.ceil(x.length / LEVEL_FRAME));
  for (let f = 0; f < out.length; f++) {
    const a = f * LEVEL_FRAME, b = Math.min(x.length, a + LEVEL_FRAME);
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
    const lo = Math.ceil((start + SPLIT_FROM) / LEVEL_FRAME);
    // the window also stops MIN_RUN_FRAMES short of the end, so the remainder is never under 50 ms
    const hi = Math.min(Math.floor((start + PREPARED_MAX_FRAMES) / LEVEL_FRAME), Math.floor((end - MIN_RUN_FRAMES * LEVEL_FRAME) / LEVEL_FRAME));
    let at = lo;
    for (let f = lo + 1; f <= hi; f++) if (levels[f] < levels[at]) at = f;
    out.push({ startFrame: start, endFrame: at * LEVEL_FRAME, cutAt10s: true });
    start = at * LEVEL_FRAME;
  }
  out.push({ startFrame: start, endFrame: end, cutAt10s: false });
  return out;
}

/** A stretch of level frames `a` to `b` inclusive. */
interface Run { a: number; b: number }

/** Stretches of frames at or above `threshold`; a quiet gap of fewer than `minGap` frames does not end one. */
function findRuns(levels: Float64Array, threshold: number, minGap: number): Run[] {
  const runs: Run[] = [];
  for (let f = 0; f < levels.length; f++) {
    if (levels[f] < threshold) continue;
    const last = runs[runs.length - 1];
    if (last && f - last.b - 1 < minGap) last.b = f; else runs.push({ a: f, b: f });
  }
  return runs;
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
  const runs = findRuns(levels, threshold, minGap);
  const cuts: Cut[] = [];
  let previousEnd = 0;
  for (const r of runs) {
    if (r.b - r.a + 1 < MIN_RUN_FRAMES) continue;
    const start = Math.max(previousEnd, (r.a - LEAD_FRAMES) * LEVEL_FRAME), end = Math.min(x.length, (r.b + 1) * LEVEL_FRAME);
    cuts.push(...splitLong(levels, start, end));
    previousEnd = end;
  }
  return cuts;
}

/** True when any 10 ms frame is above the -70 dBFS floor: with no segments, tells a view of only short clicks from silence. */
export function hasAudibleFrame(x: Float32Array): boolean {
  return frameLevels(x).some(v => v > FLOOR_DB);
}

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
  /** Loudest sample of the view in dB; null when the view is silent. */
  peakDb: number | null;
  segments: OverviewSegment[];
  omitted: number;
  hints: string[];
  /** Loudness (LUFS) of each whole second of the view, for the image. */
  arc: number[];
}

function peakAbs(x: Float32Array, c: Cut): number {
  let p = 0;
  for (let i = c.startFrame; i < c.endFrame; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

export type OverviewOptions = SegmentOptions & { startFrame?: number; endFrame?: number };

/** Segment the view `[startFrame, endFrame)` of a source and measure each segment. Frames in the result are source frames. */
export function overviewAudio(channels: Float32Array[], opts: OverviewOptions): Overview {
  if (!channels.length) throw new RangeError('overview needs at least one channel');
  const v0 = opts.startFrame ?? 0, v1 = opts.endFrame ?? channels[0].length;
  const view = channels.map(c => c.subarray(v0, v1)), x = mixToMono(view);
  let cuts = segmentMono(x, opts);
  const hints: string[] = [];
  if (!cuts.length) {
    hints.push(hasAudibleFrame(x)
      ? `no segment of ${MIN_RUN_FRAMES * 10} ms or more above -70 dBFS: a shorter sound is not listed; crop it by ear with --start and --end`
      : 'no sound above -70 dBFS in the view (measured on the mono mix)');
  }
  else if (cuts.length > 1 && cuts.slice(0, -1).every(c => c.cutAt10s)) {
    hints.push(`no gap of ${opts.minGapMs} ms or more, ${opts.gapDb} dB under the loudest frame, splits this sound: the segments are ten-second cuts of one continuous sound; lower --gap-db or --min-gap to look for gaps`);
  }
  let omitted = 0;
  if (cuts.length > MAX_SEGMENTS) {
    const peaks = cuts.map(c => peakAbs(x, c));
    const keep = cuts.map((_, i) => i).sort((a, b) => peaks[b] - peaks[a] || a - b).slice(0, MAX_SEGMENTS).sort((a, b) => a - b);
    omitted = cuts.length - MAX_SEGMENTS;
    cuts = keep.map(i => cuts[i]);
    hints.push(`${omitted} quieter segment${omitted === 1 ? '' : 's'} omitted: raise --min-gap to merge neighbours, or use --start and --end to look closer`);
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
    peakDb: finite(samplePeakDb(view)), segments, omitted, hints, arc: loudnessArc(weightedPower(view, 0), SR),
  };
}

export interface OverviewLook {
  sections: { name: string; start: number; end: number; lufs: number; centroidHz: number }[];
  arc: number[];
  source: { startSec: number; endSec: number; peakDb: number | null };
}

/** The feature object `renderSongLook` draws: numbered segment bands over the view, the loudness arc, a source footer. */
export function overviewLook(o: Overview): OverviewLook {
  return {
    // relative times are taken in frames, where the subtraction is exact
    sections: o.segments.map(s => ({ name: String(s.index), start: sec(s.startFrame - o.view.startFrame), end: sec(s.endFrame - o.view.startFrame), lufs: s.momentaryMaxLufs ?? -70, centroidHz: s.centroidHz })),
    arc: o.arc,
    source: { startSec: o.view.startSec, endSec: o.view.endSec, peakDb: o.peakDb },
  };
}
