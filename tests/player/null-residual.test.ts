// tests/player/null-residual.test.ts
import { describe, expect, it } from 'vitest';
import { addChannels, layerWavPath, nullResidualDb, reportedResidualDb } from '../../src/render/layers.ts';

const sine = (n: number, amp: number, phase = 0) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(i / 7 + phase));
const sum = (layers: Float32Array[][]) => layers.reduce<Float32Array[] | undefined>((acc, l) => addChannels(acc, l), undefined)!;

describe('null residual', () => {
  it('is -Infinity when the layers sum exactly to the mix', () => {
    const a = sine(1000, 0.2), b = sine(1000, 0.1, 1);
    const mix = Float32Array.from(a, (x, i) => x + b[i]);
    expect(nullResidualDb([mix, mix], sum([[a, a], [b, b]]))).toBe(-Infinity);
  });

  it('measures a missing layer relative to the mix', () => {
    const a = sine(1000, 0.2), b = sine(1000, 0.02, 1);
    const mix = Float32Array.from(a, (x, i) => x + b[i]);
    // Leaving out b (a tenth of a's amplitude) leaves roughly -20 dB of residual.
    expect(nullResidualDb([mix], sum([[a]]))).toBeGreaterThan(-21);
    expect(nullResidualDb([mix], sum([[a]]))).toBeLessThan(-19);
  });

  it('accumulates layers into a new sum without touching them', () => {
    const a = sine(10, 0.2), b = sine(10, 0.1, 1), before = Float32Array.from(a);
    const s = addChannels(addChannels(undefined, [a]), [b]);
    expect(a).toEqual(before);
    expect(s[0]).toEqual(Float32Array.from(a, (x, i) => x + b[i]));
  });
});

describe('reported residual', () => {
  it('is a finite JSON number, rounded to a tenth', () => {
    expect(reportedResidualDb(-Infinity)).toBe(-200);
    expect(reportedResidualDb(-73.04)).toBe(-73);
    expect(JSON.parse(JSON.stringify({ r: reportedResidualDb(-Infinity) })).r).toBe(-200);
  });
});

describe('layer WAV paths', () => {
  it('replace only a real .wav extension', () => {
    expect(layerWavPath('audio/theme.wav', 'bed')).toBe('audio/theme.bed.wav');
    expect(layerWavPath('audio/theme.WAV', 'bed')).toBe('audio/theme.bed.wav');
    expect(layerWavPath('audio/loopwav', 'bed')).toBe('audio/loopwav.bed.wav');
  });
});
