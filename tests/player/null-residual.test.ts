// tests/player/null-residual.test.ts
import { describe, expect, it } from 'vitest';
import { nullResidualDb } from '../../src/render/layers.ts';

const sine = (n: number, amp: number, phase = 0) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(i / 7 + phase));

describe('null residual', () => {
  it('is -Infinity when the layers sum exactly to the mix', () => {
    const a = sine(1000, 0.2), b = sine(1000, 0.1, 1);
    const mix = Float32Array.from(a, (x, i) => x + b[i]);
    expect(nullResidualDb([mix, mix], [[a, a], [b, b]])).toBe(-Infinity);
  });

  it('measures a missing layer relative to the mix', () => {
    const a = sine(1000, 0.2), b = sine(1000, 0.02, 1);
    const mix = Float32Array.from(a, (x, i) => x + b[i]);
    // Leaving out b (a tenth of a's amplitude) leaves roughly -20 dB of residual.
    expect(nullResidualDb([mix], [[a]])).toBeGreaterThan(-21);
    expect(nullResidualDb([mix], [[a]])).toBeLessThan(-19);
  });
});
