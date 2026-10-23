// Patch expectations (0.23.0): the xExpect block, its evaluator, where it is reported, and the guarantee that declaring one changes nothing.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateExpectations, EXPECT_REGISTRY, STEADY_BAND_SEMITONES } from '../src/expect.ts';
import { EXPECT_KINDS, parsePatch, type Patch } from '../src/schema/patch.ts';
import type { Features } from '../src/measure/index.ts';
import { patchRenderKey } from '../src/render/pipeline.ts';
import { makeCue, runtimePart } from '../src/runtime/cue.ts';
import { defaultProject } from '../src/schema/project.ts';
import { chromiumAvailable } from '../src/render/host.ts';
import { runBuild } from '../src/build/build.ts';
import { coin, patch } from './helpers/patches.ts';
import { makeFixture } from './helpers/build-fixture.ts';
import { add, beeps, project } from './helpers/cli.ts';

const feat = (over: Record<string, unknown> = {}, delivered: Record<string, unknown> = {}): Features => ({
  durationSec: 0.3, attackSec: 0.004, energyLengthSec: 0.2, tailSec: 0.1, crestDb: 12, centroidHz: 3000, flatness: 0.05,
  pitchHz: 880, pitchStrength: 0.95, pitchDirection: 7, voicedFraction: 1,
  ...over,
  delivered: { samplePeakDb: -3, truePeakDb: -3, momentaryMaxLufs: -18, clippedSamples: 0, ...delivered },
}) as unknown as Features;

const withExpect = (xExpect: unknown[], extra: Record<string, unknown> = {}) => patch({ ...coin(), ...extra, xExpect });

describe('the xExpect block in the schema', () => {
  it('parses every kind and fills the pitch defaults', () => {
    const p = withExpect([
      { check: 'duration', max: 0.35 }, { check: 'attack', min: 0.001, max: 0.015 }, { check: 'energy-length', min: 0.05 }, { check: 'tail', max: 0.12 },
      { check: 'centroid', min: 1800, max: 4200 }, { check: 'flatness', max: 0.3 }, { check: 'crest', min: 6 },
      { check: 'pitch', note: 'A5' }, { check: 'pitch-direction', is: 'rising' }, { check: 'true-peak' }, { check: 'no-clipping' }, { check: 'peak-limited', is: false },
    ]);
    expect(p.xExpect).toHaveLength(12);
    expect(p.xExpect![7]).toEqual({ check: 'pitch', note: 'A5', toleranceCents: 50, minStrength: 0.7 });
    expect(new Set(p.xExpect!.map(e => e.check))).toEqual(new Set(EXPECT_KINDS));
  });

  const bad = (xExpect: unknown[]) => { const r = parsePatch({ ...coin(), xExpect }); expect(r.ok).toBe(false); return r.ok ? [] : r.issues; };

  it('rejects an unknown kind, pointing at the entry and listing the kinds', () => {
    const [i] = bad([{ check: 'duration', max: 1 }, { check: 'loudness', max: -18 }]);
    expect(i.pointer).toBe('/xExpect/1');
    expect(i.hint).toBe(`check is one of ${EXPECT_KINDS.join(', ')}`);
  });

  it('rejects a field the kind does not have, and a bound the wrong way round', () => {
    expect(bad([{ check: 'duration', max: 1, units: 's' }])[0].pointer).toBe('/xExpect/0');
    expect(bad([{ check: 'tail', min: 0.1, max: 0.2 }])[0].pointer).toBe('/xExpect/0');
    const [i] = bad([{ check: 'centroid', min: 5000, max: 1000 }]);
    expect(i).toMatchObject({ pointer: '/xExpect/0/min', message: 'min must not be above max' });
  });

  it('needs a bound to check, and exactly one pitch to aim at', () => {
    expect(bad([{ check: 'duration' }])[0]).toMatchObject({ pointer: '/xExpect/0', message: 'duration needs a min, a max or both' });
    expect(bad([{ check: 'pitch' }])[0].message).toBe('pitch needs exactly one of note or hz');
    expect(bad([{ check: 'pitch', note: 'A5', hz: 880 }])[0].message).toBe('pitch needs exactly one of note or hz');
    expect(bad([{ check: 'pitch', note: 'H9' }])[0].pointer).toBe('/xExpect/0/note');
  });

  it('allows between 1 and 24 entries', () => {
    expect(bad([])).not.toHaveLength(0);
    expect(bad(Array.from({ length: 25 }, () => ({ check: 'no-clipping' }))).length).toBeGreaterThan(0);
  });
});

