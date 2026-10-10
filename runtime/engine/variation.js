// Variation: per-variant parameter perturbation and a variant picker for repeating sounds.
import { mulberry32 } from './rng.js';

/** @typedef {import('../../src/schema/patch.ts').Patch} Patch */

/**
 * What a variant changes: a pitch ratio and a gain offset, drawn from a seeded generator within the patch's declared
 * variation ranges. Variant 0 is the patch as written (null). The ratio is returned, not applied to the patch, because it
 * has to be applied after the project scale has snapped the pitch: applied before, a scale that snaps maps every variant
 * back to the same note and `pitchCents` does nothing (engine versions up to the snap fix did exactly that).
 * @param {Patch} patch
 * @param {number} variant
 * @param {number} seed
 * @returns {{ pitchRatio: number, gainDb: number } | null}
 */
export function variantDraw(patch, variant, seed) {
  const v = patch.variation;
  if (!variant || !v || (!v.pitchCents && !v.gainDb)) return null;
  const rand = mulberry32((seed * 7919 + variant * 104729) >>> 0);
  const u = () => rand() * 2 - 1;
  return { pitchRatio: 2 ** ((u() * v.pitchCents) / 1200), gainDb: u() * v.gainDb };
}

/**
 * The patch a variant plays: variant 0 as written, others with the drawn gain offset on every layer. The pitch ratio is
 * returned beside it for the layers to apply after snapping (see variantDraw).
 * @param {Patch} patch
 * @param {number} variant
 * @param {number} seed
 * @returns {{ patch: Patch, pitchRatio: number }}
 */
export function variantPatch(patch, variant, seed) {
  const draw = variantDraw(patch, variant, seed);
  if (!draw) return { patch, pitchRatio: 1 };
  /** @type {Patch} */
  const out = structuredClone(patch);
  for (const layer of out.layers) layer.gainDb += draw.gainDb;
  return { patch: out, pitchRatio: draw.pitchRatio };
}

/**
 * Picks variants for successive plays: honours permutation weights and never repeats the
 * previous variant when noRepeat is set and there is more than one variant.
 * @param {{ variation?: { variants?: number, weights?: number[], noRepeat?: boolean } }} patch a Patch, or just its variation
 * @param {number} seed
 */
export function createPicker(patch, seed) {
  const n = patch.variation?.variants ?? 1;
  const weights = patch.variation?.weights?.slice(0, n) ?? [];
  const w = Array.from({ length: n }, (_, i) => weights[i] ?? 1);
  const noRepeat = patch.variation?.noRepeat ?? true;
  const rand = mulberry32(seed >>> 0);
  let last = -1;
  return {
    next() {
      if (n === 1) return 0;
      const allowed = w.map((x, i) => (noRepeat && i === last ? 0 : x));
      const total = allowed.reduce((a, b) => a + b, 0);
      let r = rand() * (total || 1);
      let pick = 0;
      for (let i = 0; i < n; i++) { r -= allowed[i]; if (r < 0) { pick = i; break; } }
      if (total === 0) pick = (last + 1) % n;
      last = pick;
      return pick;
    },
  };
}
