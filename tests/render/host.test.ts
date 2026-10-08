import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromiumAvailable, openRenderHost, type RenderHost, type RenderResult } from '../../src/render/host.ts';
import { readWav, writeWav } from '../../src/audio/wav.ts';
import { momentaryMax } from '../../src/measure/loudness.ts';
import { coin, patch, tone, withSource } from '../helpers/patches.ts';

const peak = (a: Float32Array) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const rms = (a: Float32Array, from = 0, to = a.length) => Math.sqrt(a.slice(from, to).reduce((s, x) => s + x * x, 0) / Math.max(1, to - from));
const ok = (r: RenderResult) => { if (!r.ok) throw new Error(r.error); return r; };

describe('wav', () => {
  it('round-trips 16-bit and 32-bit float', () => {
    const l = Float32Array.from({ length: 480 }, (_, i) => Math.sin(i / 10) * 0.5);
    const r = Float32Array.from(l, x => -x);
    const back16 = readWav(writeWav([l, r], 48000));
    expect(back16.sampleRate).toBe(48000);
    back16.channels[0].forEach((x, i) => expect(Math.abs(x - l[i])).toBeLessThan(1 / 16000));
    const back32 = readWav(writeWav([l, r], 48000, { bits: 32 }));
    expect(back32.channels[1]).toEqual(r);
  });
});

