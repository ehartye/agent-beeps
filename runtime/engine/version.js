/** Bump for output or cue capability changes; it invalidates cached renders.
 * 4: prepared sample sources and verified cue dependency loading; legacy procedural PCM is unchanged.
 * 3: authored FM index envelopes require a compatible runtime; legacy patch PCM is unchanged.
 * 2: fixed-order sums (sum.js) make renders bit-exact; engine 1 renders differ from them by float rounding. */
export const ENGINE_VERSION = '4';
