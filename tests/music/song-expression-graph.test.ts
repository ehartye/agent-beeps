import { describe, expect, it } from 'vitest';
import { buildSong, songTail } from '../../runtime/engine/song.js';
import { buildLayer } from '../../runtime/engine/layer.js';
import { scheduleNoteExpression } from '../../runtime/engine/expression.js';
import { patch } from '../helpers/patches.ts';
import { PAD, song } from '../helpers/songs.ts';
import { FakeContext, asCtx } from '../helpers/fake-context.ts';

const instrument = () => patch({ ...PAD, xRuntime: {
  inputs: { touch: { min: 0, max: 100, default: 50 } },
  bind: [
    { input: 'touch', target: '/layers/0/filter/cutoff', range: [-1, 1] },
    { input: 'touch', target: '/layers/0/amp/attack', range: [1, -1] },
    { input: 'touch', target: '/layers/0/amp/release', range: [-1, 1] },
  ],
} });
const score = () => song({ tracks: { keys: { instrument: 'keys' } },
  patterns: { phrase: { bars: 1, notes: [[0, 'C4', .5, 0], [2, 'C4', .5, 1]] } },
  sections: { a: { bars: 1, play: { keys: 'phrase' } } }, form: ['a'] });

describe('expressive song graph', () => {
  it('maps performed velocity across a named input range and changes tone and attack', () => {
    const s = score(); s.tracks.keys.velocityInput = 'touch';
    const p = instrument(); const before = structuredClone(p); const f = new FakeContext();
    buildSong(asCtx(f), s, { keys: p });
    expect(f.nodes('biquad').map(n => n.frequency.value)).toEqual([1000, 4000]);
    const attacks = f.nodes('gain').flatMap(n => n.gain.events.filter((e: { kind: string; value: number }) => e.kind === 'linear' && e.value === 1).map((e: { time: number }) => e.time));
    expect(attacks).toContain(.4); expect(attacks).toContain(1.1);
    expect(p).toEqual(before);
  });

  it('keeps existing graph behavior when no velocity input is selected', () => {
    const f = new FakeContext(); buildSong(asCtx(f), score(), { keys: instrument() });
    expect(f.nodes('biquad').map(n => n.frequency.value)).toEqual([2000, 2000]);
  });

  it('sizes the song tail for velocity-dependent releases', () => {
    const s = score(); s.tracks.keys.velocityInput = 'touch';
    expect(songTail(s, { keys: instrument() })).toBeCloseTo(2.1, 6);
  });

  it('fails on undeclared velocity inputs and shared-effect bindings', () => {
    const s = score(); s.tracks.keys.velocityInput = 'missing';
    expect(() => buildSong(asCtx(new FakeContext()), s, { keys: instrument() })).toThrow(/missing.*input|input.*missing/i);
    s.tracks.keys.velocityInput = 'touch'; const p = instrument();
    p.fx = { reverb: { preset: 'room', sendDb: -12 } };
    p.xRuntime!.bind.push({ input: 'touch', target: '/fx/reverb/sendDb', range: [-6, 0] });
    expect(() => buildSong(asCtx(new FakeContext()), s, { keys: p })).toThrow(/shared|effect/i);
  });

  it('schedules independent pitch and brightness controls without replacing patch envelopes', () => {
    const p = patch({ ...PAD, layers: [{ ...PAD.layers[0], pitchEnv: [{ at: .2, to: 'D4' }], filter: { type: 'lowpass', cutoff: 1200, env: { to: 3000, time: .3 } } }] });
    const f = new FakeContext(); const layer = buildLayer(asCtx(f), p.layers[0], { when: 10, duration: 2, seed: 1, out: asCtx(f).destination });
    scheduleNoteExpression(layer.nodes, { pitch: [[0, -2], [.5, 0], [1, 1, 'step']], brightness: [[0, -1], [1, .5]] }, 10);
    expect(f.nodes('osc')[0].detune.events).toEqual([
      { kind: 'set', value: -200, time: 10 }, { kind: 'linear', value: 0, time: 10.5 }, { kind: 'set', value: 100, time: 11 },
    ]);
    expect(f.nodes('biquad')[0].detune.events).toEqual([{ kind: 'set', value: -1200, time: 10 }, { kind: 'linear', value: 600, time: 11 }]);
    expect(f.nodes('osc')[0].frequency.events.some((e: { kind: string; time: number }) => e.kind === 'exponential' && e.time === 10.2)).toBe(true);
    expect(f.nodes('biquad')[0].frequency.events.some((e: { kind: string; time: number }) => e.kind === 'exponential' && e.time === 10.3)).toBe(true);
  });

  it('bends modal resonators while retaining their frequency envelopes', () => {
    const p = patch({ ...PAD, layers: [{ source: { type: 'modal', pitch: 'C4', modes: [[1, 10, 0], [2, 10, -6]], exciter: 'impulse' },
      amp: { attack: .001, decay: .2, sustain: 0, release: .2 }, pitchEnv: [{ at: .1, to: 'D4' }] }] });
    const f = new FakeContext();
    const layer = buildLayer(asCtx(f), p.layers[0], { when: 0, duration: 1, seed: 1, out: asCtx(f).destination });
    scheduleNoteExpression(layer.nodes, { pitch: [[0, 0], [.5, 2]] }, 0);
    for (const mode of f.nodes('biquad')) {
      expect(mode.detune.events).toEqual([{ kind: 'set', value: 0, time: 0 }, { kind: 'linear', value: 200, time: .5 }]);
      expect(mode.frequency.events.length).toBeGreaterThan(0);
    }
  });
});
