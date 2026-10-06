import { describe, expect, it } from 'vitest';
import { estimateKey, pairPlan, planScore, planSong, tempoRelation } from '../../src/compat.ts';
import { song } from '../helpers/songs.ts';

const inD = (name: string, bpm: number, prog: [string, number][], bars = 4) => song({
  name, bpm, progressions: { a: prog },
  patterns: { 'pad-a': { bars, chords: { progression: 'a', octave: 4 } }, 'hat-a': { bars: 1, steps: 'x...' } },
  sections: { a: { bars, play: { pad: 'pad-a', hat: 'hat-a' } } },
});

describe('song compat plan', () => {
  it('estimates the key from the written notes', () => {
    const p = planSong(inD('d-minor', 60, [['Dm', 8], ['Gm', 8], ['A7', 8], ['Dm', 8]], 8));
    expect(p.key.tonic).toBe('D');
    expect(p.key.mode).toBe('minor');
    expect(p.bars).toBe(8);
    expect(p.loopSec).toBeCloseTo(32, 3); // 8 bars of 4 beats at 60 bpm
    expect(estimateKey([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]).key).toBe('C major');
  });

  it('relates tempos by simple ratios and rejects unrelated ones', () => {
    expect(tempoRelation(60, 120)).toEqual({ ratio: '2:1', exact: true });
    expect(tempoRelation(80, 120)?.ratio).toBe('3:2');
    expect(tempoRelation(56, 90)).toBeNull();
  });

  it('calls same-key same-tempo loops that divide each other phase-lockable', () => {
    const a = planSong(inD('a', 60, [['Dm', 8], ['Bb', 8], ['F', 8], ['C', 8]], 8));
    const b = planSong(inD('b', 60, [['Dm7', 8], ['Gm', 8], ['Bb', 8], ['C', 8]], 4));
    const pair = pairPlan(a, b);
    expect(pair.phaseLock).toBe(true);
    expect(pair.verdict).toBe('sync');
    expect(pair.harmony).toBeGreaterThan(0.7);
  });

  it('warns about a distant key and an unrelated tempo', () => {
    const a = planSong(inD('a', 56, [['Dm', 8], ['Bb', 8]]));
    const far = planSong(inD('far', 91, [['F#', 8], ['C#', 8], ['G#m', 8]]));
    const pair = pairPlan(a, far);
    expect(pair.verdict).toBe('clash-risk');
    expect(pair.notes.join(' ')).toMatch(/pitch classes agree|share no simple ratio/);
  });

  it('plans every pair once', () => {
    const s = ['a', 'b', 'c'].map(n => inD(n, 60, [['Dm', 8], ['Bb', 8]]));
    const plan = planScore(s);
    expect(plan.songs).toHaveLength(3);
    expect(plan.pairs).toHaveLength(3);
  });
});
