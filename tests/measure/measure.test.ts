import { describe, expect, it } from 'vitest';
import { fft } from '../../src/measure/fft.ts';
import { momentaryMax, shortTermMax, integrated, truePeakDb, samplePeakDb } from '../../src/measure/loudness.ts';
import { attackTime, energyLength, tailLength, crestDb } from '../../src/measure/envelope.ts';
import { spectrum, centroid, flatness } from '../../src/measure/spectral.ts';
import { sharpness, roughness, fluctuation } from '../../src/measure/psycho.ts';
import { pitchTrack } from '../../src/measure/pitch.ts';
import { measure, featureVector, FEATURE_NAMES } from '../../src/measure/index.ts';
import { SR, am, enveloped, filteredNoise, glide, sine, whiteNoise, withSilence } from '../helpers/signals.ts';

describe('fft', () => {
  it('finds a pure tone in the right bin', () => {
    const n = 1024;
    const re = Float64Array.from({ length: n }, (_, i) => Math.cos(2 * Math.PI * 64 * i / n));
    const im = new Float64Array(n);
    fft(re, im);
    const mag = Array.from(re, (r, i) => Math.hypot(r, im[i]));
    expect(mag.indexOf(Math.max(...mag.slice(0, n / 2)))).toBe(64);
  });
});

describe('loudness (ITU-R BS.1770 / EBU Tech 3341)', () => {
  const tone = (dbfs: number, dur: number) => sine(997, dur, 10 ** (dbfs / 20));
  it('reads a stereo -20 dBFS 997 Hz tone at -20 LUFS', () => {
    expect(momentaryMax([tone(-20, 2), tone(-20, 2)], SR)).toBeCloseTo(-20, 1);
    expect(shortTermMax([tone(-20, 4), tone(-20, 4)], SR)).toBeCloseTo(-20, 1);
    expect(integrated([tone(-20, 4), tone(-20, 4)], SR).lufs).toBeCloseTo(-20, 1);
  });
  it('passes Tech 3341 test 13: a 400 ms burst at -23 dBFS reads -23.0 max momentary', () => {
    const burst = withSilence(tone(-23, 0.4), 1, 1);
    expect(momentaryMax([burst, burst], SR)).toBeCloseTo(-23, 1);
  });
  it('zero-pads sounds shorter than one 400 ms block instead of discarding them', () => {
    const short = tone(-20, 0.1);
    const m = momentaryMax([short, short], SR);
    expect(Number.isFinite(m)).toBe(true);
    expect(m).toBeCloseTo(-20 + 10 * Math.log10(0.1 / 0.4), 0); // energy spread over the 400 ms window
    expect(integrated([short, short], SR).reliable).toBe(false);
  });
  it('reports -Infinity for silence', () => {
    expect(momentaryMax([new Float32Array(48000)], SR)).toBe(-Infinity);
  });
  it('finds inter-sample peaks with 4x oversampling', () => {
    const x = sine(12000, 0.1, 1, Math.PI / 4); // samples land at ±0.707
    expect(samplePeakDb([x])).toBeLessThan(-2.5);
    expect(truePeakDb([x], SR)).toBeGreaterThan(-0.6);
  });
});

describe('envelope', () => {
  it('times a linear 20 ms attack at 16 ms (10 % → 90 %)', () => {
    expect(attackTime(enveloped(0.02, 0.1), SR)).toBeCloseTo(0.016, 2);
  });
  it('measures energy length and tail of an exponential decay', () => {
    const x = enveloped(0.005, 0.05, 1);
    // −40 dB below peak after 0.05·ln(100) ≈ 0.23 s; −60 dB after ≈ 0.345 s
    expect(energyLength(x, SR)).toBeCloseTo(0.235, 1);
    expect(tailLength(x, SR)).toBeCloseTo(0.35, 1);
  });
  it('reports a sine crest near 3 dB', () => {
    expect(crestDb(sine(1000, 0.5))).toBeCloseTo(3.01, 1);
  });
});

describe('spectral', () => {
  it('puts a sine centroid on its frequency', () => {
    expect(centroid(spectrum(sine(1000, 0.5), SR))).toBeCloseTo(1000, -1);
  });
  it('separates noise from tone by flatness', () => {
    expect(flatness(spectrum(whiteNoise(1, 1), SR))).toBeGreaterThan(0.5);
    expect(flatness(spectrum(sine(1000, 1), SR))).toBeLessThan(0.05);
  });
});

describe('psychoacoustic indicators', () => {
  // Unit anchors: 1 acum ≈ 1 kHz narrowband; 1 asper = 1 kHz, 100 % AM at 70 Hz; 1 vacil = same at 4 Hz.
  it('lands near the definitions of acum, asper and vacil', () => {
    expect(sharpness(sine(1000, 1), SR)).toBeGreaterThan(0.8);
    expect(sharpness(sine(1000, 1), SR)).toBeLessThan(1.2);
    expect(roughness(am(1000, 70, 1), SR)).toBeGreaterThan(0.5);
    expect(roughness(am(1000, 70, 1), SR)).toBeLessThan(1.5);
    expect(fluctuation(am(1000, 4, 1, 2), SR)).toBeGreaterThan(0.7);
    expect(fluctuation(am(1000, 4, 1, 2), SR)).toBeLessThan(1.3);
  });

  it('rates high-passed noise sharper than low-passed noise', () => {
    expect(sharpness(filteredNoise(4000, true), SR)).toBeGreaterThan(sharpness(filteredNoise(500, false), SR) + 0.5);
  });
  it('rates 70 Hz amplitude modulation much rougher than a steady tone', () => {
    expect(roughness(am(1000, 70, 1), SR)).toBeGreaterThan(3 * roughness(sine(1000, 1), SR) + 0.05);
  });
  it('rates 70 Hz AM rougher than 4 Hz AM, and 4 Hz AM more fluctuating', () => {
    expect(roughness(am(1000, 70, 1, 2), SR)).toBeGreaterThan(roughness(am(1000, 4, 1, 2), SR));
    expect(fluctuation(am(1000, 4, 1, 2), SR)).toBeGreaterThan(fluctuation(am(1000, 70, 1, 2), SR));
  });
});

describe('pitch', () => {
  it('tracks a steady tone with high strength', () => {
    const p = pitchTrack(sine(440, 0.5), SR);
    expect(p.medianHz).toBeCloseTo(440, 0);
    expect(p.strength).toBeGreaterThan(0.9);
  });
  it('reports a rising glide as positive semitones', () => {
    expect(pitchTrack(glide(400, 800, 0.4), SR).directionSemitones).toBeGreaterThan(8);
  });
  it('reports noise as weakly pitched', () => {
    expect(pitchTrack(whiteNoise(0.5, 2), SR).strength).toBeLessThan(0.5);
  });
});

describe('measure', () => {
  it('produces the full feature set and a fixed-length taste vector', () => {
    const x = enveloped(0.005, 0.08, 0.5);
    const f = measure({ sampleRate: SR, authored: [x, x], delivered: [x, x] });
    expect(f.momentaryMaxLufs).toBeLessThan(0);
    expect(f.centroidHz).toBeGreaterThan(800);
    expect(f.pitchHz).toBeCloseTo(1000, -1);
    expect(f.delivered.truePeakDb).toBeLessThan(0);
    const v = featureVector(f);
    expect(v).toHaveLength(FEATURE_NAMES.length);
    expect(v.every(Number.isFinite)).toBe(true);
  });
});
