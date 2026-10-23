// 0.29.0: a signed spectrogram difference between two sounds, and the golden-kit gate that judges a changed render by its effect.
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePng, pngSize } from '../src/diff/png.ts';
import { spectrogramDiff, ROWS } from '../src/diff/spectrogram-diff.ts';
import { writeWav } from '../src/audio/wav.ts';
import { GoldenSchema, judgeGolden, measuredOf, type Golden } from '../src/golden.ts';
import type { Features } from '../src/measure/index.ts';
import { chromiumAvailable } from '../src/render/host.ts';
import { coin } from './helpers/patches.ts';
import { add, beeps, project } from './helpers/cli.ts';

const SR = 48000;
const tone = (hz: number, sec: number, amp: number) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));
const mix = (...xs: Float32Array[]) => Float32Array.from({ length: Math.max(...xs.map(x => x.length)) }, (_, i) => xs.reduce((s, x) => s + (x[i] ?? 0), 0));
const tmp = (n: string) => mkdtempSync(join(tmpdir(), `beeps-${n}-`));

describe('the PNG writer', () => {
  it('writes a file a reader can size, and the same bytes for the same pixels', () => {
    const rgb = Uint8Array.from({ length: 5 * 3 * 3 }, (_, i) => (i * 7) % 256);
    const a = encodePng(5, 3, rgb), b = encodePng(5, 3, rgb);
    expect(a.equals(b)).toBe(true);
    expect(pngSize(a)).toEqual({ width: 5, height: 3 });
    expect(a.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(() => encodePng(5, 3, new Uint8Array(10))).toThrow(/expected 45/);
    expect(pngSize(Buffer.from('not a png at all, really not'))).toBeNull();
  });
});

describe('the signed spectrogram difference', () => {
  const base = mix(tone(500, 1, 0.3), tone(6000, 1, 0.1));

  it('is zero and white for a sound against itself', () => {
    const d = spectrogramDiff(base, base, SR);
    expect(d.meanDb).toBe(0);
    expect(d.bands.every(b => b.db === null || b.db === 0)).toBe(true);
    expect(d.hints).toEqual([]);
    expect(pngSize(d.png)).toEqual({ width: d.cols * 4, height: ROWS * 4 + 6 + 12 });
  });

  it('reads +6 dB where the second sound is twice as loud in one band, and nothing elsewhere', () => {
    const louder = mix(tone(500, 1, 0.3), tone(6000, 1, 0.2));
    const d = spectrogramDiff(base, louder, SR);
    const top = d.bands.find(b => b.loHz === 4000)!;
    expect(top.db!).toBeGreaterThan(4.5);
    expect(top.db!).toBeLessThan(7.5);
    const mid = d.bands.find(b => b.loHz === 250)!;
    expect(Math.abs(mid.db ?? 0)).toBeLessThan(1);
    expect(d.hints.join(' ')).toMatch(/4k-8k Hz: the second sound has [\d.]+ dB more energy/);
    const reverse = spectrogramDiff(louder, base, SR);
    expect(reverse.bands.find(b => b.loHz === 4000)!.db!).toBeLessThan(-4.5);
  });

  it('places a difference in time: a tone added only in the last third shows in the last third', () => {
    const late = mix(base, Float32Array.from({ length: base.length }, (_, i) => (i > (2 * base.length) / 3 ? 0.2 * Math.sin((2 * Math.PI * 1500 * i) / SR) : 0)));
    const d = spectrogramDiff(base, late, SR);
    const band1500 = (t: number) => d.thirds[t - 1].bands.find(b => b.loHz === 1000)!.db;
    expect(band1500(3)!).toBeGreaterThan(6);
    expect(band1500(1) ?? 0).toBeLessThan(1);
    expect(d.thirds.map(t => t.startSec)).toEqual([0, 0.3, 0.7]);
  });

  it('compares sounds of different length on one time axis', () => {
    const d = spectrogramDiff(tone(500, 0.5, 0.3), tone(500, 1.5, 0.3), SR);
    expect(d.durationSec).toBe(1.5);
    expect(d.thirds[2].meanDb!).toBeGreaterThan(10);
  });

  it('says so when both are silent', () => {
    const d = spectrogramDiff(new Float32Array(SR), new Float32Array(SR), SR);
    expect(d.meanDb).toBeNull();
    expect(d.hints.join(' ')).toMatch(/silent/);
  });

  it('works from the command line on two audio files', () => {
    const dir = tmp('diff');
    writeFileSync(join(dir, 'a.wav'), writeWav([base], SR));
    writeFileSync(join(dir, 'b.wav'), writeWav([mix(tone(500, 1, 0.3), tone(6000, 1, 0.2))], SR));
    const out = join(dir, 'ab.png');
    const r = beeps(dir, 'diff', join(dir, 'a.wav'), join(dir, 'b.wav'), '--out', out);
    expect(r.status).toBe(0);
    expect(r.out.image).toBe(out);
    expect(pngSize(readFileSync(out))).not.toBeNull();
    expect(r.out.bands.find((b: { loHz: number }) => b.loHz === 4000).db).toBeGreaterThan(4.5);
    expect(r.out.deltas.centroidHz).toBeGreaterThan(0);
    expect(beeps(dir, 'diff', join(dir, 'a.wav'), join(dir, 'b.wav')).err.code).toBe('E_USAGE');
    expect(beeps(dir, 'diff', join(dir, 'a.wav'), join(dir, 'b.wav'), '--out', join(dir, 'a.png')).status).toBe(0);
  });
});

describe('judging a render against its blessed copy', () => {
  const feat = (over: Record<string, unknown> = {}, delivered: Record<string, unknown> = {}): Features => ({
    durationSec: 0.3, attackSec: 0.004, energyLengthSec: 0.2, tailSec: 0.1, centroidHz: 3000, pitchHz: 880, pitchStrength: 0.9,
    bands: [-30, -20, -12, -10, -14, -22, -30, -40], ...over,
    delivered: { momentaryMaxLufs: -18, truePeakDb: -3, ...delivered },
  }) as unknown as Features;
  const blessed = (f: Features, tiers?: Golden['tiers']): Golden => GoldenSchema.parse({ schema: 'beeps/golden@1', name: 'coin', seed: 1, key: 'k', wavSha256: 'aaa', measured: measuredOf(f), bands: f.bands, ...(tiers ? { tiers } : {}) });

  it('is identical when the samples are', () => {
    const f = feat();
    expect(judgeGolden(blessed(f), { wavSha256: 'aaa', features: feat({ centroidHz: 9999 }) })).toEqual({ verdict: 'identical', timbreDistanceDb: 0, moved: [] });
  });

  it('is equivalent when different samples stay inside every tolerance', () => {
    const r = judgeGolden(blessed(feat()), { wavSha256: 'bbb', features: feat({ durationSec: 0.305, centroidHz: 3060, bands: [-30.4, -20.3, -11.8, -10.2, -14.1, -22.3, -29.8, -40.2], pitchHz: 882 }, { momentaryMaxLufs: -18.1 }) });
    expect(r.verdict).toBe('equivalent');
    expect(r.moved).toEqual([]);
    expect(r.timbreDistanceDb).toBeGreaterThan(0);
    expect(r.timbreDistanceDb).toBeLessThan(1.5);
  });

  it('is different, naming what moved and by how much', () => {
    const r = judgeGolden(blessed(feat()), { wavSha256: 'bbb', features: feat({ centroidHz: 3900, pitchHz: 1000, tailSec: 0.4 }) });
    expect(r.verdict).toBe('different');
    const by = Object.fromEntries(r.moved.map(m => [m.feature, m]));
    expect(by.centroidHz).toMatchObject({ was: 3000, now: 3900, change: 30, limit: 5, unit: '%' });
    expect(by.pitchHz.unit).toBe('cents');
    expect(by.tailSec.change).toBeCloseTo(0.3, 2);
  });

  it('flags a sound that stopped being pitched, and a timbre that moved with every number inside tolerance', () => {
    const lost = judgeGolden(blessed(feat()), { wavSha256: 'bbb', features: feat({ pitchStrength: 0.2 }) });
    expect(lost.moved.map(m => m.feature)).toContain('pitched');
    const timbre = judgeGolden(blessed(feat()), { wavSha256: 'bbb', features: feat({ bands: [-26, -24, -8, -14, -10, -26, -26, -44] }) });
    expect(timbre.verdict).toBe('different');
    expect(timbre.moved.map(m => m.feature)).toEqual(['timbre']);
  });

  it('takes a sound\'s own tolerances', () => {
    const f = feat({ centroidHz: 3300 });
    expect(judgeGolden(blessed(feat()), { wavSha256: 'b', features: f }).verdict).toBe('different');
    expect(judgeGolden(blessed(feat(), { centroidPct: 15 }), { wavSha256: 'b', features: f }).verdict).toBe('equivalent');
  });
});

describe.skipIf(!(await chromiumAvailable()))('the gate on a real kit', () => {
  it('blesses, checks identical, then calls a changed pitch different and a missing blessing unblessed', () => {
    const dir = project();
    add(dir, coin());
    expect(beeps(dir, 'kit', 'add', 'coin').status).toBe(0);
    const none = beeps(dir, 'kit', 'golden', 'check');
    expect(none.status).toBe(1);
    expect(none.out.results[0]).toMatchObject({ name: 'coin', verdict: 'unblessed' });

    const bless = beeps(dir, 'kit', 'golden', 'bless');
    expect(bless.status).toBe(0);
    expect(existsSync(join(dir, '.agent-beeps', 'golden', 'coin.json'))).toBe(true);
    const same = beeps(dir, 'kit', 'golden', 'check');
    expect(same.status).toBe(0);
    expect(same.out.summary).toMatchObject({ identical: 1, different: 0 });

    const higher = { ...coin(), layers: [{ ...coin().layers[0], source: { type: 'osc', wave: 'square', pitch: 'E7' }, pitchEnv: [{ at: 0.06, to: 'B7', curve: 'step' }] }] };
    add(dir, higher);
    const changed = beeps(dir, 'kit', 'golden', 'check');
    expect(changed.status).toBe(1);
    expect(changed.out.results[0].verdict).toBe('different');
    expect(changed.out.results[0].moved.map((m: { feature: string }) => m.feature)).toEqual(expect.arrayContaining(['centroidHz']));

    expect(beeps(dir, 'kit', 'golden', 'check', 'nope').err.code).toBe('E_NOT_FOUND');
  });

  it('keeps a sound\'s tolerance overrides when it is blessed again', () => {
    const dir = project();
    add(dir, coin());
    beeps(dir, 'kit', 'add', 'coin');
    beeps(dir, 'kit', 'golden', 'bless');
    const file = join(dir, '.agent-beeps', 'golden', 'coin.json');
    const g = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...g, tiers: { centroidPct: 12 } }));
    beeps(dir, 'kit', 'golden', 'bless', 'coin');
    expect(JSON.parse(readFileSync(file, 'utf8')).tiers).toEqual({ centroidPct: 12 });
  });
});
