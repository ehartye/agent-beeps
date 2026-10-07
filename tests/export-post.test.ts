import { describe, expect, it } from 'vitest';
import { writeWav } from '../src/audio/wav.ts';
import { pcm16, toMono, trimTail } from '../src/audio/post.ts';

const SR = 48000;
/** A 0.1 s burst at -6 dBFS followed by `tailSec` of a -70 dBFS hum, as a reverb tail would leave. */
function burst(tailSec: number, right = (x: number) => x) {
  const n = Math.round((0.1 + tailSec) * SR);
  const l = Float32Array.from({ length: n }, (_, i) => (i < 0.1 * SR ? 0.5 : 10 ** (-70 / 20)) * Math.sin(i / 7));
  return writeWav([l, Float32Array.from(l, right)], SR);
}

describe('toMono', () => {
  it('keeps the left samples exactly when both channels are identical', () => {
    const src = burst(0.2);
    const { wav, identical } = toMono(src);
    expect(identical).toBe(true);
    const a = pcm16(src), b = pcm16(wav);
    expect(b.channels).toHaveLength(1);
    expect(b.sampleRate).toBe(SR);
    expect(b.channels[0]).toEqual(a.channels[0]);
    expect(wav.length).toBe(44 + (src.length - 44) / 2);
  });

  it('averages channels that differ', () => {
    const src = burst(0, x => x / 2);
    const { wav, identical } = toMono(src);
    expect(identical).toBe(false);
    const a = pcm16(src), m = pcm16(wav).channels[0];
    for (const i of [10, 500, 3000]) expect(m[i]).toBe(Math.round((a.channels[0][i] + a.channels[1][i]) / 2));
  });

  it('leaves a mono file alone', () => {
    const mono = toMono(burst(0)).wav;
    expect(toMono(mono).wav).toEqual(mono);
  });
});

describe('trimTail', () => {
  it('cuts what is below the threshold after the last louder sample, fading the kept quiet samples to zero', () => {
    const src = burst(0.5);
    const { wav, removedSec, frames } = trimTail(src, -60);
    const out = pcm16(wav);
    expect(out.channels).toHaveLength(2);
    expect(frames).toBe(out.channels[0].length);
    // The burst (0.1 s) survives, then at most the 10 ms fade.
    expect(frames / SR).toBeGreaterThan(0.099);
    expect(frames / SR).toBeLessThan(0.1 + 0.0105);
    expect(removedSec).toBeCloseTo(0.6 - frames / SR, 6);
    const a = pcm16(src);
    const loud = Math.round(0.1 * SR) - 50;
    expect(out.channels[0].subarray(0, loud)).toEqual(a.channels[0].subarray(0, loud));
    expect(out.channels[0][frames - 1]).toBe(0);
  });

  it('keeps a quiet tail that is above the threshold', () => {
    const src = burst(0.5);
    expect(trimTail(src, -80).removedSec).toBeLessThan(0.002);
  });

  it('rejects thresholds that are not a negative dBFS level', () => {
    expect(() => trimTail(burst(0), 3)).toThrow(/dBFS/);
    expect(() => trimTail(burst(0), -200)).toThrow(/dBFS/);
  });
});
