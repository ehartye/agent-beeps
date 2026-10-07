// Master effects. Reverb is a generated impulse response built once per context and preset:
// assigning a convolver buffer is expensive, and delay-network reverbs built from DelayNodes ring.
import { mulberry32 } from './rng.js';

/** Decay (s to -60 dB), lowpass start/end (Hz) and pre-delay (s) per preset. */
export const REVERB_PRESETS = /** @type {const} */ ({
  small: { decay: 0.4, lpStart: 9000, lpEnd: 3000, preDelay: 0.005 },
  room: { decay: 0.9, lpStart: 8000, lpEnd: 2500, preDelay: 0.012 },
  hall: { decay: 2.2, lpStart: 7000, lpEnd: 1800, preDelay: 0.025 },
  cave: { decay: 3.5, lpStart: 5000, lpEnd: 1200, preDelay: 0.04 },
  space: { decay: 7, lpStart: 7000, lpEnd: 900, preDelay: 0.06 },
});

/** @type {WeakMap<BaseAudioContext, Map<string, AudioBuffer>>} */
const irCache = new WeakMap();

/**
 * Stereo exponentially decaying seeded noise with a descending one-pole lowpass (highs die first).
 * @param {number} sampleRate
 * @param {keyof typeof REVERB_PRESETS} preset
 * @param {number} seed
 */
export function impulseResponse(sampleRate, preset, seed) {
  const p = REVERB_PRESETS[preset];
  const len = Math.ceil(sampleRate * (p.decay + p.preDelay));
  const pre = Math.floor(sampleRate * p.preDelay);
  /** @type {Float32Array[]} */
  const channels = [];
  for (let c = 0; c < 2; c++) {
    const rand = mulberry32(seed * 31 + c + 1);
    const data = new Float32Array(len);
    let y = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sampleRate;
      const cutoff = p.lpStart * (p.lpEnd / p.lpStart) ** (t / p.decay);
      const a = Math.exp((-2 * Math.PI * cutoff) / sampleRate);
      y = (1 - a) * (rand() * 2 - 1) + a * y;
      const env = Math.exp((-6.9078 * t) / p.decay); // -60 dB at `decay`
      const fadeIn = Math.min(1, (i - pre) / (sampleRate * 0.002));
      data[i] = y * env * fadeIn;
    }
    channels.push(data);
  }
  return channels;
}

/**
 * @param {BaseAudioContext} ctx
 * @param {keyof typeof REVERB_PRESETS} preset
 */
export function buildReverb(ctx, preset) {
  let perCtx = irCache.get(ctx);
  if (!perCtx) { perCtx = new Map(); irCache.set(ctx, perCtx); }
  let buf = perCtx.get(preset);
  if (!buf) {
    const [l, r] = impulseResponse(ctx.sampleRate, preset, 1);
    buf = ctx.createBuffer(2, l.length, ctx.sampleRate);
    buf.getChannelData(0).set(l);
    buf.getChannelData(1).set(r);
    perCtx.set(preset, buf);
  }
  const conv = ctx.createConvolver();
  conv.normalize = true;
  conv.buffer = buf;
  return conv;
}

/**
 * Feedback delay: in → delay ↔ feedback → out.
 * @param {BaseAudioContext} ctx
 * @param {{ time: number, feedback: number }} opts
 */
export function buildDelay(ctx, { time, feedback }) {
  const input = ctx.createGain();
  const delay = ctx.createDelay(2);
  delay.delayTime.value = time;
  const fb = ctx.createGain();
  fb.gain.value = feedback;
  input.connect(delay);
  delay.connect(fb).connect(delay);
  return { input, output: delay };
}

/** Corner of the opt-in DC blocker (Hz): far below any audible thump, so it removes offset, not weight. */
export const DC_BLOCK_HZ = 10;

/**
 * One-pole DC blocker y[n] = x[n] - x[n-1] + R y[n-1] (J. O. Smith, Introduction to Digital Filters: DC blocker).
 * @param {BaseAudioContext} ctx
 */
export function buildDcBlocker(ctx) {
  const r = 1 - (2 * Math.PI * DC_BLOCK_HZ) / ctx.sampleRate;
  return ctx.createIIRFilter([1, -1], [1, -r]);
}

const KNEE = 10 ** (-1.5 / 20); // untouched below -1.5 dBFS (the loudness trim keeps peaks under -1.7 dBTP)
const CEILING = 10 ** (-1 / 20); // asymptote at -1 dBFS

/** Transfer curve of the safety clipper: identity below -1.5 dBFS, tanh into the -1 dBFS ceiling above it. */
export function clipperCurve(n = 4096) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= KNEE ? a : KNEE + (CEILING - KNEE) * Math.tanh((a - KNEE) / (CEILING - KNEE));
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

/**
 * Always-on safety stage on the delivered path. A stateless soft clipper rather than
 * DynamicsCompressorNode: Chromium's compressor changes level (-1 to -3 dB, signal-dependent) even
 * 40 dB below threshold, which would break loudness matching. Sounds are trimmed to their target
 * first, so this only ever catches stray peaks; lint reports any true peak it had to shave.
 * @param {BaseAudioContext} ctx
 */
export function buildLimiter(ctx) {
  const s = ctx.createWaveShaper();
  s.curve = clipperCurve();
  // No oversampling: the resampling filter would ring past the ceiling on hard clips, and the
  // identity region is then bit-exact. Clipping aliases, but only when it clips, which lint reports.
  s.oversample = 'none';
  return s;
}

/** Seconds a feedback delay takes to fall 60 dB. @param {{ time: number, feedback: number }} d */
export const delayTail = d => Math.min(8, d.feedback <= 0 ? d.time : d.time * Math.ceil(Math.log(0.01) / Math.log(d.feedback)));
