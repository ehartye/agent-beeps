// Song compiler: sections, patterns and progressions → a flat, timed list of note events plus mix
// automation. Pure and browser-safe, so games can schedule the same events a render measured.
import { parseChord, voiceLead, chordTones } from './chords.js';
import { hzToMidi, noteToHz } from './notes.js';
import { mulberry32 } from './rng.js';

/** @typedef {import('../../src/schema/song.ts').Song} Song */
/** @typedef {import('../../src/schema/song.ts').SongPattern} SongPattern */
/**
 * @typedef {object} NoteEvent
 * @property {string} track
 * @property {number} time   seconds from song start
 * @property {number | null} dur   seconds held (null: the instrument's own duration)
 * @property {number | null} midi  null: play the instrument at its written pitch
 * @property {number} vel    0..1
 * @property {number} pan    -1..1 offset added to the track pan
 * @property {string} pattern  the pattern that played it
 */
/** @typedef {{ time: number, end: number, gainDb?: number, cutoff?: number, ramp: boolean }} MixPoint */

const STEP_VEL = /** @type {Record<string, number>} */ ({ X: 1, x: 0.7, o: 0.4 });
const EPS = 1e-9;
export const GATE_DEFAULTS = { notes: 1, chords: 1, arp: 0.9, bass: 0.95, steps: 'patch' };

/** @param {string} note */
export const noteToMidi = note => Math.round(hzToMidi(noteToHz(note)));

/**
 * Hits of a step string: start step, length in steps (with _ holds), velocity.
 * @param {string} steps
 * @returns {{ steps: number, hits: { at: number, len: number, vel: number }[] }}
 */
export function parseSteps(steps) {
  const s = steps.replace(/[\s|]/g, '');
  /** @type {{ at: number, len: number, vel: number }[]} */
  const hits = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch in STEP_VEL) hits.push({ at: i, len: 1, vel: STEP_VEL[ch] });
    else if (ch === '_' && hits.length && hits[hits.length - 1].at + hits[hits.length - 1].len === i) hits[hits.length - 1].len++;
  }
  return { steps: s.length, hits };
}

/**
 * The chords of a progression laid end to end, cycled to fill `beats`.
 * @param {[string, number][]} prog
 * @param {number} beats
 */
function chordSpans(prog, beats) {
  /** @type {{ start: number, len: number, chord: import('./chords.js').Chord }[]} */
  const spans = [];
  const parsed = prog.map(([sym, len]) => ({ chord: parseChord(sym), len }));
  let t = 0;
  for (let i = 0; t < beats - EPS; i = (i + 1) % parsed.length) {
    const len = Math.min(parsed[i].len, beats - t);
    spans.push({ start: t, len, chord: parsed[i].chord });
    t += parsed[i].len;
  }
  return spans;
}

