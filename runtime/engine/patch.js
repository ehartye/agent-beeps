// The one entry point: patch JSON → Web Audio graph on any BaseAudioContext.
// Games, the audition page and the offline renderer all call this, so what is measured is what plays.
import { buildLayer, validateLayerEnvelopes } from './layer.js';
import { buildDcBlocker, buildDelay, buildLimiter, buildReverb, busFor, delayTail, REVERB_PRESETS } from './fx.js';
import { variantPatch } from './variation.js';
import { sumInto } from './sum.js';
import { sampleBuffer } from './sources.js';

export { ENGINE_VERSION } from './version.js';

/** @typedef {import('../../src/schema/patch.ts').Patch} Patch */
/** @typedef {import('./layer.js').Scale} Scale */
/** @typedef {import('./fx.js').ReverbBuses} ReverbBuses */

/**
 * Nodes the graph already contains, for a runtime that automates live inputs.
 * @typedef {object} PatchNodes
 * @property {GainNode} trim  the loudness trim: static value, never automated by the engine
 * @property {GainNode | undefined} reverbSend
 * @property {GainNode | undefined} delaySend
 * @property {import('./layer.js').LayerNodes[]} layers
 */

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
 * `hold` (runtime path): procedural layers wait for the returned `release(at)`; finite sample layers automatically
 * start their authored amp release at source exhaustion. An earlier release replaces that schedule. The returned
 * `nodes` are references into the graph, for live inputs. Lifetimes use the engine's existing amp/fx tail conventions.
 * `reverb` (runtime path): a shared reverb bus (or buses by preset) the voice sends to instead of building a convolver of its
 * own. The send carries the loudness trim, so the wet signal is as loud as it would have been inside the voice; it bypasses the
 * voice's limiter and the authored tap, and the voice's `end` no longer includes a reverb tail (the bus rings on by itself).
 * `dispose()` stops every source and cuts the voice from its output and sends: the graph is then unreachable and collectable.
 * @param {{ destination?: AudioNode, when?: number, seed?: number, variant?: number, trimDb?: number,
 *           scale?: Scale, authoredTap?: AudioNode, limiter?: boolean, hold?: boolean, reverb?: ReverbBuses,
 *           samples?: Readonly<Record<string, AudioBuffer>> }} [opts]
 * @returns {{ end: number, authored: GainNode, release: (at: number) => number, dispose: () => void, nodes: PatchNodes }}
 */
export function buildPatch(ctx, patch, opts = {}) {
  const { destination = ctx.destination, when = 0, seed = 1, variant = 0, trimDb = 0, scale, authoredTap, limiter = true, hold = false, reverb, samples } = opts;
  const { patch: p, pitchRatio } = variantPatch(patch, variant, seed);
  // A missing sample or invalid later envelope must not leave an earlier source running.
  for (const layer of p.layers) {
    validateLayerEnvelopes(layer, { when, scale, pitchRatio });
    sampleBuffer(layer.source, samples);
  }

  const mix = ctx.createGain();
  const authored = ctx.createGain();
  // fx.dcBlock (opt-in) puts a DC blocker between the layer mix and everything after it. Without it the graph is unchanged.
  const dry = p.fx?.dcBlock ? mix.connect(buildDcBlocker(ctx)) : mix;
  /** Everything that reaches the authored tap, summed in a fixed order (see sum.js). */
  const toAuthored = [dry];

  let end = when;
  /** @type {ReturnType<typeof buildLayer>[]} */
  const built = [];
  // Each layer gets its own output; they are summed into the mix in layer order.
  const layerOuts = p.layers.map((layer, i) => {
    const out = ctx.createGain();
    const r = buildLayer(ctx, layer, { when, duration: p.duration, seed: seed + i * 7919, scale, out, hold, pitchRatio, samples });
    built.push(r);
    end = Math.max(end, r.end);
    return out;
  });
  sumInto(ctx, layerOuts, mix);

  let tail = 0;
  /** @type {GainNode | undefined} */
  let reverbSend;
  /** @type {GainNode | undefined} */
  let delaySend;
  if (p.fx?.reverb) {
    const bus = busFor(reverb, p.fx.reverb.preset);
    if (bus) {
      // Shared bus: the voice owns a send gain and nothing else. The trim is folded in, since this path skips the trim stage.
      const send = reverbSend = ctx.createGain();
      send.gain.value = db(p.fx.reverb.sendDb + trimDb);
      dry.connect(send).connect(bus.input);
    } else {
      const send = reverbSend = ctx.createGain();
      send.gain.value = db(p.fx.reverb.sendDb);
      toAuthored.push(dry.connect(send).connect(buildReverb(ctx, p.fx.reverb.preset)));
      const preset = REVERB_PRESETS[p.fx.reverb.preset];
      tail = Math.max(tail, preset.decay + preset.preDelay);
    }
  }
  if (p.fx?.delay) {
    const send = delaySend = ctx.createGain();
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

  return {
    end: end + tail,
    authored,
    release(at) {
      let silent = at;
      for (const b of built) silent = Math.max(silent, b.release(at));
      // Finite held sample layers may already be releasing or finished when stop arrives.
      return (hold ? Math.min(silent, end) : silent) + tail;
    },
    dispose() {
      const now = ctx.currentTime;
      for (const b of built) b.stop(now);
      for (const n of [authored, trim, reverbSend, delaySend]) n?.disconnect();
    },
    nodes: { trim, reverbSend, delaySend, layers: built.map(b => b.nodes) },
  };
}
