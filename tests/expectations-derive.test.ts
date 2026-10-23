// Patch expectations, second step (0.24.0): pin a sound as it is (lint --derive-expect) and keep refinement inside the brief (mutate).
import { describe, expect, it } from 'vitest';
import { afterAll, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveExpectations, evaluateExpectations } from '../src/expect.ts';
import { parsePatch } from '../src/schema/patch.ts';
import type { Features } from '../src/measure/index.ts';
import { initProject } from '../src/project.ts';
import { mutate } from '../src/mutate.ts';
import { setCandidatePatch } from '../src/sets.ts';
import { chromiumAvailable, openRenderHost, type RenderHost } from '../src/render/host.ts';
import { coin, patch } from './helpers/patches.ts';
import { add, beeps, project } from './helpers/cli.ts';

const feat = (over: Record<string, unknown> = {}, delivered: Record<string, unknown> = {}): Features => ({
  durationSec: 0.3, attackSec: 0.004, energyLengthSec: 0.2, tailSec: 0.1, crestDb: 12, centroidHz: 3000, flatness: 0.05,
  pitchHz: 880, pitchStrength: 0.95, pitchDirection: 7, voicedFraction: 1,
  ...over,
  delivered: { samplePeakDb: -3, truePeakDb: -3, momentaryMaxLufs: -18, clippedSamples: 0, ...delivered },
}) as unknown as Features;

describe('deriving a block from what a sound measures', () => {
  it('writes numbers with room around them', () => {
    const block = deriveExpectations(feat());
    expect(block).toEqual([
      { check: 'duration', max: 0.4 },
      { check: 'attack', max: 0.006 },
      { check: 'tail', max: 0.15 },
      { check: 'centroid', min: 2380, max: 3780 },
      { check: 'pitch', note: 'A5', toleranceCents: 50, minStrength: 0.7 },
      { check: 'pitch-direction', is: 'rising' },
      { check: 'true-peak' },
      { check: 'no-clipping' },
    ]);
  });

  it('uses the measured frequency when the pitch sits between notes, and skips pitch checks on an unpitched sound', () => {
    const between = deriveExpectations(feat({ pitchHz: 905 })).find(e => e.check === 'pitch');
    expect(between).toMatchObject({ check: 'pitch', hz: 905 });
    expect(between).not.toHaveProperty('note');
    const noisy = deriveExpectations(feat({ pitchStrength: 0.1, pitchHz: 0, flatness: 0.9 }));
    expect(noisy.map(e => e.check)).toEqual(['duration', 'attack', 'tail', 'centroid', 'true-peak', 'no-clipping']);
  });

  it('documents a spiky sound as peak-limited and leaves no-clipping out of a clipped one', () => {
    expect(deriveExpectations(feat({}, { peakLimited: true })).map(e => e.check)).toContain('peak-limited');
    expect(deriveExpectations(feat({}, { clippedSamples: 4 })).map(e => e.check)).not.toContain('no-clipping');
  });

  it('gives a floor to a very fast attack and a very short tail', () => {
    const block = deriveExpectations(feat({ attackSec: 0.0001, tailSec: 0.001 }));
    expect(block.find(e => e.check === 'attack')).toEqual({ check: 'attack', max: 0.002 });
    expect(block.find(e => e.check === 'tail')).toEqual({ check: 'tail', max: 0.05 });
  });

  it('is always a valid block that the sound passes', () => {
    for (const f of [feat(), feat({ pitchStrength: 0.1, pitchHz: 0 }), feat({ pitchHz: 905, pitchDirection: -3 }), feat({ pitchDirection: 0.2 }), feat({}, { peakLimited: true, clippedSamples: 2 })]) {
      const p = patch({ ...coin(), xExpect: deriveExpectations(f) });
      expect(parsePatch(p).ok).toBe(true);
      expect(evaluateExpectations(p, [f]).passed).toBe(true);
    }
  });
});

