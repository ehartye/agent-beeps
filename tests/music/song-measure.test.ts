import { describe, expect, it } from 'vitest';
import { applyTrimAndClip, measureSong } from '../../src/measure/song.ts';
import { integrated } from '../../src/measure/loudness.ts';
import { SR, sine, whiteNoise } from '../helpers/signals.ts';

const concat = (...xs: Float32Array[]) => { const out = new Float32Array(xs.reduce((a, x) => a + x.length, 0)); let o = 0; for (const x of xs) { out.set(x, o); o += x.length; } return out; };

describe('song measurement', () => {
  it('reports integrated loudness, a per-section arc and loudness range', () => {
    const quiet = sine(220, 6, 0.05), loud = sine(220, 6, 0.5);
    const x = concat(quiet, loud);
    const f = measureSong([x, x], SR, [{ name: 'intro', start: 0, end: 6 }, { name: 'a', start: 6, end: 12 }]);
    expect(f.sections[1].lufs - f.sections[0].lufs).toBeCloseTo(20, 0);
    expect(f.loudnessRangeLu).toBeGreaterThan(10);
    expect(f.integratedLufs).toBeCloseTo(integrated([x, x], SR).lufs, 1);
    expect(f.arc.length).toBe(12);
    expect(f.durationSec).toBeCloseTo(12, 1);
  });

  it('measures stereo width: 0 for mono, higher for decorrelated channels', () => {
    const a = whiteNoise(3, 1), b = whiteNoise(3, 2);
    expect(measureSong([a, a], SR, []).stereoWidth).toBeCloseTo(0, 2);
    expect(measureSong([a, b], SR, []).stereoWidth).toBeGreaterThan(0.8);
  });

  it('reports low-end share and brightness', () => {
    const low = measureSong([sine(60, 3), sine(60, 3)], SR, []);
    const high = measureSong([sine(3000, 3), sine(3000, 3)], SR, []);
    expect(low.lowShare).toBeGreaterThan(0.9);
    expect(high.lowShare).toBeLessThan(0.05);
    expect(high.centroidHz).toBeGreaterThan(low.centroidHz * 10);
  });

  it('reports the loop seam step for loops', () => {
    const x = concat(sine(220, 3, 0.05), sine(220, 3, 0.5));
    expect(measureSong([x, x], SR, [], { loop: true }).seamDb).toBeGreaterThan(15);
    const y = sine(220, 6, 0.3);
    expect(measureSong([y, y], SR, [], { loop: true }).seamDb).toBeLessThan(1);
  });

  it('trims and soft-clips in place of the browser limiter', () => {
    const x = sine(220, 1, 0.5);
    const [out] = applyTrimAndClip([x], 12);
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(10 ** (-1 / 20) + 1e-4);
    const [same] = applyTrimAndClip([sine(220, 1, 0.1)], 0);
    expect(same[100]).toBeCloseTo(sine(220, 1, 0.1)[100], 4);
  });
});
