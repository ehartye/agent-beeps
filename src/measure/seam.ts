// Seam metrics for a loop: how the last sample meets the first. The wrap is a step in the signal (a click when it dwarfs the
// ordinary sample-to-sample step), a kink in its slope, and a phase mismatch for tonal material. A codec can smooth the step
// (Ogg Opus) or reproduce it (MP3), so the source and each delivered file are measured the same way and compared.

export interface SeamMetrics {
  /** The step from the last sample to the first, in dB against the RMS first difference of the file (0 dB: an ordinary step; 20 dB or more: an audible tick). Worst channel. */
  boundaryStepDb: number;
  /** The change of slope at the wrap (the first difference across the wrap against the one just before it), in dB against the RMS second difference of the file. Worst channel. */
  slopeJumpDb: number;
  /** Where the loop ends within the cycle of its last upward zero crossing (mono mix): 0 or 1 is a crossing at the very end. Informational for noisy material. Absent when the file has fewer than two crossings. */
  lastZeroCrossingPhase?: number;
}

const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export function seamMetrics(channels: Float32Array[]): SeamMetrics {
  const n = channels[0]?.length ?? 0;
  if (n < 8) return { boundaryStepDb: 0, slopeJumpDb: 0 };
  let step = 0, slope = 0;
  let d1 = 0, d2 = 0, count = 0;
  for (const ch of channels) {
    for (let i = 2; i < n; i++) { const a = ch[i] - ch[i - 1], b = a - (ch[i - 1] - ch[i - 2]); d1 += a * a; d2 += b * b; count++; }
    const wrap = ch[0] - ch[n - 1], before = ch[n - 1] - ch[n - 2];
    step = Math.max(step, Math.abs(wrap));
    slope = Math.max(slope, Math.abs(wrap - before));
  }
  const typicalStep = Math.sqrt(d1 / count), typicalSlope = Math.sqrt(d2 / count);
  // Zero crossings of the mono mix, upward only, so each cycle contributes one.
  const mono = (i: number) => channels.reduce((s, c) => s + c[i], 0) / channels.length;
  let last = -1, prev = -1, before = mono(0);
  for (let i = 1; i < n; i++) {
    const v = mono(i);
    if (before < 0 && v >= 0) { prev = last; last = i; }
    before = v;
  }
  const phase = last > 0 && prev > 0 ? round((n - last) / (last - prev), 3) : undefined;
  return { boundaryStepDb: round(db(step) - db(typicalStep)), slopeJumpDb: round(db(slope) - db(typicalSlope)), ...(phase !== undefined ? { lastZeroCrossingPhase: phase } : {}) };
}

/** Delivered boundary step over the source's by more than this is a warning (a codec made the seam worse). */
export const SEAM_WARN_DB = 3;

/** A warning (never an error: a loop may start on a transient by design) when a delivered file's seam is worse than the source's. */
export function seamWarning(source: SeamMetrics, delivered: SeamMetrics, threshold = SEAM_WARN_DB): string | undefined {
  const over = delivered.boundaryStepDb - source.boundaryStepDb;
  return over > threshold
    ? `the delivered seam steps ${delivered.boundaryStepDb.toFixed(1)} dB over a typical sample step, ${over.toFixed(1)} dB more than the source (${source.boundaryStepDb.toFixed(1)} dB)`
    : undefined;
}
