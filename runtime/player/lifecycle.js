// runtime/player/lifecycle.js
// Resume and suspend strictly in order: rapid hide/show or off/on can never leave the context
// suspended behind a stale request.

/**
 * @param {{ resume(): Promise<void>, suspend(): Promise<void> }} ctx
 * @param {{ enabled?: boolean, hidden?: boolean }} [initial]
 */
export function createLifecycle(ctx, { enabled = true, hidden = false } = {}) {
  const state = { enabled, hidden };
  /** @type {Promise<void>} */
  let chain = Promise.resolve();
  const reconcile = () => {
    // Snapshot the desired state now: the callback below runs later, on a queued microtask, by
    // which time a rapid second call may already have mutated `state` again.
    const running = state.enabled && !state.hidden;
    chain = chain.catch(() => {}).then(() => (running ? ctx.resume() : ctx.suspend()));
    return chain;
  };
  return {
    get running() { return state.enabled && !state.hidden; },
    /** @param {boolean} value */
    setEnabled(value) { state.enabled = !!value; return reconcile(); },
    /** @param {boolean} value */
    setHidden(value) { state.hidden = !!value; return reconcile(); },
    /** Enable without resuming: the next reconcile (an unlock, on a user gesture) resumes. */
    allow() { state.enabled = true; },
    reconcile,
  };
}
