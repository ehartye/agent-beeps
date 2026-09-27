// Chord symbols and voice leading. Browser-safe: the song compiler runs in the render page and in games.

const LETTERS = /** @type {Record<string, number>} */ ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 });

/** Chord qualities as semitone intervals from the root. Extensions above the octave stay above it. */
export const QUALITIES = /** @type {Record<string, number[]>} */ ({
  '': [0, 4, 7], maj: [0, 4, 7], m: [0, 3, 7], min: [0, 3, 7], '5': [0, 7],
  dim: [0, 3, 6], aug: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7], sus: [0, 5, 7],
  '6': [0, 4, 7, 9], m6: [0, 3, 7, 9], '6/9': [0, 4, 7, 9, 14], '69': [0, 4, 7, 9, 14], 'm6/9': [0, 3, 7, 9, 14],
  '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11], M7: [0, 4, 7, 11], m7: [0, 3, 7, 10], mmaj7: [0, 3, 7, 11],
  m7b5: [0, 3, 6, 10], dim7: [0, 3, 6, 9], '7sus4': [0, 5, 7, 10], '7sus2': [0, 2, 7, 10], '7b9': [0, 4, 7, 10, 13],
  add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14], add11: [0, 4, 7, 17], 'maj7#11': [0, 4, 7, 11, 18],
  '9': [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], '9sus4': [0, 5, 7, 10, 14],
  '11': [0, 4, 7, 10, 14, 17], m11: [0, 3, 7, 10, 14, 17], maj11: [0, 4, 7, 11, 14, 17],
  '13': [0, 4, 7, 10, 14, 21], m13: [0, 3, 7, 10, 14, 21], maj13: [0, 4, 7, 11, 14, 21],
});

/** @typedef {{ symbol: string, root: number, intervals: number[], bass?: number }} Chord */

/** @param {string} name "C", "F#", "Bb" */
const pc = name => (LETTERS[name[0]] + (name[1] === '#' ? 1 : name[1] === 'b' ? -1 : 0) + 12) % 12;

/**
 * "Dm9", "Bbmaj7", "C6/9", "C/E" → root pitch class, intervals, optional slash-bass pitch class.
 * @param {string} symbol
 * @returns {Chord}
 */
export function parseChord(symbol) {
  const m = /^([A-G](?:#|b)?)(.*)$/.exec(symbol.trim());
  if (!m) throw new Error(`Unknown chord "${symbol}": a chord starts with a root A-G, e.g. Dm9 or Bbmaj7`);
  let rest = m[2];
  /** @type {number | undefined} */
  let bass;
  const slash = /\/([A-G](?:#|b)?)$/.exec(rest);
  if (slash && !(rest in QUALITIES)) { bass = pc(slash[1]); rest = rest.slice(0, -slash[0].length); }
  const intervals = QUALITIES[rest];
  if (!intervals) throw new Error(`Unknown chord quality "${rest}" in "${symbol}" (known: ${Object.keys(QUALITIES).filter(Boolean).join(', ')})`);
  return { symbol, root: pc(m[1]), intervals: [...intervals], ...(bass !== undefined ? { bass } : {}) };
}

/** Pitch classes of the chord in interval order (root first), without duplicates. @param {Chord} c */
export function chordTones(c) {
  const out = /** @type {number[]} */ ([]);
  for (const i of c.intervals) { const p = (c.root + i) % 12; if (!out.includes(p)) out.push(p); }
  return out;
}

/** Close-position voicings of the pitch classes, every inversion, lowest note in [lo, hi]. */
function candidates(/** @type {number[]} */ pcs, /** @type {number} */ lo, /** @type {number} */ hi) {
  const out = /** @type {number[][]} */ ([]);
  for (let inv = 0; inv < pcs.length; inv++) {
    const order = [...pcs.slice(inv), ...pcs.slice(0, inv)];
    for (let base = lo; base <= hi; base++) {
      if (((base % 12) + 12) % 12 !== order[0]) continue;
      const v = [base];
      for (const p of order.slice(1)) {
        let n = v[v.length - 1] + 1;
        while (((n % 12) + 12) % 12 !== p) n++;
        v.push(n);
      }
      out.push(v);
    }
  }
  return out;
}

/** Symmetric nearest-note distance between two voicings. */
function distance(/** @type {number[]} */ a, /** @type {number[]} */ b) {
  const near = (/** @type {number} */ n, /** @type {number[]} */ xs) => Math.min(...xs.map(x => Math.abs(x - n)));
  return a.reduce((s, n) => s + near(n, b), 0) + b.reduce((s, n) => s + near(n, a), 0);
}

/**
 * MIDI voicings for a progression, each moving as little as possible from the last.
 * `octave` 4 puts the first chord's root at C4-B4 (MIDI 60-71). `spread` puts the root an octave
 * below and voice-leads the rest above it; `close` restarts root position every chord.
 * @param {Chord[]} chords
 * `drop2` lowers the second-highest voice of each voice-led chord an octave; `open` raises every
 * other voice (from the second lowest) an octave, for wide, airy chords.
 * @param {{ octave?: number, voicing?: 'lead' | 'spread' | 'close' | 'drop2' | 'open', slash?: boolean }} [opts]
 * @returns {number[][]}
 */
export function voiceLead(chords, { octave = 4, voicing = 'lead', slash = true } = {}) {
  const c0 = 12 * (octave + 1);
  /** @type {number[] | null} */
  let prev = null;
  return chords.map(ch => {
    const tones = chordTones(ch);
    let upper = voicing === 'spread' && tones.length > 2 ? tones.slice(1) : tones;
    const lo = c0 - 7, hi = c0 + 7;
    let pick;
    if (voicing === 'close' || !prev) {
      const root = upper[0];
      pick = candidates(upper, c0, c0 + 11).find(v => ((v[0] % 12) + 12) % 12 === root) ?? candidates(upper, lo, hi)[0];
    } else {
      const center = c0 + 6;
      let best = Infinity;
      for (const v of candidates(upper, lo, hi)) {
        if (v[v.length - 1] > c0 + 24) continue;
        const mean = v.reduce((a, b) => a + b, 0) / v.length;
        const cost = distance(prev, v) + 0.25 * Math.abs(mean - center);
        if (cost < best) { best = cost; pick = v; }
      }
    }
    pick = /** @type {number[]} */ (pick);
    prev = pick;
    let notes = [...pick];
    if (voicing === 'drop2' && notes.length >= 3) notes[notes.length - 2] -= 12;
    if (voicing === 'open' && notes.length >= 3) notes = notes.map((n, i) => (i % 2 === 1 ? n + 12 : n));
    notes.sort((a, b) => a - b);
    if (voicing === 'spread' && tones.length > 2) notes.unshift(12 * octave + ch.root);
    if (ch.bass !== undefined && slash) {
      let b = 12 * octave + ch.bass;
      while (b >= notes[0]) b -= 12;
      notes.unshift(b);
    }
    return notes;
  });
}
