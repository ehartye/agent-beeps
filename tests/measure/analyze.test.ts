import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeWav } from '../../src/audio/wav.ts';
import { decodeAudio } from '../../src/audio/decode.ts';
import { analyzeAudio } from '../../src/analyze.ts';
import { compareAnalyses } from '../../src/compare.ts';
import { findFfmpeg, encodeMp3 } from '../../src/compress.ts';
import { SR, evenOnsets, shotTrain, sine } from '../helpers/signals.ts';

const dir = mkdtempSync(join(tmpdir(), 'beeps-analyze-'));
const wav = (name: string, x: Float32Array, bits: 16 | 32 = 16) => { const p = join(dir, name); writeFileSync(p, writeWav([x], SR, { bits })); return p; };
const burst = (name: string, { interval = 0.087, tau = 0.012, n = 16, bits = 16 as 16 | 32 } = {}) => wav(name, shotTrain(evenOnsets(n, interval), tau), bits);

let ffmpeg: string | undefined;
try { ffmpeg = findFfmpeg(); if (spawnSync(ffmpeg, ['-version']).status !== 0) ffmpeg = undefined; } catch { ffmpeg = undefined; }

describe('decodeAudio', () => {
  it('reads 16-bit and float WAVs as they are', () => {
    const x = sine(440, 0.2);
    for (const bits of [16, 32] as const) {
      const d = decodeAudio(wav(`tone${bits}.wav`, x, bits));
      expect(d.sampleRate).toBe(SR);
      expect(d.channels).toHaveLength(1);
      expect(d.channels[0].length).toBe(x.length);
      expect(d.channels[0][1000]).toBeCloseTo(x[1000], 3);
    }
  });

  it('reads a WAVE_FORMAT_EXTENSIBLE float file, which is what ffmpeg writes', () => {
    const x = sine(440, 0.1);
    const plain = writeWav([x], SR, { bits: 32 });                       // 44-byte header, fmt chunk of 16 bytes
    const fmt = Buffer.alloc(8 + 40);
    fmt.write('fmt ', 0); fmt.writeUInt32LE(40, 4);
    plain.copy(fmt, 8, 20, 36);                                          // the 16 common fmt bytes
    fmt.writeUInt16LE(0xfffe, 8);                                        // format tag: extensible
    fmt.writeUInt16LE(22, 8 + 16); fmt.writeUInt16LE(32, 8 + 18); fmt.writeUInt32LE(4, 8 + 20);
    fmt.writeUInt16LE(3, 8 + 24);                                        // sub-format GUID starts with the real code: IEEE float
    const data = plain.subarray(36);
    const out = Buffer.concat([plain.subarray(0, 12), fmt, data]);
    out.writeUInt32LE(out.length - 8, 4);
    const p = join(dir, 'extensible.wav'); writeFileSync(p, out);
    const d = decodeAudio(p);
    expect(d.channels[0].length).toBe(x.length);
    expect(d.channels[0][500]).toBeCloseTo(x[500], 5);
  });

  it('says what is wrong with a file that does not exist', () => {
    expect(() => decodeAudio(join(dir, 'nope.wav'))).toThrowError(/nope\.wav/);
  });

  it.skipIf(!ffmpeg)('decodes MP3 through ffmpeg to about the same length', () => {
    const burst8 = shotTrain(evenOnsets(8, 0.1), 0.01);
    const src = wav('for-mp3.wav', burst8);
    const mp3 = join(dir, 'burst.mp3');
    encodeMp3(ffmpeg!, src, mp3, 128);
    const d = decodeAudio(mp3);
    expect(d.sampleRate).toBe(48000);
    expect(Math.abs(d.channels[0].length - burst8.length) / SR).toBeLessThan(0.1);
  });
});

