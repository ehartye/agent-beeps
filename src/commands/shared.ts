import { openRenderHost, verifyingDeterminism, type RenderHost } from '../render/host.ts';
import type { Rendered, RenderOutcome } from '../render/pipeline.ts';

/** `verifyDeterminism`: every song render is done twice and compared (E_NONDETERMINISTIC on a difference). */
export async function withHost<T>(fn: (host: RenderHost) => Promise<T>, { verifyDeterminism = false } = {}): Promise<T> {
  const host = await openRenderHost();
  try { return await fn(verifyDeterminism ? verifyingDeterminism(host) : host); } finally { await host.close(); }
}

/** The features an agent reads first; the full set lives in the render's meta.json. */
export function summary(r: Rendered) {
  const f = r.features;
  return {
    name: r.patch.name, seed: r.seed, variant: r.variant, key: r.key, trimDb: r.trimDb,
    wav: r.wavPath, look: r.lookPath, meta: r.dir + '/meta.json',
    features: {
      energyLengthSec: f.energyLengthSec, attackSec: f.attackSec, tailSec: f.tailSec,
      centroidHz: f.centroidHz, sharpness: f.sharpness, roughness: f.roughness, flatness: f.flatness,
      pitchHz: f.pitchStrength >= 0.7 ? f.pitchHz : null, pitchDirection: f.pitchDirection,
      loudnessLufs: f.delivered.momentaryMaxLufs, truePeakDb: f.delivered.truePeakDb,
      // true: the trim stopped at the true-peak ceiling, so the sound sits below its loudness target and lowering its loudest layer may make it quieter.
      peakLimited: f.delivered.peakLimited === true,
    },
  };
}

export function outcomeJson(o: RenderOutcome) {
  return o.ok ? { ok: true, ...summary(o) } : { ok: false, name: o.patchName, error: o.error };
}

export const int = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`expected an integer, got "${v}"`);
  return n;
};
