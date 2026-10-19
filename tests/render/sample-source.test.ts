// Actual native Web Audio PCM, not a model of what a buffer source should do.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openRenderHost, chromiumAvailable, type RenderHost } from '../../src/render/host.ts';
import { writeWav } from '../../src/audio/wav.ts';
import { sampleId } from '../../src/samples/store.ts';
import { withSource } from '../helpers/patches.ts';
import type { Patch } from '../../src/schema/patch.ts';

const channels = [Float32Array.from({ length: 4800 }, (_, i) => (i % 8 - 4) / 32), Float32Array.from({ length: 4800 }, (_, i) => (3 - i % 8) / 64)];
const bytes = (pcm: Float32Array) => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
const samePcm = (a: number[], b: number[]) => bytes(Float32Array.from(a)).equals(bytes(Float32Array.from(b)));

describe.skipIf(!(await chromiumAvailable()))('sample one-shots in native Chromium', () => {
  let host: RenderHost;
  beforeAll(async () => { host = await openRenderHost(); });
  afterAll(async () => { await host?.close(); });

  async function render({ count = 2, mode = 'overlap', fx = false }: { count?: number; mode?: 'overlap' | 'release' | 'dispose' | 'natural'; fx?: boolean } = {}) {
    const pcm = channels.slice(0, count), wav = writeWav(pcm, 48000, { bits: 32 }), id = sampleId(wav);
    const p = withSource({ type: 'sample', asset: id }, { start: 0.0125, amp: { attack: 0, decay: 0, sustain: 1, release: 0.025 } });
    p.variation = { pitchCents: 1200, gainDb: 0, variants: 2, noRepeat: true };
    if (fx) p.fx = { delay: { time: 0.125, feedback: 0, sendDb: 0 } };
    const result = await host.page.evaluate(async ({ p, id, wav, mode, url }) => {
      const load = new Function('path', 'return import(path)') as (path: string) => Promise<any>;
      const { prepareSampleWavs } = await load(`${url}/engine/samples.js`);
      const { build } = await load(`${url}/engine/voice.js`);
      const { toBase64 } = await load(`${url}/engine/offline.js`);
      const ctx = new OfflineAudioContext(2, 24000, 48000);
      const buffers = prepareSampleWavs(ctx, p, { [id]: Uint8Array.from(wav) });
      const first = build(ctx, ctx.destination, p, { samples: buffers, hold: true, limiter: false, variant: 1 }).start(0.025);
      const ends = [first.end];
      if (mode === 'overlap' || mode === 'dispose') {
        const second = build(ctx, ctx.destination, p, { samples: buffers, hold: true, limiter: false }).start(0.05);
        ends.push(second.end);
      }
      if (mode === 'release') ends.push(first.stop(0.075));
      // Suspend at exactly one render quantum: immediate dispose must cut this voice only.
      if (mode === 'dispose') { const suspended = ctx.suspend(3072 / 48000); void ctx.startRendering(); await suspended; first.dispose(); const pending = new Promise<AudioBuffer>(resolve => { ctx.oncomplete = event => resolve(event.renderedBuffer); }); await ctx.resume(); const rendered = await pending; return { encoded: [0, 1].map(c => toBase64(rendered.getChannelData(c))), ends }; }
      const rendered = await ctx.startRendering();
      return { encoded: [0, 1].map(c => toBase64(rendered.getChannelData(c))), ends };
    }, { p: p as Patch, id, wav: [...wav], mode, url: host.url });
    const actual = result.encoded.map((encoded: string) => { const b = Buffer.from(encoded, 'base64'); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); });
    return { actual, ends: result.ends, pcm };
  }

  it.each([1, 2])('renders exact original-rate %s-channel PCM at independent overlapping onsets', async count => {
    const { actual, pcm, ends } = await render({ count });
    expect(ends[0]).toBeCloseTo(0.1625); expect(ends[1]).toBeCloseTo(0.1875);
    for (let c = 0; c < 2; c++) {
      const expected = new Float32Array(24000), source = pcm[c % count];
      for (const onset of [1800, 3000]) for (let i = 0; i < source.length; i++) expected[onset + i] += source[i];
      expect(bytes(actual[c]).equals(bytes(expected)), `channel ${c}`).toBe(true);
    }
  });
  it('ends held sample voices naturally and retains exact delayed effect tails', async () => {
    const { actual, pcm, ends } = await render({ mode: 'natural', fx: true });
    expect(ends[0]).toBeCloseTo(0.2875);
    for (let c = 0; c < 2; c++) {
      const expected = new Float32Array(24000);
      expected.set(pcm[c], 1800); expected.set(pcm[c], 7800);
      expect(bytes(actual[c]).equals(bytes(expected))).toBe(true);
      expect(actual[c].subarray(7800, 12600).some(x => x !== 0)).toBe(true);
      expect(actual[c].subarray(12600).every(x => x === 0)).toBe(true);
    }
  });
  it('applies the authored amp release before the recording natural end', async () => {
    const { actual, pcm, ends } = await render({ mode: 'release' });
    expect(ends[1]).toBeCloseTo(0.1);
    for (let c = 0; c < 2; c++) {
      expect(bytes(actual[c].subarray(1800, 3600)).equals(bytes(pcm[c].subarray(0, 1800)))).toBe(true);
      // Native ramps round their gain to float32 before multiplication.
      for (const frame of [3600, 3900, 4200, 4500, 4799]) expect(actual[c][frame]).toBeCloseTo(pcm[c][frame - 1800] * (4800 - frame) / 1200, 7);
      expect(actual[c].subarray(4800).every(x => x === 0)).toBe(true);
    }
  });
  it('disposes one voice without stopping a second voice sharing its buffer', async () => {
    const { actual, pcm } = await render({ mode: 'dispose' });
    for (let c = 0; c < 2; c++) {
      expect(bytes(actual[c].subarray(3072, 7800)).equals(bytes(pcm[c].subarray(72)))).toBe(true);
      expect(actual[c].subarray(7800).every(x => x === 0)).toBe(true);
    }
  });

  async function filteredLifetime({ hold = false, stop, attack = 0, filter = true }: { hold?: boolean; stop?: number; attack?: number; filter?: boolean } = {}) {
    const pcm = new Float32Array(480);
    if (filter) pcm[479] = 0.5; else pcm.fill(0.5);
    const wav = writeWav([pcm], 48000, { bits: 32 }), id = sampleId(wav);
    const p = withSource({ type: 'sample', asset: id }, {
      amp: { attack, decay: 0, sustain: 1, release: 0.05 },
      ...(filter ? { filter: { type: 'bandpass', cutoff: 1000, q: 100 } } : {}),
    });
    p.duration = 0.15;
    return host.page.evaluate(async ({ p, id, wav, hold, stop, url }) => {
      const load = new Function('path', 'return import(path)') as (path: string) => Promise<any>;
      const { prepareSampleWavs } = await load(`${url}/engine/samples.js`);
      const { buildPatch } = await load(`${url}/engine/patch.js`);
      const { build } = await load(`${url}/engine/voice.js`);
      const run = async (runtime: boolean) => {
        const ctx = new OfflineAudioContext(1, 24000, 48000);
        const samples = prepareSampleWavs(ctx, p, { [id]: Uint8Array.from(wav) });
        let ended = 0;
        const graph = runtime
          ? build(ctx, ctx.destination, p, { samples, hold, limiter: false, onEnded: () => ended++ }).start(0)
          : buildPatch(ctx, p, { samples, hold, limiter: false });
        if (stop !== undefined) { if (runtime) graph.stop(stop); else graph.release(stop); }
        const end = graph.end;
        const suspended = ctx.suspend(1536 / 48000);
        const rendering = ctx.startRendering();
        await suspended;
        // Dispatch actual ConstantSourceNode.onended callbacks. Rendering alone can finish
        // before Chromium delivers them, hiding an incorrect public-voice disposal time.
        await new Promise(resolve => setTimeout(resolve, 10));
        const endedAtCheckpoint = ended;
        await ctx.resume();
        const output = await rendering;
        await new Promise(resolve => setTimeout(resolve, 10));
        return { pcm: [...output.getChannelData(0)], end, endedAtCheckpoint, ended };
      };
      return { raw: await run(false), runtime: await run(true) };
    }, { p, id, wav: [...wav], hold, stop, url: host.url });
  }

  it('keeps the authored amp lifetime for nonheld sample filter tails after timer callbacks dispatch', async () => {
    const { raw, runtime } = await filteredLifetime();
    expect(Math.max(...raw.pcm.slice(2400, 4800).map(Math.abs))).toBeGreaterThan(0.0001);
    expect(samePcm(runtime.pcm, raw.pcm)).toBe(true);
    expect(raw.end).toBeCloseTo(0.2); expect(runtime.end).toBeCloseTo(0.2);
    expect(runtime.endedAtCheckpoint).toBe(0); expect(runtime.ended).toBe(1);
  });

  it('automatically releases held sample filtering at source exhaustion and cleans up after the release', async () => {
    const { raw, runtime } = await filteredLifetime({ hold: true });
    expect(Math.max(...raw.pcm.slice(960, 2400).map(Math.abs))).toBeGreaterThan(0.0001);
    expect(samePcm(runtime.pcm, raw.pcm)).toBe(true);
    expect(raw.end).toBeCloseTo(0.06); expect(runtime.end).toBeCloseTo(0.06);
    expect(runtime.endedAtCheckpoint).toBe(0); expect(runtime.ended).toBe(1);
    expect(raw.pcm.slice(2880).every(x => x === 0)).toBe(true);
  });

  it('preserves an early attack segment when stop replaces automatic sample release', async () => {
    const { raw, runtime } = await filteredLifetime({ hold: true, stop: 0.005, attack: 0.1, filter: false });
    expect(samePcm(runtime.pcm, raw.pcm)).toBe(true);
    expect(runtime.end).toBeCloseTo(0.055);
    for (const frame of [24, 120, 239]) expect(runtime.pcm[frame]).toBeCloseTo(0.5 * frame / 4800, 7);
    for (const frame of [240, 360, 479]) expect(runtime.pcm[frame]).toBeCloseTo(0.025 * (2640 - frame) / 2400, 7);
  });

  it('does not restart or extend the automatic release when stop arrives after it began', async () => {
    const baseline = await filteredLifetime({ hold: true });
    const lateStop = await filteredLifetime({ hold: true, stop: 0.03 });
    expect(lateStop.raw.end).toBeCloseTo(0.06); expect(lateStop.runtime.end).toBeCloseTo(0.06);
    expect(samePcm(lateStop.raw.pcm, baseline.raw.pcm)).toBe(true);
    expect(samePcm(lateStop.runtime.pcm, baseline.runtime.pcm)).toBe(true);
  });

  it('automatically releases a sample shorter than its attack without a later attack ramp reviving the filter', async () => {
    const { raw, runtime } = await filteredLifetime({ hold: true, attack: 0.1 });
    expect(runtime.end).toBeCloseTo(0.06);
    expect(samePcm(runtime.pcm, raw.pcm)).toBe(true);
    expect(Math.max(...raw.pcm.slice(960, 2400).map(Math.abs))).toBeGreaterThan(0.00001);
    expect(raw.pcm.slice(2880).every(x => x === 0)).toBe(true);
  });
});
