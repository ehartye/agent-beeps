// A patch plus named inputs becomes a voice a game can start, steer and stop in its own AudioContext.
//
//   const v = build(ctx, ctx.destination, cue, { seed: 7, params: { speed: 0.4 } });
//   v.start();                 // creates the graph and begins at ctx.currentTime (or v.start(at))
//   v.set('speed', 0.9);       // a live input: automates a parameter the graph already has, no node is created
//   v.stop();                  // a held voice releases with the patch's own envelope; any other fades out
//   v.dispose();               // cut it now and let the graph be collected
//
// `build` validates and plans; `start` creates the nodes. It is `buildPatch` (the function the offline renderer runs, so a baked
// render and this voice share every line of graph code) plus `applyParams` for the static inputs and a small automation layer
// for the live ones. Browser-safe: no Node APIs, no zod.
import { buildPatch } from './patch.js';
import { ENGINE_VERSION } from './version.js';
import { applyParams, clampInput, defaultParams, isLiveTarget, makeLive, targetsOf } from './params.js';

/** @typedef {import('../../src/schema/patch.ts').Patch} Patch */
/** @typedef {import('./params.js').RuntimeBlock} RuntimeBlock */
/** @typedef {import('./layer.js').Scale} Scale */
/** @typedef {import('./fx.js').ReverbBuses} ReverbBuses */
/** @typedef {{ schema: 'beeps/runtime-cue@1', id: string, engine: string, seed: number, trimDb: number, scale?: Scale, patch: Patch }} Cue */

export const CUE_SCHEMA = 'beeps/runtime-cue@1';

/**
 * Check a runtime cue file (what `beeps build` writes for a patch whose delivery is `runtime` or `both`) and return it typed.
 * A cue made by another engine version is refused: its loudness trim was measured with that engine's graph.
 * @param {unknown} value  parsed JSON
 * @param {{ allowEngineMismatch?: boolean }} [opts]
 * @returns {Cue}
 */
export function parseCue(value, { allowEngineMismatch = false } = {}) {
  const c = /** @type {any} */ (value);
  if (!c || c.schema !== CUE_SCHEMA) throw new TypeError(`not a ${CUE_SCHEMA} file`);
  if (typeof c.id !== 'string' || !Number.isFinite(c.seed) || !Number.isFinite(c.trimDb) || !c.patch || c.patch.schema !== 'beeps/patch@1') throw new TypeError(`${CUE_SCHEMA}: needs id, seed, trimDb and a beeps/patch@1 patch`);
  if (c.engine !== ENGINE_VERSION && !allowEngineMismatch) throw new Error(`cue "${c.id}" was built with engine ${c.engine}, this runtime is engine ${ENGINE_VERSION}: rebuild the audio (beeps build) or pass { allowEngineMismatch: true }`);
  return c;
}

const isCue = (/** @type {any} */ x) => x?.schema === CUE_SCHEMA;

/**
 * @typedef {object} BuildOptions
 * @property {number} [seed]       selects the noise and grain content and the variant's draw (default: the cue's seed, else 1)
 * @property {Record<string, number>} [params]  starting input values (absent inputs sit at their declared defaults)
 * @property {number} [variant]    which declared variant to voice (0 is the patch as written)
 * @property {number} [trimDb]     loudness trim in dB (default: the cue's measured trim, else 0)
 * @property {Scale | null} [scale]  pitched sources snap to it when its `snap` is true. Default: the cue's project scale; null: none
 * @property {boolean} [limiter]   the transparent safety clipper on the voice's output (default true)
 * @property {boolean} [hold]      sound until stopped instead of ending at the patch's duration (default: the patch's xRuntime.hold)
 * @property {AudioNode} [tap]     also receive the signal before the trim and limiter (the parity harness uses it)
 * @property {ReverbBuses} [reverb]  a shared reverb bus (see createReverbBus) to send to instead of a convolver of the voice's own
 * @property {() => void} [onEnded]  called once when the voice is finished: ended on its own, stopped or disposed
 */

/**
 * @typedef {object} Voice
 * @property {boolean} started
 * @property {number | undefined} end  context time the voice is silent, effect tails included; Infinity while a hold voice is held; undefined before start
 * @property {(at?: number) => Voice} start
 * @property {(input: string, value: number, at?: number, tau?: number) => void} set
 * @property {(at?: number, fade?: number) => number} stop
 * @property {() => void} dispose
 */

/**
 * Plan a voice. Nothing is created in the audio graph until `start`.
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} out  where the voice's output goes
 * @param {Patch | Cue} source  a parsed patch (defaults filled; see parsePatch in the schema entry) or a runtime cue
 * @param {BuildOptions} [opts]
 * @returns {Voice}
 */
