// Repeated-event analysis for a mono signal: shots, footsteps, ticks, a burst of anything that recurs.
// Onsets come from the rising edge of the high-passed envelope; the rate from the autocorrelation of that onset strength.
import { absEnvelope, butterworth4 } from './filters.ts';

export interface EventBand { name: string; loHz: number; hiHz: number }
export const EVENT_BANDS: EventBand[] = [
  { name: 'low', loHz: 40, hiHz: 160 }, { name: 'low-mid', loHz: 160, hiHz: 500 }, { name: 'mid', loHz: 500, hiHz: 2000 },
  { name: 'presence', loHz: 2000, hiHz: 6000 }, { name: 'air', loHz: 6000, hiHz: 12000 },
];

export interface Events {
  count: number;
  onsetsSec: number[];
  /** Peak of each event in dB relative to the loudest. */
  levelsDb: number[];
  /** Events per minute from the median interval; null with fewer than 3 events or when nothing repeats (`periodicity` under 0.12). */
  rpm: number | null;
  intervalMsMedian: number | null;
  /** Standard deviation of the intervals over their mean: ~0 for a machine, 0.2+ for a human or a jittery edit. */
  intervalCv: number | null;
  /** Level between events (55-85 % of each interval, median) against the median event peak, dB. null with fewer than 2 events. */
  floorDb: number | null;
  /** Strength (0-1) of the strongest repeat in the onset autocorrelation. */
  periodicity: number;
}

const EMPTY: Events = { count: 0, onsetsSec: [], levelsDb: [], rpm: null, intervalMsMedian: null, intervalCv: null, floorDb: null, periodicity: 0 };
const MIN_LAG_MS = 20, MAX_LAG_MS = 1200, NOISE_PERIODICITY = 0.12, MIN_RISE = 0.15;
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const db = (v: number) => 20 * Math.log10(Math.max(v, 1e-6));

/** The autocorrelation lag (ms) of the repeat, with its strength. */
function repeatLag(o: Float64Array): { lag: number; strength: number } {
  const n = o.length, mean = o.reduce((a, b) => a + b, 0) / n;
  const c = Float64Array.from(o, v => v - mean);
  const maxLag = Math.min(MAX_LAG_MS, Math.floor(n / 2));
  let zero = 0; for (let i = 0; i < n; i++) zero += c[i] * c[i];
  if (!(zero > 0) || maxLag <= MIN_LAG_MS + 2) return { lag: 0, strength: 0 };
  const ac = new Float64Array(maxLag + 2);
  for (let l = MIN_LAG_MS - 1; l <= maxLag + 1; l++) { let s = 0; for (let i = 0; i + l < n; i++) s += c[i] * c[i + l]; ac[l] = s / zero; }
  const peaks: number[] = [];
  for (let l = MIN_LAG_MS; l <= maxLag; l++) if (ac[l] > ac[l - 1] && ac[l] >= ac[l + 1] && ac[l] > 0.03) peaks.push(l);
  if (!peaks.length) return { lag: 0, strength: 0 };
  // the strongest repeat; a half, third or quarter of it replaces it only when that is nearly as strong (an every-other-shot accent)
  // so an echo spacing, which is weaker, is not mistaken for the firing interval
  let lag = peaks.reduce((p, l) => (ac[l] > ac[p] ? l : p), peaks[0]);
  for (const k of [4, 3, 2]) {
    const target = Math.round(lag / k);
    if (target < MIN_LAG_MS) continue;
    const near = peaks.filter(l => Math.abs(l - target) <= Math.max(2, Math.round(target * 0.06))).sort((a, b) => ac[b] - ac[a])[0];
    if (near !== undefined && ac[near] >= 0.85 * ac[lag]) { lag = near; break; }
  }
  return { lag, strength: Math.min(1, ac[lag]) };
}

