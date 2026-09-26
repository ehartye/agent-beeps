// Loudness per ITU-R BS.1770-5 with EBU Tech 3341 windows, at 48 kHz.
// Short sounds: BS.1770 discards incomplete 400 ms blocks, so a 150 ms coin has no integrated
// loudness. For momentary/short-term maxima we zero-pad to one full window (as EBU Tech 3341's
// 400 ms burst test implies) so every sound gets a level; integrated is flagged unreliable < 1 s.

type Channels = ArrayLike<number>[];

// K-weighting at 48 kHz: high-shelf "head" filter then RLB high-pass (BS.1770-5 Table 1 / 2).
const SHELF = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] };
const RLB = { b: [1, -2, 1], a: [-1.99004745483398, 0.99007225036621] };

function biquad(x: ArrayLike<number>, { b, a }: { b: number[]; a: number[] }): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

function assertRate(sr: number) {
  if (sr !== 48000) throw new Error(`loudness is implemented at 48 kHz; got ${sr}`);
}

/** Squared K-weighted signal summed across channels (all channel weights 1). */
export function weightedPower(channels: Channels, minLength: number): Float64Array {
  const n = Math.max(minLength, channels[0]?.length ?? 0);
  const sum = new Float64Array(n);
  for (const ch of channels) {
    const k = biquad(biquad(ch, SHELF), RLB);
    for (let i = 0; i < k.length; i++) sum[i] += k[i] * k[i];
  }
  return sum;
}

export const toLufs = (meanSquare: number) => (meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity);

function slidingMax(power: Float64Array, win: number, hop: number): number {
  let best = 0;
  const prefix = new Float64Array(power.length + 1);
  for (let i = 0; i < power.length; i++) prefix[i + 1] = prefix[i] + power[i];
  for (let s = 0; s + win <= power.length; s += hop) best = Math.max(best, (prefix[s + win] - prefix[s]) / win);
  return best;
}

/** Maximum momentary loudness (400 ms window, 10 ms hop), LUFS. */
export function momentaryMax(channels: Channels, sr: number): number {
  assertRate(sr);
  const win = Math.round(0.4 * sr);
  return toLufs(slidingMax(weightedPower(channels, win), win, Math.round(0.01 * sr)));
}

/** Maximum short-term loudness (3 s window, 100 ms hop), LUFS. */
export function shortTermMax(channels: Channels, sr: number): number {
  assertRate(sr);
  const win = 3 * sr;
  return toLufs(slidingMax(weightedPower(channels, win), win, Math.round(0.1 * sr)));
}

/** Gated integrated loudness (400 ms blocks, 75 % overlap, −70 LUFS absolute and −10 LU relative gates). */
export function integrated(channels: Channels, sr: number): { lufs: number; reliable: boolean } {
  assertRate(sr);
  const win = Math.round(0.4 * sr), hop = Math.round(0.1 * sr);
  const length = channels[0]?.length ?? 0;
  const power = weightedPower(channels, win);
  const blocks: number[] = [];
  for (let s = 0; s + win <= power.length; s += hop) {
    let e = 0;
    for (let i = s; i < s + win; i++) e += power[i];
    blocks.push(e / win);
  }
  const abs = blocks.filter(z => toLufs(z) > -70);
  if (!abs.length) return { lufs: -Infinity, reliable: length >= sr };
  const rel = toLufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter(z => toLufs(z) > rel);
  return { lufs: toLufs(gated.reduce((a, b) => a + b, 0) / gated.length), reliable: length >= sr };
}

export function samplePeakDb(channels: Channels): number {
  let p = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) p = Math.max(p, Math.abs(ch[i]));
  return p > 0 ? 20 * Math.log10(p) : -Infinity;
}

const TAPS = 16;
const kernel = (() => {
  // Windowed-sinc interpolators for the three fractional phases of 4x oversampling.
  return [0.25, 0.5, 0.75].map(frac => {
    const h: number[] = [];
    for (let j = -TAPS + 1; j <= TAPS; j++) {
      const t = j - frac;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * t) / (TAPS + 1));
      h.push(sinc * w);
    }
    return h;
  });
})();

/** True peak via 4x oversampling (BS.1770-5 Annex 2 approach), dBTP. */
export function truePeakDb(channels: Channels, sr: number): number {
  assertRate(sr);
  let p = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      p = Math.max(p, Math.abs(ch[i]));
      for (const h of kernel) {
        let v = 0;
        for (let k = 0; k < h.length; k++) {
          const idx = i + k - TAPS + 1;
          if (idx >= 0 && idx < ch.length) v += ch[idx] * h[k];
        }
        p = Math.max(p, Math.abs(v));
      }
    }
  }
  return p > 0 ? 20 * Math.log10(p) : -Infinity;
}
