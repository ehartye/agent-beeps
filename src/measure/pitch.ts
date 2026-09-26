// YIN pitch tracking (de Cheveigné & Kawahara 2002): pitch, pitch strength and pitch direction.

const W = 1024;
const MIN_HZ = 50, MAX_HZ = 4000;
const THRESHOLD = 0.15;
const MAX_FRAMES = 120;

export interface PitchTrack { medianHz: number; strength: number; directionSemitones: number; voicedFraction: number }

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function yinFrame(x: ArrayLike<number>, start: number, sr: number): { hz: number; strength: number } {
  const tauMin = Math.floor(sr / MAX_HZ), tauMax = Math.ceil(sr / MIN_HZ);
  const d = new Float64Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) { const v = x[start + i] - x[start + i + tau]; s += v * v; }
    d[tau] = s;
  }
  // Cumulative mean normalized difference
  const c = new Float64Array(tauMax + 1);
  c[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) { running += d[tau]; c[tau] = running > 0 ? (d[tau] * tau) / running : 1; }
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (c[t] < THRESHOLD) { while (t + 1 <= tauMax && c[t + 1] < c[t]) t++; tau = t; break; }
  }
  if (tau < 0) { // no dip under threshold: take the global minimum, reported as weak
    let best = tauMin;
    for (let t = tauMin; t <= tauMax; t++) if (c[t] < c[best]) best = t;
    tau = best;
  }
  // Parabolic interpolation around the dip
  const a = c[tau - 1] ?? c[tau], b = c[tau], cc = c[tau + 1] ?? c[tau];
  const denom = a - 2 * b + cc;
  const shift = denom !== 0 ? (0.5 * (a - cc)) / denom : 0;
  return { hz: sr / (tau + Math.max(-0.5, Math.min(0.5, shift))), strength: Math.max(0, 1 - b) };
}

export function pitchTrack(x: ArrayLike<number>, sr: number): PitchTrack {
  const frameLen = W + Math.ceil(sr / MIN_HZ) + 1;
  const count = Math.max(0, Math.floor((x.length - frameLen) / Math.round(0.01 * sr)) + 1);
  if (count === 0) return { medianHz: 0, strength: 0, directionSemitones: 0, voicedFraction: 0 };
  const step = Math.max(1, Math.ceil(count / MAX_FRAMES));
  const starts: number[] = [];
  for (let f = 0; f < count; f += step) starts.push(f * Math.round(0.01 * sr));
  const energy = starts.map(s => { let e = 0; for (let i = 0; i < W; i++) e += x[s + i] * x[s + i]; return e; });
  const maxE = Math.max(...energy);
  const frames = starts.map((s, i) => (energy[i] > maxE * 1e-3 ? yinFrame(x, s, sr) : null)).filter(f => f !== null);
  if (!frames.length) return { medianHz: 0, strength: 0, directionSemitones: 0, voicedFraction: 0 };
  const voiced = frames.filter(f => f.strength >= 1 - THRESHOLD * 2);
  const hz = voiced.map(f => f.hz);
  const head = median(hz.slice(0, 3)), tail = median(hz.slice(-3));
  return {
    medianHz: median(hz),
    strength: median(frames.map(f => f.strength)),
    directionSemitones: voiced.length >= 3 && head > 0 ? 12 * Math.log2(tail / head) : 0,
    voicedFraction: voiced.length / frames.length,
  };
}
