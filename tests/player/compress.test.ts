// tests/player/compress.test.ts
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWav } from '../../src/audio/wav.ts';
import { parseMp3 } from '../../src/audio/container.ts';
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

describe.skipIf(!hasFfmpeg)('loopcheck seam metrics', () => {
  it('reports the delivered seam and warns when it is worse than the source by 3 dB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-seam-')), src = join(dir, 'src');
    mkdirSync(src);
    const clean = loopChannels(2);
    writeFileSync(join(src, 'theme.wav'), writeWav(clean, SR));
    const ticked = clean.map(c => { const d = Float32Array.from(c); d[d.length - 1] = 0.9; return d; });
    writeFileSync(join(dir, 'theme.wav'), writeWav(ticked, SR));
    const [worse] = checkLoops([join(dir, 'theme.wav')], { source: src });
    expect(worse.seam!.boundaryStepDb).toBeGreaterThan(worse.sourceSeam!.boundaryStepDb + 3);
    expect(worse.warnings![0]).toMatch(/more than the source/);
    const [same] = checkLoops([join(src, 'theme.wav')]);
    expect(same.warnings).toBeUndefined();
    expect(same.seam!.boundaryStepDb).toBeLessThan(10);
  });
});

describe.skipIf(!hasFfmpeg)('compress sample rates', () => {
  const rate = 44100;
  const setup = () => {
    const src = mkdtempSync(join(tmpdir(), 'beeps-rate-src-')), out = mkdtempSync(join(tmpdir(), 'beeps-rate-out-'));
    const n = rate * 2, tone = Float32Array.from({ length: n }, (_, i) => 0.25 * Math.sin(2 * Math.PI * 440 * i / rate));
    writeFileSync(join(src, 'a.wav'), writeWav([tone, tone], rate));
    writeFileSync(join(src, 'a.wav.json'), JSON.stringify({ ...sidecar('a', 'a.wav', 2), sampleRate: rate, loop: false }));
    return { src, out };
  };
  it('mp3 keeps the source rate, so the sidecar and the file agree', () => {
    const { src, out } = setup();
    const r = compressBundle(src, out, { format: 'mp3' });
    expect(r.checks[0].problems).toEqual([]);
    expect(JSON.parse(readFileSync(join(out, 'a.mp3.json'), 'utf8')).sampleRate).toBe(rate);
    expect(parseMp3(readFileSync(join(out, 'a.mp3')))).toMatchObject({ sampleRate: rate });
  });
  it('opus cannot, so a 44.1 kHz source is reported rather than silently resampled', () => {
    const { src, out } = setup();
    const r = compressBundle(src, out, { format: 'opus' });
    expect(r.problems[0].problems.join()).toMatch(/always 48000 Hz but the source is 44100 Hz/);
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

  it('encodes gapless MP3 as an alternative format: same ids and frame counts, .mp3 files, mp3 encoding in the sidecar', () => {
    const src = mkdtempSync(join(tmpdir(), 'beeps-mp3-src-')), out = mkdtempSync(join(tmpdir(), 'beeps-mp3-out-'));
    const loop = loopChannels(4);
    writeFileSync(join(src, 'theme.wav'), writeWav(loop, SR));
    writeFileSync(join(src, 'theme.wav.json'), JSON.stringify(sidecar('theme', 'theme.wav', 4, { bpm: 60, meter: 4 })));
    const r = compressBundle(src, out, { format: 'mp3' });
    expect(r.problems).toEqual([]);
    expect(r.checks.every(c => c.frameDelta === 0)).toBe(true);
    expect(r.checks[0].wrap!.seamExcessDb).toBeLessThan(6);
    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    expect(index.assets.theme).toMatchObject({ file: 'theme.mp3', encoding: { codec: 'mp3', container: 'mp3', kbps: 80 } });
    expect(existsSync(join(out, 'theme.mp3.json'))).toBe(true);
  });

  it('refuses an output directory equal to the source', () => {
    const d = mkdtempSync(join(tmpdir(), 'beeps-compress-same-'));
    writeFileSync(join(d, 'a.wav.json'), '{}');
    expect(() => compressBundle(d, d)).toThrow(/differ/);
  });

  it('rejects a missing ffmpeg override with a hint that it must be a path', () => {
    const old = process.env.BEEPS_FFMPEG;
    try {
      for (const bad of [join(tmpdir(), 'no-such-ffmpeg.exe'), 'ffmpeg']) {
        process.env.BEEPS_FFMPEG = bad;
        expect(() => findFfmpeg()).toThrow(expect.objectContaining({ message: expect.stringMatching(/does not exist/), hint: expect.stringMatching(/must be the path of the ffmpeg executable/) }));
      }
    } finally { if (old === undefined) delete process.env.BEEPS_FFMPEG; else process.env.BEEPS_FFMPEG = old; }
  });

  it('rejects a directory as the ffmpeg override', () => {
    const old = process.env.BEEPS_FFMPEG;
    process.env.BEEPS_FFMPEG = tmpdir();
    try { expect(() => findFfmpeg()).toThrow(/is a directory/); } finally { if (old === undefined) delete process.env.BEEPS_FFMPEG; else process.env.BEEPS_FFMPEG = old; }
  });
});
