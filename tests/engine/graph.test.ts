import { describe, expect, it } from 'vitest';
import { buildPatch } from '../../runtime/engine/patch.js';
import { envelopeAt } from '../../runtime/engine/layer.js';
import { createPicker, variantPatch } from '../../runtime/engine/variation.js';
import { impulseResponse } from '../../runtime/engine/fx.js';
import { noteToHz } from '../../runtime/engine/notes.js';
import { FakeContext, asCtx } from '../helpers/fake-context.ts';
import { coin, patch, tone, withSource } from '../helpers/patches.ts';

const build = (p: ReturnType<typeof coin>, opts: Record<string, unknown> = {}) => {
  const f = new FakeContext();
  const g = buildPatch(asCtx(f), p, { seed: 1, ...opts });
  return { f, g };
};

describe('buildPatch', () => {
  it('ends after the duration plus the release', () => {
    const { g } = build(coin());
    expect(g.end).toBeCloseTo(0.3 + 0.05, 5);
  });

  it('steps the coin pitch with the envelope', () => {
    const { f } = build(coin());
    const osc = f.nodes('osc')[0];
    expect(osc.frequency.events[0]).toMatchObject({ kind: 'set', value: expect.closeTo(noteToHz('E6'), 3), time: 0 });
    expect(osc.frequency.events[1]).toMatchObject({ kind: 'set', value: expect.closeTo(noteToHz('B6'), 3), time: 0.06 });
  });

  it('writes resonanceDb straight into a lowpass Q and q into a bandpass Q', () => {
    const lp = build(tone('sine', 440, { filter: { type: 'lowpass', cutoff: 2000, resonanceDb: 6 } })).f.nodes('biquad')[0];
    expect(lp.type).toBe('lowpass');
    expect(lp.Q.value).toBe(6);
    const bp = build(tone('sine', 440, { filter: { type: 'bandpass', cutoff: 2000, q: 5 } })).f.nodes('biquad')[0];
    expect(bp.Q.value).toBe(5);
  });

  it('spreads unison detune so voices do not start in phase', () => {
    const { f } = build(withSource({ type: 'osc', wave: 'sawtooth', pitch: 110, unison: { voices: 3, detuneCents: 20 } }));
    expect(f.nodes('osc').map(o => o.detune.value)).toEqual([-10, 0, 10]);
  });

  it('builds the 808 metal voice from six squares and two bandpasses', () => {
    const { f } = build(withSource({ type: 'metal', bands: [3440, 7100] }));
    expect(f.nodes('osc').filter(o => o.type === 'square')).toHaveLength(6);
    expect(f.nodes('biquad').filter(b => b.type === 'bandpass').map(b => b.frequency.value)).toEqual([3440, 7100]);
  });

  it('routes FM modulators into the carrier frequency', () => {
    const { f } = build(withSource({ type: 'fm', pitch: 200, operators: [{ ratio: 1 }, { ratio: 2, index: 3 }], algorithm: [[1, 0]] }));
    const [carrier, mod] = f.nodes('osc');
    const depth = mod.outputs[0] as any;
    expect(depth.gain.value).toBe(3 * 200 * 1);
    expect(depth.outputs[0]).toBe(carrier.frequency);
  });

  it('drops additive partials and modal modes above 0.45 of the sample rate', () => {
    const { f } = build(withSource({ type: 'additive', pitch: 10000, partials: [[1, 0, 0.2], [2, -6, 0.2], [3, -12, 0.2]] }));
    expect(f.count('osc')).toBe(2); // 30 kHz dropped
    const m = build(withSource({ type: 'modal', pitch: 12000, modes: [[1, 20, 0], [2, 20, 0]] })).f;
    expect(m.nodes('biquad').filter(b => b.type === 'bandpass')).toHaveLength(1);
  });

  it('never schedules an exponential ramp to zero', () => {
    const { f } = build(patch({ ...coin(), layers: [{ source: { type: 'osc', wave: 'sine', pitch: 400 },
      pitchEnv: [{ at: 0.1, to: 50, curve: 'exp' }], amp: { attack: 0.005, decay: 0.2 },
      filter: { type: 'lowpass', cutoff: 5000, env: { to: 200, time: 0.2 } } }] }));
    expect(f.rampTargets('exponential').every(v => v > 0)).toBe(true);
  });

  it('snaps pitched sources to the project scale', () => {
    const { f } = build(tone('sine', 466.16), { scale: { root: 'C', mode: 'majorPentatonic', snap: true } });
    expect(f.nodes('osc')[0].frequency.value).toBeCloseTo(440, 3);
  });

  it('adds a convolver only when reverb is requested, and a limiter on the delivered path', () => {
    expect(build(coin()).f.count('convolver')).toBe(0);
    const { f, g } = build(patch({ ...coin(), fx: { reverb: { preset: 'room', sendDb: -18 } } }));
    expect(f.count('convolver')).toBe(1);
    expect(f.nodes('shaper')).toHaveLength(1); // the safety clipper
    expect(g.end).toBeGreaterThan(0.35 + 0.9);
  });

  it('applies the trim before the limiter and exposes the authored tap', () => {
    const tap = new FakeContext().createGain();
    const { f, g } = build(coin(), { trimDb: -6, authoredTap: tap });
    const authored = g.authored as any;
    const trim = authored.outputs.find((n: any) => n.kind === 'gain' && n !== tap) as any;
    expect(trim.gain.value).toBeCloseTo(10 ** (-6 / 20));
    expect(trim.outputs[0].kind).toBe('shaper');
    expect(authored.outputs).toContain(tap);
    void f;
  });
});

