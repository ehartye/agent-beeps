/** In-place iterative radix-2 complex FFT. Length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

export const hann = (n: number): Float64Array => Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));

export const nextPow2 = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(2, n)));

/** Power spectra of Hann-windowed frames (n/2 + 1 bins each). Signals shorter than a frame are zero-padded. */
export function stftPower(x: ArrayLike<number>, n = 2048, hop = 512): Float64Array[] {
  const w = hann(n);
  const frames: Float64Array[] = [];
  const last = Math.max(0, x.length - n);
  for (let start = 0; start <= last; start += hop) {
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n && start + i < x.length; i++) re[i] = x[start + i] * w[i];
    fft(re, im);
    const p = new Float64Array(n / 2 + 1);
    for (let k = 0; k <= n / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k];
    frames.push(p);
  }
  return frames;
}
