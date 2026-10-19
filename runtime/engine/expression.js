// Native song performance controls. Onset mappings share the runtime parameter interpreter;
// curves use detune, preserving the instrument's frequency/filter envelopes and LFOs.
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
