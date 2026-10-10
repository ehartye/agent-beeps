// One layer: source → drive → filter → tremolo → amp envelope → pan → layer gain → out.
import { buildSource } from './sources.js';
import { noteToHz, snapToScale } from './notes.js';

/** @typedef {import('../../src/schema/patch.ts').Layer} Layer */
/**
 * Nodes the layer already contains, for a runtime that automates live inputs.
 * @typedef {object} LayerNodes
 * @property {GainNode} gain  the layer's trim (static value, never automated by the engine)
 * @property {StereoPannerNode | undefined} pan
 * @property {BiquadFilterNode | undefined} filter
 * @property {OscillatorNode | undefined} lfo
 * @property {{ param: AudioParam, ratio: number }[]} pitch
 * @property {AudioParam[]} detune
 * @property {number} baseHz
 */
/** @typedef {{ root: string, mode: 'chromatic'|'major'|'minor'|'dorian'|'majorPentatonic'|'minorPentatonic'|'blues', snap: boolean }} Scale */

const MIN_FREQ = 1;
const db = (/** @type {number} */ x) => 10 ** (x / 20);

/**
 * @param {string | number} p
 * @param {Scale | undefined} scale
 */
export function resolvePitch(p, scale) {
  const hz = noteToHz(p);
  return scale?.snap ? snapToScale(hz, scale) : hz;
}

