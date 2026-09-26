// Songs: compiled note events played through instrument patches, per-track buses (level, lowpass,
// pan, sends) and one master reverb and tempo-synced delay. Browser-safe, like the rest of the engine.
import { buildLayer } from './layer.js';
import { buildReverb, delayTail, REVERB_PRESETS } from './fx.js';
import { patchLength } from './patch.js';
import { compileSong } from './sequence.js';
import { hzToMidi, noteToHz } from './notes.js';

/** @typedef {import('../../src/schema/patch.ts').Patch} Patch */
/** @typedef {import('../../src/schema/song.ts').Song} Song */

const db = (/** @type {number} */ x) => 10 ** (x / 20);
const GLIDE = 0.05; // seconds: an unramped mix change still glides, so it never clicks
const SEED_POOL = 8; // distinct noise/grain seeds per track: enough variety, bounded buffers

/** MIDI note of the first pitched layer as written, or null for unpitched instruments. @param {Patch} p */
export function instrumentRoot(p) {
  for (const l of p.layers) {
    const src = /** @type {any} */ (l.source);
    if ('pitch' in src) return hzToMidi(noteToHz(src.pitch));
  }
  return null;
}

/**
 * A copy of the patch shifted by `semitones`: sources and pitch envelopes move exactly; filter
 * cutoffs move by `keytrack` of the shift. `duration` (seconds) replaces the note-off time.
 * @param {Patch} p
 * @param {number} semitones
 * @param {number} keytrack
 * @param {number | null} duration
 * @returns {Patch}
 */
export function transposePatch(p, semitones, keytrack, duration) {
  const ratio = 2 ** (semitones / 12);
  const fRatio = ratio ** keytrack;
  /** @type {Patch} */
  const out = structuredClone(p);
  if (duration !== null) out.duration = Math.max(0.01, duration);
  if (!semitones) return out;
  for (const l of out.layers) {
    const src = /** @type {any} */ (l.source);
    if ('pitch' in src) src.pitch = noteToHz(src.pitch) * ratio;
    if (l.pitchEnv) for (const pt of l.pitchEnv) pt.to = noteToHz(pt.to) * ratio;
    if (l.filter && keytrack) {
      l.filter.cutoff = Math.min(22000, l.filter.cutoff * fRatio);
      if (l.filter.env) l.filter.env.to = Math.min(22000, l.filter.env.to * fRatio);
    }
  }
  return out;
}

/**
 * Seconds a song keeps sounding after its form ends: the longest instrument ring plus effect tails.
 * @param {Song} song
 * @param {Record<string, Patch>} instruments by track name
 */
export function songTail(song, instruments) {
  let ring = 0;
  for (const p of Object.values(instruments)) {
    const release = Math.max(...p.layers.map(l => l.amp.release));
    ring = Math.max(ring, release, patchLength({ ...p, duration: Math.min(p.duration, 0.01) }));
  }
  let fx = 0;
  const r = song.master.reverb;
  if (r) fx = Math.max(fx, REVERB_PRESETS[r.preset].decay + REVERB_PRESETS[r.preset].preDelay);
  const d = song.master.delay;
  if (d) fx = Math.max(fx, delayTail({ time: d.beats * 60 / song.bpm, feedback: d.feedback }));
  return ring + fx + 0.1;
}

/**
 * @param {BaseAudioContext} ctx
 * @param {Song} song
 * @param {Record<string, Patch>} instruments  parsed instrument patch per track
 * @param {{ destination?: AudioNode, when?: number, lazy?: boolean }} [opts]
 *   lazy: build no notes yet; call `advance(t)` to build every note starting before context time t.
 *   Notes built just ahead of the playhead keep the graph small (offline renders run several
 *   times faster, and live playback never holds a whole song's nodes).
 * @returns {{ end: number, length: number, sections: ReturnType<typeof compileSong>['sections'], advance: (t: number) => number, done: () => boolean }}
 */
