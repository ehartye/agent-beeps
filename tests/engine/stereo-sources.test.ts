import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPatch } from '../../runtime/engine/patch.js';
import { renderKey } from '../../src/hash.ts';
import { chromiumAvailable, openRenderHost, type RenderHost } from '../../src/render/host.ts';
import { parsePatch } from '../../src/schema/patch.ts';
import { FakeContext, asCtx } from '../helpers/fake-context.ts';
import { patch, withSource } from '../helpers/patches.ts';

const NOISE = { type: 'noise', color: 'pink' };
const GRAINS = { type: 'grains', rate: 400, grainDecay: 0.004, center: 3000, q: 1 };
const sources = (extra: Record<string, unknown>) => [{ ...NOISE, ...extra }, { ...GRAINS, ...extra }];

const bufferOf = (src: Record<string, unknown>) => {
  const f = new FakeContext();
  buildPatch(asCtx(f), withSource(src), { seed: 1 });
  return f.nodes('bufferSource')[0].buffer as { numberOfChannels: number; getChannelData(c: number): Float32Array };
};

function correlation(a: Float32Array, b: Float32Array) {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return ab / Math.sqrt(aa * bb);
}

describe('stereo noise and grains: schema', () => {
  it.each(sources({}))('accepts stereo true, false and a width 0..1 on $type', src => {
    for (const stereo of [true, false, 0, 0.5, 1]) expect(parsePatch({ schema: 'beeps/patch@1', name: 'x', family: 'x', duration: 0.2, layers: [{ source: { ...src, stereo }, amp: {} }] }).ok).toBe(true);
  });
  it.each(sources({}))('rejects stereo outside 0..1 or of the wrong type on $type', src => {
    for (const stereo of [1.5, -0.1, 'wide']) expect(parsePatch({ schema: 'beeps/patch@1', name: 'x', family: 'x', duration: 0.2, layers: [{ source: { ...src, stereo }, amp: {} }] }).ok).toBe(false);
  });
  it('leaves no stereo key on a parsed patch that does not use it, so its render key cannot move', () => {
    const p = withSource(NOISE);
    expect('stereo' in (p.layers[0].source as object)).toBe(false);
    expect(renderKey(p, { seed: 1, variant: 0, pipeline: 2 })).toBe(renderKey(JSON.parse(JSON.stringify(p)), { seed: 1, variant: 0, pipeline: 2 }));
  });
});

describe('stereo noise and grains: graph', () => {
  it.each(sources({}))('stays a one-channel buffer by default and with stereo false on $type', src => {
    expect(bufferOf(src).numberOfChannels).toBe(1);
    expect(bufferOf({ ...src, stereo: false }).numberOfChannels).toBe(1);
    expect(bufferOf({ ...src, stereo: 0 }).numberOfChannels).toBe(1);
  });
  it.each(sources({ stereo: true }))('builds two decorrelated channels on $type, left identical to the mono buffer', src => {
    const mono = bufferOf({ ...src, stereo: undefined });
    const st = bufferOf(src);
    expect(st.numberOfChannels).toBe(2);
    expect(Array.from(st.getChannelData(0).slice(0, 2000))).toEqual(Array.from(mono.getChannelData(0).slice(0, 2000)));
    expect(Math.abs(correlation(st.getChannelData(0), st.getChannelData(1)))).toBeLessThan(0.1);
  });
  it('width sets the channel correlation to sqrt(1 - width)', () => {
    const b = bufferOf({ ...NOISE, stereo: 0.75 });
    expect(correlation(b.getChannelData(0), b.getChannelData(1))).toBeCloseTo(0.5, 1);
  });
  it('is deterministic for a seed', () => {
    const a = bufferOf({ ...GRAINS, stereo: 1 }), b = bufferOf({ ...GRAINS, stereo: 1 });
    expect(Buffer.from(a.getChannelData(1).buffer).equals(Buffer.from(b.getChannelData(1).buffer))).toBe(true);
  });
});

describe.skipIf(!(await chromiumAvailable()))('stereo noise and grains: rendered', () => {
  let host: RenderHost;
  beforeAll(async () => { host = await openRenderHost(); });
  afterAll(async () => { await host?.close(); });
  const make = (source: Record<string, unknown>) => patch({
    schema: 'beeps/patch@1', name: 'bed', family: 'ambience', duration: 0.5,
    layers: [{ source, amp: { attack: 0.01, decay: 0, sustain: 1, release: 0.01 } }],
  });
  const render = async (source: Record<string, unknown>) => {
    const [r] = await host.render([{ patch: make(source), opts: { seed: 1 } }]);
    if (!r.ok) throw new Error(r.error);
    return r.authored;
  };

  it.each(sources({}))('widens $type from fully correlated to decorrelated and leaves the left channel as the mono render', async src => {
    const mono = await render(src);
    const wide = await render({ ...src, stereo: true });
    expect(correlation(mono[0], mono[1])).toBeCloseTo(1, 5);
    expect(Math.abs(correlation(wide[0], wide[1]))).toBeLessThan(0.15);
    // Left is the mono signal; the bandpass may round differently on a two-channel input, so compare to float tolerance.
    expect(Math.max(...wide[0].map((x, n) => Math.abs(x - mono[0][n])))).toBeLessThan(1e-5);
  });
});