describe('a declared expectation never changes the sound', () => {
  const project0 = defaultProject();

  it('is not part of the render key, however it is edited', () => {
    const base = patchRenderKey(coin(), project0, 1, 0);
    expect(patchRenderKey(withExpect([{ check: 'duration', max: 1 }]), project0, 1, 0)).toBe(base);
    expect(patchRenderKey(withExpect([{ check: 'duration', max: 0.1 }, { check: 'no-clipping' }]), project0, 1, 0)).toBe(base);
  });

  it('is left out of a runtime cue and of its hash', () => {
    const cue = makeCue(withExpect([{ check: 'duration', max: 1 }]), project0, 1, -3);
    expect('xExpect' in cue.patch).toBe(false);
    expect(makeCue(coin(), project0, 1, -3)).toEqual(cue);
    expect(runtimePart(withExpect([{ check: 'duration', max: 1 }]))).toBe(runtimePart(coin()));
  });

  it('is accepted by the schema of a patch that also has runtime inputs', () => {
    const r = parsePatch({ ...coin(), xRuntime: { inputs: { size: { min: 0, max: 1, default: 0.5 } }, bind: [] }, xExpect: [{ check: 'no-clipping' }] });
    expect(r.ok).toBe(true);
  });
});

describe('evaluating a block', () => {
  const run = (xExpect: unknown[], f: Features[] = [feat()]) => evaluateExpectations(withExpect(xExpect), f);

  it('passes at the boundary and fails just past it', () => {
    expect(run([{ check: 'duration', max: 0.3 }, { check: 'attack', min: 0.004 }]).passed).toBe(true);
    const r = run([{ check: 'duration', max: 0.299 }]);
    expect(r.passed).toBe(false);
    expect(r.checks[0]).toMatchObject({ kind: 'duration', outcome: 'fail', pointer: '/xExpect/0', unit: 's', expected: { max: 0.299 }, actual: 0.3 });
  });

  it('reads each measured feature and its unit', () => {
    const r = run([
      { check: 'energy-length', max: 0.25 }, { check: 'tail', max: 0.1 }, { check: 'centroid', min: 2000 }, { check: 'flatness', max: 0.1 }, { check: 'crest', max: 12 },
    ]);
    expect(r.checks.map(c => [c.kind, c.actual, c.unit, c.outcome])).toEqual([
      ['energy-length', 0.2, 's', 'pass'], ['tail', 0.1, 's', 'pass'], ['centroid', 3000, 'Hz', 'pass'], ['flatness', 0.05, '0-1', 'pass'], ['crest', 12, 'dB', 'pass'],
    ]);
  });

  it('gives a hint that says which way to move, only on a failure', () => {
    const r = run([{ check: 'tail', max: 0.05 }, { check: 'centroid', min: 5000 }, { check: 'centroid', max: 4000 }, { check: 'duration', max: 1 }]);
    expect(r.checks[0].hint).toMatch(/shorten the release/);
    expect(r.checks[1].hint).toMatch(/raise the filter cutoff/);
    expect(r.checks[2].outcome).toBe('pass');
    expect(r.checks[3].hint).toBeUndefined();
  });

  it('checks a pitch within a tolerance in cents, and says how far off it is', () => {
    const a5 = run([{ check: 'pitch', note: 'A5', toleranceCents: 10 }]).checks[0];
    expect(a5).toMatchObject({ outcome: 'pass', actual: 880, targetHz: 880, offCents: 0 });
    const sharp = run([{ check: 'pitch', hz: 800, toleranceCents: 50 }]).checks[0];
    expect(sharp.outcome).toBe('fail');
    expect(sharp.offCents).toBeCloseTo(1200 * Math.log2(880 / 800), 0);
    expect(sharp.hint).toMatch(/source\.pitch/);
  });

  it('calls a pitch it cannot measure unmeasurable, which fails', () => {
    const noisy = feat({ pitchStrength: 0.2, pitchHz: 0 });
    const r = run([{ check: 'pitch', note: 'A5' }, { check: 'pitch-direction', is: 'rising' }, { check: 'duration', max: 1 }], [noisy]);
    expect(r.checks.map(c => c.outcome)).toEqual(['unmeasurable', 'unmeasurable', 'pass']);
    expect(r.checks[0]).toMatchObject({ actual: null, reason: expect.stringContaining('no steady pitch') });
    expect(r.passed).toBe(false);
    expect(run([{ check: 'pitch', note: 'A5', minStrength: 0.1 }], [feat({ pitchStrength: 0.2 })]).checks[0].outcome).toBe('pass');
  });

  it('reads the direction with a dead band of half a semitone', () => {
    const dir = (semitones: number, is: string) => run([{ check: 'pitch-direction', is }], [feat({ pitchDirection: semitones })]).checks[0];
    expect(dir(7, 'rising').outcome).toBe('pass');
    expect(dir(-7, 'falling').outcome).toBe('pass');
    expect(dir(STEADY_BAND_SEMITONES, 'steady').outcome).toBe('pass');
    expect(dir(-STEADY_BAND_SEMITONES, 'steady').outcome).toBe('pass');
    expect(dir(0.6, 'steady')).toMatchObject({ outcome: 'fail', actual: 'rising', semitones: 0.6 });
  });

  it('checks the delivered peaks, with the craft ceiling as the default true-peak', () => {
    const r = (f: Features, e: unknown[]) => run(e, [f]).checks.map(c => c.outcome);
    expect(r(feat({}, { truePeakDb: -1 }), [{ check: 'true-peak' }])).toEqual(['pass']);
    expect(r(feat({}, { truePeakDb: -0.5 }), [{ check: 'true-peak' }])).toEqual(['fail']);
    expect(r(feat({}, { truePeakDb: -0.5 }), [{ check: 'true-peak', max: 0 }])).toEqual(['pass']);
    expect(run([{ check: 'true-peak' }]).checks[0].expected).toEqual({ max: -1 });
    expect(r(feat({}, { clippedSamples: 3 }), [{ check: 'no-clipping' }])).toEqual(['fail']);
    expect(r(feat({}, { peakLimited: true }), [{ check: 'peak-limited', is: true }])).toEqual(['pass']);
    expect(r(feat(), [{ check: 'peak-limited', is: true }])).toEqual(['fail']);
  });

  it('reports a failing variant by index, and never averages across variants', () => {
    const variants = [feat(), feat(), feat({ pitchHz: 990 }), feat({ pitchHz: 1100 })];
    const r = run([{ check: 'pitch', note: 'A5', toleranceCents: 30 }, { check: 'duration', max: 1 }], variants);
    expect(r.checks[0]).toMatchObject({ outcome: 'fail', variant: 2, actual: 990 });
    expect(r.checks[1].variant).toBeUndefined();
    expect(run([{ check: 'duration', max: 1 }], variants).checks[0].variant).toBeUndefined();
  });

  it('is empty and passing for a patch with no block', () => {
    expect(evaluateExpectations(coin(), [feat()])).toEqual({ passed: true, checks: [] });
  });
});

