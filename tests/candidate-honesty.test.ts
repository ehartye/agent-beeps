// Honest feedback, Phase 2a (0.20.0): candidate sets say what they dropped, and the commands around them stop acting quietly on
// input they could not use (a bad array index, an option for a project that exists, a bitrate that is not a number).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BeepsError } from '../src/errors.ts';
import { readPrompt } from '../src/directions.ts';
import { applyBatch } from '../src/batch.ts';
import { generate } from '../src/generate.ts';
import { mutate } from '../src/mutate.ts';
import { loadPatch, initProject, openProject } from '../src/project.ts';
import { removePointer } from '../src/pointer.ts';
import { chromiumAvailable, openRenderHost, type RenderHost } from '../src/render/host.ts';
import { requireCandidates, setNotices, setReport, type SetReport } from '../src/set-report.ts';
import { coin } from './helpers/patches.ts';
import { add, beeps, project } from './helpers/cli.ts';

const report = (over: Partial<SetReport> = {}): SetReport => ({ requested: 6, kept: 6, tried: 24, dropped: [], notSelected: 18, ...over });
const fakeRenders = (n: number) => Array.from({ length: n }, () => ({})) as never;

describe('the set report', () => {
  it('counts every tried candidate exactly once', () => {
    const dropped = [{ name: 'a', reason: 'lint' as const, detail: 'tail-ceiling' }, { name: 'b', reason: 'render' as const, detail: 'boom' }];
    const r = setReport(6, fakeRenders(10), dropped, 4);
    expect(r).toMatchObject({ requested: 6, kept: 4, tried: 12, notSelected: 6 });
    expect(r.kept + r.notSelected + r.dropped.length).toBe(r.tried);
  });

  it('is a short-set notice only when fewer were kept than asked for', () => {
    expect(setNotices(report())).toEqual([]);
    const [n] = setNotices(report({ kept: 3, notSelected: 0, dropped: Array.from({ length: 21 }, (_, i) => ({ name: `c${i}`, reason: 'lint' as const, detail: 'x' })) }));
    expect(n).toMatchObject({ code: 'N_SHORT_SET', severity: 'warn', requested: 6, applied: 3 });
  });

  it('says when a prompt cancelled itself or could not steer', () => {
    const steering = { directions: ['softer'], cancelled: [['brighter', 'darker']] as [string, string][], applied: false };
    expect(setNotices(report(), steering).map(n => n.code)).toEqual(['N_STEERING_CANCELLED', 'N_STEERING_UNUSED']);
    expect(setNotices(report(), { ...steering, applied: true, cancelled: [] })).toEqual([]);
    expect(setNotices(report(), { directions: [], cancelled: [], applied: false })).toEqual([]);
  });

  it('fails with E_RENDER and the first drops when nothing survived', () => {
    const dropped = Array.from({ length: 14 }, (_, i) => ({ name: `c${i}`, reason: 'lint' as const, detail: 'x' }));
    let thrown: unknown;
    try { requireCandidates(report({ kept: 0, tried: 14, notSelected: 0, dropped }), 'coin candidate'); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BeepsError);
    expect(thrown).toMatchObject({ code: 'E_RENDER', details: { report: { kept: 0 } } });
    expect((thrown as BeepsError).details!.report).toMatchObject({ dropped: expect.any(Array) });
    expect(((thrown as BeepsError).details!.report as SetReport).dropped).toHaveLength(10);
    expect(() => requireCandidates(report(), 'x')).not.toThrow();
  });

  it('reads which opposite words in a prompt cancelled', () => {
    expect(readPrompt('bright but dark')).toEqual({ directions: [], cancelled: [['brighter', 'darker']] });
    expect(readPrompt('a short, long thing, cozy').cancelled).toEqual([['shorter', 'longer']]);
    expect(readPrompt('a coin')).toEqual({ directions: [], cancelled: [] });
  });
});

describe('removing from a patch', () => {
  it('refuses an array entry that is not an index in range, instead of removing the first', () => {
    for (const ptr of ['/list/abc', '/list/-1', '/list/5', '/list/01']) {
      const d = { list: [{ x: 1 }, { x: 2 }] };
      expect(() => removePointer(d, ptr), ptr).toThrow(/no array index/);
      expect(d.list).toHaveLength(2);
    }
  });

  it('says whether an object key was there', () => {
    const d: Record<string, unknown> = { a: 1 };
    expect(removePointer(d, '/a')).toBe(true);
    expect(removePointer(d, '/a')).toBe(false);
  });
});