export function build(ctx, out, source, opts = {}) {
  const cue = isCue(source) ? /** @type {Cue} */ (source) : undefined;
  const patch = cue ? cue.patch : /** @type {Patch} */ (source);
  if (!patch || patch.schema !== 'beeps/patch@1' || !Array.isArray(patch.layers)) throw new TypeError('build: expected a parsed beeps/patch@1 patch or a runtime cue (parse raw JSON with parsePatch, which fills the defaults)');
  const rt = /** @type {RuntimeBlock | undefined} */ (/** @type {any} */ (patch).xRuntime);
  const inputs = rt?.inputs ?? {};
  const seed = opts.seed ?? cue?.seed ?? 1;
  const trimDb = opts.trimDb ?? cue?.trimDb ?? 0;
  const scale = opts.scale === null ? undefined : (opts.scale ?? cue?.scale);
  const hold = opts.hold ?? rt?.hold ?? false;

  /** Current input values: the declared defaults, then the caller's. */
  const vals = defaultParams(patch);
  const given = (/** @type {string} */ name, /** @type {number} */ value) => {
    const d = inputs[name];
    if (!d) throw new Error(`unknown input "${name}"${Object.keys(inputs).length ? ` (declared: ${Object.keys(inputs).join(', ')})` : ' (this patch declares no inputs)'}`);
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`input "${name}" needs a finite number, got ${value}`);
    vals[name] = clampInput(d, value);
  };
  for (const [k, v] of Object.entries(opts.params ?? {})) given(k, v);

  // Inputs with a static binding are fixed when the graph is built; the others are live.
  const staticInputs = new Set((rt?.bind ?? []).filter(b => !b.live).map(b => b.input));

  /** @type {ReturnType<typeof buildPatch> | undefined} */
  let built;
  /** @type {ReturnType<typeof makeLive> | undefined} */
  let live;
  /** @type {ConstantSourceNode | undefined} */
  let timer;
  let done = false;
  let finished = false;
  let endAt = /** @type {number | undefined} */ (undefined);

  const finish = () => {
    if (finished) return;
    finished = true;
    built?.dispose();
    try { opts.onEnded?.(); } catch (e) { console.error(e); }
  };

  /** Context time of a call that took an optional `at`. */
  const when = (/** @type {number | undefined} */ at) => (at === undefined ? ctx.currentTime : at);

  /** (Re)arm the end-of-voice timer to fire once context time `at` has passed. */
  function armTimer(/** @type {number} */ from, /** @type {number} */ at) {
    if (!timer) {
      timer = ctx.createConstantSource();
      timer.onended = () => finish();
      timer.start(from);
    }
    timer.stop(Math.max(at, from) + 0.012);
  }

  /** The live automation of this voice's `live` bindings (the same parameters a static value would have set). */
  function liveInputs(/** @type {ReturnType<typeof buildPatch>} */ r) {
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
    return makeLive(inputs, vals, [...targets.values()], () => ctx.currentTime);
  }

  /** @type {Voice} */
  const voice = {
    get started() { return built !== undefined; },
    get end() { return endAt; },

    start(at) {
      if (done) throw new Error('start: the voice was stopped or disposed');
      if (built) throw new Error('start: already started (a voice plays once; build another)');
      const t0 = when(at);
      const applied = applyParams(patch, vals);
      built = buildPatch(ctx, applied.patch, {
        destination: out, when: t0, seed, variant: opts.variant ?? 0, trimDb: trimDb + applied.trimDeltaDb, scale,
        limiter: opts.limiter ?? true, hold, authoredTap: opts.tap, reverb: opts.reverb,
      });
      endAt = built.end;
      live = liveInputs(built);
      // A silent, unconnected source whose `ended` event says when the voice is finished (it adds nothing to the audio graph).
      if (Number.isFinite(built.end)) armTimer(t0, built.end);
      return voice;
    },

    set(input, value, at, tau) {
      if (finished) return;
      if (!built) { given(input, value); return; }
      if (!inputs[input]) throw new Error(`unknown input "${input}"`);
      if (staticInputs.has(input)) throw new Error(`input "${input}" has bindings the graph fixes when it is built (not "live": true): set it before start()`);
      live?.(input, value, at, tau);
    },

    stop(at, fade = 0.02) {
      const t = when(at);
      if (!built) { done = true; finish(); return t; }
      if (finished) return t;
      if (hold && !done) {
        done = true;
        const silent = built.release(t);
        endAt = silent;
        armTimer(t, silent);
        return silent;
      }
      done = true;
      const g = built.nodes.trim.gain;
      g.cancelScheduledValues(t);
      g.setTargetAtTime(0, t, fade / 4);
      endAt = Math.min(endAt ?? Infinity, t + fade);
      armTimer(t, endAt);
      return endAt;
    },

    dispose() {
      done = true;
      try { timer?.stop(); } catch { /* never started */ }
      finish();
    },
  };

  return voice;
}
