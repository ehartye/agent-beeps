// Pitch helpers shared by the engine, the CLI and the audition page. Browser-safe: no Node APIs.

/** Semitone offsets of each supported scale, from its root. */
export const SCALES = /** @type {const} */ ({
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
});

const LETTERS = /** @type {Record<string, number>} */ ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 });
const NOTE = /^([A-G])(#|b)?(-?\d)$/;

/** @param {number} hz */
export const hzToMidi = hz => 69 + 12 * Math.log2(hz / 440);
/** @param {number} midi */
export const midiToHz = midi => 440 * 2 ** ((midi - 69) / 12);

/** @param {string} name root name such as "C", "F#" or "Bb" */
export function pitchClass(name) {
  const m = /^([A-G])(#|b)?$/.exec(name);
  if (!m) throw new Error(`Unknown scale root "${name}"`);
  return (LETTERS[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
}

/**
 * Note name ("E6", "Bb3") or frequency in Hz to Hz.
 * @param {string | number} note
 */
export function noteToHz(note) {
  if (typeof note === 'number') return note;
  const m = NOTE.exec(note);
  if (!m) throw new Error(`Unknown note "${note}" (expected a name like E6 or Bb3, or a number in Hz)`);
  const semitone = LETTERS[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return midiToHz(12 * (Number(m[3]) + 1) + semitone);
}

/**
 * Nearest pitch whose pitch class is in the scale, so overlapping sounds share a key.
 * @param {number} hz
 * @param {{ root: string, mode: keyof typeof SCALES }} scale
 */
export function snapToScale(hz, scale) {
  const steps = SCALES[scale.mode];
  if (!steps) throw new Error(`Unknown scale mode "${scale.mode}"`);
  const root = pitchClass(scale.root);
  const allowed = new Set(steps.map(s => (s + root) % 12));
  const midi = hzToMidi(hz);
  const base = Math.round(midi);
  let best = base, bestDist = Infinity;
  for (let d = -6; d <= 6; d++) {
    const m = base + d;
    if (!allowed.has(((m % 12) + 12) % 12)) continue;
    const dist = Math.abs(m - midi);
    if (dist < bestDist) { best = m; bestDist = dist; }
  }
  return midiToHz(best);
}
