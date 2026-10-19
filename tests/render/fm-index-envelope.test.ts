// Native Web Audio assertions: changing FM depth must redistribute spectral energy while
// the carrier frequency, amplitude envelope and filters stay fixed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromiumAvailable, openRenderHost, type Pcm, type RenderHost, type RenderResult } from '../../src/render/host.ts';
import type { Patch } from '../../src/schema/patch.ts';
import { renderKinds } from '../../src/runtime/harness.ts';
import { ENGINE_VERSION } from '../../runtime/engine/version.js';
import { patch } from '../helpers/patches.ts';

type Curve = [number, number, ('linear' | 'step' | 'exp')?][];
const SHAPED: Curve = [[0, 1], [0.2, 1], [0.4, 0], [0.8, 0]];

function fm(indexEnv?: Curve): Patch {
  return patch({
    schema: 'beeps/patch@1', name: 'fm-index-envelope', family: 'test', duration: 0.8,
    layers: [{
      // Non-integral ratio keeps the carrier separate from its reflected sidebands.
      source: { type: 'fm', pitch: 400, operators: [{ ratio: 1 }, { ratio: 1.5, index: 3, ...(indexEnv ? { indexEnv } : {}) }], algorithm: [[1, 0]] },
      gainDb: -9, amp: { attack: 0.005, decay: 0, sustain: 1, release: 0.02 },
    }],
  });
}

const ok = (r: RenderResult): Pcm => { if (!r.ok) throw new Error(r.error); return r; };
const bits = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

function samePcm(a: Pcm, b: Pcm): void {
  expect(a.sampleRate).toBe(b.sampleRate);
  for (const tap of ['authored', 'delivered'] as const) {
    expect(a[tap].length).toBe(b[tap].length);
    for (let c = 0; c < a[tap].length; c++) expect(bits(a[tap][c]).equals(bits(b[tap][c])), `${tap} channel ${c}`).toBe(true);
  }
}

function spectrum(p: Pcm, from: number, to: number): { rms: number; carrier: number; sidebandFraction: number } {
  const samples = p.authored[0].subarray(Math.round(from * p.sampleRate), Math.round(to * p.sampleRate));
  // Exactly 40 carrier cycles and 60 modulator cycles per 100 ms window. No spectral
  // leakage or FFT-window gain correction obscures the sideband/carrier energy ratio.
  let square = 0, real = 0, imaginary = 0;
  for (let i = 0; i < samples.length; i++) {
    const phase = 2 * Math.PI * 400 * i / p.sampleRate;
    square += samples[i] ** 2;
    real += samples[i] * Math.cos(phase);
    imaginary += samples[i] * Math.sin(phase);
  }
  const energy = square / samples.length;
  const carrier = 2 * (real ** 2 + imaginary ** 2) / samples.length ** 2;
  return { rms: Math.sqrt(energy), carrier, sidebandFraction: Math.max(0, 1 - carrier / energy) };
}

