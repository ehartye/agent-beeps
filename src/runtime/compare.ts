// EXPERIMENTAL (runtime-codegen spike). How two renders of "the same sound" differ, as numbers a reviewer can read.
import { measure, type Features } from '../measure/index.ts';

export interface Pcm { sampleRate: number; delivered: Float32Array[]; authored: Float32Array[] }

export interface TapDiff {
  /** Every sample identical to the bit. */
  bitExact: boolean;
  samples: number;
  /** Samples that differ at all. */
  differing: number;
  /** Largest |a - b| as a fraction of full scale, and in dBFS (-Infinity when exact). */
  maxAbs: number;
  maxAbsDb: number;
  /** RMS of the difference relative to the RMS of the reference, in dB (-Infinity when exact). */
  rmsRelDb: number;
  /** Pearson correlation of the mono mixes (1 when identical). */
  correlation: number;
  /** Lengths differ: the shorter is compared and this says by how much. */
  lengthDelta: number;
}

const dB = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

export function diffTap(ref: Float32Array[], got: Float32Array[]): TapDiff {
  const n = Math.min(ref[0].length, got[0].length);
  let differing = 0, maxAbs = 0, se = 0, sr = 0, sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0, count = 0;
  for (let c = 0; c < Math.min(ref.length, got.length); c++) {
    const a = ref[c], b = got[c];
    for (let i = 0; i < n; i++) {
      const d = a[i] - b[i];
      if (d !== 0) { differing++; maxAbs = Math.max(maxAbs, Math.abs(d)); }
      se += d * d; sr += a[i] * a[i];
      sa += a[i]; sb += b[i]; sab += a[i] * b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; count++;
    }
  }
  const cov = sab / count - (sa / count) * (sb / count);
  const va = saa / count - (sa / count) ** 2, vb = sbb / count - (sb / count) ** 2;
  const correlation = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : differing === 0 ? 1 : 0;
  return {
    bitExact: differing === 0 && ref[0].length === got[0].length,
    samples: count, differing, maxAbs, maxAbsDb: dB(maxAbs),
    rmsRelDb: se === 0 ? -Infinity : dB(Math.sqrt(se / Math.max(sr, 1e-30))),
    correlation, lengthDelta: got[0].length - ref[0].length,
  };
}

/** The features the repo's `measure` reports that a listener would hear a difference in. */
export const FEATURE_KEYS = ['momentaryMaxLufs', 'integratedLufs', 'samplePeakDb', 'truePeakDb', 'centroidHz', 'centroidPeakHz', 'energyLengthSec', 'attackSec', 'tailSec', 'crestDb', 'flatness', 'sharpness', 'roughness', 'pitchHz'] as const;
export type FeatureKey = typeof FEATURE_KEYS[number];

export function featureDelta(ref: Features, got: Features): Record<FeatureKey, number> {
  return Object.fromEntries(FEATURE_KEYS.map(k => [k, Math.round(((got[k] as number) - (ref[k] as number)) * 1e4) / 1e4])) as Record<FeatureKey, number>;
}

export const featuresOf = (p: Pcm): Features => measure(p);