/** Arp orderings of a sorted note list. @param {number[]} notes @param {string} shape @param {() => number} rand */
function arpOrder(notes, shape, rand) {
  if (shape === 'down') return [...notes].reverse();
  if (shape === 'updown') return notes.length > 2 ? [...notes, ...notes.slice(1, -1).reverse()] : notes;
  if (shape === 'converge') {
    const out = [];
    for (let lo = 0, hi = notes.length - 1; lo <= hi; lo++, hi--) { out.push(notes[lo]); if (hi !== lo) out.push(notes[hi]); }
    return out;
  }
  if (shape === 'random') return notes.map(n => [rand(), n]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  return notes;
}

/**
 * Events of one pattern pass, in beats from the pattern's start (dur in beats, or null).
 * @param {Song} song
 * @param {SongPattern} p
 * @param {() => number} rand
 * @returns {{ beat: number, len: number, dur: number | null, midi: number | null, vel: number, voice?: number, voices?: number, strum?: number }[]}
 */
export function patternEvents(song, p, rand) {
  const beats = p.bars * song.meter;
  const kind = /** @type {'notes'|'chords'|'arp'|'bass'|'steps'} */ (['notes', 'chords', 'arp', 'bass', 'steps'].find(k => /** @type {any} */ (p)[k] !== undefined));
  const gate = p.gate ?? GATE_DEFAULTS[kind];
  const hold = (/** @type {number} */ len) => (gate === 'patch' ? null : len * /** @type {number} */ (gate));
  /** @type {ReturnType<typeof patternEvents>} */
  const out = [];
  const tr = p.transpose;
  const push = (/** @type {number} */ beat, /** @type {number} */ len, /** @type {number | null} */ midi, /** @type {number} */ vel, extra = {}) => {
    if (beat < beats - EPS) out.push({ beat, len, dur: hold(len), midi: midi === null ? null : midi + tr, vel: vel * p.vel, ...extra });
  };

  if (kind === 'notes') {
    for (const [beat, note, len, vel] of /** @type {any[]} */ (p.notes)) push(beat, len, noteToMidi(note), vel ?? 1);
  } else if (kind === 'steps') {
    const { steps, hits } = parseSteps(/** @type {string} */ (p.steps));
    const step = 1 / p.stepsPerBeat;
    const midi = p.note ? noteToMidi(p.note) : null;
    for (let base = 0; base < beats - EPS; base += steps * step) {
      for (const h of hits) push(base + h.at * step, h.len * step, midi, h.vel);
    }
  } else {
    const spec = /** @type {any} */ (p)[kind];
    const spans = chordSpans(song.progressions[spec.progression], beats);
    if (kind === 'chords') {
      const voicings = voiceLead(spans.map(s => s.chord), { octave: spec.octave, voicing: spec.voicing });
      spans.forEach((s, i) => {
        const v = voicings[i];
        const strike = (/** @type {number} */ at, /** @type {number} */ len, /** @type {number} */ vel) =>
          v.forEach((midi, voice) => push(s.start + at, len, midi, vel, { voice, voices: v.length, strum: voice * spec.strum }));
        if (!spec.rhythm) { strike(0, s.len, 1); return; }
        const { steps, hits } = parseSteps(spec.rhythm);
        const step = 1 / p.stepsPerBeat;
        for (let base = 0; base < s.len - EPS; base += steps * step) {
          for (const h of hits) if (base + h.at * step < s.len - EPS) strike(base + h.at * step, Math.min(h.len * step, s.len - base - h.at * step), h.vel);
        }
      });
    } else if (kind === 'arp') {
      const voicings = voiceLead(spans.map(s => s.chord), { octave: spec.octave, voicing: 'lead' });
      const step = 1 / spec.rate;
      const mask = spec.rhythm ? parseSteps(spec.rhythm) : null;
      let n = 0;
      spans.forEach((s, i) => {
        const base = [...voicings[i]].sort((a, b) => a - b);
        const notes = [];
        for (let o = 0; o < spec.octaves; o++) for (const m of base) notes.push(m + 12 * o);
        const order = arpOrder(notes, spec.shape, rand);
        for (let k = 0; k * step < s.len - EPS; k++, n++) {
          const hit = mask ? mask.hits.find(h => h.at === n % mask.steps) : { vel: 1 };
          if (hit) push(s.start + k * step, step, order[k % order.length], hit.vel);
        }
      });
    } else {
      const step = 1 / p.stepsPerBeat;
      spans.forEach(s => {
        const tones = chordTones(s.chord);
        const rootMidi = 12 * (spec.octave + 1) + s.chord.root;
        const toneMidi = (/** @type {number} */ k) => {
          if (k === 0 && s.chord.bass !== undefined) return 12 * (spec.octave + 1) + s.chord.bass;
          const interval = s.chord.intervals[k % s.chord.intervals.length] % 12;
          return rootMidi + (k < tones.length ? interval : 0);
        };
        if (!spec.rhythm) { push(s.start, s.len, toneMidi(spec.tones[0]), 1); return; }
        const { steps, hits } = parseSteps(spec.rhythm);
        let n = 0;
        for (let base = 0; base < s.len - EPS; base += steps * step) {
          for (const h of hits) {
            const at = base + h.at * step;
            if (at < s.len - EPS) push(s.start + at, Math.min(h.len * step, s.len - at), toneMidi(spec.tones[n++ % spec.tones.length]), h.vel);
          }
        }
      });
    }
  }
  return out;
}

/**
 * @param {Song} song
 * @returns {{ spb: number, length: number, sections: { name: string, start: number, end: number, bars: number }[], events: NoteEvent[], mix: Record<string, MixPoint[]> }}
 */
export function compileSong(song) {
  const spb = 60 / song.bpm;
  const sixteenth = spb / 4;
  /** @type {NoteEvent[]} */
  const events = [];
  /** @type {Record<string, MixPoint[]>} */
  const mix = {};
  const sections = [];
  const rand = mulberry32(song.seed * 2654435761);
  let beat = 0;
  for (const name of song.form) {
    const sec = song.sections[name];
    const len = sec.bars * song.meter;
    const start = beat * spb, end = (beat + len) * spb;
    sections.push({ name, start, end, bars: sec.bars });
    for (const [track, ref] of Object.entries(sec.play)) {
      if (ref === null) continue;
      const list = Array.isArray(ref) ? ref : [ref];
      const t = song.tracks[track];
      for (let pos = 0, i = 0; pos < len - EPS; i++) {
        const pname = list[i % list.length];
        const p = song.patterns[pname];
        for (const e of patternEvents(song, p, rand)) {
          const at = pos + e.beat;
          if (at >= len - EPS) continue;
          const room = len - at;
          let time = (beat + at) * spb;
          if (song.swing && Math.abs(at * 4 - Math.round(at * 4)) < 1e-6 && Math.round(at * 4) % 2 === 1) time += song.swing * sixteenth;
          time += e.strum ?? 0;
          const pan = e.voices && e.voices > 1 ? t.spread * ((2 * /** @type {number} */ (e.voice)) / (e.voices - 1) - 1) : 0;
          events.push({ track, time, dur: e.dur === null ? null : Math.min(e.dur, room) * spb, midi: e.midi, vel: e.vel, pan, pattern: pname });
        }
        pos += p.bars * song.meter;
      }
    }
    for (const [track, m] of Object.entries(sec.mix ?? {})) {
      (mix[track] ??= []).push({ time: start, end, ...m, ramp: sec.ramp });
    }
    beat += len;
  }
  // Humanize per track from its own seeded stream, so editing one track never shifts another.
  const streams = new Map();
  for (const e of events) {
    const h = song.tracks[e.track].humanize;
    if (!h) continue;
    if (!streams.has(e.track)) streams.set(e.track, mulberry32((song.seed * 7919 + [...e.track].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) >>> 0));
    const r = streams.get(e.track);
    e.time = Math.max(0, e.time + (r() * 2 - 1) * 0.012 * h);
    e.vel = Math.max(0, Math.min(1, e.vel * (1 + (r() * 2 - 1) * 0.2 * h)));
  }
  events.sort((a, b) => a.time - b.time);
  return { spb, length: beat * spb, sections, events, mix };
}
