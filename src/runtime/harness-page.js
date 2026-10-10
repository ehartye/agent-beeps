// @ts-nocheck (a browser page that imports files staged next to it at run time)
// The page the runtime harness loads in each browser. It renders one cue through the baked path (the offline renderer's own
// function) or through the runtime voice (`build` from the package entry), in an OfflineAudioContext shaped exactly like the
// renderer's, and returns the delivered and authored taps. It also times graph builds and counts what they create.
import { patchLength } from './engine/patch.js';
import { renderOfflinePcm, tapContext, renderTaps, toBase64 } from './engine/offline.js';
import { applyParams } from './engine/params.js';
import { build, createReverbBus, noiseCacheStats, setNoiseCacheLimit } from './engine/index.js';

const SR = 48000;
const pack = r => ({ sampleRate: r.sampleRate, delivered: r.delivered.map(toBase64), authored: r.authored.map(toBase64) });

/**
 * @param {{ kind: 'baked' | 'runtime', patch: any, params?: Record<string, number>, seed: number, variant: number, scale?: any, trimDb: number,
 *   reverbBus?: string, live?: { at: number, input: string, value: number, tau: number }[] }} spec
 */
async function run(spec) {
  const params = spec.params ?? {};
  // The baked reference of a given input value is the patch with every binding applied as a fixed number.
  const { patch: applied, trimDeltaDb } = applyParams(spec.patch, params, true);
  if (spec.kind === 'baked') {
    return pack(await renderOfflinePcm(applied, { seed: spec.seed, variant: spec.variant, scale: spec.scale, trimDb: spec.trimDb + trimDeltaDb }));
  }
  const hold = spec.patch.xRuntime?.hold === true;
  const t = tapContext(patchLength(applied));
  const opts = { seed: spec.seed, params, variant: spec.variant, scale: spec.scale ?? null, trimDb: spec.trimDb, tap: t.authored };
  if (spec.reverbBus) opts.reverb = createReverbBus(t.ctx, t.delivered, { preset: spec.reverbBus });
  const v = build(t.ctx, t.delivered, spec.patch, opts).start(0);
  if (hold) v.stop(spec.patch.duration);
  for (const e of spec.live ?? []) v.set(e.input, e.value, e.at, e.tau);
  return pack(await renderTaps(t.ctx));
}

/**
 * Time `n` voice builds (start() is where the nodes are made) of one cue into one context and count what they create.
 * `dispose`: dispose every voice at once (what a game does when it is done with a sound), `varySeed`: a different seed
 * each time, `bus`: send reverb to a shared bus.
 */
async function perf(spec, n) {
  const params = spec.params ?? {};
  const counts = { nodes: 0, buffers: 0, bufferBytes: 0 };
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
  const ctx = spec.realtime ? new AudioContext({ sampleRate: SR, latencyHint: 'interactive' }) : new OfflineAudioContext(2, SR, SR);
  if (spec.realtime && ctx.state !== 'running') await ctx.resume().catch(() => {});
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const bus = spec.bus ? createReverbBus(ctx, out, { preset: spec.bus }) : undefined;
  if (spec.noiseLimit !== undefined) setNoiseCacheLimit(spec.noiseLimit === 'inf' ? Infinity : spec.noiseLimit);
  let n0 = 0;
  const sd = () => (spec.varySeed ? spec.seed + n0++ : spec.seed);
  const make = () => build(ctx, out, spec.patch, { params, seed: sd(), variant: spec.variant, scale: spec.scale ?? null, trimDb: spec.trimDb, reverb: bus }).start();
  const times = [];
  let first = 0, warm;
  for (let i = 0; i < n; i++) {
    const before = { ...counts };
    const t0 = performance.now();
    const v = make();
    const dt = performance.now() - t0;
    if (spec.dispose) {
      v.dispose();
      // Yield now and then, as a game's frames do: the browser frees a disposed node's native memory from tasks on the main thread,
      // which a loop of thousands of synchronous builds never lets run.
      if (i % 20 === 19) await new Promise(r => setTimeout(r, 0));
    }
    if (i === 0) first = dt; else times.push(dt);
    if (i === 1) warm = Object.fromEntries(Object.entries(counts).map(([k, x]) => [k, x - before[k]]));
  }
  for (const [k, orig] of originals) proto[k] = orig;
  const state = ctx.state;
  const cache = noiseCacheStats(ctx);
  if (spec.realtime && !spec.keepOpen) await ctx.close();
  window.__ctx = ctx; // kept alive so a leak check sees what the context still holds
  times.sort((a, b) => a - b);
  const pick = q => times[Math.min(times.length - 1, Math.floor(q * times.length))];
  return { firstMs: first, medianMs: pick(0.5), p95Ms: pick(0.95), maxMs: times[times.length - 1], warmCounts: warm, n, ctxState: state, noiseCache: cache };
}

window.run = run;
window.perf = perf;
window.ready = true;
