import { describe, expect, it } from 'vitest';
import { buildPatch } from '../../runtime/engine/patch.js';
import { buildSource } from '../../runtime/engine/sources.js';
import { build } from '../../runtime/engine/voice.js';
import { FakeContext, asCtx } from '../helpers/fake-context.ts';
import { patch, withSource } from '../helpers/patches.ts';

const asset = `sha256:${'a'.repeat(64)}`;
const sample = () => withSource({ type: 'sample', asset }, { amp: { attack: 0, decay: 0, sustain: 1, release: 0.05 }, start: 0.025 });
const buffer = (f: FakeContext) => f.createBuffer(2, 4800, 48000) as unknown as AudioBuffer;

describe('sample graph source', () => {
  it('fails atomically when a later sample is missing, including runtime start', () => {
    const p = patch({ ...sample(), layers: [withSource({ type: 'osc', wave: 'sine', pitch: 220 }).layers[0], sample().layers[0]] });
    for (const runtime of [false, true]) {
      const f = new FakeContext();
      const voice = build(asCtx(f), f.destination as unknown as AudioNode, p, { hold: true });
      expect(() => runtime ? voice.start() : buildPatch(asCtx(f), p, { hold: true })).toThrow(/missing.*sample|sample.*missing/i);
      expect(f.created).toEqual([]);
      expect(voice.started).toBe(false);
    }
  });
  it.each([{ sampleRate: 44100 }, { numberOfChannels: 3 }, { numberOfChannels: 0 }, { length: 0 }, { length: 480001 }, { length: 1.1 }])('preflights invalid buffer dimensions %j', bad => {
    const f = new FakeContext(), b = Object.assign(buffer(f), bad);
    expect(() => buildPatch(asCtx(f), sample(), { samples: { [asset]: b } })).toThrow(/sample.*48|sample.*channel|sample.*frame/i);
    expect(f.created).toEqual([]);
  });
  it('guards standalone source construction too', () => {
    const f = new FakeContext();
    expect(() => buildSource(asCtx(f), sample().layers[0].source, { pitchHz: 440, seed: 1, length: 1 })).toThrow(/missing.*sample|sample.*missing/i);
    expect(f.created).toEqual([]);
  });
  it('shares immutable buffers across independent original-rate one-shot sources', () => {
    const f = new FakeContext(), b = buffer(f), p = sample();
    p.variation = { pitchCents: 1200, gainDb: 0, variants: 2, noRepeat: true };
    const a = buildPatch(asCtx(f), p, { samples: { [asset]: b }, when: 1, hold: true, variant: 1 });
    const c = buildPatch(asCtx(f), p, { samples: { [asset]: b }, when: 1.05, hold: true });
    const [first, second] = f.nodes('bufferSource');
    expect(first).not.toBe(second);
    expect(first.buffer).toBe(b); expect(second.buffer).toBe(b);
    expect([first.startedAt, second.startedAt]).toEqual([1.025, 1.075]);
    expect(first.loop).toBe(false);
    expect(first.playbackRate.value).toBe(1); expect(first.playbackRate.events).toEqual([]);
    expect(first.detune.events).toEqual([]);
    expect(a.nodes.layers[0].detune).toEqual([]);
    expect(a.end).toBeCloseTo(1.175); expect(c.end).toBeCloseTo(1.225);
    a.dispose();
    expect(first.stoppedAt).toBe(0); expect(second.stoppedAt).toBeUndefined();
  });
  it('passes prepared samples through the public voice and automatically releases finite samples', () => {
    const f = new FakeContext(), b = buffer(f);
    const v = build(asCtx(f), f.destination as unknown as AudioNode, sample(), { samples: { [asset]: b }, hold: true }).start(1);
    expect(f.nodes('bufferSource')[0].buffer).toBe(b);
    expect(v.end).toBeCloseTo(1.175);
    expect(v.stop(1.1)).toBeCloseTo(1.15);
  });
  it('does not extend a completed automatic release when an ended callback has not dispatched yet', () => {
    const f = new FakeContext(), b = buffer(f);
    const v = build(asCtx(f), f.destination as unknown as AudioNode, sample(), { samples: { [asset]: b }, hold: true }).start(1);
    expect(v.stop(2)).toBeCloseTo(1.175);
  });
});
