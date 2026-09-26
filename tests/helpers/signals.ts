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
