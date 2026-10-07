// The one entry point: patch JSON → Web Audio graph on any BaseAudioContext.
// Games, the audition page and the offline renderer all call this, so what is measured is what plays.
import { buildLayer } from './layer.js';
import { buildDcBlocker, buildDelay, buildLimiter, buildReverb, delayTail, REVERB_PRESETS } from './fx.js';
import { variantPatch } from './variation.js';
import { sumInto } from './sum.js';

export { ENGINE_VERSION } from './version.js';

/** @typedef {import('../../src/schema/patch.ts').Patch} Patch */
/** @typedef {import('./layer.js').Scale} Scale */

const db = (/** @type {number} */ x) => 10 ** (x / 20);

/**
 * Seconds from onset until the patch is silent: the same arithmetic buildPatch schedules with,
 * so an offline context can be sized before the graph exists.
 * @param {Patch} p
 */
export function patchLength(p) {
  let end = 0;
  for (const l of p.layers) {
    const off = Math.max(l.start + Math.min(l.amp.attack, 0.002), p.duration);
    end = Math.max(end, off + l.amp.release);
  }
  let tail = 0;
  if (p.fx?.reverb) tail = Math.max(tail, REVERB_PRESETS[p.fx.reverb.preset].decay + REVERB_PRESETS[p.fx.reverb.preset].preDelay);
  if (p.fx?.delay) tail = Math.max(tail, delayTail(p.fx.delay));
  return end + tail;
}

/**
 * @param {BaseAudioContext} ctx
 * @param {Patch} patch  a parsed patch (defaults filled)
 * @param {{ destination?: AudioNode, when?: number, seed?: number, variant?: number, trimDb?: number,
 *           scale?: Scale, authoredTap?: AudioNode, limiter?: boolean }} [opts]
 * @returns {{ end: number, authored: GainNode }}
 */
export function buildPatch(ctx, patch, opts = {}) {
  const { destination = ctx.destination, when = 0, seed = 1, variant = 0, trimDb = 0, scale, authoredTap, limiter = true } = opts;
  const p = variantPatch(patch, variant, seed);

  const mix = ctx.createGain();
  const authored = ctx.createGain();
  // fx.dcBlock (opt-in) puts a DC blocker between the layer mix and everything after it. Without it the graph is unchanged.
  const dry = p.fx?.dcBlock ? mix.connect(buildDcBlocker(ctx)) : mix;
  /** Everything that reaches the authored tap, summed in a fixed order (see sum.js). */
  const toAuthored = [dry];

  let end = when;
  // Each layer gets its own output; they are summed into the mix in layer order.
  const layerOuts = p.layers.map((layer, i) => {
    const out = ctx.createGain();
    const r = buildLayer(ctx, layer, { when, duration: p.duration, seed: seed + i * 7919, scale, out });
    end = Math.max(end, r.end);
    return out;
  });
  sumInto(ctx, layerOuts, mix);

  let tail = 0;
  if (p.fx?.reverb) {
    const send = ctx.createGain();
    send.gain.value = db(p.fx.reverb.sendDb);
    toAuthored.push(dry.connect(send).connect(buildReverb(ctx, p.fx.reverb.preset)));
    const preset = REVERB_PRESETS[p.fx.reverb.preset];
    tail = Math.max(tail, preset.decay + preset.preDelay);
  }
  if (p.fx?.delay) {
    const send = ctx.createGain();
    send.gain.value = db(p.fx.delay.sendDb);
    const d = buildDelay(ctx, p.fx.delay);
    dry.connect(send).connect(d.input);
    toAuthored.push(d.output);
    tail = Math.max(tail, delayTail(p.fx.delay));
  }

  sumInto(ctx, toAuthored, authored);

  const trim = ctx.createGain();
  trim.gain.value = db(trimDb);
  authored.connect(trim);
  if (limiter) trim.connect(buildLimiter(ctx)).connect(destination);
  else trim.connect(destination);
  if (authoredTap) authored.connect(authoredTap);

  return { end: end + tail, authored };
}
