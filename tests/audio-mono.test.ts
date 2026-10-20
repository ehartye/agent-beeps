import { describe, expect, it } from 'vitest';
import { mixToMono } from '../src/audio/mono.ts';

describe('mixToMono', () => {
  it('returns a single channel itself', () => {
    const x = Float32Array.of(0.1, -0.2);
    expect(mixToMono([x])).toBe(x);
  });

  it('averages channels and cancels anti-phase ones', () => {
    expect(Array.from(mixToMono([Float32Array.of(1, 0.5), Float32Array.of(0, 0.5)]))).toEqual([0.5, 0.5]);
    expect(Array.from(mixToMono([Float32Array.of(0.25, -0.5), Float32Array.of(-0.25, 0.5)]))).toEqual([0, 0]);
  });

  it('rounds the sum once, so stereo is exactly (L + R) / 2 as a float32', () => {
    const l = Float32Array.of(0.1, 1e-8, -0.3, 16777217 / 2 ** 20), r = Float32Array.of(0.2, 3, 0.7, 1e-7);
    const m = mixToMono([l, r]);
    for (let i = 0; i < l.length; i++) expect(m[i]).toBe(Math.fround((l[i] + r[i]) / 2));
  });

  it('does not depend on the channel order', () => {
    const a = Float32Array.of(0.1, -0.7, 0.33), b = Float32Array.of(0.9, 0.2, -0.05), c = Float32Array.of(-0.4, 0.5, 0.11);
    expect(Array.from(mixToMono([a, b, c]))).toEqual(Array.from(mixToMono([c, a, b])));
  });
});
