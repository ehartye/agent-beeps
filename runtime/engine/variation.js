// Variation: per-variant parameter perturbation and a variant picker for repeating sounds.
import { mulberry32 } from './rng.js';
import { noteToHz } from './notes.js';

/** @typedef {import('../../src/schema/patch.ts').Patch} Patch */

/**
 * Variant 0 is the patch as written. Other variants detune pitched sources and nudge layer gain
 * within the patch's declared variation ranges, from a seeded generator.
 * @param {Patch} patch
 * @param {number} variant
 * @param {number} seed
 * @returns {Patch}
 */
export function variantPatch(patch, variant, seed) {
  const v = patch.variation;
  if (!variant || !v || (!v.pitchCents && !v.gainDb)) return patch;
  const rand = mulberry32((seed * 7919 + variant * 104729) >>> 0);
  const u = () => rand() * 2 - 1;
  const ratio = 2 ** ((u() * v.pitchCents) / 1200);
  const gain = u() * v.gainDb;
  /** @type {Patch} */
  const out = structuredClone(patch);
  for (const layer of out.layers) {
    const src = /** @type {any} */ (layer.source);
    if ('pitch' in src) src.pitch = noteToHz(src.pitch) * ratio;
    if (layer.pitchEnv) for (const p of layer.pitchEnv) p.to = noteToHz(p.to) * ratio;
    layer.gainDb += gain;
  }
  return out;
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
