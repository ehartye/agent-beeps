// The one entry point: patch JSON → Web Audio graph on any BaseAudioContext.
// Games, the audition page and the offline renderer all call this, so what is measured is what plays.
import { buildLayer } from './layer.js';
import { buildDelay, buildLimiter, buildReverb, delayTail, REVERB_PRESETS } from './fx.js';
import { variantPatch } from './variation.js';

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

  const dry = ctx.createGain();
  const authored = ctx.createGain();
  dry.connect(authored);

  let end = when;
  p.layers.forEach((layer, i) => {
    const r = buildLayer(ctx, layer, { when, duration: p.duration, seed: seed + i * 7919, scale, out: dry });
    end = Math.max(end, r.end);
  });

  let tail = 0;
  if (p.fx?.reverb) {
    const send = ctx.createGain();
    send.gain.value = db(p.fx.reverb.sendDb);
    dry.connect(send).connect(buildReverb(ctx, p.fx.reverb.preset)).connect(authored);
    const preset = REVERB_PRESETS[p.fx.reverb.preset];
    tail = Math.max(tail, preset.decay + preset.preDelay);
  }
  if (p.fx?.delay) {
    const send = ctx.createGain();
    send.gain.value = db(p.fx.delay.sendDb);
    const d = buildDelay(ctx, p.fx.delay);
    dry.connect(send).connect(d.input);
    d.output.connect(authored);
    tail = Math.max(tail, delayTail(p.fx.delay));
  }

  const trim = ctx.createGain();
  trim.gain.value = db(trimDb);
  authored.connect(trim);
  if (limiter) trim.connect(buildLimiter(ctx)).connect(destination);
  else trim.connect(destination);
  if (authoredTap) authored.connect(authoredTap);

  return { end: end + tail, authored };
}
