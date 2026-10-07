// Chromium sums the connections into one input in an order that changes between runs, and float addition of three
// or more terms is order-dependent: no input or AudioParam in a built graph may receive more than two connections.
// tests/render/determinism.test.ts proves the effect in Chromium; this is the fast structural guard.
import { describe, expect, it } from 'vitest';
import { buildPatch } from '../../runtime/engine/patch.js';
import { buildSong } from '../../runtime/engine/song.js';
import { sumNodes, voicePool } from '../../runtime/engine/sum.js';
import { FakeContext, asCtx } from '../helpers/fake-context.ts';
import { patch } from '../helpers/patches.ts';
import { HAT, PAD, song } from '../helpers/songs.ts';

const amp = { attack: 0.004, decay: 0.3, sustain: 0, release: 0.1 };

describe('fixed-order sums', () => {
  it('sumNodes chains gains left to right, two inputs each', () => {
    const f = new FakeContext();
    const ins = [f.createGain(), f.createGain(), f.createGain(), f.createGain()];
    const out = sumNodes(asCtx(f), ins as any) as any;
    expect(f.maxFanIn()).toBe(2);
    expect(out.kind).toBe('gain');
    expect(ins[3].outputs).toEqual([out]);
    expect(sumNodes(asCtx(f), [ins[0]] as any)).toBe(ins[0]);
  });

  it('voicePool reuses a slot once its note has ended and splices new slots onto the chain', () => {
    const f = new FakeContext();
    const dest = f.createGain();
    const pool = voicePool(asCtx(f), dest as any);
    const a = pool.slot(0, 1), b = pool.slot(0.5, 1.5), c = pool.slot(1, 2), d = pool.slot(1.2, 2.2);
    expect(c).toBe(a);
    expect([a, b, d].length).toBe(new Set([a, b, d]).size);
    expect(pool.size).toBe(3);
    expect(f.maxFanIn()).toBe(2);
    expect(f.created.filter(n => n.outputs.includes(dest))).toHaveLength(1);
  });

  it('a patch with many layers, voices, partials, operators and both effects has no input with more than two connections', () => {
    const f = new FakeContext();
    buildPatch(asCtx(f), patch({
      schema: 'beeps/patch@1', name: 'wide', family: 'explosion', duration: 0.4,
      fx: { reverb: { preset: 'room', sendDb: -6 }, delay: { time: 0.1, feedback: 0.3, sendDb: -8 } },
      layers: [
        { source: { type: 'osc', wave: 'sawtooth', pitch: 'C4', unison: { voices: 5, detuneCents: 20 } }, amp },
        { source: { type: 'noise', color: 'brown' }, amp },
        { source: { type: 'metal' }, amp },
        { source: { type: 'additive', pitch: 'C5', partials: [[1, 0, 0.3], [2, -6, 0.2], [3, -9, 0.1]] }, amp },
        { source: { type: 'modal', pitch: 'C4', modes: [[1, 40, 0], [2.3, 50, -6], [3.9, 60, -9]] }, amp },
        { source: { type: 'fm', pitch: 'C3', operators: [{ ratio: 1 }, { ratio: 2 }, { ratio: 3 }, { ratio: 4 }], algorithm: [[1, 0], [2, 0], [3, 0]] }, amp },
        { source: { type: 'grains', rate: 100, grainDecay: 0.01, center: 2000 }, amp },
      ],
    }), { seed: 1 });
    expect(f.maxFanIn()).toBeLessThanOrEqual(2);
  });

  it('a song with overlapping notes, three tracks and both master effects has no input with more than two connections', () => {
    const f = new FakeContext();
    const s = song({
      master: { reverb: { preset: 'room' }, delay: { beats: 0.75 } },
      tracks: { pad: { instrument: PAD, sends: { reverb: -6, delay: -8 } }, hat: { instrument: HAT, sends: { reverb: -10 } }, lead: { instrument: PAD, sends: { delay: -6 } } },
      patterns: { 'pad-a': { bars: 2, chords: { progression: 'a', octave: 4 } }, 'hat-a': { bars: 1, steps: 'x.x.x.x.x.x.x.x.' }, 'lead-a': { bars: 2, chords: { progression: 'a', octave: 5 } } },
      sections: { a: { bars: 2, play: { pad: 'pad-a', hat: 'hat-a', lead: 'lead-a' } } },
    });
    buildSong(asCtx(f), s, { pad: patch(PAD), hat: patch(HAT), lead: patch(PAD) });
    // Voice-pool slots take many notes over time; a finished note adds exact zeros, so what must hold is that
    // at most two of a slot's notes are scheduled (start to stop) at any instant.
    const into = new Map<object, any[]>();
    for (const n of f.created) for (const o of n.outputs) into.set(o, [...(into.get(o) ?? []), n]);
    const windows = (n: any, seen = new Set()): [number, number][] => {
      if (seen.has(n)) return [];
      seen.add(n);
      const own: [number, number][] = n.startedAt !== undefined ? [[n.startedAt, n.stoppedAt ?? Infinity]] : [];
      return [...own, ...(into.get(n) ?? []).flatMap(u => windows(u, seen))];
    };
    const crowded = [...into].filter(([, from]) => from.length > 2);
    expect(crowded.length).toBeGreaterThan(0); // the pads overlap, so slots are reused
    for (const [, from] of crowded) {
      const notes = from.map(n => { const w = windows(n); return [Math.min(...w.map(x => x[0])), Math.max(...w.map(x => x[1]))]; });
      for (const [t] of notes) expect(notes.filter(([a, b]) => a <= t && t < b).length).toBeLessThanOrEqual(2);
    }
  });
});
