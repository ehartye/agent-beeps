import { describe, expect, it } from 'vitest';
import { findEvents, eventProfile, EVENT_BANDS } from '../../src/measure/events.ts';
import { butterworth4 } from '../../src/measure/filters.ts';
import { SR, evenOnsets, sine, shotTrain, whiteNoise } from '../helpers/signals.ts';

describe('butterworth4', () => {
  const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
  it('lowpass keeps a tone below the cutoff and removes one above it', () => {
    const lo = butterworth4(sine(200, 1), SR, 'lp', 2000), hi = butterworth4(sine(8000, 1), SR, 'lp', 2000);
    expect(rms(lo)).toBeGreaterThan(0.9 * rms(sine(200, 1)));
    expect(rms(hi)).toBeLessThan(0.02 * rms(sine(8000, 1)));
  });
  it('highpass does the opposite, and is 3 dB down at the cutoff', () => {
    const lo = butterworth4(sine(100, 1), SR, 'hp', 2000), hi = butterworth4(sine(8000, 1), SR, 'hp', 2000);
    expect(rms(lo)).toBeLessThan(0.01 * rms(sine(100, 1)));
    expect(rms(hi)).toBeGreaterThan(0.95 * rms(sine(8000, 1)));
    const at = rms(butterworth4(sine(2000, 1), SR, 'hp', 2000).subarray(SR / 2)) / rms(sine(2000, 1).subarray(SR / 2));
    expect(20 * Math.log10(at)).toBeCloseTo(-3, 0);
  });
});

describe('findEvents', () => {
  it('finds the rate of a steady 700 rpm burst and calls it regular', () => {
    const interval = 60 / 700;
    const ev = findEvents(shotTrain(evenOnsets(20, interval), 0.012), SR);
    expect(ev.count).toBeGreaterThanOrEqual(19);
    expect(ev.count).toBeLessThanOrEqual(20);
    expect(ev.rpm).toBeCloseTo(700, -1);                 // within 5 rpm
    expect(ev.intervalCv).toBeLessThan(0.05);
    expect(ev.onsetsSec[0]).toBeCloseTo(0.05, 1);
  });

  it('does not mistake a multiple of the true interval for it', () => {
    // every second shot is quieter: the autocorrelation peaks at 2x the interval too
    const onsets = evenOnsets(24, 0.074);
    const x = shotTrain(onsets.filter((_, i) => i % 2 === 0), 0.015, { amp: 0.8 });
    const y = shotTrain(onsets.filter((_, i) => i % 2 === 1), 0.015, { amp: 0.5, seed: 4 });
    const mix = Float32Array.from(x, (v, i) => v + y[i]);
    expect(findEvents(mix, SR).rpm).toBeCloseTo(60 / 0.074, -1);
  });

  it('reports irregular firing as a high interval variation', () => {
    const ev = findEvents(shotTrain(evenOnsets(20, 0.1, { jitterSec: 0.035 }), 0.012), SR);
    expect(ev.intervalCv).toBeGreaterThan(0.15);
  });

  it('measures the level between shots: a long tail fills the gaps, a short one leaves them empty', () => {
    const onsets = evenOnsets(16, 0.09);
    const dry = findEvents(shotTrain(onsets, 0.004), SR), wet = findEvents(shotTrain(onsets, 0.05), SR);
    expect(wet.floorDb!).toBeGreaterThan(dry.floorDb! + 12);
    expect(dry.floorDb!).toBeLessThan(-30);
  });

  it('gives a level per shot and drops nothing from an even train', () => {
    const ev = findEvents(shotTrain(evenOnsets(10, 0.1), 0.01), SR);
    expect(ev.levelsDb.length).toBe(ev.count);
    expect(Math.max(...ev.levelsDb)).toBeCloseTo(0, 5);
  });

  it('reports one event with no rate, and silence with none', () => {
    const one = findEvents(shotTrain([0.1], 0.02, { dur: 0.6 }), SR);
    expect(one.count).toBe(1);
    expect(one.rpm).toBeNull();
    expect(findEvents(new Float32Array(SR), SR).count).toBe(0);
  });

  it('finds nothing periodic in steady noise', () => {
    const ev = findEvents(whiteNoise(1.5, 5, 0.3), SR);
    expect(ev.rpm === null || ev.periodicity < 0.2).toBe(true);
  });
});

describe('eventProfile', () => {
  it('reads how fast an event dies in each band', () => {
    const tau = 0.010;                                   // -20 dB after tau * ln(10) = 23 ms
    const x = shotTrain(evenOnsets(20, 0.16), tau);
    const ev = findEvents(x, SR);
    const mid = eventProfile(x, SR, ev.onsetsSec).find(b => b.name === 'mid')!;
    expect(mid.t20Ms).not.toBeNull();
    expect(mid.t20Ms!).toBeGreaterThan(15);
    expect(mid.t20Ms!).toBeLessThan(32);
    expect(mid.t10Ms!).toBeLessThan(mid.t20Ms!);
  });

  it('tells a slow-decaying band from a fast one', () => {
    const fast = shotTrain(evenOnsets(16, 0.16), 0.004), slow = shotTrain(evenOnsets(16, 0.16), 0.03);
    const t20 = (x: Float32Array) => eventProfile(x, SR, findEvents(x, SR).onsetsSec).find(b => b.name === 'presence')!.t20Ms!;
    expect(t20(slow)).toBeGreaterThan(3 * t20(fast));
  });

  it('names its bands and reports null when a band never falls 20 dB', () => {
    expect(EVENT_BANDS.map(b => b.name)).toEqual(['low', 'low-mid', 'mid', 'presence', 'air']);
    const sustained = Float32Array.from(whiteNoise(2, 8, 0.3));
    const prof = eventProfile(sustained, SR, [0.2, 0.4, 0.6, 0.8, 1.0]);
    expect(prof.some(b => b.t20Ms === null)).toBe(true);
  });
});