/** Soft-clip curve tanh(kx)/tanh(k). @param {number} drive 0..1 */
export function driveCurve(drive) {
  const k = 1 + drive * 20;
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

/**
 * Amp envelope value at `t` seconds after onset, before release. Computed analytically so the
 * release starts from the true level in every browser (no cancelAndHoldAtTime dependency).
 * @param {{ attack: number, decay: number, sustain: number }} amp
 * @param {number} t
 */
export function envelopeAt(amp, t) {
  if (t <= 0) return 0;
  if (t < amp.attack) return t / amp.attack;
  if (amp.decay <= 0 || amp.sustain >= 1) return 1; // no decay stage is scheduled: held at peak
  return amp.sustain + (1 - amp.sustain) * Math.exp(-(t - amp.attack) / (amp.decay / 3));
}

/**
 * `hold` (runtime path only): the layer does not schedule its own release. It sounds until the returned
 * `release(at)` is called, which schedules exactly what the default path schedules at `when + duration`.
 * The returned `nodes` are references to nodes the graph already contains (no node is added for them), so a
 * runtime can automate a live input. Without `hold` the graph, its events and their order are unchanged.
 * @param {BaseAudioContext} ctx
 * @param {Layer} layer
 * `pitchRatio` is a pitch offset applied after the scale has chosen the note (a variant's detune): the scale decides which
 * note a sound is, the offset moves it from there. Sources without a pitch (noise, grains, metal) are not moved by it.
 * @param {{ when: number, duration: number, seed: number, scale?: Scale, out: AudioNode, hold?: boolean, pitchRatio?: number }} opts
 * @returns {{ end: number, release: (at: number) => number, stop: (t: number) => void, nodes: LayerNodes }}
 */
export function buildLayer(ctx, layer, { when, duration, seed, scale, out, hold = false, pitchRatio = 1 }) {
  const t0 = when + layer.start;
  const { attack, decay, sustain, release } = layer.amp;
  const off = Math.max(t0 + Math.min(attack, 0.002), when + duration);
  const end = off + release;
  const src = /** @type {any} */ (layer.source);
  const base = 'pitch' in src ? resolvePitch(src.pitch, scale) * pitchRatio : 440;
  const built = buildSource(ctx, layer.source, { pitchHz: base, seed, length: end - t0 });

  // Pitch envelope: every frequency param follows, keeping its ratio to the fundamental.
  if (layer.pitchEnv?.length) {
    for (const { param, ratio } of built.pitch) {
      param.setValueAtTime(base * ratio, t0);
      for (const point of layer.pitchEnv) {
        const at = t0 + point.at;
        const v = Math.max(MIN_FREQ, resolvePitch(point.to, scale) * pitchRatio * ratio);
        if (point.curve === 'step') param.setValueAtTime(v, at);
        else if (point.curve === 'linear') param.linearRampToValueAtTime(v, at);
        else param.exponentialRampToValueAtTime(v, at);
      }
    }
  }

  /** @type {AudioNode} */
  let node = built.output;

  if (layer.drive) {
    const shaper = ctx.createWaveShaper();
    shaper.curve = driveCurve(layer.drive);
    shaper.oversample = '4x';
    node = node.connect(shaper);
  }

  /** @type {BiquadFilterNode | undefined} */
  let filter;
  if (layer.filter) {
    const f = layer.filter;
    filter = ctx.createBiquadFilter();
    filter.type = f.type;
    filter.frequency.value = f.cutoff;
    // Chromium: lowpass/highpass Q is resonance in dB; bandpass/notch/peaking Q is a quality factor.
    filter.Q.value = 'resonanceDb' in f ? f.resonanceDb : f.q;
    if ('gainDb' in f && f.gainDb !== undefined) filter.gain.value = f.gainDb;
    if (f.env) {
      filter.frequency.setValueAtTime(f.cutoff, t0);
      filter.frequency.exponentialRampToValueAtTime(Math.max(MIN_FREQ, f.env.to), t0 + f.env.time);
    }
    node = node.connect(filter);
  }

  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, t0);
  if (attack > 0) amp.gain.linearRampToValueAtTime(1, t0 + attack);
  else amp.gain.setValueAtTime(1, t0);
  if (decay > 0 && sustain < 1) amp.gain.setTargetAtTime(sustain, t0 + attack, decay / 3);
  /** The release: hold the analytic level at `at`, then fall linearly to silence. Returns when the voice is silent. */
  const scheduleRelease = (/** @type {number} */ at) => {
    amp.gain.setValueAtTime(envelopeAt(layer.amp, at - t0), at);
    amp.gain.linearRampToValueAtTime(0, at + release);
    return at + release;
  };
  if (!hold) scheduleRelease(off);
  node = node.connect(amp);

  // Opt-in second filter, after the envelope: the envelope is what leaves a short low burst with a
  // nonzero mean, so a lowpassed layer can also lose its sub-audible content (`filter` is one filter).
  if (layer.highpass !== undefined) {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = layer.highpass;
    hp.Q.value = 0;
    node = node.connect(hp);
  }

  /** @type {OscillatorNode | undefined} */
  let lfoNode;
  if (layer.lfo) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = layer.lfo.rate;
    const depth = ctx.createGain();
    depth.gain.value = layer.lfo.depth;
    lfo.connect(depth);
    if (layer.lfo.target === 'pitch') for (const p of built.detune) depth.connect(p);
    else if (layer.lfo.target === 'cutoff' && filter) depth.connect(filter.frequency);
    else if (layer.lfo.target === 'gain') {
      const trem = ctx.createGain();
      trem.gain.value = 1 - Math.min(1, layer.lfo.depth) / 2;
      depth.gain.value = Math.min(1, layer.lfo.depth) / 2;
      depth.connect(trem.gain);
      node = node.connect(trem);
    }
    lfo.start(t0);
    if (!hold) lfo.stop(end);
    lfoNode = lfo;
  }

  /** @type {StereoPannerNode | undefined} */
  let panNode;
  if (layer.pan !== undefined && layer.pan !== 0) {
    const pan = ctx.createStereoPanner();
    pan.pan.value = layer.pan;
    node = node.connect(pan);
    panNode = pan;
  }

  const gain = ctx.createGain();
  gain.gain.value = db(layer.gainDb);
  node.connect(gain).connect(out);

  built.start(t0);
  if (!hold) built.stop(end + 0.01);
  return {
    end: hold ? Infinity : end,
    release(at) {
      const silent = scheduleRelease(Math.max(at, t0 + Math.min(attack, 0.002)));
      built.stop(silent + 0.01);
      lfoNode?.stop(silent);
      return silent;
    },
    /** Stop every source of the layer at `t` (used to tear a voice down; stopping twice is harmless). */
    stop(t) {
      built.stop(t);
      lfoNode?.stop(t);
    },
    nodes: { gain, pan: panNode, filter, lfo: lfoNode, pitch: built.pitch, detune: built.detune, baseHz: base },
  };
}
