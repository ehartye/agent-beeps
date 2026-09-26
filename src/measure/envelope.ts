// Time-domain envelope features from a 2 ms RMS envelope at a 1 ms hop.

const WIN = 0.002, HOP = 0.001;

export function rmsEnvelope(x: ArrayLike<number>, sr: number): Float64Array {
  const win = Math.max(1, Math.round(WIN * sr)), hop = Math.max(1, Math.round(HOP * sr));
  const n = Math.max(1, Math.floor((x.length - win) / hop) + 1);
  const env = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let e = 0;
    for (let i = f * hop; i < f * hop + win && i < x.length; i++) e += x[i] * x[i];
    env[f] = Math.sqrt(e / win);
  }
  return env;
}

const peakOf = (env: Float64Array) => {
  let p = 0, at = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > p) { p = env[i]; at = i; }
  return { p, at };
};

/** Seconds from 10 % to 90 % of the envelope peak, on the rising edge before the peak. */
export function attackTime(x: ArrayLike<number>, sr: number): number {
  const env = rmsEnvelope(x, sr);
  const { p, at } = peakOf(env);
  if (p === 0) return 0;
  let lo = -1, hi = -1;
  for (let i = 0; i <= at; i++) {
    if (lo < 0 && env[i] >= 0.1 * p) lo = i;
    if (hi < 0 && env[i] >= 0.9 * p) { hi = i; break; }
  }
  return lo < 0 || hi < 0 ? 0 : (hi - lo) * HOP;
}

/** Seconds between the first and last envelope values within `db` of the peak. */
function span(x: ArrayLike<number>, sr: number, db: number): number {
  const env = rmsEnvelope(x, sr);
  const { p } = peakOf(env);
  if (p === 0) return 0;
  const floor = p * 10 ** (db / 20);
  let first = -1, last = -1;
  for (let i = 0; i < env.length; i++) if (env[i] >= floor) { if (first < 0) first = i; last = i; }
  return (last - first + 1) * HOP;
}

/** Duration the sound stays within 40 dB of its peak: how long it is heard as "on". */
export const energyLength = (x: ArrayLike<number>, sr: number) => span(x, sr, -40);
/** Duration the sound stays within 60 dB of its peak, including the tail. */
export const tailLength = (x: ArrayLike<number>, sr: number) => span(x, sr, -60);

/** Peak-to-RMS ratio in dB over the audible span. */
export function crestDb(x: ArrayLike<number>): number {
  let peak = 0, sum = 0, count = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak === 0) return 0;
  const floor = peak * 1e-3;
  let first = 0, last = x.length - 1;
  while (first < x.length && Math.abs(x[first]) < floor) first++;
  while (last > first && Math.abs(x[last]) < floor) last--;
  for (let i = first; i <= last; i++) { sum += x[i] * x[i]; count++; }
  return 20 * Math.log10(peak / Math.sqrt(sum / Math.max(1, count)));
}

export function dcOffset(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  return x.length ? s / x.length : 0;
}

export function clippedSamples(channels: ArrayLike<number>[]): number {
  let n = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]) >= 0.999) n++;
  return n;
}