describe.skipIf(!(await chromiumAvailable()))('Chromium offline render', () => {
  let host: RenderHost;
  beforeAll(async () => { host = await openRenderHost(); });
  afterAll(async () => { await host?.close(); });

  it('renders deterministically for a seed', async () => {
    const [a, b] = (await host.render([{ patch: coin(), opts: { seed: 5 } }, { patch: coin(), opts: { seed: 5 } }])).map(ok);
    expect(a.delivered[0].length).toBeGreaterThan(48000 * 0.3);
    expect(a.delivered[0]).toEqual(b.delivered[0]);
    expect(peak(a.authored[0])).toBeGreaterThan(0.1);
  });

  it('fx.dcBlock removes the DC a swept sine thump and a lowpassed brown noise leave, at the same loudness; dcBlock false changes nothing', async () => {
    const boom = (fx?: Record<string, unknown>) => patch({
      schema: 'beeps/patch@1', name: 'dc-boom', family: 'explosion', duration: 0.45, ...(fx ? { fx } : {}),
      layers: [
        { source: { type: 'osc', wave: 'sine', pitch: 'G2' }, pitchEnv: [{ at: 0, to: 'G2' }, { at: 0.22, to: 'G1', curve: 'exp' }], amp: { attack: 0.004, decay: 0.22, sustain: 0, release: 0.08 } },
        { source: { type: 'noise', color: 'brown' }, amp: { attack: 0.004, decay: 0.3, sustain: 0, release: 0.1 }, filter: { type: 'lowpass', cutoff: 900, resonanceDb: 0 }, gainDb: -2 },
      ],
    });
    const dc = (x: Float32Array) => Math.abs(x.reduce((s, v) => s + v, 0) / x.length);
    const [plain, off, blocked] = (await host.render([boom(), boom({ dcBlock: false }), boom({ dcBlock: true })].map(p => ({ patch: p, opts: { seed: 1 } })))).map(ok);
    expect(dc(plain.authored[0])).toBeGreaterThan(0.001);
    expect(dc(blocked.authored[0])).toBeLessThan(0.0002);
    expect(Math.abs(momentaryMax(blocked.authored, 48000) - momentaryMax(plain.authored, 48000))).toBeLessThan(0.5);
    expect(off.delivered[0].length).toBe(plain.delivered[0].length);
    for (let i = 0; i < plain.delivered[0].length; i += 1) expect(Math.abs(off.delivered[0][i] - plain.delivered[0][i])).toBeLessThan(1e-6);
  });

  it('a layer highpass takes the DC off a short low sine and a lowpassed noise burst, keeping the lowpass; absent, renders are unchanged', async () => {
    const burst = (extra: Record<string, unknown> = {}) => patch({
      schema: 'beeps/patch@1', name: 'dc-thud', family: 'foley', duration: 0.2,
      layers: [
        { source: { type: 'osc', wave: 'sine', pitch: 70 }, amp: { attack: 0.004, decay: 0.09, sustain: 0, release: 0.02 }, ...extra },
        { source: { type: 'noise', color: 'brown' }, amp: { attack: 0.004, decay: 0.09, sustain: 0, release: 0.02 }, filter: { type: 'lowpass', cutoff: 400, resonanceDb: 0 }, ...extra },
      ],
    });
    const dc = (x: Float32Array) => Math.abs(x.reduce((s, v) => s + v, 0) / x.length);
    const [plain, hp] = (await host.render([burst(), burst({ highpass: 40 })].map(p => ({ patch: p, opts: { seed: 1 } })))).map(ok);
    expect(dc(plain.authored[0])).toBeGreaterThan(0.001);
    expect(dc(hp.authored[0])).toBeLessThan(0.001);
  });

  it('band-limits oscillators: a 6 kHz sawtooth peaks near 0.74, not 1', async () => {
    const [saw] = (await host.render([{ patch: tone('sawtooth', 6000), opts: { seed: 1 } }])).map(ok);
    const p = peak(saw.authored[0]);
    expect(p).toBeGreaterThan(0.68);
    expect(p).toBeLessThan(0.8);
  });

  it('shows a gain literal is not a loudness: a Q 5 bandpass far from the tone passes a sliver', async () => {
    const [open, narrow] = (await host.render([
      { patch: tone('triangle', 220), opts: { seed: 1 } },
      { patch: tone('triangle', 220, { filter: { type: 'bandpass', cutoff: 3000, q: 5 } }), opts: { seed: 1 } },
    ])).map(ok);
    expect(rms(narrow.authored[0])).toBeLessThan(rms(open.authored[0]) / 10);
  });

  it('applies the trim to the delivered tap only', async () => {
    const [flat, trimmed] = (await host.render([{ patch: coin(), opts: { seed: 1, trimDb: -12 } }, { patch: coin(), opts: { seed: 1, trimDb: -24 } }])).map(ok); // both below the limiter threshold
    expect(trimmed.authored[0]).toEqual(flat.authored[0]);
    expect(rms(trimmed.delivered[0])).toBeCloseTo(rms(flat.delivered[0]) * 10 ** (-12 / 20), 3);
  });

  it('keeps the safety clipper transparent below its knee and under the ceiling above it', async () => {
    const [quiet, hot] = (await host.render([{ patch: coin(), opts: { seed: 1, trimDb: -30 } }, { patch: coin(), opts: { seed: 1, trimDb: 12 } }])).map(ok);
    const expected = quiet.authored[0].map(x => x * 10 ** (-30 / 20));
    let maxErr = 0;
    quiet.delivered[0].forEach((x, i) => { maxErr = Math.max(maxErr, Math.abs(x - expected[i])); });
    expect(maxErr).toBeLessThan(1e-5);
    expect(momentaryMax(quiet.delivered, 48000)).toBeCloseTo(momentaryMax(quiet.authored, 48000) - 30, 2);
    expect(peak(hot.delivered[0])).toBeLessThan(10 ** (-0.9 / 20));
  });

  it('renders every source type to non-silent audio', async () => {
    const sources = [
      { type: 'noise', color: 'pink' },
      { type: 'fm', pitch: 220, operators: [{ ratio: 1 }, { ratio: 2, index: 3 }], algorithm: [[1, 0]] },
      { type: 'additive', pitch: 440, partials: [[1, 0, 0.5], [2, -6, 0.3]] },
      { type: 'modal', pitch: 600, modes: [[1, 30, 0], [2.76, 40, -6]], exciter: 'impulse' },
      { type: 'grains', rate: 80, grainDecay: 0.004, center: 3000, q: 2 },
      { type: 'metal', bands: [3440, 7100] },
    ];
    const results = (await host.render(sources.map(s => ({ patch: withSource(s), opts: { seed: 2 } })))).map(ok);
    results.forEach((r, i) => expect(peak(r.authored[0]), sources[i].type).toBeGreaterThan(0.01));
  });

  it('keeps reverb tails in the render', async () => {
    const [dry, wet] = (await host.render([
      { patch: coin(), opts: { seed: 1 } },
      { patch: patch({ ...coin(), fx: { reverb: { preset: 'hall', sendDb: -6 } } }), opts: { seed: 1 } },
    ])).map(ok);
    expect(wet.authored[0].length).toBeGreaterThan(dry.authored[0].length + 48000);
    const late = Math.floor(48000 * 0.6);
    expect(rms(wet.authored[0], late, late + 4800)).toBeGreaterThan(rms(dry.authored[0], late - 4800, late) + 1e-4);
  });

  it('fails a bad item alone', async () => {
    const bad: any = coin();
    bad.layers[0].source.pitch = 'not-a-note';
    const [good, broken] = await host.render([{ patch: coin(), opts: {} }, { patch: bad, opts: {} }]);
    expect(good.ok).toBe(true);
    expect(broken.ok).toBe(false);
  });
});
