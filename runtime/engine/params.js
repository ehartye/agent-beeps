// Named runtime inputs bound to patch parameters (the `xRuntime` block of beeps/patch@1; docs/runtime.md).
//
// A patch's `xRuntime` block declares inputs (speed, size, distance...) and binds each to patch values. The rule that
// keeps both delivery paths honest: **the authored patch is the value at each input's `default`**. A binding never
// stores a value; it stores a *delta* from the authored one, so at the defaults the runtime graph is the authored
// graph, and everything measured about the patch (loudness, lint, look) is true of the runtime path at its defaults.
//
//   delta(v) = f(shape((v - min) / (max - min))) - f(shape((default - min) / (max - min)))      f: lerp lo -> hi
//
// The delta is applied in the target's natural unit: dB and plain numbers add; Hz and seconds multiply by 2^delta
// (delta in octaves); the macro `/out/transpose` is in semitones. Browser-safe: no Node APIs, no zod.

/** @typedef {import('../../src/schema/patch.ts').Patch} Patch */
/** @typedef {{ min: number, max: number, default: number, description?: string }} RuntimeInput */
/** @typedef {{ input: string, target: string | string[], range: [number, number], shape?: 'linear' | 'quad' | 'sqrt', unit?: 'db' | 'lin' | 'oct' | 'st', live?: boolean, clamp?: [number, number] }} RuntimeBind */
/** @typedef {{ delivery?: 'baked' | 'runtime' | 'both', hold?: boolean, inputs: Record<string, RuntimeInput>, bind: RuntimeBind[] }} RuntimeBlock */

/** Macro targets: the three controls nearly every game input wants, defined once so a static and a live binding agree. */
export const MACROS = /** @type {const} */ ({
  '/out/gainDb': 'db',       // loudness of the whole voice, dB (the trim stage)
  '/out/transpose': 'st',    // pitch of every pitched source, semitones
  '/out/brightness': 'oct',  // every filter cutoff, octaves
});

/** Unit class of a pointer target, from its last segment. */
export function unitOf(/** @type {string} */ target) {
  if (target in MACROS) return MACROS[/** @type {keyof typeof MACROS} */ (target)];
  const last = target.slice(target.lastIndexOf('/') + 1);
  if (/Db$/.test(last)) return 'db';
  if (['cutoff', 'pitch', 'rate', 'attack', 'decay', 'release', 'start', 'duration', 'highpass', 'time', 'q', 'to', 'center', 'base', 'detuneCents'].includes(last)) return 'oct';
  return 'lin';
}

/**
 * The delta one binding contributes at input value `v` (0 at the input's default): the numeric core, shared by the
 * interpreter and by generated modules.
 * @param {number | undefined} v  undefined: the default
 * @param {number} def @param {number} min @param {number} max
 * @param {number} lo  binding value at the input's min @param {number} hi  ...and at its max
 * @param {'linear' | 'quad' | 'sqrt'} [shape]
 */
export function bd(v, def, min, max, lo, hi, shape) {
  if (v === undefined || v === def) return 0;
  const at = (/** @type {number} */ x) => {
    const t = Math.min(1, Math.max(0, (x - min) / (max - min || 1)));
    return lo + (hi - lo) * (shape === 'quad' ? t * t : shape === 'sqrt' ? Math.sqrt(t) : t);
  };
  return at(v) - at(def);
}

/**
 * @param {RuntimeBind} b
 * @param {RuntimeInput} input
 * @param {number | undefined} v
 */
export const bindDelta = (b, input, v) => bd(v, input.default, input.min, input.max, b.range[0], b.range[1], b.shape);

/** How a summed delta moves a live parameter from its built value: gain (dB), oct (Hz), st / ct (cents from semitones / octaves), pan. */
/** @type {Record<'gain' | 'oct' | 'st' | 'ct' | 'pan', (base: number, delta: number) => number>} */
const KINDS = {
  gain: (b, s) => b * 10 ** (s / 20),
  oct: (b, s) => b * 2 ** s,
  st: (b, s) => b + 100 * s,
  ct: (b, s) => b + 1200 * s,
  pan: (b, s) => Math.min(1, Math.max(-1, b + s)),
};

/**
 * Live inputs. `targets` is `[param, kind, [[input, lo, hi, shape], ...]]`: the parameter, how a delta moves it, and the bindings
 * that feed it. The parameters are ones the graph already has and the engine never automates (a layer's gain, a filter's
 * detune, an oscillator's detune, a send), so a live input adds no node and cannot fight a scheduled envelope. Returns `set`.
 * @param {Record<string, RuntimeInput>} inputs
 * @param {Record<string, number>} vals  starting input values (mutated by set)
 * @param {[AudioParam, 'gain' | 'oct' | 'st' | 'ct' | 'pan', [string, number, number, ('linear' | 'quad' | 'sqrt')?][]][]} targets
 * @param {() => number} now
 */
