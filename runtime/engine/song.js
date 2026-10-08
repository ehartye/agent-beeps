// Songs: compiled note events played through instrument patches, per-track buses (level, lowpass,
// pan, sends) and one master reverb and tempo-synced delay. Browser-safe, like the rest of the engine.
import { buildLayer } from './layer.js';
import { buildReverb, delayTail, REVERB_PRESETS } from './fx.js';
import { patchLength } from './patch.js';
import { compileSong } from './sequence.js';
import { hzToMidi, noteToHz } from './notes.js';
import { sumInto, voicePool } from './sum.js';
import { recordNodes } from './retain.js';

/** @typedef {import('../../src/schema/patch.ts').Patch} Patch */
/** @typedef {import('../../src/schema/song.ts').Song} Song */

const db = (/** @type {number} */ x) => 10 ** (x / 20);
const GLIDE = 0.05; // seconds: an unramped mix change still glides, so it never clicks
/** Seconds a finished note stays referenced (retain): its amp is at zero, this outlasts any filter ring. */
const RELEASE_AFTER = 1;
const SEED_POOL = 8; // distinct noise/grain seeds per track: enough variety, bounded buffers

/**
 * Pin a long-lived input to a fixed channel count. Left to 'max', its count follows whichever connections are
 * live: mono notes alone make it 1, a panned or spread note makes it 2, and it flips as notes start and finish
 * (and as the lazily built graph is edited between render windows, when a finished note's node may or may not
 * have been collected yet). The render then showed a burst up to 0.08 of full scale at the quantum of a flip, decaying
 * over the bus filter's ring and not at the same quantum from one run to the next; pinning the count removes it. That
 * fits Chromium re-creating the processor behind a node when its input channel count changes, which zeroes a filter's
 * state. A stereo panner also changes its law with the count (equal-power for mono, balance for stereo), so a flip
 * moves the level too.
 * 'speakers' upmixes mono to both sides, exactly as the stereo destination does.
 * @template {AudioNode} N @param {N} node @param {1 | 2} channels @returns {N}
 */
const pinned = (node, channels) => {
  node.channelCount = channels;
  node.channelCountMode = 'explicit';
  node.channelInterpretation = 'speakers';
  return node;
};

/** Whether any layer of the patch makes a stereo signal by itself: a layer pan, or a noise or grains source with `stereo`. @param {Patch} p */
export function patchIsStereo(p) {
  return p.layers.some(l => {
    const src = /** @type {any} */ (l.source);
    return (l.pan !== undefined && l.pan !== 0) || src.stereo === true || (typeof src.stereo === 'number' && src.stereo > 0);
  });
}

/** MIDI note of the first pitched layer as written, or null for unpitched instruments. @param {Patch} p */
export function instrumentRoot(p) {
  for (const l of p.layers) {
    const src = /** @type {any} */ (l.source);
    if ('pitch' in src) return hzToMidi(noteToHz(src.pitch));
  }
  return null;
}

/**
 * Where an instrument's pitched layers sit relative to its root, in semitones: a pad with a sine an
 * octave under its main layer spans { low: -12, high: 0 }. Unpitched instruments return null.
 * @param {Patch} p
 * @returns {{ root: number, low: number, high: number } | null}
 */
export function instrumentSpan(p) {
  const root = instrumentRoot(p);
  if (root === null) return null;
  let low = 0, high = 0;
  for (const l of p.layers) {
    const src = /** @type {any} */ (l.source);
    if (!('pitch' in src)) continue;
    const off = hzToMidi(noteToHz(src.pitch)) - root;
    low = Math.min(low, off); high = Math.max(high, off);
  }
  return { root, low: Math.round(low * 100) / 100, high: Math.round(high * 100) / 100 };
}

/**
 * How a track retunes its instrument: the semitone shift for a written note (null: an unpitched
 * note), from the instrument's own pitch. A note plays the instrument's pitched layers at the
 * written note when `root` is unset (shift = note - root of the patch), `root` names the note the
 * patch sounds at as written, `fixed` ignores the written note, and `transpose` adds semitones.
 * @param {{ root?: string, fixed?: boolean, transpose?: number }} t
 * @param {Patch} p
 * @returns {((midi: number | null) => number) | null}  null for an instrument with no pitched layer
 */
