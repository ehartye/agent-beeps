// runtime/player/voices.js
// Which sound effects may sound: a voice budget, strict-priority stealing, a cooldown and an
// instance cap per sound. Priority 1 is the most important (FMOD convention, as in meta.priority).
// Pure bookkeeping on a caller-supplied clock; the player does the audio.

/**
 * @typedef {{ key: number, id: string, priority: number, startedAt: number }} Voice
 * @typedef {{ priority: number, cooldownSec: number, cap: number }} VoiceRequest
 */

/** @param {Voice[]} voices */
const oldest = voices => voices.reduce((a, b) => (b.startedAt < a.startedAt || (b.startedAt === a.startedAt && b.key < a.key) ? b : a));

/** @param {{ budget?: number }} [opts] */
export function createVoiceManager({ budget = 8 } = {}) {
  /** @type {Voice[]} */
  let active = [];
  /** @type {Map<string, number>} */
  const lastStart = new Map();
  let nextKey = 1;
  return {
    /**
     * Ask to start sound `id` at time `now` (seconds). Null means drop it; `steal` names a voice
     * the caller must stop first.
     * @param {string} id
     * @param {VoiceRequest} req
     * @param {number} now
     * @returns {{ key: number, steal: number | null } | null}
     */
    request(id, { priority, cooldownSec, cap }, now) {
      const last = lastStart.get(id);
      // now < last means the clock went backwards (e.g. a recreated AudioContext, whose currentTime
      // restarts at 0): treat the cooldown as elapsed rather than blocking on a stale future time.
      if (last !== undefined && now >= last && now - last < cooldownSec) return null;
      /** @type {Voice | null} */
      let steal = null;
      const same = active.filter(v => v.id === id);
      // A missing or NaN cap is the floor (1), never unlimited: Math.max(1, NaN) would be NaN,
      // and `same.length >= NaN` is always false.
      const effectiveCap = Math.max(1, Number.isFinite(cap) ? cap : 1);
      if (same.length >= effectiveCap) steal = oldest(same);
      else if (active.length >= budget) {
        const lessImportant = active.filter(v => v.priority > priority);
        if (!lessImportant.length) return null;
        steal = oldest(lessImportant);
      }
      if (steal) active = active.filter(v => v !== steal);
      const voice = { key: nextKey++, id, priority, startedAt: now };
      active.push(voice);
      lastStart.set(id, now);
      return { key: voice.key, steal: steal ? steal.key : null };
    },
    /** @param {number} key */
    release(key) { active = active.filter(v => v.key !== key); },
    /** @param {number} key */
    has(key) { return active.some(v => v.key === key); },
    clear() { active = []; lastStart.clear(); },
    get size() { return active.length; },
  };
}
