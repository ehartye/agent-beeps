// Psychoacoustic indicators: sharpness, roughness, fluctuation strength.
// These are approximations in the spirit of DIN 45692 (sharpness) and Zwicker/Fastl modulation
// metrics (roughness ~70 Hz AM, fluctuation ~4 Hz AM). They diagnose named defects ("tinny",
// "grating") and feed the taste model; they are indicators, not verdicts, and not certified meters.
import { fft, hann, nextPow2 } from './fft.ts';
import { BARK_CENTERS, BARK_EDGES, barkEnergies, spectrum } from './spectral.ts';

const EXP = 0.23; // specific loudness ~ energy^0.23 (Zwicker's power law)

/** Relative specific loudness per Bark band; bands 60 dB below the loudest are ignored. */
function specificLoudness(energies: Float64Array): Float64Array {
  const max = Math.max(...energies);
  return energies.map(e => (max > 0 && e > max * 1e-6 ? e ** EXP : 0));
}

/** DIN 45692 weighting: flat to 15.8 Bark, then rising steeply. */
const g = (z: number) => (z <= 15.8 ? 1 : 0.066 * Math.exp(0.171 * z));

/** Sharpness in acum-like units: the high-frequency-energy ("tinny", "scratchy") axis. */
export function sharpness(x: ArrayLike<number>, sr: number): number {
  const n = specificLoudness(barkEnergies(spectrum(x, sr)));
  let num = 0, den = 0;
  n.forEach((v, i) => { const z = i + 0.5; num += v * g(z) * z; den += v; });
  return den > 0 ? (0.11 * num) / den : 0;
}

function bandpass(x: ArrayLike<number>, sr: number, center: number, bw: number): Float64Array {
  const w0 = (2 * Math.PI * center) / sr;
  const q = center / bw;
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0, b2 = -alpha / a0, a1 = (-2 * Math.cos(w0)) / a0, a2 = (1 - alpha) / a0;
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

const ENV_RATE = 1000;

/** Rectified, smoothed band envelope decimated to 1 kHz. */
function bandEnvelope(y: Float64Array, sr: number): Float64Array {
  const step = Math.round(sr / ENV_RATE);
  const a = Math.exp((-2 * Math.PI * 350) / sr);
  let s1 = 0, s2 = 0;
  const out = new Float64Array(Math.floor(y.length / step));
  for (let i = 0, j = 0; i < y.length; i++) {
    s1 = (1 - a) * Math.abs(y[i]) + a * s1;
    s2 = (1 - a) * s1 + a * s2;
    if (i % step === step - 1 && j < out.length) out[j++] = s2;
  }
  return out;
}

/**
 * Modulation depth spectrum of an envelope, weighted by a log-Gaussian around `centerHz`;
 * returns the strongest weighted depth.
 */
function weightedModulation(env: Float64Array, centerHz: number, sigmaOct: number): number {
  let mean = 0;
  for (const v of env) mean += v;
  mean /= Math.max(1, env.length);
  if (mean <= 0 || env.length < 8) return 0;
  const n = nextPow2(Math.max(1024, env.length));
  const w = hann(env.length);
  let wsum = 0;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < env.length; i++) { re[i] = (env[i] - mean) * w[i]; wsum += w[i]; }
  fft(re, im);
  let best = 0;
  for (let k = 1; k < n / 2; k++) {
    const fm = (k * ENV_RATE) / n;
    if (fm < 0.5 || fm > 300) continue;
    const depth = (2 * Math.hypot(re[k], im[k])) / wsum / mean;
    const weight = Math.exp(-(Math.log2(fm / centerHz) ** 2) / (2 * sigmaOct * sigmaOct));
    best = Math.max(best, depth * weight);
  }
  return best;
}

function modulationMetric(x: ArrayLike<number>, sr: number, centerHz: number, sigmaOct: number): number {
  const loud = specificLoudness(barkEnergies(spectrum(x, sr)));
  const total = loud.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let r = 0;
  for (let b = 0; b < BARK_CENTERS.length; b++) {
    if (loud[b] === 0 || BARK_EDGES[b + 1] > 0.45 * sr) continue;
    const bw = BARK_EDGES[b + 1] - BARK_EDGES[b];
    const env = bandEnvelope(bandpass(x, sr, BARK_CENTERS[b], bw), sr);
    r += weightedModulation(env, centerHz, sigmaOct) * (loud[b] / total);
  }
  return r;
}

/** Roughness in asper-like units: fast (~70 Hz) amplitude modulation, the "grating" axis. */
export const roughness = (x: ArrayLike<number>, sr: number) => modulationMetric(x, sr, 70, 0.8);
/** Fluctuation strength in vacil-like units: slow (~4 Hz) modulation, wobble and tremolo. */
export const fluctuation = (x: ArrayLike<number>, sr: number) => modulationMetric(x, sr, 4, 1);
