// 4th-order Butterworth low/highpass (two RBJ biquads, Q 0.5412 and 1.3066), run forward once in float64.
const Q4 = [0.5412, 1.3066];

function biquad(x: Float64Array, sr: number, kind: 'lp' | 'hp', fc: number, q: number): Float64Array {
  const w = 2 * Math.PI * Math.min(fc, sr * 0.49) / sr, cos = Math.cos(w), alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b1 = kind === 'lp' ? (1 - cos) / a0 : -(1 + cos) / a0;
  const b0 = kind === 'lp' ? b1 / 2 : -b1 / 2;
  const a1 = -2 * cos / a0, a2 = (1 - alpha) / a0;
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

export function butterworth4(x: ArrayLike<number>, sr: number, kind: 'lp' | 'hp', fc: number): Float32Array {
  // Odd-reflect 50 ms before the first sample (as filtfilt pads) so a signal that starts mid-cycle does not ring as a step.
  const pad = Math.min(x.length - 1, Math.round(0.05 * sr));
  let y: Float64Array = new Float64Array(x.length + pad);
  for (let i = 0; i < pad; i++) y[i] = 2 * x[0] - x[pad - i];
  for (let i = 0; i < x.length; i++) y[pad + i] = x[i];
  for (const q of Q4) y = biquad(y, sr, kind, fc, q);
  return Float32Array.from(y.subarray(pad));
}

/** Moving average of |x| over `ms` milliseconds, centred: a cheap amplitude envelope. */
export function absEnvelope(x: ArrayLike<number>, sr: number, ms: number): Float64Array {
  const w = Math.max(1, Math.round(sr * ms / 1000)), n = x.length, out = new Float64Array(n);
  const csum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) csum[i + 1] = csum[i] + Math.abs(x[i]);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - (w >> 1)), hi = Math.min(n, lo + w);
    out[i] = (csum[hi] - csum[lo]) / (hi - lo);
  }
  return out;
}
