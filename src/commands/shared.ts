import { InvalidArgumentError } from 'commander';
import { withRenderHost, type RenderHost } from '../render/host.ts';
import type { Rendered, RenderOutcome } from '../render/pipeline.ts';

/**
 * Run `fn` against a render host that opens Chromium on its first render call, so a fully cached command starts no browser.
 * `verifyDeterminism`: every song render is done twice and compared (E_NONDETERMINISTIC on a difference).
 */
export function withHost<T>(fn: (host: RenderHost) => Promise<T>, { verifyDeterminism = false } = {}): Promise<T> {
  return withRenderHost(fn, { verifyDeterminism });
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

/** A number above zero (a bitrate): commander reports anything else as a usage error naming the option, instead of the option quietly falling back to its default. */
export const positive = (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError(`expected a number above 0, got "${v}"`);
  return n;
};

export const int = (v: string) => {
  const n = Number(v);
  // Commander reports this as a usage error (E_USAGE, exit 2) naming the option.
  if (!Number.isInteger(n)) throw new InvalidArgumentError(`expected an integer, got "${v}"`);
  return n;
};