export function buildSong(ctx, song, instruments, opts = {}) {
  const { destination = ctx.destination, when = 0, lazy = false } = opts;
  const c = compileSong(song);
  const master = ctx.createGain();
  master.connect(destination);

  /** @type {GainNode | undefined} */
  let reverbIn;
  if (song.master.reverb) {
    reverbIn = ctx.createGain();
    const ret = ctx.createGain();
    ret.gain.value = db(song.master.reverb.returnDb);
    reverbIn.connect(buildReverb(ctx, song.master.reverb.preset)).connect(ret).connect(master);
  }
  /** @type {GainNode | undefined} */
  let delayIn;
  if (song.master.delay) {
    const d = song.master.delay;
    delayIn = ctx.createGain();
    const line = ctx.createDelay(4);
    line.delayTime.value = d.beats * c.spb;
    // Darkening each repeat keeps echoes behind the dry sound instead of stacking up bright.
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = d.cutoff;
    const fb = ctx.createGain();
    fb.gain.value = d.feedback;
    const ret = ctx.createGain();
    ret.gain.value = db(d.returnDb);
    delayIn.connect(line).connect(tone).connect(fb).connect(line);
    tone.connect(ret).connect(master);
    if (reverbIn) ret.connect(reverbIn);
  }

  /** @type {Record<string, { input: GainNode, root: number | null }>} */
  const buses = {};
  for (const [name, t] of Object.entries(song.tracks)) {
    const p = instruments[name];
    if (!p) throw new Error(`track "${name}" has no instrument patch`);
    const input = ctx.createGain();
    /** @type {AudioNode} */
    let node = input;
    // The instrument's own effects run once per track, not once per note.
    if (p.fx?.reverb) {
      const send = ctx.createGain();
      send.gain.value = db(p.fx.reverb.sendDb);
      const wet = ctx.createGain();
      input.connect(send).connect(buildReverb(ctx, p.fx.reverb.preset)).connect(wet);
      const sum = ctx.createGain();
      input.connect(sum); wet.connect(sum);
      node = sum;
    }
    const points = c.mix[name] ?? [];
    if (t.cutoff !== undefined || points.some(m => m.cutoff !== undefined)) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0;
      let cut = t.cutoff ?? 20000;
      lp.frequency.setValueAtTime(cut, when);
      for (const m of points) {
        if (m.cutoff === undefined) continue;
        lp.frequency.setValueAtTime(cut, when + m.time);
        lp.frequency.exponentialRampToValueAtTime(m.cutoff, when + (m.ramp ? m.end : m.time + GLIDE));
        cut = m.cutoff;
      }
      node = node.connect(lp);
    }
    if (t.pan) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = t.pan;
      node = node.connect(pan);
    }
    const level = ctx.createGain();
    let g = t.gainDb;
    level.gain.setValueAtTime(db(g), when);
    for (const m of points) {
      if (m.gainDb === undefined) continue;
      level.gain.setValueAtTime(db(g), when + m.time);
      level.gain.linearRampToValueAtTime(db(m.gainDb), when + (m.ramp ? m.end : m.time + GLIDE));
      g = m.gainDb;
    }
    node.connect(level).connect(master);
    if (reverbIn && t.sends.reverb !== undefined) { const s = ctx.createGain(); s.gain.value = db(t.sends.reverb); level.connect(s).connect(reverbIn); }
    if (delayIn && t.sends.delay !== undefined) { const s = ctx.createGain(); s.gain.value = db(t.sends.delay); level.connect(s).connect(delayIn); }
    buses[name] = { input, root: t.root ? hzToMidi(noteToHz(t.root)) : instrumentRoot(p) };
  }

  /** @type {Map<string, Patch>} */
  const voices = new Map();
  let cursor = 0;
  /** Build every not-yet-built note that starts before context time `t`; returns how many. */
  const advance = (/** @type {number} */ t) => {
    const from = cursor;
    while (cursor < c.events.length && when + c.events[cursor].time < t) playEvent(c.events[cursor], cursor++);
    return cursor - from;
  };
  const playEvent = (/** @type {import('./sequence.js').NoteEvent} */ e, /** @type {number} */ i) => {
    const bus = buses[e.track];
    const t = song.tracks[e.track];
    const shift = e.midi !== null && bus.root !== null ? e.midi - bus.root : 0;
    const key = `${e.track}:${shift.toFixed(3)}:${e.dur ?? 'patch'}`;
    let p = voices.get(key);
    if (!p) { p = transposePatch(instruments[e.track], shift, t.keytrack, e.dur); voices.set(key, p); }
    const out = ctx.createGain();
    out.gain.value = e.vel;
    if (e.pan) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = e.pan;
      out.connect(pan).connect(bus.input);
    } else out.connect(bus.input);
    const at = when + e.time;
    const seed = song.seed * 101 + (i % SEED_POOL);
    p.layers.forEach((layer, li) => buildLayer(ctx, layer, { when: at, duration: /** @type {Patch} */ (p).duration, seed: seed + li * 7919, out }));
  };
  if (!lazy) advance(Infinity);
  return { end: when + c.length + songTail(song, instruments), length: c.length, sections: c.sections, advance, done: () => cursor >= c.events.length };
}
