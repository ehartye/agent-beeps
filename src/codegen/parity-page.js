// @ts-nocheck (a browser page that imports files staged next to it at run time)
// EXPERIMENTAL (runtime-codegen spike). The page the parity harness loads in each browser: it renders one cue through the
// baked path, the interpreter or the generated module, in an OfflineAudioContext shaped exactly like the renderer's, and
// returns the delivered and authored taps. It also times graph builds.
import { patchLength } from './baked/patch.js';
import { renderOfflinePcm } from './baked/offline.js';
import { applyParams } from './engine/params.js';
import { createVoice } from './engine/live.js';

const SR = 48000, PAD = 0.05;
/** @param {Float32Array} f */
function b64(f) {
  const bytes = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const pack = (/** @type {AudioBuffer} */ buf) => ({
  sampleRate: SR,
  delivered: [b64(buf.getChannelData(0)), b64(buf.getChannelData(1))],
  authored: [b64(buf.getChannelData(2)), b64(buf.getChannelData(3))],
});

/** The renderer's own tap layout (runtime/engine/offline.js): 4 channels, delivered stereo then authored stereo. */
function taps(/** @type {number} */ seconds) {
  const ctx = new OfflineAudioContext(4, Math.ceil((seconds + PAD) * SR), SR);
  ctx.destination.channelInterpretation = 'discrete';
  const merger = ctx.createChannelMerger(4);
  merger.connect(ctx.destination);
  const bus = (/** @type {number} */ offset) => {
    const g = ctx.createGain();
    g.channelCount = 2; g.channelCountMode = 'explicit'; g.channelInterpretation = 'speakers';
    const split = ctx.createChannelSplitter(2);
    g.connect(split); split.connect(merger, 0, offset); split.connect(merger, 1, offset + 1);
    return g;
  };
  return { ctx, delivered: bus(0), authored: bus(2) };
}

/**
 * @param {{ kind: 'baked' | 'interp' | 'gen', patch: any, name: string, params?: Record<string, number>, seed: number, variant: number, scale?: any, trimDb: number,
 *   live?: { at: number, input: string, value: number, tau: number }[] }} spec
 */
async function run(spec) {
  const params = spec.params ?? {};
  // The baked reference of a given input value is the patch with every binding applied as a fixed number.
  const { patch: applied, trimDeltaDb } = applyParams(spec.patch, params, true);
  const hold = spec.patch.xRuntime?.hold === true;
  const seconds = patchLength(applied);
  if (spec.kind === 'baked') {
    const r = await renderOfflinePcm(applied, { seed: spec.seed, variant: spec.variant, scale: spec.scale, trimDb: spec.trimDb + trimDeltaDb });
    return { sampleRate: r.sampleRate, delivered: r.delivered.map(b64), authored: r.authored.map(b64) };
  }
  const t = taps(seconds);
  const opts = { variant: spec.variant, scale: spec.scale, trimDb: spec.trimDb };
  let v;
  if (spec.kind === 'interp') v = createVoice(t.ctx, spec.patch, t.delivered, params, spec.seed, { ...opts, tap: t.authored });
  else {
    const m = await import(`./cues/${spec.name}.js`);
    v = m.build(t.ctx, t.delivered, params, spec.seed, { ...opts, tap: t.authored });
  }
  if (hold) v.release(spec.patch.duration);
  for (const e of spec.live ?? []) v.set(e.input, e.value, e.at, e.tau);
  return pack(await t.ctx.startRendering());
}

/** Time `n` graph builds of one cue into one OfflineAudioContext, and count what they create. */
async function perf(/** @type {any} */ spec, /** @type {number} */ n) {
  const params = spec.params ?? {};
  const counts = { nodes: 0, params: 0, buffers: 0, bufferBytes: 0, connects: 0 };
  const proto = BaseAudioContext.prototype;
  const originals = [];
  for (const k of Object.getOwnPropertyNames(proto)) {
    if (!k.startsWith('create') || typeof proto[k] !== 'function') continue;
    const orig = proto[k];
    originals.push([k, orig]);
    proto[k] = function (...a) {
      const r = orig.apply(this, a);
      if (k === 'createBuffer') { counts.buffers++; counts.bufferBytes += a[0] * a[1] * 4; }
      else if (k !== 'createPeriodicWave') counts.nodes++;
      return r;
    };
  }
  const ctx = new OfflineAudioContext(2, SR, SR);
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const gen = spec.kind === 'gen' ? await import(`./cues/${spec.name}.js`) : null;
  const build = () => (gen
    ? gen.build(ctx, out, params, spec.seed, { variant: spec.variant, scale: spec.scale, trimDb: spec.trimDb })
    : createVoice(ctx, spec.patch, out, params, spec.seed, { variant: spec.variant, scale: spec.scale, trimDb: spec.trimDb }));
  const times = [];
  let first = 0, firstCounts;
  for (let i = 0; i < n; i++) {
    const before = { ...counts };
    const t0 = performance.now();
    build();
    const dt = performance.now() - t0;
    if (i === 0) { first = dt; firstCounts = { ...counts }; } else times.push(dt);
    if (i === 1) counts.warm = Object.fromEntries(Object.entries(counts).filter(([k]) => k !== 'warm').map(([k, v]) => [k, v - before[k]]));
  }
  for (const [k, orig] of originals) proto[k] = orig;
  times.sort((a, b) => a - b);
  const pick = (/** @type {number} */ q) => times[Math.min(times.length - 1, Math.floor(q * times.length))];
  return { firstMs: first, medianMs: pick(0.5), p95Ms: pick(0.95), maxMs: times[times.length - 1], firstCounts, warmCounts: counts.warm, n };
}

/** Pitch and level of a held tone, for the live-input check: zero crossings and RMS over a window. */
window.run = run;
window.perf = perf;
window.ready = true;
