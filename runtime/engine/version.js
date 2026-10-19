/** Bump for output or cue capability changes; it invalidates cached renders.
 * 3: authored FM index envelopes require a compatible runtime; legacy patch PCM is unchanged.
 * 2: fixed-order sums (sum.js) make renders bit-exact; engine 1 renders differ from them by float rounding. */
export const ENGINE_VERSION = '3';
