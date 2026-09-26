// One layer: source → drive → filter → tremolo → amp envelope → pan → layer gain → out.
import { buildSource } from './sources.js';
import { noteToHz, snapToScale } from './notes.js';

/** @typedef {import('../../src/schema/patch.ts').Layer} Layer */
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
 * @param {BaseAudioContext} ctx
 * @param {Layer} layer
 * @param {{ when: number, duration: number, seed: number, scale?: Scale, out: AudioNode }} opts
 * @returns {{ end: number }}
 */
export function buildLayer(ctx, layer, { when, duration, seed, scale, out }) {
  const t0 = when + layer.start;
  const { attack, decay, sustain, release } = layer.amp;
  const off = Math.max(t0 + Math.min(attack, 0.002), when + duration);
  const end = off + release;
  const src = /** @type {any} */ (layer.source);
  const base = 'pitch' in src ? resolvePitch(src.pitch, scale) : 440;
  const built = buildSource(ctx, layer.source, { pitchHz: base, seed, length: end - t0 });

  // Pitch envelope: every frequency param follows, keeping its ratio to the fundamental.
  if (layer.pitchEnv?.length) {
    for (const { param, ratio } of built.pitch) {
      param.setValueAtTime(base * ratio, t0);
      for (const point of layer.pitchEnv) {
        const at = t0 + point.at;
        const v = Math.max(MIN_FREQ, resolvePitch(point.to, scale) * ratio);
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
  const level = envelopeAt(layer.amp, off - t0);
  amp.gain.setValueAtTime(level, off);
  amp.gain.linearRampToValueAtTime(0, end);
  node = node.connect(amp);

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
    lfo.stop(end);
  }

  if (layer.pan !== undefined && layer.pan !== 0) {
    const pan = ctx.createStereoPanner();
    pan.pan.value = layer.pan;
    node = node.connect(pan);
  }

  const gain = ctx.createGain();
  gain.gain.value = db(layer.gainDb);
  node.connect(gain).connect(out);

  built.start(t0);
  built.stop(end + 0.01);
  return { end };
}