describe('batch', () => {
  const setup = () => { const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-batch-'))); applyBatch(p, [{ op: 'create', patch: coin() }]); return p; };

  it('fails a remove of a bad array index with the operation index', () => {
    const p = setup();
    let thrown: unknown;
    try { applyBatch(p, [{ op: 'remove', name: 'coin', pointer: '/layers/abc' }]); } catch (e) { thrown = e; }
    expect(thrown).toMatchObject({ code: 'E_SCHEMA', details: { operationIndex: 0 } });
    expect(loadPatch(p, 'coin').layers).toHaveLength(1);
  });

  it('lists a remove of an absent key as a noop and not as a change', () => {
    const p = setup();
    const r = applyBatch(p, [{ op: 'remove', name: 'coin', pointer: '/meta' }]);
    expect(r.changed).toEqual([]);
    expect(r.noops).toEqual([{ operationIndex: 0, op: 'remove', name: 'coin', pointer: '/meta' }]);
    expect(applyBatch(p, [{ op: 'set', name: 'coin', pointer: '/duration', value: 0.4 }]).noops).toBeUndefined();
  });
});

describe('init on an existing project', () => {
  it('says which options it ignored', () => {
    const dir = project('C:majorPentatonic');
    const again = beeps(dir, 'init', '--scale', 'A:minor', '--target', '-20');
    expect(again.status).toBe(0);
    expect(again.out).toMatchObject({ existing: true, ignored: ['--scale', '--target'] });
    expect(again.out.notices.map((n: { code: string }) => n.code)).toEqual(['N_OPTION_IGNORED', 'N_OPTION_IGNORED']);
    expect(again.out.project.scale.root).toBe('C');
    expect(openProject(dir).project.scale.root).toBe('C');
  });

  it('is quiet on a plain rerun and on a first init', () => {
    const dir = project();
    expect(beeps(dir, 'init').out.notices).toBeUndefined();
    expect(beeps(dir, 'init').out.ignored).toBeUndefined();
    const fresh = mkdtempSync(join(tmpdir(), 'beeps-init-'));
    const first = beeps(fresh, 'init', '--scale', 'D:minor').out;
    expect(first.existing).toBeUndefined();
    expect(first.project.scale).toMatchObject({ root: 'D', mode: 'minor' });
  });
});

describe('option values that are not numbers', () => {
  it('rejects a bitrate of 0 or text instead of using the default', () => {
    const dir = project();
    for (const v of ['0', 'abc', '-5']) {
      const r = beeps(dir, 'compress', dir, join(dir, 'out'), '--sfx-kbps', v);
      expect(r.status, v).toBe(2);
      expect(r.err.code).toBe('E_USAGE');
    }
  });

  it('rejects a mutate --count outside 1 to 8 before touching the project', () => {
    const dir = project();
    for (const v of ['0', '9', '-1']) {
      const r = beeps(dir, 'mutate', 'coin', '--count', v);
      expect(r.status, v).toBe(1);
      expect(r.err).toMatchObject({ code: 'E_USAGE', received: v });
    }
  });
});

describe.skipIf(!(await chromiumAvailable()))('generate and mutate report what they dropped', () => {
  let host: RenderHost;
  beforeAll(async () => { process.env.AGENT_BEEPS_HOME = mkdtempSync(join(tmpdir(), 'beeps-home-')); host = await openRenderHost(); });
  afterAll(async () => { await host?.close(); });

  it('generate accounts for every candidate it tried', async () => {
    const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-gen-')));
    const set = await generate(host, p, { archetype: 'coin', count: 4, seed: 11, prompt: 'soft' });
    const r = set.report;
    expect(r).toMatchObject({ requested: 4, kept: 4 });
    expect(r.kept + r.notSelected + r.dropped.length).toBe(r.tried);
    expect(r.tried).toBeGreaterThanOrEqual(4);
    expect(set.notices.map(n => n.code)).not.toContain('N_SHORT_SET');
    expect(set.steering.length).toBeGreaterThan(0);
  });

  it('generate reports a prompt that cancelled itself', async () => {
    const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-gen-')));
    const set = await generate(host, p, { archetype: 'coin', count: 3, seed: 3, prompt: 'bright but dark' });
    expect(set.steering).toEqual([]);
    expect(set.notices.map(n => n.code)).toContain('N_STEERING_CANCELLED');
  });

  it('mutate reports unchanged perturbations and fails when the parent does not render', async () => {
    const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-mut-')));
    const set = await mutate(host, p, { parent: coin(), toward: ['darker'], count: 3, seed: 5 });
    const r = set.report;
    expect(r.kept).toBe(set.candidates.length);
    expect(r.kept + r.notSelected + r.dropped.length).toBe(r.tried);
    expect(r.unchanged).toBeGreaterThanOrEqual(0);
    expect(r.blendFallbacks).toBeUndefined();
    const broken = { ...coin(), name: 'broken', layers: [{ ...coin().layers[0], source: { type: 'sample', object: 'nope', start: 0, end: 1 } }] } as never;
    await expect(mutate(host, p, { parent: broken, toward: ['darker'], count: 2, seed: 1 })).rejects.toMatchObject({ code: 'E_RENDER' });
  });
});

describe.skipIf(!(await chromiumAvailable()))('look --out with one ref', () => {
  it('writes the image it was asked to write', () => {
    const dir = project();
    add(dir, coin());
    const out = join(dir, 'pics', 'coin.png');
    const r = beeps(dir, 'look', 'coin', '--out', out);
    expect(r.status).toBe(0);
    expect(r.out.out).toBe(out);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out).subarray(1, 4).toString()).toBe('PNG');
  });
});
