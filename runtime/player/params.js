// runtime/player/params.js
// Click-free AudioParam changes: no level change is instant, and a new ramp starts from where the
// param actually is, even mid-fade.

/** Seconds: the shortest ramp for any level change, so nothing clicks. */
export const RAMP = 0.02;

/** A usable fade length: a non-finite or non-positive one would schedule NaN times, which throw. @param {unknown} x */
export const fade = x => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : RAMP);

/** The ramp duration actually scheduled for a requested fade: at least RAMP. @param {unknown} x */
export const span = x => Math.max(RAMP, fade(x));

/**
 * Freeze `param` at whatever it is doing at `at`, so the next ramp starts there and nothing snaps.
 * Browsers have cancelAndHoldAtTime. The fallback holds the current value for an immediate change;
 * for a future `at` (a bar line) it holds `scheduled`, the last target, since the level now may be
 * mid-fade toward it and would snap back at the bar.
 * @param {AudioParam} param
 * @param {number} at
 * @param {number} now the context's current time
 * @param {number} [scheduled]
 */
export function hold(param, at, now, scheduled) {
  if (typeof param.cancelAndHoldAtTime === 'function') { param.cancelAndHoldAtTime(at); return; }
  const future = at > now + 1e-9;
  param.cancelScheduledValues(at);
  param.setValueAtTime(future && scheduled !== undefined ? scheduled : param.value, at);
}

/**
 * Ramp `param` to `to` over `sec`, starting now.
 * @param {AudioParam} param @param {number} to @param {unknown} sec @param {number} now
 */
export function ramp(param, to, sec, now) {
  hold(param, now, now);
  param.linearRampToValueAtTime(to, now + span(sec));
}
