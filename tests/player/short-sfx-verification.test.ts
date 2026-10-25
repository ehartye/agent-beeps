import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readWav, writeWav } from '../../src/audio/wav.ts';
import { decodeChannels, encodeOpus, envelopeCorrelation, findFfmpeg, verify } from '../../src/compress.ts';

const sampleRate = 48000;
const temporary: string[] = [];
const ffmpeg = (() => { try { return findFfmpeg(); } catch { return null; } })();

/** A short decaying test tone with eight useful sub-20ms energy windows. */
function transient(seconds = 0.039): Float32Array[] {
  const channel = Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, i) => {
    const t = i / sampleRate;
    const envelope = Math.min(1, t / 0.001) * Math.exp(-t / 0.006);
    return envelope * (0.5 * Math.sin(2 * Math.PI * 1100 * t) + 0.1 * Math.sin(2 * Math.PI * 2700 * t));
  });
  return [channel, channel.slice()];
}

afterEach(() => {
  for (const dir of temporary.splice(0)) {
    if (dirname(dir) !== tmpdir() || !basename(dir).startsWith('beeps-short-sfx-')) throw new Error('unsafe fixture cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('short SFX decoded-signal verification', () => {
  it.each([0.019, 0.039])('accepts an identical %ss transient instead of a degenerate correlation', seconds => {
    const channels = transient(seconds);
    expect(envelopeCorrelation(channels, channels, sampleRate)).toBeCloseTo(1, 12);
    expect(verify({ channels, sampleRate }, channels, false, 'sfx').problems).toEqual([]);
  });

  it('keeps silence and a zero-variance envelope from becoming automatic passes', () => {
    const channels = transient();
    const silence = channels.map(ch => new Float32Array(ch.length));
    const flat = channels.map(ch => new Float32Array(ch.length).fill(0.25));
    for (const decoded of [silence, flat]) {
      const report = verify({ channels, sampleRate }, decoded, false, 'sfx');
      expect(Number.isFinite(report.envelopeCorrelation)).toBe(true);
      expect(report.problems.join()).toContain('decoded loudness over time');
    }
    expect(envelopeCorrelation(flat, flat, sampleRate)).toBe(0);
  });

  it('does not invent a match when too few samples can carry variance', () => {
    for (const samples of [new Float32Array(), new Float32Array([0.5])]) {
      expect(envelopeCorrelation([samples], [samples], sampleRate)).toBe(0);
    }
  });

  it('rejects a reversed envelope and a delayed transient at the original frame count', () => {
    const channels = transient();
    const reversed = channels.map(ch => ch.slice().reverse());
    const shifted = channels.map(ch => {
      const out = new Float32Array(ch.length);
      out.set(ch.subarray(0, ch.length - 480), 480);
      return out;
    });
    for (const decoded of [reversed, shifted]) {
      expect(verify({ channels, sampleRate }, decoded, false, 'sfx').problems.join()).toContain('decoded loudness over time');
    }
  });

  it('still rejects trimmed or padded decoded frame counts', () => {
    const channels = transient();
    const truncated = channels.map(ch => ch.slice(0, ch.length - 100));
    const padded = channels.map(ch => { const out = new Float32Array(ch.length + 100); out.set(ch); return out; });
    for (const decoded of [truncated, padded]) {
      expect(verify({ channels, sampleRate }, decoded, false, 'sfx').problems.join()).toContain('codec added or trimmed');
    }
  });

  it('retains 20ms windows when two complete windows are available', () => {
    const blocks = (values: number[]) => Float32Array.from({ length: 1920 }, (_, i) => values[Math.floor(i / 480)]);
    const want = [blocks([0.4, 0.1, 0.2, 0.1])];
    const got = [blocks([0.1, 0.4, 0.1, 0.2])];
    // The 20ms energy bins agree; smaller bins would compare a different shape.
    expect(envelopeCorrelation(want, got, sampleRate)).toBeCloseTo(1, 12);
  });

  it.skipIf(!ffmpeg)('accepts a real short Opus decode and rejects its damaged controls', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-short-sfx-'));
    temporary.push(dir);
    const wav = join(dir, 'transient.wav'), encoded = join(dir, 'transient.ogg');
    writeFileSync(wav, writeWav(transient(), sampleRate));
    const source = readWav(readFileSync(wav));
    encodeOpus(ffmpeg!, wav, encoded, 72);
    const decoded = decodeChannels(ffmpeg!, encoded, source.channels.length, source.sampleRate);
    expect(verify(source, decoded, false, 'sfx').problems).toEqual([]);
    const silence = decoded.map(ch => new Float32Array(ch.length));
    const reversed = decoded.map(ch => ch.slice().reverse());
    const truncated = decoded.map(ch => ch.slice(0, ch.length - 100));
    const shifted = decoded.map(ch => { const out = new Float32Array(ch.length); out.set(ch.subarray(0, ch.length - 480), 480); return out; });
    for (const damaged of [silence, reversed, truncated, shifted]) {
      expect(verify(source, damaged, false, 'sfx').problems.length).toBeGreaterThan(0);
    }
  });
});
