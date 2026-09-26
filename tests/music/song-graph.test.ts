import { describe, expect, it } from 'vitest';
import { buildSong, instrumentRoot, songTail, transposePatch } from '../../runtime/engine/song.js';
import { noteToHz } from '../../runtime/engine/notes.js';
import { FakeContext, asCtx } from '../helpers/fake-context.ts';
import { patch } from '../helpers/patches.ts';
import { HAT, PAD, song } from '../helpers/songs.ts';

const instruments = () => ({ pad: patch(PAD), hat: patch(HAT) });

describe('song engine', () => {
  it('finds an instrument root from its first pitched layer', () => {
    expect(instrumentRoot(patch(HAT))).toBeNull();
    expect(instrumentRoot(patch(PAD))).toBeCloseTo(60, 5);
  });

  it('transposes every pitch and keytracks filters', () => {
    const t = transposePatch(patch({ ...PAD, layers: [{ ...PAD.layers[0], pitchEnv: [{ at: 0.1, to: 'C5' }] }] }), 12, 1, 0.5);
    expect(t.layers[0].source).toMatchObject({ pitch: expect.closeTo(noteToHz('C5'), 3) });
    expect(Number(t.layers[0].pitchEnv![0].to)).toBeCloseTo(noteToHz('C6'), 3);
    expect(t.layers[0].filter!.cutoff).toBeCloseTo(4000, 3);
    expect(t.duration).toBe(0.5);
  });

  it('plays one oscillator per chord tone, at each chord tone pitch', () => {
    const f = new FakeContext();
    buildSong(asCtx(f), song(), instruments());
    const freqs = f.nodes('osc').map(o => Math.round(o.frequency.value));
    for (const n of ['C4', 'E4', 'G4', 'F4', 'A4']) expect(freqs).toContain(Math.round(noteToHz(n)));
    expect(f.nodes('osc')).toHaveLength(6);
  });

  it('shares one noise buffer across repeated hats', () => {
    const f = new FakeContext();
    buildSong(asCtx(f), song(), instruments());
    const buffers = new Set(f.nodes('bufferSource').map(b => b.buffer));
    expect(f.nodes('bufferSource').length).toBe(16);
    expect(buffers.size).toBeLessThanOrEqual(8);
  });

  it('builds one master reverb, not one per note', () => {
    const f = new FakeContext();
    buildSong(asCtx(f), song({ master: { reverb: { preset: 'space' } }, tracks: { pad: { instrument: 'pad', sends: { reverb: -6 } }, hat: { instrument: 'hat' } } }), instruments());
    expect(f.count('convolver')).toBe(1);
  });

  it('automates a track level across a ramped section', () => {
    const f = new FakeContext();
    buildSong(asCtx(f), song({ sections: { a: { bars: 2, play: { pad: 'pad-a' } }, b: { bars: 2, play: { pad: 'pad-a' }, mix: { pad: { gainDb: -20 } }, ramp: true } }, form: ['a', 'b'] }), instruments());
    expect(f.rampTargets('linear')).toContainEqual(expect.closeTo(10 ** (-20 / 20), 5));
  });

  it('reports a tail long enough for the reverb', () => {
    const s = song({ master: { reverb: { preset: 'space' } } });
    expect(songTail(s, instruments())).toBeGreaterThan(7);
  });

  it('automates reverb sends and pan from section mixes', () => {
    const f = new FakeContext();
    buildSong(asCtx(f), song({ master: { reverb: { preset: 'hall' } }, tracks: { pad: { instrument: 'pad', sends: { reverb: -20 } }, hat: { instrument: 'hat' } }, sections: { a: { bars: 2, play: { pad: 'pad-a' } }, b: { bars: 2, play: { pad: 'pad-a' }, mix: { pad: { pan: 0.5, sends: { reverb: -2 } } }, ramp: true } }, form: ['a', 'b'] }), instruments());
    expect(f.rampTargets('linear')).toContainEqual(expect.closeTo(10 ** (-2 / 20), 5));
    expect(f.rampTargets('linear')).toContainEqual(0.5);
  });
});

