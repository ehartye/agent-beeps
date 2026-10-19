// Browser-safe breakpoint automation, shared by sources that evolve a parameter from voice onset.

/** @typedef {readonly [seconds: number, scale: number, arrivalCurve?: 'linear' | 'step' | 'exp']} EnvelopePoint */

/**
 * Validate the actual curve after runtime mappings, which may combine inputs beyond the schema's sampled corners.
 * @param {unknown} points
 */
export function validateEnvelope(points) {
  if (!Array.isArray(points)) throw new TypeError('envelope must be an array of points');
  if (points.length < 1 || points.length > 64) throw new RangeError('envelope requires 1..64 points');
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (!Array.isArray(point) || point.length < 2 || point.length > 3) throw new TypeError(`envelope point ${i}: expected tuple [seconds, scale, arrivalCurve?]`);
    const [seconds, value, curve] = point;
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 10) throw new RangeError(`envelope point ${i}: time must be finite seconds in 0..10`);
    if (i === 0 && seconds !== 0) throw new RangeError('envelope point 0: must start at time 0');
    if (i > 0 && seconds <= points[i - 1][0]) throw new RangeError(`envelope point ${i}: times must be strictly increasing`);
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`envelope point ${i}: scale must be finite in 0..1`);
    if (curve !== undefined && !['linear', 'step', 'exp'].includes(curve)) throw new TypeError(`envelope point ${i}: arrival curve must be linear, step or exp`);
    if (i > 0 && curve === 'exp' && (points[i - 1][1] <= 0 || value <= 0)) throw new RangeError(`envelope point ${i}: exponential segments require positive scales at both endpoints`);
  }
}

/**
 * Preflight a complete schedule without touching a parameter, so a patch can validate every layer before starting one.
 * @param {readonly EnvelopePoint[]} points
 * @param {{ when: number, scale: number }} options absolute voice onset and nonnegative peak value
 */
export function validateEnvelopeSchedule(points, { when, scale }) {
  if (!Number.isFinite(when) || when < 0) throw new RangeError('envelope onset must be finite and nonnegative');
  if (!Number.isFinite(scale) || scale < 0) throw new RangeError('envelope scale must be finite and nonnegative');
  validateEnvelope(points);
  // AudioParam values are Float32: reject overflow and exponential endpoints that would round to zero,
  // before scheduling even the initial set. Linear/step targets may naturally round to zero.
  if (scale > 0) for (let i = 0; i < points.length; i++) {
    const target = Math.fround(points[i][1] * scale);
    if (!Number.isFinite(target)) throw new RangeError(`envelope point ${i}: scaled target must be finite in Float32`);
    if (i > 0 && points[i][2] === 'exp' && (target <= 0 || Math.fround(points[i - 1][1] * scale) <= 0)) {
      throw new RangeError(`envelope point ${i}: scaled exponential endpoints must stay positive in Float32`);
    }
  }
}

/**
 * Schedule normalized breakpoints on a parameter owned by this envelope. Points start at zero,
 * increase in seconds, and use scales in 0..1. Each curve describes arrival at that point; exponential
 * segments need positive endpoints. The last value holds; callers own source lifetime and release.
 * @param {AudioParam} param
 * @param {readonly EnvelopePoint[]} points
 * @param {{ when: number, scale: number }} options absolute voice onset and nonnegative peak value
 */
export function scheduleEnvelope(param, points, { when, scale }) {
  validateEnvelopeSchedule(points, { when, scale });
  param.setValueAtTime(points[0][1] * scale, when);
  // A zero peak is silent, including envelopes with valid positive exponential scales.
  if (scale === 0) return;
  for (let i = 1; i < points.length; i++) {
    const [seconds, value, curve = 'linear'] = points[i];
    const at = when + seconds;
    const target = value * scale;
    if (curve === 'step') param.setValueAtTime(target, at);
    else if (curve === 'exp') param.exponentialRampToValueAtTime(target, at);
    else param.linearRampToValueAtTime(target, at);
  }
}