describe('the docs follow the registry', () => {
  it('has an entry for every kind and a current docs/expectations.md', () => {
    expect(Object.keys(EXPECT_REGISTRY).sort()).toEqual([...EXPECT_KINDS].sort());
    const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'gen-expect-docs.mjs'), '--check'], { encoding: 'utf8', windowsHide: true });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const doc = readFileSync(join(import.meta.dirname, '..', 'docs', 'expectations.md'), 'utf8');
    for (const k of EXPECT_KINDS) expect(doc, k).toContain(`\`${k}\``);
  });

  it('lists the kinds in capabilities', () => {
    const dir = project();
    const caps = beeps(dir, 'capabilities', '--no-schema').out;
    expect(caps.expectKinds.map((k: { kind: string }) => k.kind)).toEqual([...EXPECT_KINDS]);
  });
});

describe.skipIf(!(await chromiumAvailable()))('reported by lint, kit check and build', () => {
  const chime = (xExpect: unknown[], extra: Record<string, unknown> = {}): Patch => patch({ ...coin(), name: 'chime', ...extra, xExpect });

  it('lint exits 1 on a failed expectation, with the pointer and hint, and is not an error', () => {
    const dir = project();
    add(dir, chime([{ check: 'duration', max: 0.35 }, { check: 'tail', max: 0.001 }]));
    const r = beeps(dir, 'lint', 'chime');
    expect(r.status).toBe(1);
    const report = r.out.reports[0];
    expect(report.errors).toEqual([]);
    expect(report.expectations.passed).toBe(false);
    expect(report.expectations.checks.map((c: { outcome: string }) => c.outcome)).toEqual(['pass', 'fail']);
    expect(report.expectations.checks[1]).toMatchObject({ kind: 'tail', pointer: '/xExpect/1', expected: { max: 0.001 } });
    expect(report.expectations.checks[1].hint).toBeTruthy();
  });

  it('lint exits 0 when the expectations hold, and keeps the patch in the clean list of a brief run', () => {
    const dir = project();
    add(dir, chime([{ check: 'duration', max: 1 }, { check: 'no-clipping' }]));
    const r = beeps(dir, 'lint', 'chime', '--brief');
    expect(r.status).toBe(0);
    expect(r.out.clean).toContain('chime');
    expect(beeps(dir, 'lint', 'chime').out.reports[0].expectations.passed).toBe(true);
  });

  it('a failing expectation keeps the patch out of the brief clean list', () => {
    const dir = project();
    add(dir, chime([{ check: 'duration', max: 0.01 }]));
    const r = beeps(dir, 'lint', 'chime', '--brief');
    expect(r.status).toBe(1);
    expect(r.out.clean).not.toContain('chime');
  });

  it('checks every declared variant and names the one that fails', () => {
    const dir = project('C:chromatic');
    add(dir, chime([{ check: 'pitch', note: 'E6', toleranceCents: 20 }], { variation: { variants: 4, pitchCents: 200 } }));
    const r = beeps(dir, 'lint', 'chime');
    const c = r.out.reports[0].expectations.checks[0];
    expect(c.outcome).toBe('fail');
    expect(c.variant).toBeGreaterThanOrEqual(1);
    expect(r.status).toBe(1);
  });

  it('kit check carries the same verdict and exits 1', () => {
    const dir = project();
    add(dir, chime([{ check: 'duration', max: 0.01 }]));
    expect(beeps(dir, 'kit', 'add', 'chime').status).toBe(0);
    const r = beeps(dir, 'kit', 'check');
    expect(r.status).toBe(1);
    expect(r.out.sounds[0].expectations).toMatchObject({ passed: false });
  });

  it('renders the same samples and key with and without the block', () => {
    const dir = project();
    add(dir, { ...coin(), name: 'plain' }, chime([{ check: 'duration', max: 0.01 }], { name: 'plain-x' }));
    const a = beeps(dir, 'render', 'plain').out.renders[0];
    const b = beeps(dir, 'render', 'plain-x').out.renders[0];
    expect(b.trimDb).toBe(a.trimDb);
    expect(b.features).toEqual(a.features);
    expect(readFileSync(b.wav).equals(readFileSync(a.wav))).toBe(true);
  });

  it('build refuses to ship a patch whose expectations fail, and ships one that holds', async () => {
    const fx = makeFixture({ config: { target: 'wav-master' } });
    fx.write('sfx/coin.json', { ...coin(), xExpect: [{ check: 'duration', max: 0.01 }] });
    await expect(runBuild(fx.cfg(), { only: ['coin'] })).rejects.toMatchObject({ code: 'E_VERIFY', pointer: '/xExpect/0' });
    fx.write('sfx/coin.json', { ...coin(), xExpect: [{ check: 'duration', max: 5 }] });
    const ok = await runBuild(fx.cfg(), { only: ['coin'] });
    expect(ok.built).toEqual(['coin']);
  });
});
