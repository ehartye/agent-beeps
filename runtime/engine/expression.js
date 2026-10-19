// Native song performance controls. Onset mappings share the runtime parameter interpreter;
// curves use detune, preserving the instrument's frequency/filter envelopes and LFOs.
import { noteToHz } from './notes.js';
import { METAL_RATIOS, nyquistSafe } from './sources.js';
import { applyParams, targetsOf } from './params.js';

/** @typedef {import('../../src/schema/patch.ts').Patch} Patch */
/** @typedef {import('../../src/schema/song.ts').Song} Song */
/** @typedef {import('../../src/schema/song.ts').SongTrack} SongTrack */
/** @typedef {import('./sequence.js').NoteEvent} NoteEvent */
/** @typedef {[number, number, ('linear' | 'step')?][]} Curve */

/** A track explicitly selects its velocity input; other runtime inputs keep their old behavior. */
export function velocityInputIssue(/** @type {Patch} */ patch, /** @type {string} */ input) {
  const rt = patch.xRuntime;
  if (!rt || !Object.hasOwn(rt.inputs, input)) return `velocity input "${input}" is not declared by the instrument`;
  const binds = rt.bind.filter(b => b.input === input);
  if (!binds.length) return `velocity input "${input}" has no parameter bindings`;
  for (const b of binds) for (const target of targetsOf(patch, b)) {
    if (target.startsWith('/fx/')) return `velocity input "${input}" targets a shared effect bus (${target}); bind a layer parameter or output macro instead`;
    if (target === '/out/brightness' && !patch.layers.some(l => l.filter)) return `velocity input "${input}" changes brightness but the instrument has no layer filter`;
  }
  return null;
}

/** Map the final performed velocity onto the input's min..max, including live bindings at onset. */
export function velocityPatch(/** @type {Patch} */ patch, /** @type {SongTrack} */ track, /** @type {number} */ velocity) {
  const input = track.velocityInput;
  if (!input) return { patch, trimDeltaDb: 0 };
  const issue = velocityInputIssue(patch, input);
  if (issue) throw new Error(issue);
  const spec = /** @type {NonNullable<Patch['xRuntime']>} */ (patch.xRuntime).inputs[input];
  const value = spec.min + Math.max(0, Math.min(1, velocity)) * (spec.max - spec.min);
  return applyParams(patch, { [input]: value }, true);
}

/** Refuse unsupported gestures instead of silently discarding a musician's authored control. */
export function songPerformanceIssues(/** @type {Song} */ song, /** @type {Record<string, Patch>} */ instruments, /** @type {NoteEvent[]} */ events) {
  /** @type {{ pointer: string, message: string }[]} */
  const issues = [];
  for (const [track, t] of Object.entries(song.tracks)) {
    const p = instruments[track];
    if (!p) continue;
    const at = `/tracks/${track}`;
    if (p.layers.some(l => l.source.type === 'sample')) {
      if (!t.fixed) issues.push({ pointer: `${at}/fixed`, message: 'sample instruments require fixed: true (unpitched one-shot playback)' });
      if (t.root !== undefined) issues.push({ pointer: `${at}/root`, message: 'sample instruments cannot request root retuning' });
      if (t.transpose) issues.push({ pointer: `${at}/transpose`, message: 'sample instruments cannot request transpose retuning' });
      if (events.some(e => e.track === track && e.expression?.pitch)) issues.push({ pointer: `${at}/instrument`, message: 'sample instruments cannot use pitch expression' });
      if (t.velocityInput && p.xRuntime?.bind.some(b => b.input === t.velocityInput && targetsOf(p, b).includes('/out/transpose'))) {
        issues.push({ pointer: `${at}/velocityInput`, message: 'sample instruments cannot request transpose through a velocity input' });
      }
    }
    if (t.velocityInput) {
      const issue = velocityInputIssue(p, t.velocityInput);
      if (issue) issues.push({ pointer: `${at}/velocityInput`, message: issue });
    }
    const played = events.filter(e => e.track === track);
    if (played.some(e => e.expression?.pitch) && !p.layers.some(l => 'pitch' in l.source)) {
      issues.push({ pointer: `${at}/instrument`, message: 'pitch expression requires an instrument with a pitched source' });
    }
    if (played.some(e => e.expression?.brightness) && !p.layers.some(l => l.filter)) {
      issues.push({ pointer: `${at}/instrument`, message: 'brightness expression requires an instrument with a layer filter' });
    }
  }
  return issues;
}

