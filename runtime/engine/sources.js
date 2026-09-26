// Sound sources: each patch source type becomes a small group of Web Audio nodes.
import { mulberry32, noiseSamples } from './rng.js';

/** @typedef {import('../../src/schema/patch.ts').Source} Source */
/**
 * @typedef {object} BuiltSource
 * @property {AudioNode} output
 * @property {{ param: AudioParam, ratio: number }[]} pitch   frequency params that follow the pitch envelope
 * @property {AudioParam[]} detune                            cent-valued params for pitch LFOs
 * @property {(t: number) => void} start
 * @property {(t: number) => void} stop
 */

const db = (/** @type {number} */ x) => 10 ** (x / 20);
const nyquistSafe = (/** @type {BaseAudioContext} */ ctx, /** @type {number} */ hz) => hz < 0.45 * ctx.sampleRate;

/** 808 metal: six detuned squares in deliberately inharmonic ratios. */
export const METAL_RATIOS = [2, 3, 4.16, 5.43, 6.79, 8.21];

/** @type {WeakMap<BaseAudioContext, Map<string, AudioBuffer>>} */
const noiseCache = new WeakMap();

/**
 * Seeded 2-second looping noise, built once per context, colour and seed: a song fires hundreds of
 * noise notes and would otherwise allocate a fresh buffer for each.
 * @param {BaseAudioContext} ctx
 * @param {'white' | 'pink' | 'brown'} color
 * @param {number} seed
 */
function noiseBuffer(ctx, color, seed) {
  let perCtx = noiseCache.get(ctx);
  if (!perCtx) { perCtx = new Map(); noiseCache.set(ctx, perCtx); }
  const key = `${color}:${seed}`;
  let buf = perCtx.get(key);
  if (!buf) { buf = bufferOf(ctx, noiseSamples(color, Math.ceil(ctx.sampleRate * 2), seed)); perCtx.set(key, buf); }
  return buf;
}

/**
 * @param {BaseAudioContext} ctx
 * @param {Float32Array} samples
 * @param {number} [channels]
 */
function bufferOf(ctx, samples, channels = 1) {
  const buf = ctx.createBuffer(channels, samples.length, ctx.sampleRate);
  for (let c = 0; c < channels; c++) buf.getChannelData(c).set(samples);
  return buf;
}

/**
 * @param {BaseAudioContext} ctx
 * @param {Source} src
 * @param {{ pitchHz: number, seed: number, length: number }} opts  length = seconds the source may sound
 * @returns {BuiltSource}
 */
