import { describe, expect, it } from 'vitest';
import { writeWav } from '../src/audio/wav.ts';
import { inspectPcm16, pcm16, toMono, trimTail, writePcm16 } from '../src/audio/post.ts';

const SR = 48000;
/** A 0.1 s burst at -6 dBFS followed by `tailSec` of a -70 dBFS hum, as a reverb tail would leave. */
function burst(tailSec: number, right = (x: number) => x) {
  const n = Math.round((0.1 + tailSec) * SR);
  const l = Float32Array.from({ length: n }, (_, i) => (i < 0.1 * SR ? 0.5 : 10 ** (-70 / 20)) * Math.sin(i / 7));
  return writeWav([l, Float32Array.from(l, right)], SR);
}

describe('canonical integer PCM admission', () => {
  it('inspects a bounded header before reading the sample payload', () => {
    const wav = writePcm16({ sampleRate: 101, channels: [new Int16Array([-32768, 0, 32767])] });
    expect(inspectPcm16(wav.subarray(0, 44), wav.length)).toEqual({ sampleRate: 101, channels: 1, frames: 3, dataBytes: 6 });
    expect(pcm16(wav).channels[0]).toEqual(new Int16Array([-32768, 0, 32767]));
  });

  it.each([
    ['truncated header', (b: Buffer) => b.subarray(0, 43)],
    ['truncated payload', (b: Buffer) => b.subarray(0, b.length - 1)],
    ['trailing bytes', (b: Buffer) => Buffer.concat([b, Buffer.alloc(2)])],
    ['RIFF length', (b: Buffer) => { b.writeUInt32LE(1, 4); return b; }],
    ['fmt magic', (b: Buffer) => { b.write('JUNK', 12); return b; }],
    ['fmt size', (b: Buffer) => { b.writeUInt32LE(18, 16); return b; }],
    ['float format', (b: Buffer) => { b.writeUInt16LE(3, 20); return b; }],
    ['extensible format', (b: Buffer) => { b.writeUInt16LE(65534, 20); return b; }],
    ['zero channels', (b: Buffer) => { b.writeUInt16LE(0, 22); return b; }],
    ['zero sample rate', (b: Buffer) => { b.writeUInt32LE(0, 24); return b; }],
    ['byte rate', (b: Buffer) => { b.writeUInt32LE(1, 28); return b; }],
    ['block align', (b: Buffer) => { b.writeUInt16LE(1, 32); return b; }],
    ['sample width', (b: Buffer) => { b.writeUInt16LE(24, 34); return b; }],
    ['data magic', (b: Buffer) => { b.write('JUNK', 36); return b; }],
    ['data length', (b: Buffer) => { b.writeUInt32LE(2, 40); return b; }],
    ['high-bit RIFF magic', (b: Buffer) => { b[0] |= 128; return b; }],
    ['nonintegral frame', (b: Buffer) => { const short = b.subarray(0, b.length - 1); short.writeUInt32LE(short.length - 8, 4); short.writeUInt32LE(short.length - 44, 40); return short; }],
  ])('rejects %s before PCM allocation', (_name, mutate) => {
    const wav = writePcm16({ sampleRate: 48000, channels: [new Int16Array([1, -1])] });
    expect(() => pcm16(mutate(wav))).toThrow(/canonical/);
  });
});

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
