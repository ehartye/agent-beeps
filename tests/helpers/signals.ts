// Synthetic test signals with known answers. All at 48 kHz.
import { mulberry32 } from '../../runtime/engine/rng.js';

export const SR = 48000;
const len = (dur: number) => Math.round(dur * SR);

export const sine = (f: number, dur: number, amp = 0.5, phase = 0) =>
  Float32Array.from({ length: len(dur) }, (_, i) => amp * Math.sin(2 * Math.PI * f * i / SR + phase));

/** Amplitude-modulated sine: (1 + depth·sin(2π·fm·t)) / (1 + depth) · 0.5·sin(2π·f·t) */
export const am = (f: number, fm: number, depth: number, dur = 1) =>
  Float32Array.from({ length: len(dur) }, (_, i) => {
    const t = i / SR;
    return 0.5 * (1 + depth * Math.sin(2 * Math.PI * fm * t)) / (1 + depth) * Math.sin(2 * Math.PI * f * t);
  });

export const whiteNoise = (dur: number, seed: number, amp = 0.5) => {
  const r = mulberry32(seed);
  return Float32Array.from({ length: len(dur) }, () => amp * (r() * 2 - 1));
};

/** One-pole filtered noise: lowpass at fc, or highpass (noise minus lowpass) when high. */
export const filteredNoise = (fc: number, high: boolean, dur = 1, seed = 4) => {
  const x = whiteNoise(dur, seed);
  const a = Math.exp(-2 * Math.PI * fc / SR);
  let y = 0;
  return Float32Array.from(x, v => { y = (1 - a) * v + a * y; return high ? v - y : y * 3; });
};

/** 1 kHz sine under a linear attack then exponential decay. */
export const enveloped = (attack: number, decay: number, dur = 0.6) =>
  Float32Array.from({ length: len(dur) }, (_, i) => {
    const t = i / SR;
    const env = t < attack ? t / attack : Math.exp(-(t - attack) / decay);
    return 0.5 * env * Math.sin(2 * Math.PI * 1000 * t);
  });

/** Exponential glide from f0 to f1 over dur. */
export const glide = (f0: number, f1: number, dur: number) => {
  let phase = 0;
  return Float32Array.from({ length: len(dur) }, (_, i) => {
    const f = f0 * (f1 / f0) ** (i / len(dur));
    phase += 2 * Math.PI * f / SR;
    return 0.5 * Math.sin(phase);
  });
};

export const withSilence = (x: Float32Array, before: number, after: number) => {
  const out = new Float32Array(len(before) + x.length + len(after));
  out.set(x, len(before));
  return out;
};

/**
 * A train of noise-burst "shots": exponentially decaying white noise (time constant `tau` s) starting at each onset.
 * `onsets` are seconds. Known answers for event detection: rate, regularity, decay.
 */
export const shotTrain = (onsets: number[], tau: number, { dur, seed = 9, amp = 0.8 }: { dur?: number; seed?: number; amp?: number } = {}) => {
  const total = dur ?? onsets[onsets.length - 1] + 0.3;
  const out = new Float32Array(len(total));
  const r = mulberry32(seed);
  for (const t0 of onsets) {
    const start = Math.round(t0 * SR);
    for (let i = start; i < out.length && i < start + Math.round(tau * 8 * SR); i++) {
      out[i] += amp * (r() * 2 - 1) * Math.exp(-(i - start) / SR / tau);
    }
  }
  return out;
};

/** n onsets spaced `intervalSec` apart starting at `first`, with optional uniform jitter of ±`jitterSec` (seeded). */
export const evenOnsets = (n: number, intervalSec: number, { first = 0.05, jitterSec = 0, seed = 3 }: { first?: number; jitterSec?: number; seed?: number } = {}) => {
  const r = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => first + i * intervalSec + (r() * 2 - 1) * jitterSec);
};