export function findEvents(x: Float32Array, sr: number): Events {
  const hp = butterworth4(x, sr, 'hp', 800);
  const hop = Math.max(1, Math.round(sr / 1000));
  const sm = absEnvelope(Float32Array.from(hp, v => v * v), sr, 3);               // 3 ms mean power, sqrt'd per hop
  const e = new Float64Array(Math.floor(sm.length / hop));
  for (let k = 0; k < e.length; k++) e[k] = Math.sqrt(sm[k * hop]);
  const top = e.reduce((a, b) => Math.max(a, b), 0);
  if (!(top > 3e-3)) return { ...EMPTY };                                     // under -50 dBFS above 800 Hz there is nothing to find
  let a = 0, b = e.length - 1;
  while (e[a] < 0.1 * top) a++;
  while (e[b] < 0.1 * top) b--;
  a = Math.max(0, a - 12);                                                          // the first rise starts before it crosses 10 %
  if (b - a < 4) return { ...EMPTY };
  const o = new Float64Array(b - a);
  for (let k = 0; k < o.length; k++) o[k] = Math.max(0, Math.log(e[a + k + 1] + 1e-4) - Math.log(e[a + k] + 1e-4));
  const { lag, strength } = repeatLag(o);
  const periodic = strength >= NOISE_PERIODICITY;
  const refractory = periodic ? Math.round(lag * 0.6) : 30;
  const mu = o.reduce((s, v) => s + v, 0) / o.length;
  const sd = Math.sqrt(o.reduce((s, v) => s + (v - mu) ** 2, 0) / o.length);
  const thr = Math.max(MIN_RISE, mu + sd);
  const cand: number[] = [];
  for (let k = 1; k < o.length - 1; k++) if (o[k] > thr && o[k] >= o[k - 1] && o[k] > o[k + 1]) cand.push(k);
  const kept: number[] = [];
  for (const k of cand.sort((p, q) => o[q] - o[p])) if (kept.every(j => Math.abs(j - k) >= refractory)) kept.push(k);
  kept.sort((p, q) => p - q);

  // snap each onset to its crack: the peak of a 1 ms envelope just after the rise
  const env1 = absEnvelope(hp, sr, 1);
  const onsets: number[] = [];
  for (const k of kept) {
    const t = (a + k) * hop / sr, lo = Math.max(0, Math.round((t - 0.006) * sr)), hi = Math.min(env1.length, Math.round((t + 0.008) * sr));
    let at = lo; for (let i = lo; i < hi; i++) if (env1[i] > env1[at]) at = i;
    const s = at / sr;
    if (!onsets.length || s - onsets[onsets.length - 1] > 0.003) onsets.push(s);
  }
  if (!onsets.length) return { ...EMPTY, periodicity: strength };

  const peaks = onsets.map(t => { let m = 0; for (let i = Math.round(t * sr); i < Math.min(x.length, Math.round((t + 0.03) * sr)); i++) m = Math.max(m, Math.abs(x[i])); return m; });
  const top0 = Math.max(...peaks);
  const intervals = onsets.slice(1).map((t, i) => t - onsets[i]);
  const mean = intervals.reduce((s, v) => s + v, 0) / (intervals.length || 1);
  const cv = intervals.length >= 2 ? Math.sqrt(intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / intervals.length) / mean : null;

  let floorDb: number | null = null;
  if (periodic && onsets.length >= 2) {
    const floors: number[] = [], hits: number[] = [];
    for (let i = 0; i < onsets.length - 1; i++) {
      const L = onsets[i + 1] - onsets[i];
      const seg = Array.from(env1.subarray(Math.round((onsets[i] + 0.55 * L) * sr), Math.round((onsets[i] + 0.85 * L) * sr)));
      floors.push(median(seg));
      let m = 0; for (let j = Math.round(onsets[i] * sr); j < Math.round((onsets[i] + 0.01) * sr); j++) m = Math.max(m, env1[j]);
      hits.push(m);
    }
    floorDb = Math.round(100 * (db(median(floors)) - db(median(hits)))) / 100;
  }
  return {
    count: onsets.length,
    onsetsSec: onsets.map(t => Math.round(t * 1e4) / 1e4),
    levelsDb: peaks.map(p => Math.round(100 * db(p / top0)) / 100),
    rpm: periodic && onsets.length >= 3 ? Math.round(10 * 60 / median(intervals)) / 10 : null,
    intervalMsMedian: periodic && intervals.length ? Math.round(10 * 1000 * median(intervals)) / 10 : null,
    intervalCv: !periodic || cv === null ? null : Math.round(1e4 * cv) / 1e4,
    floorDb,
    periodicity: Math.round(1e3 * strength) / 1e3,
  };
}

export interface BandProfile { name: string; loHz: number; hiHz: number; peakMs: number; peakDb: number; t10Ms: number | null; t20Ms: number | null }

/**
 * The mean event, one band at a time: where its envelope peaks (ms after the onset), and how many ms after the peak it takes to
 * fall 10 and 20 dB (null when it never does inside the window, which means a sustained tail or the next event).
 */
export function eventProfile(x: Float32Array, sr: number, onsetsSec: number[], bands: EventBand[] = EVENT_BANDS, spanMs = 90, leadMs = 4): BandProfile[] {
  const n = Math.round(spanMs), step = sr / 1000;
  return bands.map(band => {
    const filtered = butterworth4(butterworth4(x, sr, 'hp', band.loHz), sr, 'lp', Math.min(band.hiHz, sr * 0.45));
    const env = absEnvelope(filtered, sr, 1.5), acc = new Float64Array(n);
    let used = 0;
    for (const t of onsetsSec) {
      const start = Math.round(t * sr - leadMs * step);
      if (start < 0 || start + Math.round(n * step) > env.length) continue;
      for (let k = 0; k < n; k++) acc[k] += env[start + Math.round(k * step)];
      used++;
    }
    if (!used) return { ...band, peakMs: 0, peakDb: -120, t10Ms: null, t20Ms: null };
    let pk = 0; for (let k = 0; k < n; k++) { acc[k] /= used; if (acc[k] > acc[pk]) pk = k; }
    const fall = (d: number) => { for (let k = pk; k < n; k++) if (db(acc[k] / acc[pk]) < -d) return k - pk; return null; };
    return { ...band, peakMs: pk - leadMs, peakDb: Math.round(100 * db(acc[pk])) / 100, t10Ms: fall(10), t20Ms: fall(20) };
  });
}
