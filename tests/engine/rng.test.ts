import { describe, expect, it } from 'vitest';
import { mulberry32, noiseSamples } from '../../runtime/engine/rng.js';

describe('rng', () => {
  it('is deterministic per seed and in [0,1)', () => {
    const a = mulberry32(7), b = mulberry32(7), c = mulberry32(8);
    const xs = [a(), a(), a()];
    expect(xs).toEqual([b(), b(), b()]);
    expect(xs).not.toEqual([c(), c(), c()]);
    expect(xs.every(x => x >= 0 && x < 1)).toBe(true);
  });
  it('makes seeded, peak-normalized noise of each colour', () => {
    for (const color of ['white', 'pink', 'brown'] as const) {
      const n = noiseSamples(color, 4800, 3);
      expect(n).toEqual(noiseSamples(color, 4800, 3));
      expect(n.length).toBe(4800);
      const peak = n.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
      expect(peak).toBeCloseTo(1, 5);
    }
    expect(noiseSamples('white', 100, 1)).not.toEqual(noiseSamples('white', 100, 2));
  });
});
