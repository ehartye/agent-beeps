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
});
