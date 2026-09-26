// Long-term spectrum (Welch average over non-silent frames) and features derived from it.
import { stftPower } from './fft.ts';

export const N = 2048;

export interface Spectrum { power: Float64Array; peakFrame: Float64Array; binHz: number; sr: number }

/** Zwicker critical-band (Bark) edges in Hz: 24 bands. */
export const BARK_EDGES = [0, 100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270, 1480, 1720, 2000, 2320, 2700, 3150, 3700, 4400, 5300, 6400, 7700, 9500, 12000, 15500];
export const BARK_CENTERS = BARK_EDGES.slice(0, -1).map((lo, i) => (lo + BARK_EDGES[i + 1]) / 2);

export function spectrum(x: ArrayLike<number>, sr: number): Spectrum {
  const frames = stftPower(x, N, N / 4);
  const energy = frames.map(f => f.reduce((a, b) => a + b, 0));
  const max = Math.max(0, ...energy);
  const power = new Float64Array(N / 2 + 1);
  let count = 0, peakIndex = 0;
  frames.forEach((f, i) => {
    if (energy[i] > max * 1e-6) { for (let k = 0; k < f.length; k++) power[k] += f[k]; count++; }
    if (energy[i] === max) peakIndex = i;
  });
  if (count) for (let k = 0; k < power.length; k++) power[k] /= count;
  return { power, peakFrame: frames[peakIndex] ?? new Float64Array(N / 2 + 1), binHz: sr / N, sr };
}

function centroidOf(p: Float64Array, binHz: number): number {
  let num = 0, den = 0;
  for (let k = 1; k < p.length; k++) {
    const f = k * binHz;
    if (f < 20 || f > 20000) continue;
    num += f * p[k]; den += p[k];
  }
  return den > 0 ? num / den : 0;
}

/** Power-weighted mean frequency in Hz: the "brightness" axis. */
export const centroid = (s: Spectrum) => centroidOf(s.power, s.binHz);
export const peakCentroid = (s: Spectrum) => centroidOf(s.peakFrame, s.binHz);

/** Wiener entropy between 50 Hz and 16 kHz: ~1 for noise, ~0 for a pure tone. */
export function flatness(s: Spectrum): number {
  let logSum = 0, sum = 0, n = 0;
  const peak = Math.max(...s.power);
  if (!(peak > 0)) return 0;
  const eps = peak * 1e-12;
  for (let k = 1; k < s.power.length; k++) {
    const f = k * s.binHz;
    if (f < 50 || f > 16000) continue;
    logSum += Math.log(s.power[k] + eps); sum += s.power[k] + eps; n++;
  }
  return n ? Math.exp(logSum / n) / (sum / n) : 0;
}

/** Energy per Bark band (bands above 0.45·sr are left at zero). */
export function barkEnergies(s: Spectrum): Float64Array {
  const e = new Float64Array(BARK_EDGES.length - 1);
  for (let k = 1; k < s.power.length; k++) {
    const f = k * s.binHz;
    for (let b = 0; b < e.length; b++) if (f >= BARK_EDGES[b] && f < BARK_EDGES[b + 1]) { e[b] += s.power[k]; break; }
  }
  return e;
}

export const LOG_BAND_EDGES = [60, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** Relative energy (dB re total) in 8 octave-ish bands from 60 Hz to 16 kHz. */
export function logBands(s: Spectrum): number[] {
  const e = new Array(LOG_BAND_EDGES.length - 1).fill(0);
  let total = 0;
  for (let k = 1; k < s.power.length; k++) {
    const f = k * s.binHz;
    total += s.power[k];
    for (let b = 0; b < e.length; b++) if (f >= LOG_BAND_EDGES[b] && f < LOG_BAND_EDGES[b + 1]) { e[b] += s.power[k]; break; }
  }
  return e.map(x => (x > 0 && total > 0 ? Math.round(100 * 10 * Math.log10(x / total)) / 100 : -120));
}
