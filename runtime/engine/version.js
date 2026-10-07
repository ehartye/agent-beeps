/** Bump when the engine's output changes for the same patch; it invalidates cached renders.
 * 2: fixed-order sums (sum.js) make renders bit-exact; engine 1 renders differ from them by float rounding. */
export const ENGINE_VERSION = '2';
