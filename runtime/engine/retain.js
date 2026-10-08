// Keeping graph nodes alive. Chromium disposes an AudioNode whose JS wrapper has been garbage collected, and disposing one drops
// its output connections on the spot, even while it still carries a tail: the feedback loop of a delay, the resonators behind a
// modal drum's 5 ms exciter. Which collection runs when depends on allocation and memory pressure, so a graph that lets go of nodes
// it still needs renders differently from one run to the next. An offline render therefore holds every node it builds (see
// buildSong's `retain`), and lets go of a note's nodes only once the note is long over.

/** Context methods that make something other than a node (a buffer is held by whatever plays it). */
const NOT_NODES = new Set(['createBuffer', 'createPeriodicWave']);

/**
 * Start recording every node `ctx` creates, until `stop()` returns them. Recordings do not nest on one context.
 * @param {BaseAudioContext} ctx
 * @returns {{ stop: () => AudioNode[] }}
 */
export function recordNodes(ctx) {
  /** @type {AudioNode[]} */
  const nodes = [];
  /** @type {string[]} */
  const wrapped = [];
  const target = /** @type {any} */ (ctx);
  for (const key of allKeys(target)) {
    if (!key.startsWith('create') || NOT_NODES.has(key) || typeof target[key] !== 'function') continue;
    const original = target[key];
    target[key] = (/** @type {any[]} */ ...args) => {
      const made = original.apply(target, args);
      nodes.push(made);
      return made;
    };
    wrapped.push(key);
  }
  return {
    stop() {
      // The wrapper is an own property shadowing the prototype's method: removing it restores the original.
      for (const key of wrapped) delete target[key];
      return nodes;
    },
  };
}

/** @param {object} o */
function allKeys(o) {
  const keys = new Set();
  for (let p = o; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) for (const k of Object.getOwnPropertyNames(p)) keys.add(k);
  return keys;
}
