// tests/player/compress.test.ts
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWav } from '../../src/audio/wav.ts';
import { alignmentSnrDb, checkLoops, compressBundle, findFfmpeg, wrapReport } from '../../src/compress.ts';

const hasFfmpeg = (() => { try { findFfmpeg(); return true; } catch { return false; } })();
const SR = 48000;

/** A loop that wraps exactly: every partial completes a whole number of cycles in the file. */
function loopChannels(sec: number): Float32Array[] {
  const n = Math.round(SR * sec);
  const make = (hz: number) => {
    const a = Math.round(hz * sec), b = Math.round(hz * 2.01 * sec);
    return Float32Array.from({ length: n }, (_, i) => 0.25 * Math.sin(2 * Math.PI * a * i / n) + 0.1 * Math.sin(2 * Math.PI * b * i / n));
  };
  return [make(220), make(330)];
}
const sidecar = (id: string, file: string, durationSec: number, extra: Record<string, unknown> = {}) => ({
  schema: 'beeps/audio-asset@1', id, label: id, description: '', role: 'music', file, loop: true, durationSec, sampleRate: SR, channels: 2,
  renderKey: 'k', loudness: { metric: 'integrated', lufs: -20 }, truePeakDb: -3, normalizationAlreadyApplied: true, ...extra,
});

describe('wrapReport', () => {
  it('sees a seamless loop as a jump of about one typical step and a click as many', () => {
    const ok = wrapReport(loopChannels(2), SR);
    expect(ok.seamExcessDb).toBeLessThan(3);
    expect(Math.abs(ok.levelStepDb)).toBeLessThan(1);
    const clicked = loopChannels(2).map(c => { const d = Float32Array.from(c); d[d.length - 1] = 0.9; return d; });
    expect(wrapReport(clicked, SR).seamExcessDb).toBeGreaterThan(15);
  });
  it('scores a shifted copy near 0 dB and an identical one high', () => {
    const a = loopChannels(1);
    expect(alignmentSnrDb(a, a)).toBeGreaterThan(100);
    expect(alignmentSnrDb(a, a.map(c => { const d = new Float32Array(c.length); d.set(c.subarray(0, c.length - 2000), 2000); return d; }))).toBeLessThan(6);
  });
});

describe.skipIf(!hasFfmpeg)('beeps compress', () => {
  it('encodes a layered loop and an sfx to opus, keeps the frame count, and bundles them', () => {
    const src = mkdtempSync(join(tmpdir(), 'beeps-compress-src-')), out = mkdtempSync(join(tmpdir(), 'beeps-compress-out-'));
    const loop = loopChannels(4);
    for (const f of ['theme.wav', 'theme.bed.wav']) writeFileSync(join(src, f), writeWav(loop, SR));
    writeFileSync(join(src, 'theme.wav.json'), JSON.stringify(sidecar('theme', 'theme.wav', 4, { bpm: 60, meter: 4, layers: [{ name: 'bed', file: 'theme.bed.wav' }], states: { calm: ['bed'] }, initialState: 'calm' })));
    writeFileSync(join(src, 'tick.wav'), writeWav([loop[0].subarray(0, 4800)], SR));
    writeFileSync(join(src, 'tick.wav.json'), JSON.stringify(sidecar('tick', 'tick.wav', 0.1, { role: 'sfx', loop: false, channels: 1, priority: 3 })));
    const r = compressBundle(src, out);
    expect(r.problems).toEqual([]);
    expect(r.bytes).toBeLessThan(r.sourceBytes / 5);
    expect(r.checks.every(c => c.frameDelta === 0)).toBe(true);
    expect(r.checks.find(c => c.file === 'theme.ogg')!.wrap!.seamExcessDb).toBeLessThan(6);
    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    expect(index.assets.theme).toMatchObject({ file: 'theme.ogg', layers: [{ name: 'bed', file: 'theme.bed.ogg' }], encoding: { codec: 'opus', kbps: 56 } });
    expect(index.assets.tick.file).toBe('tick.ogg');
    expect(existsSync(join(out, 'theme.ogg.json'))).toBe(true);
    expect(checkLoops([join(out, 'theme.ogg')])[0].problems).toEqual([]);
  });

  it('refuses an output directory equal to the source', () => {
    const d = mkdtempSync(join(tmpdir(), 'beeps-compress-same-'));
    writeFileSync(join(d, 'a.wav.json'), '{}');
    expect(() => compressBundle(d, d)).toThrow(/differ/);
  });

  it('rejects a missing ffmpeg override with a hint', () => {
    const old = process.env.BEEPS_FFMPEG;
    process.env.BEEPS_FFMPEG = join(tmpdir(), 'no-such-ffmpeg.exe');
    try { expect(() => findFfmpeg()).toThrow(/does not exist/); } finally { if (old === undefined) delete process.env.BEEPS_FFMPEG; else process.env.BEEPS_FFMPEG = old; }
  });
});
