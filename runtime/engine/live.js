// EXPERIMENTAL (runtime-codegen spike). Option A, the interpreter: a patch plus named inputs becomes a playable voice.
//
//   const v = createVoice(ctx, patch, ctx.destination, { speed: 0.4 }, seed, { trimDb, scale });
//   v.set('speed', 0.9);          // live inputs only: automates a parameter the graph already has
//   v.release();                  // `hold` voices only
//
// It is `buildPatch` (the very function the renderer uses, so a baked render and this voice share every line of graph code)
// plus `applyParams` for the static inputs and a small automation layer for the live ones. The generated modules of
// option B expose the same `{ end, set, release, stop }` voice, so a game can swap one for the other per cue.
import { buildPatch } from './patch.js';
import { applyParams, defaultParams, isLiveTarget, makeLive, targetsOf } from './params.js';

/** @typedef {import('../../src/schema/patch.ts').Patch} Patch */
/** @typedef {import('./params.js').RuntimeBlock} RuntimeBlock */

/**
 * @typedef {object} Voice
 * @property {number} end                              context time the voice is silent (Infinity while held)
 * @property {(input: string, value: number, at?: number, tau?: number) => void} set  move a live input
 * @property {(at?: number) => number} release         end a `hold` voice; returns when it is silent
 * @property {(fade?: number) => void} stop            fade out and disconnect now
 */

/**
 * @param {BaseAudioContext} ctx
 * @param {Patch} patch  a parsed patch (defaults filled), with or without an `xRuntime` block
 * @param {AudioNode} out
 * @param {Record<string, number>} [params]
 * @param {number} [seed]
 * @param {{ when?: number, variant?: number, trimDb?: number, scale?: import('./layer.js').Scale, hold?: boolean, limiter?: boolean, tap?: AudioNode }} [opts]
 * @returns {Voice}
 */
export function createVoice(ctx, patch, out, params = {}, seed = 1, opts = {}) {
  const rt = /** @type {RuntimeBlock | undefined} */ (/** @type {any} */ (patch).xRuntime);
  const { when = 0, variant = 0, trimDb = 0, scale, limiter = true } = opts;
  const hold = opts.hold ?? rt?.hold ?? false;
  const { patch: p, trimDeltaDb } = applyParams(patch, params);
  const r = buildPatch(ctx, p, { destination: out, when, seed, variant, trimDb: trimDb + trimDeltaDb, scale, limiter, hold, authoredTap: opts.tap });

  // Live inputs: for each target, the automatable parameter the graph already has and how a delta moves it.
  const vals = { ...defaultParams(patch), ...params };
  /** @type {Map<AudioParam, [AudioParam, 'gain' | 'oct' | 'st' | 'ct' | 'pan', [string, number, number, ('linear' | 'quad' | 'sqrt')?][]]>} */
  const targets = new Map();
  const add = (/** @type {AudioParam | undefined} */ param, /** @type {'gain' | 'oct' | 'st' | 'ct' | 'pan'} */ kind, /** @type {import('./params.js').RuntimeBind} */ bind) => {
    if (!param) return;
    let t = targets.get(param);
    if (!t) targets.set(param, t = [param, kind, []]);
    t[2].push([bind.input, bind.range[0], bind.range[1], bind.shape]);
  };
  for (const bind of rt?.bind ?? []) {
    if (!bind.live) continue;
    for (const target of targetsOf(patch, bind)) {
      if (!isLiveTarget(target)) throw new Error(`xRuntime: ${target} cannot be live (it is not a parameter the graph automates)`);
      const layer = (/** @type {RegExpExecArray | null} */ m) => (m ? r.nodes.layers[Number(m[1])] : undefined);
      let m;
      if (target === '/out/gainDb') add(r.nodes.trim.gain, 'gain', bind);
      else if (target === '/out/transpose') for (const l of r.nodes.layers) for (const d of l.detune) add(d, 'st', bind);
      else if (target === '/out/brightness') for (const l of r.nodes.layers) add(l.filter?.detune, 'ct', bind);
      else if ((m = /^\/layers\/(\d+)\/gainDb$/.exec(target))) add(layer(m)?.gain.gain, 'gain', bind);
      else if ((m = /^\/layers\/(\d+)\/pan$/.exec(target))) add(layer(m)?.pan?.pan, 'pan', bind);
      else if ((m = /^\/layers\/(\d+)\/filter\/cutoff$/.exec(target))) add(layer(m)?.filter?.detune, 'ct', bind);
      else if ((m = /^\/layers\/(\d+)\/lfo\/rate$/.exec(target))) add(layer(m)?.lfo?.frequency, 'oct', bind);
      else if (target === '/fx/reverb/sendDb') add(r.nodes.reverbSend?.gain, 'gain', bind);
      else if (target === '/fx/delay/sendDb') add(r.nodes.delaySend?.gain, 'gain', bind);
    }
  }
  const set = makeLive(rt?.inputs ?? {}, vals, [...targets.values()], () => ctx.currentTime);

  return {
    end: r.end,
    set,
    release: (at = ctx.currentTime) => r.release(at),
    stop(fade = 0.02) {
      const g = r.nodes.trim.gain, now = ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setTargetAtTime(0, now, fade / 4);
      setTimeout(() => r.nodes.trim.disconnect(), fade * 1000 * 2);
    },
  };
}