export function trackShift(t, p) {
  const inst = instrumentRoot(p);
  if (inst === null) return null;
  const ref = t.root ? hzToMidi(noteToHz(t.root)) : inst;
  const tr = t.transpose ?? 0;
  return midi => (midi === null ? 0 : t.fixed ? 0 : midi - ref) + tr;
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
    // A gate:'patch' event can begin just before the form ends and play its full duration.
    ring = Math.max(ring, release, patchLength(p));
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
 * @param {{ destination?: AudioNode, when?: number, lazy?: boolean, only?: string[], retain?: boolean }} [opts]
 *   only: play just these tracks' notes out of the full song. Every chance roll, arp order and
 *   noise seed is still drawn as in the full song, so solos of the parts sum back to the mix.
 *   lazy: build no notes yet; call `advance(t)` to build every note starting before context time t.
 *   Notes built just ahead of the playhead keep the graph small (offline renders run several
 *   times faster, and live playback never holds a whole song's nodes).
 *   retain: keep every node referenced from here (the song's own graph for good, a note's until `release(now)`
 *   finds it over). Chromium disposes a node whose JS wrapper is collected and drops its output connections on
 *   the spot, even while it carries a tail: a collection cut a master delay's feedback loop, and the body of a
 *   modal drum hit whose 5 ms exciter had finished, at moments that changed from run to run (see retain.js).
 *   Offline renders retain; live playback need not.
 * @returns {{ end: number, length: number, sections: ReturnType<typeof compileSong>['sections'], advance: (t: number) => number, release: (now: number) => number, graph: AudioNode[] | undefined, done: () => boolean }}
 */
export function buildSong(ctx, song, instruments, opts = {}) {
  const { destination = ctx.destination, when = 0, lazy = false, only, retain = false } = opts;
  const playing = only ? new Set(only) : undefined;
  const c = compileSong(song);
  const setup = retain ? recordNodes(ctx) : undefined;
  const master = ctx.createGain();
  master.connect(destination);
  // Every many-to-one meeting point is summed in a fixed order (see sum.js), or renders are not bit-exact.
  /** @type {AudioNode[]} */
  const toMaster = [];
  /** @type {AudioNode[]} */
  const toReverb = [];
  /** @type {AudioNode[]} */
  const toDelay = [];

  /** @type {GainNode | undefined} */
  let reverbIn;
  if (song.master.reverb) {
    reverbIn = pinned(ctx.createGain(), 2);
    const ret = ctx.createGain();
    ret.gain.value = db(song.master.reverb.returnDb);
    toMaster.push(reverbIn.connect(buildReverb(ctx, song.master.reverb.preset)).connect(ret));
  }
  /** @type {GainNode | undefined} */
  let delayIn;
  if (song.master.delay) {
    const d = song.master.delay;
    delayIn = pinned(ctx.createGain(), 2);
    const line = ctx.createDelay(d.beats * c.spb);
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
    tone.connect(ret);
    toMaster.push(ret);
    if (reverbIn) toReverb.push(ret);
  }

  // A track's bus is as wide as the widest note it can play, for the whole song, whichever notes happen to be live
  // (and in a solo render too, so a stem sums back to the mix): stereo when a note is spread or its patch is stereo.
  const spread = new Set(c.events.filter(e => e.pan).map(e => e.track));
  /** @type {Record<string, { input: GainNode, pool: ReturnType<typeof voicePool>, shift: ReturnType<typeof trackShift> }>} */
  const buses = {};
  for (const [name, t] of Object.entries(song.tracks)) {
    const p = instruments[name];
    if (!p) throw new Error(`track "${name}" has no instrument patch`);
    const input = pinned(ctx.createGain(), spread.has(name) || patchIsStereo(p) ? 2 : 1);
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
    /**
     * One automated value per mix point: from the current value (or the point's `from`) to the new
     * one, gliding across the ramp or over a short glide. Frequencies glide exponentially.
     */
    const automate = (/** @type {AudioParam} */ param, /** @type {number} */ initial, /** @type {(m: any) => number | undefined} */ pick, exp = false) => {
      let v = initial;
      param.setValueAtTime(v, when);
      for (const m of points) {
        const next = pick(m);
        if (next === undefined) continue;
        const from = m.from ? pick(m.from) : undefined;
        param.setValueAtTime(from ?? v, when + m.time);
        const at = when + (m.ramp ? m.end : m.time + GLIDE);
        if (exp) param.exponentialRampToValueAtTime(next, at); else param.linearRampToValueAtTime(next, at);
        v = next;
      }
    };
    if (t.highpass !== undefined) {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = t.highpass;
      hp.Q.value = 0;
      node = node.connect(hp);
    }
    if (t.cutoff !== undefined || points.some(m => m.cutoff !== undefined)) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0;
      automate(lp.frequency, t.cutoff ?? 20000, m => m.cutoff, true);
      node = node.connect(lp);
    }
    if (t.pan || points.some(m => m.pan !== undefined)) {
      const pan = ctx.createStereoPanner();
      automate(pan.pan, t.pan, m => m.pan);
      node = node.connect(pan);
    }
    const level = ctx.createGain();
    automate(level.gain, db(t.gainDb), m => (m.gainDb === undefined ? undefined : db(m.gainDb)));
    toMaster.push(node.connect(level));
    for (const [kind, input] of /** @type {const} */ ([['reverb', reverbIn], ['delay', delayIn]])) {
      const base = t.sends[kind];
      if (!input || (base === undefined && !points.some(m => m.sends?.[kind] !== undefined))) continue;
      const send = ctx.createGain();
      automate(send.gain, base === undefined ? 0 : db(base), m => (m.sends?.[kind] === undefined ? undefined : db(m.sends[kind])));
      (kind === 'reverb' ? toReverb : toDelay).push(level.connect(send));
    }
    buses[name] = { input, pool: voicePool(ctx, input), shift: trackShift(t, p) };
  }
  sumInto(ctx, toMaster, master);
  if (reverbIn) sumInto(ctx, toReverb, reverbIn);
  if (delayIn) sumInto(ctx, toDelay, delayIn);

  // Everything built so far (the master effects, every bus and its sends) lives as long as the song object does.
  const graph = setup?.stop();
  /** @type {Map<string, Patch>} */
  const voices = new Map();
  /** @type {{ end: number, keep: AudioNode[] }[]} */
  let held = [];
  /** Let go of the notes that ended more than a second before context time `now`: silent, and long past any filter ring. Returns how many. */
  const release = (/** @type {number} */ now) => {
    const before = held.length;
    held = held.filter(h => h.end + RELEASE_AFTER > now);
    return before - held.length;
  };
  let cursor = 0;
  /** Build every not-yet-built note that starts before context time `t`; returns how many. */
  const advance = (/** @type {number} */ t) => {
    const from = cursor;
    while (cursor < c.events.length && when + c.events[cursor].time < t) {
      if (!playing || playing.has(c.events[cursor].track)) playEvent(c.events[cursor], cursor);
      cursor++;
    }
    return cursor - from;
  };
  /** Builds one note's nodes into its track's bus; returns when it falls silent. */
  const buildNote = (/** @type {import('./sequence.js').NoteEvent} */ e, /** @type {number} */ i, /** @type {Patch} */ p, /** @type {typeof buses[string]} */ bus) => {
    const out = ctx.createGain();
    out.gain.value = e.vel;
    /** @type {AudioNode} */
    let note = out;
    if (e.pan) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = e.pan;
      note = out.connect(pan);
    }
    const at = when + e.time;
    const seed = song.seed * 101 + (i % SEED_POOL);
    let end = at;
    const layerOuts = p.layers.map((layer, li) => {
      const lo = ctx.createGain();
      end = Math.max(end, buildLayer(ctx, layer, { when: at, duration: p.duration, seed: seed + li * 7919, out: lo }).end);
      return lo;
    });
    sumInto(ctx, layerOuts, out);
    // buildLayer stops sources 10 ms after `end`; the amp is already at zero then, so `end` is when the note falls silent.
    note.connect(bus.pool.slot(at, end));
    return end;
  };
  const playEvent = (/** @type {import('./sequence.js').NoteEvent} */ e, /** @type {number} */ i) => {
    const bus = buses[e.track];
    const t = song.tracks[e.track];
    const shift = bus.shift ? bus.shift(e.midi) : 0;
    const key = `${e.track}:${shift.toFixed(3)}:${e.dur ?? 'patch'}`;
    let p = voices.get(key);
    if (!p) { p = transposePatch(instruments[e.track], shift, t.keytrack, e.dur); voices.set(key, p); }
    const recording = retain ? recordNodes(ctx) : undefined;
    let end = when + e.time;
    try { end = buildNote(e, i, p, bus); } finally { if (recording) held.push({ end, keep: recording.stop() }); }
  };
  if (!lazy) advance(Infinity);
  return { end: when + c.length + songTail(song, instruments), length: c.length, sections: c.sections, advance, release, graph, done: () => cursor >= c.events.length };
}
