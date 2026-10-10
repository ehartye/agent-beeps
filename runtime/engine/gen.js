// EXPERIMENTAL (runtime-codegen spike). The few helpers generated cue modules import. Nothing here adds a node of its own:
// every function either computes a number or creates exactly the node the engine would have created at that point.
import { snapToScale } from './notes.js';
import { mulberry32 } from './rng.js';

export { bd, makeLive } from './params.js';
export { sumInto } from './sum.js';
export { noiseBuffer, widthOf, grainBuffer, exciterBuffer, nyquistSafe, METAL_RATIOS } from './sources.js';
export { buildReverb, buildDelay, buildLimiter, buildDcBlocker } from './fx.js';
export { driveCurve, envelopeAt } from './layer.js';

export const db = (/** @type {number} */ x) => 10 ** (x / 20);

/** A gain node, optionally at a value. @param {BaseAudioContext} c @param {number} [v] */
export const G = (c, v) => { const g = c.createGain(); if (v !== undefined) g.gain.value = v; return g; };

/** Resolve a pitch against the project (or the game's) scale: snapped when the scale asks for it. */
export const rp = (/** @type {number} */ hz, /** @type {any} */ scale) => (scale?.snap ? snapToScale(hz, scale) : hz);

/** The variant's pitch ratio and gain offset: the draws variantPatch makes, in the same order. @returns {[number, number]} */
export function vary(/** @type {number} */ seed, /** @type {number} */ variant, /** @type {number} */ pitchCents, /** @type {number} */ gainDb) {
  const rand = mulberry32((seed * 7919 + variant * 104729) >>> 0);
  const u = () => rand() * 2 - 1;
  return [2 ** ((u() * pitchCents) / 1200), u() * gainDb];
}

/**
 * A layer's pitch envelope over its frequency params. \`pts\` is [at, hz, curve] with curve 0 exp, 1 linear, 2 step.
 * @param {[AudioParam, number][]} list @param {number} base @param {number} t0 @param {[number, number, number][]} pts
 */
export function penv(list, base, t0, pts) {
  for (const [param, ratio] of list) {
    param.setValueAtTime(base * ratio, t0);
    for (const [at, hz, curve] of pts) {
      const v = Math.max(1, hz * ratio);
      if (curve === 2) param.setValueAtTime(v, t0 + at);
      else if (curve === 1) param.linearRampToValueAtTime(v, t0 + at);
      else param.exponentialRampToValueAtTime(v, t0 + at);
    }
  }
}

/** A clamp that only applies when its binding moved. */
export const cl = (/** @type {number} */ d, /** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => (d === 0 ? v : Math.min(hi, Math.max(lo, v)));

/** Start every source node (after its per-start callbacks). */
export function go(/** @type {AudioScheduledSourceNode[]} */ nodes, /** @type {((t: number) => void)[]} */ onStart, /** @type {number} */ t) {
  for (const f of onStart) f(t);
  for (const n of nodes) n.start(t);
}
/** Stop every source node. */
export function halt(/** @type {AudioScheduledSourceNode[]} */ nodes, /** @type {number} */ t) { for (const n of nodes) n.stop(t); }

/** The voice every generated module returns, the same shape the interpreter's \`createVoice\` returns. */
export function voice(/** @type {BaseAudioContext} */ ctx, /** @type {GainNode} */ trim, /** @type {number} */ end, /** @type {any} */ set, /** @type {((at: number) => number) | undefined} */ rel, /** @type {number} */ tail) {
  return {
    end,
    set,
    release: (at = ctx.currentTime) => (rel ? rel(at) + tail : end),
    stop(fade = 0.02) {
      const now = ctx.currentTime;
      trim.gain.cancelScheduledValues(now);
      trim.gain.setTargetAtTime(0, now, fade / 4);
      setTimeout(() => trim.disconnect(), fade * 2000);
    },
  };
}