export function buildSource(ctx, src, { pitchHz, seed, length }) {
  const mix = ctx.createGain();
  /** @type {AudioScheduledSourceNode[]} */
  const nodes = [];
  /** @type {BuiltSource['pitch']} */
  const pitch = [];
  /** @type {AudioParam[]} */
  const detune = [];
  /** @type {((t: number) => void)[]} */
  const onStart = [];

  if (src.type === 'osc') {
    const voices = src.unison?.voices ?? 1;
    const spread = src.unison?.detuneCents ?? 0;
    for (let i = 0; i < voices; i++) {
      const o = ctx.createOscillator();
      o.type = src.wave;
      o.frequency.value = pitchHz;
      // Spread evenly: in-phase unison voices would add at onset instead of chorusing.
      o.detune.value = voices === 1 ? 0 : -spread / 2 + (spread * i) / (voices - 1);
      const g = ctx.createGain();
      g.gain.value = 1 / voices;
      o.connect(g).connect(mix);
      nodes.push(o); pitch.push({ param: o.frequency, ratio: 1 }); detune.push(o.detune);
    }
  } else if (src.type === 'noise') {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuffer(ctx, src.color, seed);
    s.loop = true;
    s.connect(mix);
    nodes.push(s);
  } else if (src.type === 'fm') {
    const ops = src.operators.map(op => {
      const o = ctx.createOscillator();
      o.type = op.wave;
      o.frequency.value = pitchHz * op.ratio;
      nodes.push(o); pitch.push({ param: o.frequency, ratio: op.ratio }); detune.push(o.detune);
      return o;
    });
    for (const [from, to] of src.algorithm) {
      if (from >= ops.length || to >= ops.length || from === to) continue;
      const depth = ctx.createGain();
      depth.gain.value = src.operators[from].index * pitchHz * src.operators[to].ratio;
      ops[from].connect(depth).connect(ops[to].frequency);
    }
    ops[0].connect(mix);
  } else if (src.type === 'additive') {
    const total = src.partials.reduce((a, [, g]) => a + db(g), 0) || 1;
    for (const [ratio, gainDb, decay] of src.partials) {
      if (!nyquistSafe(ctx, pitchHz * ratio)) continue;
      const o = ctx.createOscillator();
      o.frequency.value = pitchHz * ratio;
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g).connect(mix);
      nodes.push(o); pitch.push({ param: o.frequency, ratio }); detune.push(o.detune);
      // Each partial decays on its own clock: that independence is what makes additive sound physical.
      onStart.push(t => {
        g.gain.setValueAtTime(db(gainDb) / total, t);
        g.gain.setTargetAtTime(0, t, decay / 5);
      });
    }
  } else if (src.type === 'modal') {
    const exciter = ctx.createBufferSource();
    const n = src.exciter === 'impulse' ? 1 : Math.ceil(ctx.sampleRate * 0.005);
    const excite = src.exciter === 'impulse' ? Float32Array.of(1) : noiseSamples('white', n, seed);
    if (src.exciter === 'noiseBurst') for (let i = 0; i < n; i++) excite[i] *= 1 - i / n;
    exciter.buffer = bufferOf(ctx, excite);
    nodes.push(exciter);
    for (const [ratio, q, gainDb] of src.modes) {
      if (!nyquistSafe(ctx, pitchHz * ratio)) continue;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = pitchHz * ratio;
      bp.Q.value = q;
      const g = ctx.createGain();
      // A bandpass passes a sliver of an impulse; scale by Q so modes ring at a usable level.
      g.gain.value = db(gainDb) * q * 4;
      exciter.connect(bp).connect(g).connect(mix);
      pitch.push({ param: bp.frequency, ratio });
    }
  } else if (src.type === 'grains') {
    const rand = mulberry32(seed);
    const len = Math.max(1, Math.ceil(ctx.sampleRate * length));
    const out = new Float32Array(len);
    const noise = noiseSamples('white', len, seed + 1);
    const decaySamples = src.grainDecay * ctx.sampleRate;
    let t = 0;
    while (true) {
      const progress = t / len;
      const rate = src.rate * (src.rateEnd === undefined ? 1 : 1 + (src.rateEnd - 1) * progress);
      if (rate <= 0) break;
      t += Math.max(1, Math.round((-Math.log(1 - rand()) / rate) * ctx.sampleRate)); // Poisson arrivals
      if (t >= len) break;
      const amp = 0.5 + 0.5 * rand();
      const grainLen = Math.min(len - t, Math.ceil(decaySamples * 6));
      for (let i = 0; i < grainLen; i++) out[t + i] += amp * noise[(t + i) % len] * Math.exp(-i / decaySamples);
    }
    let peak = 0;
    for (const x of out) peak = Math.max(peak, Math.abs(x));
    if (peak > 0) for (let i = 0; i < len; i++) out[i] /= peak;
    const s = ctx.createBufferSource();
    s.buffer = bufferOf(ctx, out);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = src.center;
    bp.Q.value = src.q;
    s.connect(bp).connect(mix);
    nodes.push(s);
  } else if (src.type === 'metal') {
    const sum = ctx.createGain();
    sum.gain.value = 1 / METAL_RATIOS.length;
    for (const r of METAL_RATIOS) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = src.base * r;
      o.connect(sum);
      nodes.push(o); detune.push(o.detune);
    }
    for (const band of src.bands) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = band;
      bp.Q.value = 1.5;
      sum.connect(bp).connect(mix);
    }
  }

  return {
    output: mix,
    pitch,
    detune,
    start: t => { for (const f of onStart) f(t); for (const n of nodes) n.start(t); },
    stop: t => { for (const n of nodes) n.stop(t); },
  };
}