describe('envelope', () => {
  it('rises linearly, decays toward sustain, holds without decay', () => {
    const amp = { attack: 0.01, decay: 0.3, sustain: 0.2 };
    expect(envelopeAt(amp, 0.005)).toBeCloseTo(0.5);
    expect(envelopeAt(amp, 0.01)).toBeCloseTo(1);
    expect(envelopeAt(amp, 2)).toBeCloseTo(0.2, 2);
    expect(envelopeAt({ attack: 0.01, decay: 0, sustain: 0 }, 1)).toBe(1);
  });
});

describe('variation', () => {
  const varied = () => patch({ ...coin(), variation: { pitchCents: 50, gainDb: 2, variants: 4 } });
  it('keeps variant 0 as written and perturbs others deterministically within range', () => {
    const p = varied();
    expect(variantPatch(p, 0, 1)).toBe(p);
    const a = variantPatch(p, 2, 1), b = variantPatch(p, 2, 1);
    expect(a).toEqual(b);
    const hz = (a.layers[0].source as any).pitch as number;
    const cents = 1200 * Math.log2(hz / noteToHz('E6'));
    expect(Math.abs(cents)).toBeLessThanOrEqual(50);
    expect(Math.abs(a.layers[0].gainDb)).toBeLessThanOrEqual(2);
  });
  it('never repeats a variant back to back and honours weights', () => {
    const picker = createPicker(varied(), 9);
    let last = -1;
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 400; i++) { const v = picker.next(); expect(v).not.toBe(last); last = v; counts[v]++; }
    expect(Math.min(...counts)).toBeGreaterThan(50);
    const weighted = createPicker(patch({ ...coin(), variation: { variants: 3, weights: [1, 1, 0], noRepeat: false } }), 3);
    for (let i = 0; i < 100; i++) expect(weighted.next()).not.toBe(2);
  });
});

describe('generated reverb', () => {
  it('is deterministic, stereo-decorrelated and decays', () => {
    const [l, r] = impulseResponse(48000, 'room', 1);
    expect(impulseResponse(48000, 'room', 1)[0]).toEqual(l);
    expect(l).not.toEqual(r);
    const rms = (a: Float32Array, from: number, to: number) => Math.sqrt(a.slice(from, to).reduce((s, x) => s + x * x, 0) / (to - from));
    expect(rms(l, 48000 * 0.7, 48000 * 0.8)).toBeLessThan(rms(l, 1000, 5800) / 100);
  });
});
