// A recording or render as a text table, one row per time window: the text twin of `sample overview` for an agent that cannot view the image.
// Each row says how loud the window is, how bright, whether it holds a steady pitch, and how many separate events start in it.
import { mixToMono } from '../audio/mono.ts';
import { findEvents } from '../measure/events.ts';
import { pitchTrack } from '../measure/pitch.ts';
import { centroid, spectrum } from '../measure/spectral.ts';
import { SR } from './overview.ts';

export const MAX_WINDOWS = 120;
/** The loudest stretch of a window that is analysed for brightness and pitch (the rest only counts toward level and events). */
const ANALYSIS_SEC = 0.75;
/** Below this peak (dBFS) a window is silence and has no brightness or pitch. */
const SILENT_DB = -70;

export interface DigestWindow {
  index: number;
  startSec: number;
  endSec: number;
  rmsDb: number | null;
  peakDb: number | null;
  centroidHz: number | null;
  /** A steady pitch in Hz (pitch strength 0.7 or more), else null. */
  pitchHz: number | null;
  /** Separate onsets that start inside the window. */
  events: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const db = (v: number) => (v > 1e-9 ? 20 * Math.log10(v) : -Infinity);

/** The loudest `len` frames of `x` (by 50 ms blocks), as a view, so brightness and pitch are read where the sound is. */
function loudest(x: Float32Array, len: number): Float32Array {
  if (x.length <= len) return x;
  const block = Math.max(1, Math.round(0.05 * SR));
  let best = 0, bestE = -1;
  for (let s = 0; s + len <= x.length; s += block) {
    let e = 0;
    for (let i = s; i < s + len; i += 8) e += x[i] * x[i];
    if (e > bestE) { bestE = e; best = s; }
  }
  return x.subarray(best, best + len);
}

export interface Digest {
  view: { startSec: number; endSec: number; windowSec: number };
  windows: DigestWindow[];
  text: string;
}

/** Digest `[startFrame, endFrame)` of a source into `windows` equal windows. */
export function digestAudio(channels: Float32Array[], { startFrame, endFrame, windows }: { startFrame: number; endFrame: number; windows: number }): Digest {
  const mono = mixToMono(channels.map(c => c.subarray(startFrame, endFrame)));
  const n = Math.max(1, Math.min(windows, MAX_WINDOWS, Math.floor(mono.length / (0.05 * SR)) || 1));
  const size = mono.length / n;
  const out: DigestWindow[] = [];
  const all = findEvents(mono, SR).onsetsSec;
  for (let i = 0; i < n; i++) {
    const a = Math.round(i * size), b = i === n - 1 ? mono.length : Math.round((i + 1) * size);
    const x = mono.subarray(a, b);
    let peak = 0, sum = 0;
    for (let k = 0; k < x.length; k++) { const v = Math.abs(x[k]); if (v > peak) peak = v; sum += v * v; }
    const peakDb = db(peak);
    const t0 = a / SR, t1 = b / SR;
    const events = all.filter(t => t >= t0 && t < t1).length;
    const base = { index: i + 1, startSec: r1(t0 + startFrame / SR), endSec: r1(t1 + startFrame / SR), events };
    if (!(peakDb > SILENT_DB)) { out.push({ ...base, rmsDb: null, peakDb: null, centroidHz: null, pitchHz: null }); continue; }
    const slice = loudest(x, Math.round(ANALYSIS_SEC * SR));
    const p = pitchTrack(slice, SR);
    out.push({
      ...base, rmsDb: r1(db(Math.sqrt(sum / x.length))), peakDb: r1(peakDb),
      centroidHz: Math.round(centroid(spectrum(slice, SR))),
      pitchHz: p.strength >= 0.7 && p.medianHz > 0 ? Math.round(p.medianHz * 10) / 10 : null,
    });
  }
  const f = (v: number | null, w: number, d = '') => (v === null ? '-' : `${v}${d}`).padStart(w);
  const text = [
    `${out.length} windows of ${r1(size / SR)} s from ${r1(startFrame / SR)} s to ${r1(endFrame / SR)} s ("-" is silence or no steady pitch)`,
    '  #   start    end    rms    peak  centroid   pitch  events',
    ...out.map(w => `${String(w.index).padStart(3)} ${f(w.startSec, 7)} ${f(w.endSec, 7)} ${f(w.rmsDb, 6)} ${f(w.peakDb, 7)} ${f(w.centroidHz, 8)} ${f(w.pitchHz, 7)} ${String(w.events).padStart(6)}`),
  ].join('\n');
  return { view: { startSec: r1(startFrame / SR), endSec: r1(endFrame / SR), windowSec: r1(size / SR) }, windows: out, text };
}