describe.skipIf(!(await chromiumAvailable()))('FM index envelopes in native Chromium', () => {
  let host: RenderHost;
  beforeAll(async () => { host = await openRenderHost(); });
  afterAll(async () => { await host?.close(); });

  it('removes FM sidebands during the amp sustain without changing loudness or carrier frequency', async () => {
    const [shaped, fixed] = (await host.render([fm(SHAPED), fm()].map(p => ({ patch: p, opts: { seed: 4242 } })))).map(ok);
    const early = spectrum(shaped, 0.08, 0.18), late = spectrum(shaped, 0.55, 0.65);
    expect(early.sidebandFraction).toBeGreaterThan(0.9);
    expect(late.sidebandFraction).toBeLessThan(0.000001);
    // FM changes the spectrum of a constant-amplitude oscillator; a gain fade cannot
    // satisfy both the sideband ratio and equal RMS checks. There is no filter here.
    expect(late.rms / early.rms).toBeCloseTo(1, 3);
    expect(late.carrier / late.rms ** 2).toBeCloseTo(1, 5);
    expect(spectrum(fixed, 0.08, 0.18).sidebandFraction).toBeGreaterThan(0.9);
    expect(spectrum(fixed, 0.55, 0.65).sidebandFraction).toBeGreaterThan(0.9);
    expect(shaped.authored.every(c => c.every(x => Number.isFinite(x) && Math.abs(x) <= 1))).toBe(true);
    expect(bits(shaped.authored[0]).equals(bits(fixed.authored[0]))).toBe(false);
  });

  it('renders an explicit unity envelope bit-exactly like an absent envelope', async () => {
    const [legacy, unity] = (await host.render([fm(), fm([[0, 1], [0.25, 1], [0.8, 1]])].map(p => ({ patch: p, opts: { seed: 4242, trimDb: -3 } })))).map(ok);
    expect(legacy.authored[0].some(x => x !== 0)).toBe(true);
    samePcm(legacy, unity);
  });

  it('repeats shaped FM bit-exactly on both authored and delivered taps', async () => {
    const p = fm([[0, 0], [0.01, 1], [0.18, 0.3, 'exp'], [0.3, 0.8, 'step'], [0.6, 0]]);
    const runs = (await host.render(Array.from({ length: 4 }, () => ({ patch: p, opts: { seed: 4242, trimDb: -3 } })))).map(ok);
    expect(runs[0].authored[0].some(x => x !== 0)).toBe(true);
    for (const repeated of runs.slice(1)) samePcm(runs[0], repeated);
  });

  it.each([false, true])('matches baked PCM through the runtime voice (hold=%s)', async hold => {
    const p = fm([[0, 0.2], [0.02, 1], [0.18, 0.25, 'exp'], [0.3, 0.75, 'step'], [0.6, 0]]);
    p.xRuntime = { delivery: 'both', hold, inputs: {}, bind: [] };
    const { baked, runtime } = await renderKinds({ schema: 'beeps/runtime-cue@1', id: p.name, engine: ENGINE_VERSION, seed: 4242, trimDb: -3, patch: p }, {});
    samePcm(baked, runtime);
    const [production, absent] = (await host.render([p, fm()].map(patch => ({ patch, opts: { seed: 4242, trimDb: -3 } })))).map(ok);
    samePcm(baked, production);
    // The same PCM assertion has a meaningful negative control: the runtime must
    // not agree with a baked patch that omits its source timbre envelope.
    expect(bits(runtime.authored[0]).equals(bits(absent.authored[0]))).toBe(false);
  });

  it('applies a static runtime index input to the entire normalized curve', async () => {
    const env: Curve = [[0, 1], [0.2, 1], [0.3, 0.5, 'step'], [0.8, 0.5]];
    const p = fm(env);
    p.xRuntime = {
      delivery: 'both', inputs: { intensity: { min: 0, max: 1, default: 0 } },
      bind: [{ input: 'intensity', target: '/layers/0/source/operators/1/index', range: [0, 3] }],
    };
    const { baked, runtime } = await renderKinds({ schema: 'beeps/runtime-cue@1', id: p.name, engine: ENGINE_VERSION, seed: 4242, trimDb: -3, patch: p }, { intensity: 1 });
    const expected = fm(env);
    if (expected.layers[0].source.type !== 'fm') throw new Error('expected FM fixture');
    expected.layers[0].source.operators[1].index = 6;
    const [doubled, unchanged] = (await host.render([expected, fm()].map(patch => ({ patch, opts: { seed: 4242, trimDb: -3 } })))).map(ok);
    samePcm(runtime, baked);
    samePcm(runtime, doubled);
    // At the second plateau, peak 6 times scale 0.5 is the original static index 3.
    // This catches treating points as absolute indices or scaling only the first point.
    expect(spectrum(runtime, 0.55, 0.65).sidebandFraction).toBeCloseTo(spectrum(unchanged, 0.08, 0.18).sidebandFraction, 4);
    expect(bits(runtime.authored[0]).equals(bits(unchanged.authored[0]))).toBe(false);
  });

  it('keeps overlapping runtime voices at their own envelope age after voice and layer onset offsets', async () => {
    const p = fm(SHAPED);
    p.layers[0].start = 0.05;
    const encoded = await host.page.evaluate(async ({ patch, url }) => {
      // Keep native module imports out of Vitest's server-side import transform:
      // this function runs in Chromium rather than in Vitest's module context.
      const load = new Function('path', 'return import(path)') as (path: string) => Promise<any>;
      const { build } = await load(`${url}/engine/voice.js`);
      const { toBase64 } = await load(`${url}/engine/offline.js`);
      const ctx = new OfflineAudioContext(2, 72_000, 48_000);
      ctx.destination.channelInterpretation = 'discrete';
      const merger = ctx.createChannelMerger(2);
      merger.connect(ctx.destination);
      // Route the voices to separate channels so each source's timbre is measurable
      // while they overlap in the very same context and share the runtime module.
      for (const [channel, when] of [0.125, 0.525].entries()) {
        const out = ctx.createGain();
        out.connect(merger, 0, channel);
        const voice = build(ctx, out, patch, { seed: 4242, hold: true, limiter: false }).start(when);
        voice.stop(when + patch.duration);
      }
      const buffer = await ctx.startRendering();
      return [0, 1].map(c => toBase64(buffer.getChannelData(c)));
    }, { patch: p, url: host.url });
    const channels = encoded.map((s: string) => {
      const bytes = Buffer.from(s, 'base64');
      return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    });
    const at = (c: number): Pcm => ({ sampleRate: 48_000, authored: [channels[c]], delivered: [channels[c]] });
    expect(channels[1].subarray(0, 27_600).every(x => x === 0)).toBe(true); // 0.525 + 0.05 seconds
    expect(spectrum(at(0), 0.655, 0.755).sidebandFraction).toBeLessThan(0.000001);
    expect(spectrum(at(1), 0.655, 0.755).sidebandFraction).toBeGreaterThan(0.9);
    expect(channels.every(c => c.every(x => Number.isFinite(x) && Math.abs(x) <= 1))).toBe(true);
  });
});