describe.skipIf(!(await chromiumAvailable()))('pinning a real sound', () => {
  it('lint --derive-expect prints a block that, saved into the patch, makes lint pass', () => {
    const dir = project();
    add(dir, coin());
    const first = beeps(dir, 'lint', 'coin', '--derive-expect');
    const block = first.out.reports[0].derived.xExpect;
    expect(block.length).toBeGreaterThan(3);
    expect(first.out.reports[0].expectations).toBeUndefined();
    add(dir, { ...coin(), xExpect: block });
    const again = beeps(dir, 'lint', 'coin');
    expect(again.status).toBe(0);
    expect(again.out.reports[0].expectations.passed).toBe(true);
    expect(again.out.reports[0].derived).toBeUndefined();
  });

  it('a derived block is a regression gate: a changed sound fails it', () => {
    const dir = project();
    add(dir, coin());
    const block = beeps(dir, 'lint', 'coin', '--derive-expect').out.reports[0].derived.xExpect;
    const longer = { ...coin(), duration: 1.5, layers: [{ ...coin().layers[0], amp: { ...coin().layers[0].amp, decay: 0.9 } }], xExpect: block };
    add(dir, longer);
    const r = beeps(dir, 'lint', 'coin');
    expect(r.status).toBe(1);
    expect(r.out.reports[0].expectations.checks.filter((c: { outcome: string }) => c.outcome === 'fail').length).toBeGreaterThan(0);
  });

  it('with --brief, a patch asked to derive is listed rather than called clean', () => {
    const dir = project();
    add(dir, coin());
    const r = beeps(dir, 'lint', 'coin', '--brief', '--derive-expect');
    expect(r.out.clean).not.toContain('coin');
    expect(r.out.reports[0].derived.xExpect.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!(await chromiumAvailable()))('mutate stays inside the brief', () => {
  let host: RenderHost;
  beforeAll(async () => { process.env.AGENT_BEEPS_HOME = mkdtempSync(join(tmpdir(), 'beeps-home-')); host = await openRenderHost(); });
  afterAll(async () => { await host?.close(); });

  it('keeps children that meet the parent block, and does not pass the block on', async () => {
    const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-mut-')));
    const parent = patch({ ...coin(), xExpect: [{ check: 'duration', max: 2 }] });
    const set = await mutate(host, p, { parent, toward: ['darker'], count: 3, seed: 5 });
    expect(set.report.expectationMisses).toBeUndefined();
    expect(set.candidates.length).toBeGreaterThan(0);
    for (const c of set.candidates) expect(setCandidatePatch(p, set.id, c.name).xExpect).toBeUndefined();
  });

  it('drops children that miss it, says which check dropped them, and can be told not to', async () => {
    const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-mut-')));
    const centroid = (await mutate(host, p, { parent: coin(), toward: [], count: 1, seed: 1 })).candidates[0].features as { centroidHz: number };
    const brief = patch({ ...coin(), xExpect: [{ check: 'centroid', max: Math.round(centroid.centroidHz * 0.9) }] });
    let set: Awaited<ReturnType<typeof mutate>> | undefined, failure: (Error & { code?: string; hint?: string }) | undefined;
    try { set = await mutate(host, p, { parent: brief, toward: ['brighter'], count: 4, seed: 5 }); } catch (e) { failure = e as Error; }
    if (failure || !set) {
      expect(failure).toMatchObject({ code: 'E_RENDER' });
      expect(failure!.hint).toMatch(/--ignore-expect/);
    } else {
      expect(set.report.expectationMisses?.centroid ?? 0).toBeGreaterThan(0);
      expect(set.report.dropped.some(d => d.reason === 'expectation' && d.checks?.includes('centroid'))).toBe(true);
      expect(set.report.kept + set.report.notSelected + set.report.dropped.length).toBe(set.report.tried);
    }
    const free = await mutate(host, p, { parent: brief, toward: ['brighter'], count: 4, seed: 5, ignoreExpect: true });
    expect(free.report.dropped.some(d => d.reason === 'expectation')).toBe(false);
    expect(free.candidates.length).toBeGreaterThan(0);
  });

  it('fails with a hint about --ignore-expect when no child can meet the block', async () => {
    const dir = project();
    add(dir, patch({ ...coin(), xExpect: [{ check: 'duration', max: 0.01 }] }));
    const r = beeps(dir, 'mutate', 'coin', '--toward', 'darker', '--count', '2', '--seed', '3');
    expect(r.status).toBe(1);
    expect(r.err.code).toBe('E_RENDER');
    expect(r.err.hint).toMatch(/--ignore-expect/);
    const free = beeps(dir, 'mutate', 'coin', '--toward', 'darker', '--count', '2', '--seed', '3', '--ignore-expect');
    expect(free.status).toBe(0);
    expect(free.out.candidates.length).toBeGreaterThan(0);
  });
});

