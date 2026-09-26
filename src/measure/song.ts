// Song features: integrated loudness (music is levelled on integrated, not max momentary), loudness
// range, a per-second and per-section arc (does the piece build and breathe?), stereo width, low-end
// share, brightness, and the loop seam. Streams over the signal: a 3-minute song is ~9 M samples.
import { fft, hann } from './fft.ts';
import { integrated, samplePeakDb, toLufs, truePeakDb, weightedPower } from './loudness.ts';
import { centroid, flatness, logBands, type Spectrum } from './spectral.ts';
import { clipperCurve } from '../../runtime/engine/fx.js';

export interface SongSection { name: string; start: number; end: number }

export interface SongFeatures {
  durationSec: number;
  integratedLufs: number; shortTermMaxLufs: number; loudnessRangeLu: number;
  samplePeakDb: number; truePeakDb: number; crestDb: number;
  centroidHz: number; flatness: number; bands: number[]; lowShare: number; stereoWidth: number;
  /** Loudness (LUFS) of each whole second: the shape of the piece. */
  arc: number[];
  sections: { name: string; start: number; end: number; lufs: number; centroidHz: number }[];
  /**
   * Loop songs: |level step| across the loop point. Each side is the median of 100 ms block levels
   * over 1.5 s, so a single accent on the downbeat does not read as a seam.
   */
  seamDb?: number;
  seamStartLufs?: number;
  seamEndLufs?: number;
  delivered?: { integratedLufs: number; truePeakDb: number; clippedSamples: number; peakLimited?: boolean };
}

const N = 2048;
const r = (x: number, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);

function spectrumOf(mono: Float32Array, sr: number, from: number, to: number): Spectrum {
  const w = hann(N);
  const power = new Float64Array(N / 2 + 1);
  let count = 0;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let s = from; s + N <= to; s += N) {
    let e = 0;
    for (let i = 0; i < N; i++) { const v = mono[s + i]; re[i] = v * w[i]; im[i] = 0; e += v * v; }
    if (e < 1e-10 * N) continue;
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k];
    count++;
  }
  if (count) for (let k = 0; k < power.length; k++) power[k] /= count;
  return { power, peakFrame: power, binHz: sr / N, sr };
}

const meanOf = (p: Float64Array, a: number, b: number) => {
  let s = 0;
  const lo = Math.max(0, a), hi = Math.min(p.length, b);
  for (let i = lo; i < hi; i++) s += p[i];
  return hi > lo ? s / (hi - lo) : 0;
};

export function measureSong(channels: Float32Array[], sr: number, sections: SongSection[], { loop = false } = {}): SongFeatures {
  const n = channels[0].length;
  const mono = new Float32Array(n);
  let mid = 0, side = 0;
  for (let i = 0; i < n; i++) {
    const L = channels[0][i], R = channels[1]?.[i] ?? L;
    mono[i] = (L + R) / 2;
    mid += ((L + R) / 2) ** 2; side += ((L - R) / 2) ** 2;
  }
  const power = weightedPower(channels, 0);
  const int = integrated(channels, sr).lufs;

  // Short-term (3 s) windows every 0.5 s: max and loudness range (EBU Tech 3342 gating).
  const win = 3 * sr, hop = sr / 2;
  const st: number[] = [];
  for (let s = 0; s + win <= n; s += hop) st.push(toLufs(meanOf(power, s, s + win)));
  if (!st.length) st.push(toLufs(meanOf(power, 0, n)));
  const abs = st.filter(v => v > -70);
  const relGate = abs.length ? toLufs(abs.reduce((a, v) => a + 10 ** ((v + 0.691) / 10), 0) / abs.length) - 20 : -Infinity;
  const gated = abs.filter(v => v > relGate).sort((a, b) => a - b);
  const pct = (q: number) => gated[Math.min(gated.length - 1, Math.floor(q * (gated.length - 1) + 0.5))];
  const lra = gated.length > 1 ? pct(0.95) - pct(0.1) : 0;

  const arc: number[] = [];
  for (let s = 0; s + sr <= n; s += sr) arc.push(r(Math.max(-70, toLufs(meanOf(power, s, s + sr))), 1));

  const spec = spectrumOf(mono, sr, 0, n);
  let low = 0, all = 0;
  for (let k = 1; k < spec.power.length; k++) {
    const f = k * spec.binHz;
    if (f < 20) continue;
    all += spec.power[k];
    if (f < 120) low += spec.power[k];
  }
  let peak = 0, sq = 0;
  for (let i = 0; i < n; i++) { const a = Math.abs(mono[i]); if (a > peak) peak = a; sq += mono[i] * mono[i]; }

  const out: SongFeatures = {
    durationSec: r(n / sr, 3),
    integratedLufs: r(int),
    shortTermMaxLufs: r(Math.max(...st)),
    loudnessRangeLu: r(lra, 1),
    samplePeakDb: r(samplePeakDb(channels)),
    truePeakDb: r(truePeakDb(channels, sr)),
    crestDb: r(sq > 0 ? 20 * Math.log10(peak / Math.sqrt(sq / n)) : 0),
    centroidHz: r(centroid(spec), 0),
    flatness: r(flatness(spec), 4),
    bands: logBands(spec),
    lowShare: r(all > 0 ? low / all : 0, 3),
    stereoWidth: r(mid > 0 ? Math.sqrt(side / mid) : 0, 3),
    arc,
    sections: sections.map(s => {
      const a = Math.round(s.start * sr), b = Math.min(n, Math.round(s.end * sr));
      return { ...s, lufs: r(integrated(channels.map(c => c.subarray(a, b)), sr).lufs, 1), centroidHz: r(centroid(spectrumOf(mono, sr, a, b)), 0) };
    }),
  };
  if (loop) {
    const block = Math.round(0.1 * sr), span = Math.min(Math.floor(n / 2), Math.round(1.5 * sr));
    const edge = (from: number) => {
      const levels: number[] = [];
      for (let b = from; b + block <= from + span; b += block) levels.push(toLufs(meanOf(power, b, b + block)));
      levels.sort((a, b) => a - b);
      return Math.max(-70, levels[levels.length >> 1] ?? -70);
    };
    const start = edge(0), end = edge(n - span);
    out.seamStartLufs = r(start, 1);
    out.seamEndLufs = r(end, 1);
    out.seamDb = r(Math.abs(end - start), 1);
  }
  return out;
}

/**
 * The delivered signal: trim, then the engine's safety clipper curve (the same transfer function
 * the browser WaveShaper applies to SFX), so songs and sounds share one ceiling.
 */
export function applyTrimAndClip(channels: Float32Array[], trimDb: number): Float32Array[] {
  const curve = clipperCurve();
  const last = curve.length - 1;
  const g = 10 ** (trimDb / 20);
  return channels.map(ch => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      const x = Math.max(-1, Math.min(1, ch[i] * g));
      const pos = ((x + 1) / 2) * last;
      const k = Math.min(last - 1, Math.floor(pos));
      out[i] = curve[k] + (curve[k + 1] - curve[k]) * (pos - k);
    }
    return out;
  });
}