export function makeLive(inputs, vals, targets, now) {
  const live = targets.map(([param, kind, binds]) => ({ param, f: KINDS[kind], base: param.value, binds }));
  const total = (/** @type {typeof live[number]} */ t) =>
    t.binds.reduce((s, [k, lo, hi, shape]) => s + bd(vals[k], inputs[k].default, inputs[k].min, inputs[k].max, lo, hi, shape), 0);
  // The build used the authored values; move live parameters to their starting inputs without scheduling anything.
  for (const t of live) { const s = total(t); if (s !== 0) t.param.value = t.f(t.base, s); }
  return (/** @type {string} */ input, /** @type {number} */ value, at = now(), tau = 0.02) => {
    const d = inputs[input];
    if (!d) throw new Error(`unknown input "${input}"`);
    vals[input] = clampInput(d, value);
    for (const t of live) {
      if (!t.binds.some(b => b[0] === input)) continue;
      const v = t.f(t.base, total(t));
      t.param.cancelScheduledValues(at);
      if (tau > 0) t.param.setTargetAtTime(v, at, tau);
      else t.param.setValueAtTime(v, at);
    }
  };
}

/** The binding's target, with `*` expanded over the patch's layers. @param {Patch} patch @param {RuntimeBind} b */
export function targetsOf(patch, b) {
  const list = Array.isArray(b.target) ? b.target : [b.target];
  const out = [];
  for (const t of list) {
    if (t.includes('/*')) for (let i = 0; i < patch.layers.length; i++) out.push(t.replace('/*', `/${i}`));
    else out.push(t);
  }
  return out;
}

/** Live-capable targets: automation of a parameter the graph already has, with no node added. */
export const LIVE_POINTERS = [/^\/layers\/\d+\/gainDb$/, /^\/layers\/\d+\/pan$/, /^\/layers\/\d+\/filter\/cutoff$/, /^\/layers\/\d+\/lfo\/rate$/, /^\/fx\/(reverb|delay)\/sendDb$/];
export const isLiveTarget = (/** @type {string} */ t) => t in MACROS || LIVE_POINTERS.some(r => r.test(t));

/** Default value of every declared input. @param {Patch} patch */
export function defaultParams(patch) {
  const r = /** @type {RuntimeBlock | undefined} */ (/** @type {any} */ (patch).xRuntime);
  return Object.fromEntries(Object.entries(r?.inputs ?? {}).map(([k, i]) => [k, i.default]));
}

/** Clamp an input to its declared range (a runtime value outside it is a caller bug, not a reason to blow a filter up). */
export const clampInput = (/** @type {RuntimeInput} */ i, /** @type {number} */ v) => Math.min(i.max, Math.max(i.min, v));

/** @param {string | number} p */
const hz = p => {
  if (typeof p === 'number') return p;
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(p);
  if (!m) return NaN;
  const semi = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[/** @type {'C'} */ (m[1])] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return 440 * 2 ** ((12 * (Number(m[3]) + 1) + semi - 69) / 12);
};

/**
 * Apply the *static* bindings to a copy of the patch: the interpreter path, and the reference the generated code is tested
 * against. Live bindings (`live: true`) are left alone here; the voice automates them after the build.
 * @param {Patch} patch
 * @param {Record<string, number>} [params]  absent inputs sit at their defaults
 * @param {boolean} [all]  also apply the live bindings, as a fixed value: the bake of a live voice at that input
 * @returns {{ patch: Patch, trimDeltaDb: number }}
 */
export function applyParams(patch, params = {}, all = false) {
  const rt = /** @type {RuntimeBlock | undefined} */ (/** @type {any} */ (patch).xRuntime);
  if (!rt?.bind?.length) return { patch, trimDeltaDb: 0 };
  /** @type {any} */
  const p = structuredClone(patch);
  let trimDeltaDb = 0;
  for (const b of rt.bind) {
    if (b.live && !all) continue;
    const input = rt.inputs[b.input];
    if (!input) throw new Error(`xRuntime: bind uses undeclared input "${b.input}"`);
    const d = bindDelta(b, input, params[b.input]);
    if (d === 0) continue;
    for (const t of targetsOf(p, b)) {
      if (t === '/out/gainDb') trimDeltaDb += d;
      else if (t === '/out/transpose') transpose(p, 2 ** (d / 12));
      else if (t === '/out/brightness') brighten(p, 2 ** d);
      else {
        const keys = t.slice(1).split('/');
        let cur = p;
        for (const k of keys.slice(0, -1)) cur = cur?.[k];
        const last = keys[keys.length - 1];
        if (cur == null || cur[last] === undefined) throw new Error(`xRuntime: bind target ${t} does not exist in the patch`);
        const unit = b.unit ?? unitOf(t);
        const base = last === 'pitch' || last === 'to' ? hz(cur[last]) : cur[last];
        let v = unit === 'oct' ? base * 2 ** d : unit === 'st' ? base * 2 ** (d / 12) : base + d;
        if (b.clamp) v = Math.min(b.clamp[1], Math.max(b.clamp[0], v));
        cur[last] = v;
      }
    }
  }
  return { patch: p, trimDeltaDb };
}

/** Every pitched thing, scaled by `r` (a frequency ratio). @param {any} p @param {number} r */
function transpose(p, r) {
  for (const l of p.layers) {
    const s = l.source;
    if ('pitch' in s) s.pitch = hz(s.pitch) * r;
    if (s.type === 'metal') s.base *= r;
    if (l.pitchEnv) for (const e of l.pitchEnv) e.to = hz(e.to) * r;
  }
}

/** Every filter cutoff (and its envelope target), scaled by `r`. @param {any} p @param {number} r */
function brighten(p, r) {
  for (const l of p.layers) {
    if (!l.filter) continue;
    l.filter.cutoff *= r;
    if (l.filter.env) l.filter.env.to *= r;
  }
}
