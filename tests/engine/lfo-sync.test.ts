// 0.33.0: an LFO can carry `sync` (cycles per beat). A song plays it at bpm / 60 x sync Hz; every other use plays `rate`.
import { describe, expect, it } from 'vitest';
import { buildLayer } from '../../runtime/engine/layer.js';
import { buildPatch } from '../../runtime/engine/patch.js';
import { buildSong } from '../../runtime/engine/song.js';
import { parsePatch } from '../../src/schema/patch.ts';
import { FakeContext, asCtx } from '../helpers/fake-context.ts';
import { patch } from '../helpers/patches.ts';
import { song } from '../helpers/songs.ts';

const wobbler = (lfo: Record<string, unknown>) => patch({
  schema: 'beeps/patch@1', name: 'wobbler', family: 'music', duration: 0.5,
  layers: [{ source: { type: 'osc', wave: 'sawtooth', pitch: 'C2' }, amp: { attack: 0.01, decay: 0.2, sustain: 0.8, release: 0.1 }, filter: { type: 'lowpass', cutoff: 900, resonanceDb: 0 }, lfo: { target: 'cutoff', depth: 800, ...lfo } }],
});
/** The LFO is the one oscillator running below audio rate; the source runs at the note's pitch. */
const lfoHz = (f: FakeContext) => {
  const slow = f.nodes('osc').filter(o => o.frequency.value < 30);
  expect(slow).toHaveLength(1);
  return slow[0].frequency.value as number;
};

describe('tempo-synced LFO', () => {
  it('runs at bpm / 60 x sync when a tempo is given', () => {
    const f = new FakeContext(); const p = wobbler({ rate: 3, sync: 2 });
    buildLayer(asCtx(f), p.layers[0], { when: 0, duration: 0.5, seed: 1, out: asCtx(f).destination, tempo: 120 });
    expect(lfoHz(f)).toBe(4);
  });

  it('follows the tempo: the same instrument at 140 bpm wobbles faster', () => {
    const f = new FakeContext(); const p = wobbler({ rate: 3, sync: 1.5 });
    buildLayer(asCtx(f), p.layers[0], { when: 0, duration: 0.5, seed: 1, out: asCtx(f).destination, tempo: 140 });
    expect(lfoHz(f)).toBeCloseTo(3.5, 10);
  });

  it('uses rate without a tempo, and for a patch played on its own', () => {
    const a = new FakeContext(); const p = wobbler({ rate: 3, sync: 2 });
    buildLayer(asCtx(a), p.layers[0], { when: 0, duration: 0.5, seed: 1, out: asCtx(a).destination });
    expect(lfoHz(a)).toBe(3);
    const b = new FakeContext(); buildPatch(asCtx(b), p, { seed: 1 });
    expect(lfoHz(b)).toBe(3);
  });

  it('leaves an LFO without sync alone, whatever the tempo', () => {
    const f = new FakeContext(); const p = wobbler({ rate: 3 });
    buildLayer(asCtx(f), p.layers[0], { when: 0, duration: 0.5, seed: 1, out: asCtx(f).destination, tempo: 120 });
    expect(lfoHz(f)).toBe(3);
  });

  it('is used by a song at the song\'s own tempo', () => {
    const s = song({ bpm: 120, tracks: { bass: { instrument: 'bass' } },
      patterns: { line: { bars: 1, notes: [[0, 'C2', 1, 1]] } }, sections: { a: { bars: 1, play: { bass: 'line' } } }, form: ['a'] });
    const f = new FakeContext();
    buildSong(asCtx(f), s, { bass: wobbler({ rate: 3, sync: 2 }) });
    expect(lfoHz(f)).toBe(4); // 120 / 60 x 2, not the rate of 3
  });
});

describe('lfo.sync in the patch schema', () => {
  const lfo = (extra: Record<string, unknown>) => parsePatch({
    schema: 'beeps/patch@1', name: 'w', family: 'music', duration: 0.5,
    layers: [{ source: { type: 'osc', wave: 'sawtooth', pitch: 'C2' }, amp: { attack: 0.01, decay: 0.2, sustain: 0.8, release: 0.1 }, lfo: { target: 'cutoff', rate: 3, depth: 100, ...extra } }],
  });
  it('accepts a positive number of cycles per beat', () => { expect(lfo({ sync: 0.25 }).ok).toBe(true); expect(lfo({ sync: 32 }).ok).toBe(true); });
  it('rejects zero, negative and absurd values with a pointer', () => {
    for (const sync of [0, -1, 33]) {
      const r = lfo({ sync });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues[0].pointer).toBe('/layers/0/lfo/sync');
    }
  });
});
