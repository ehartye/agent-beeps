// Fixed-order summing. Chromium keeps the connections into a node input (and into an AudioParam) in a
// pointer-keyed hash set and sums them in that set's order, which changes from run to run. Float addition of
// three or more terms rounds differently in a different order, so a graph where three signals meet in one
// input renders a few ulps differently each time (1 LSB at 16 bits in a handful of samples). Two terms commute
// exactly, so every sum here is a chain of gains with at most two inputs each, in the order given: bit-exact.

/**
 * One node carrying the sum of `nodes` (non-empty), added left to right. A single node is returned as is.
 * @param {BaseAudioContext} ctx
 * @param {AudioNode[]} nodes
 * @returns {AudioNode}
 */
export function sumNodes(ctx, nodes) {
  let acc = nodes[0];
  for (let i = 1; i < nodes.length; i++) {
    const g = ctx.createGain();
    acc.connect(g);
    nodes[i].connect(g);
    acc = g;
  }
  return acc;
}

/**
 * Connect the sum of `nodes` to `dest` (a node or an AudioParam) through one connection. No-op when empty.
 * @param {BaseAudioContext} ctx
 * @param {AudioNode[]} nodes
 * @param {AudioNode | AudioParam} dest
 */
export function sumInto(ctx, nodes, dest) {
  if (!nodes.length) return;
  sumNodes(ctx, nodes).connect(/** @type {any} */ (dest));
}

/**
 * Voices that come and go (song notes) into one input. Each note goes to the first slot whose previous note has
 * ended; slots are summed in a fixed chain. A finished note's connection stays but carries exact zeros, and
 * x + 0 is exact, so each slot input sums at most one sounding note (two if an end estimate was short, still
 * exact). Slots are created as polyphony grows; a new slot is spliced onto the end of the chain.
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} dest
 */
export function voicePool(ctx, dest) {
  /** @type {{ input: GainNode, freeAt: number }[]} */
  const slots = [];
  /** @type {AudioNode | undefined} */
  let top;
  return {
    /** The input a note sounding from `start` to `end` (context seconds) should connect to. */
    slot(/** @type {number} */ start, /** @type {number} */ end) {
      let s = slots.find(x => x.freeAt <= start);
      if (!s) {
        s = { input: ctx.createGain(), freeAt: 0 };
        slots.push(s);
        if (!top) { top = s.input; top.connect(dest); }
        else {
          const g = ctx.createGain();
          top.connect(g);
          s.input.connect(g);
          g.connect(dest);
          top.disconnect(dest);
          top = g;
        }
      }
      s.freeAt = end;
      return s.input;
    },
    get size() { return slots.length; },
  };
}