/** Validate the actual performed numeric/scheduling domains without allocating nodes or re-parsing
 * patch schemas: a held musical note can exceed the patch duration limit, and zero amp times are valid.
 * @param {BaseAudioContext} ctx @param {Patch} performed
 * @param {{track: string, velocity: number, onset: number, trimDeltaDb: number}} options
 */
export function preflightVelocityPatch(ctx, performed, { track, velocity, onset, trimDeltaDb }) {
  const db = (/** @type {number} */ value) => 10 ** (value / 20);
  // The engine receives parsed patches. Still check realized numeric values: a finite
  // binding can overflow at a performed input, including an interior nonlinear sum.
  const check = (/** @type {unknown} */ value, /** @type {string} */ pointer) => {
    if (typeof value === 'number' && !Number.isFinite(Math.fround(value))) throw new RangeError(`/tracks/${track}/velocityInput: ${pointer} must remain finite in Float32 at velocity ${velocity}`);
    if (Array.isArray(value)) value.forEach((v, i) => check(v, `${pointer}/${i}`));
    else if (value && typeof value === 'object') for (const [key, v] of Object.entries(value)) if (key !== 'xRuntime') check(v, `${pointer}/${key}`);
  };
  check(performed, '');
  const domain = (/** @type {number} */ value, /** @type {string} */ pointer, positive = false) => {
    check(value, pointer);
    if (positive ? value <= 0 : value < 0) throw new RangeError(`/tracks/${track}/velocityInput: ${pointer} must remain ${positive ? 'positive' : 'nonnegative'} at velocity ${velocity}`);
  };
  domain(performed.duration, '/duration', true);
  check(velocity * db(trimDeltaDb), '/out/gainDb (linear note gain)');
  // Raw authored numbers are not all AudioParam values: dB becomes linear gain,
  // and source frequencies/depths multiply ratios after the track has retuned them.
  // Check those actual derived values too, before any earlier event can start.
  for (const [i, layer] of performed.layers.entries()) {
    const at = `/layers/${i}`, src = layer.source;
    domain(layer.start, `${at}/start`);
    for (const name of /** @type {const} */ (['attack', 'decay', 'release'])) domain(layer.amp[name], `${at}/amp/${name}`);
    // Validate actual absolute schedule times and source length as well as authored deltas.
    // Zero attack/decay/release remain valid; long held notes are not patch-schema durations.
    const t0 = onset + layer.start;
    const off = Math.max(t0 + Math.min(layer.amp.attack, .002), onset + performed.duration);
    const end = off + layer.amp.release;
    for (const [name, value] of /** @type {[string, number][]} */ ([['onset', t0], ['attack', t0 + layer.amp.attack], ['off', off], ['end', end], ['stop', end + .01], ['source duration', end - t0]])) domain(value, `${at}/${name}`);
    if (layer.filter) {
      domain(layer.filter.cutoff, `${at}/filter/cutoff`, true);
      if ('q' in layer.filter) domain(layer.filter.q, `${at}/filter/q`, true);
      if (layer.filter.env) {
        domain(layer.filter.env.time, `${at}/filter/env/time`, true);
        domain(t0 + layer.filter.env.time, `${at}/filter/env (schedule time)`);
      }
    }
    if (layer.lfo) domain(layer.lfo.rate, `${at}/lfo/rate`, true);
    if (layer.pitchEnv) for (const [j, point] of layer.pitchEnv.entries()) {
      domain(point.at, `${at}/pitchEnv/${j}/at`);
      domain(t0 + point.at, `${at}/pitchEnv/${j} (schedule time)`);
    }
    check(db(layer.gainDb), `${at}/gainDb (linear gain)`);
    const base = 'pitch' in src ? noteToHz(src.pitch) : 440;
    if ('pitch' in src) domain(base, `${at}/source/pitch`, true);
    if (src.type === 'osc' && src.unison) {
      domain(src.unison.voices, `${at}/source/unison/voices`, true);
      if (!Number.isInteger(src.unison.voices) || src.unison.voices > 7) throw new RangeError(`/tracks/${track}/velocityInput: ${at}/source/unison/voices must remain an integer in 1..7 at velocity ${velocity}`);
    }
    const ratios = [1];
    if (src.type === 'fm') {
      ratios.splice(0, 1, ...src.operators.map(op => op.ratio));
      src.operators.forEach((op, j) => {
        domain(op.ratio, `${at}/source/operators/${j}/ratio`, true);
        domain(op.index, `${at}/source/operators/${j}/index`);
        check(base * op.ratio, `${at}/source/operators/${j}/ratio (frequency)`);
      });
      for (const [from, to] of src.algorithm) if (from < src.operators.length && to < src.operators.length && from !== to) {
        check(src.operators[from].index * base * src.operators[to].ratio, `${at}/source/operators/${from}/index (modulation depth)`);
      }
    } else if (src.type === 'additive') {
      for (const [j, [ratio, , decay]] of src.partials.entries()) {
        domain(ratio, `${at}/source/partials/${j}/0`, true);
        domain(decay, `${at}/source/partials/${j}/2 (time constant)`, true);
      }
      const total = src.partials.reduce((sum, [, gain]) => sum + db(gain), 0) || 1;
      ratios.splice(0, 1, ...src.partials.filter(([ratio]) => nyquistSafe(ctx, base * ratio)).map(([ratio]) => ratio));
      for (const [j, [ratio, gain]] of src.partials.entries()) if (nyquistSafe(ctx, base * ratio)) check(db(gain) / total, `${at}/source/partials/${j}/1 (normalized gain)`);
    } else if (src.type === 'modal') {
      for (const [j, [ratio, q]] of src.modes.entries()) {
        domain(ratio, `${at}/source/modes/${j}/0`, true);
        domain(q, `${at}/source/modes/${j}/1`, true);
      }
      ratios.splice(0, 1, ...src.modes.filter(([ratio]) => nyquistSafe(ctx, base * ratio)).map(([ratio]) => ratio));
      for (const [j, [ratio, q, gain]] of src.modes.entries()) if (nyquistSafe(ctx, base * ratio)) check(db(gain) * q * 4, `${at}/source/modes/${j}/2 (resonator gain)`);
    } else if (src.type === 'grains') {
      // grainBuffer materializes this source duration, then passes its frame count to
      // createBuffer (an unsigned-long native length). Validate before allocating any song node.
      const frames = Math.max(1, Math.ceil(ctx.sampleRate * (end - t0)));
      if (!Number.isSafeInteger(frames) || frames > 0xffffffff) throw new RangeError(`/tracks/${track}/velocityInput: ${at}/source duration exceeds the native buffer frame domain at velocity ${velocity}`);
      for (const key of /** @type {const} */ (['rate', 'grainDecay', 'center', 'q'])) domain(src[key], `${at}/source/${key}`, true);
      if (src.rateEnd !== undefined) domain(src.rateEnd, `${at}/source/rateEnd`);
    } else if (src.type === 'voice') {
      if (src.vibrato) domain(src.vibrato.rate, `${at}/source/vibrato/rate`, true);
      if (src.tremolo) domain(src.tremolo.rate, `${at}/source/tremolo/rate`, true);
      for (const [j, [hz, q]] of src.formants.entries()) {
        domain(hz, `${at}/source/formants/${j}/0`, true);
        domain(q, `${at}/source/formants/${j}/1`, true);
      }
      // PeriodicWave coefficients are Float32 too; nonlinear tilt mappings can overflow them.
      for (let harmonic = 1; harmonic <= 48; harmonic++) check(1 / harmonic ** src.tilt, `${at}/source/tilt (harmonic coefficient)`);
      for (const [j, [hz, , gain]] of src.formants.entries()) if (nyquistSafe(ctx, hz)) check(db(gain), `${at}/source/formants/${j}/2 (linear gain)`);
    } else if (src.type === 'metal') {
      domain(src.base, `${at}/source/base`, true);
      for (const ratio of METAL_RATIOS) check(src.base * ratio, `${at}/source/base (frequency)`);
    }
    if (layer.pitchEnv) for (const point of layer.pitchEnv) for (const ratio of ratios) check(noteToHz(point.to) * ratio, `${at}/pitchEnv (frequency)`);
  }
}

/** @param {AudioParam} param @param {Curve} curve @param {number} when @param {number} scale */
function scheduleCurve(param, curve, when, scale) {
  const base = param.value;
  for (let i = 0; i < curve.length; i++) {
    const [at, value, arrival = 'linear'] = curve[i];
    const t = when + at, v = base + value * scale;
    if (i === 0 || arrival === 'step') param.setValueAtTime(v, t);
    else param.linearRampToValueAtTime(v, t);
  }
}

/** Curves are in seconds, clipped to the held duration; their final value holds into the release. */
export function scheduleNoteExpression(/** @type {import('./layer.js').LayerNodes} */ nodes,
  /** @type {{ pitch?: Curve, brightness?: Curve }} */ expression, /** @type {number} */ when) {
  if (expression.pitch) for (const param of new Set(nodes.expressionDetune)) scheduleCurve(param, expression.pitch, when, 100);
  if (expression.brightness && nodes.filter) scheduleCurve(nodes.filter.detune, expression.brightness, when, 1200);
}