describe('analyzeAudio at other sample rates', () => {
  it.skipIf(!ffmpeg)('resamples a 44.1 kHz file to 48 kHz, keeps its timing, and says what the source was', () => {
    const rate = 44100, x = shotTrain(evenOnsets(16, 60 / 700), 0.012);
    // shotTrain is built at 48 kHz; reinterpreting the same samples at 44.1 kHz stretches time by 48/44.1, so the rate reads 700 * 44.1/48 = 643
    const p = join(dir, 'cd.wav'); writeFileSync(p, writeWav([x], rate));
    const a = analyzeAudio(p);
    expect(a.sampleRate).toBe(48000);
    expect(a.sourceSampleRate).toBe(44100);
    expect(a.events.rpm).toBeCloseTo(700 * 44100 / 48000, -1);
  });

  it('reports the source rate as the analysis rate for a 48 kHz file', () => {
    const a = analyzeAudio(burst('native.wav'));
    expect(a.sampleRate).toBe(48000);
    expect(a.sourceSampleRate).toBe(48000);
  });
});

describe('analyzeAudio', () => {
  it('reports the features, the repeat and the shape of a burst', () => {
    const a = analyzeAudio(burst('b1.wav', { interval: 60 / 700 }));
    expect(a.sampleRate).toBe(SR);
    expect(a.durationSec).toBeGreaterThan(1.3);
    expect(a.events.count).toBeGreaterThanOrEqual(15);
    expect(a.events.rpm).toBeCloseTo(700, -1);
    expect(a.profile).toHaveLength(5);
    expect(a.features.crestDb).toBeGreaterThan(5);
    expect(a.spectrum.edgesHz.length).toBe(a.spectrum.db.length + 1);
    expect(a.active.endSec).toBeGreaterThan(a.active.startSec);
  });

  it('stops the profile window before the next event, so a neighbouring shot is not read as a tail', () => {
    const a = analyzeAudio(burst('dense.wav', { interval: 0.087, tau: 0.012 }));
    expect(a.profileWindowMs).toBeLessThanOrEqual(0.9 * 87);
    expect(a.profileWindowMs).toBeGreaterThanOrEqual(60);
    const slow = analyzeAudio(burst('sparse.wav', { interval: 0.4, tau: 0.012, n: 6 }));
    expect(slow.profileWindowMs).toBe(90);
  });

  it('leaves the profile out when nothing repeats', () => {
    const a = analyzeAudio(wav('one.wav', shotTrain([0.1], 0.02, { dur: 0.6 })));
    expect(a.events.count).toBe(1);
    expect(a.profile).toBeNull();
    expect(a.profileWindowMs).toBeNull();
  });
});

describe('compareAnalyses', () => {
  const ref = analyzeAudio(burst('ref.wav', { tau: 0.04 }));

  it('finds nothing to say about a sound compared with itself', () => {
    const c = compareAnalyses(ref, ref);
    expect(c.hints).toEqual([]);
    expect(c.deltas.events.rpmPct).toBeCloseTo(0, 5);
    expect(c.deltas.events.floorDb).toBeCloseTo(0, 5);
  });

  it('says a candidate with short tails leaves the gaps emptier than the reference', () => {
    const cand = analyzeAudio(burst('dry.wav', { tau: 0.004 }));
    const c = compareAnalyses(ref, cand);
    expect(c.deltas.events.floorDb).toBeLessThan(-6);
    expect(c.hints.join('\n')).toMatch(/between (shots|events)/i);
    expect(c.hints.join('\n')).toMatch(/tail|decay/i);
  });

  it('says a candidate firing slower is slower, with both rates', () => {
    const cand = analyzeAudio(burst('slow.wav', { tau: 0.04, interval: 0.11 }));
    const c = compareAnalyses(ref, cand);
    expect(c.deltas.events.rpmPct).toBeLessThan(-15);
    expect(c.hints.join('\n')).toMatch(/rate/i);
    expect(c.hints.join('\n')).toMatch(/\b5\d\d\b/);      // the candidate rate, ~545 rpm
  });

  it('names a band that is missing energy', () => {
    const cand = analyzeAudio(wav('tone.wav', Float32Array.from(shotTrain(evenOnsets(16, 0.087), 0.04), (v, i) => v * 0.2 + 0.5 * Math.sin(2 * Math.PI * 300 * i / SR) * Math.exp(-(i % Math.round(0.087 * SR)) / SR / 0.04))));
    const c = compareAnalyses(ref, cand);
    expect(c.deltas.spectrum.some(b => Math.abs(b.db) > 4)).toBe(true);
    expect(c.hints.join('\n')).toMatch(/Hz/);
  });
});
