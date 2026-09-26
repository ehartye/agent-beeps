import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mulberry32 } from '../runtime/engine/rng.js';
import { farthestPoint, generate } from '../src/generate.ts';
import { crossover, directionScore, mutate, perturb } from '../src/mutate.ts';
import { getArchetype } from '../src/archetypes.ts';
import { parsePatch } from '../src/schema/patch.ts';
import { featureVector, FEATURE_NAMES } from '../src/measure/index.ts';
import { initProject } from '../src/project.ts';
import { chromiumAvailable, openRenderHost, type RenderHost } from '../src/render/host.ts';
import { coin } from './helpers/patches.ts';

describe('farthest-point selection', () => {
  it('spreads picks across clusters', () => {
    const pts = [[0, 0], [0.1, 0], [0, 0.1], [10, 10], [10.1, 10], [-10, 5]];
    const pick = farthestPoint(pts, 3, 0);
    expect(pick[0]).toBe(0);
    expect(new Set(pick.map(i => (i >= 3 ? i : 0))).size).toBe(3);
  });
});

describe('prompt steering', () => {
  it('reads everyday words as directions', async () => {
    const { promptDirections } = await import('../src/directions.ts');
    expect(promptDirections('coin pickup for a cozy platformer: warm, soft, not harsh').sort()).toEqual(['darker', 'less-harsh', 'softer']);
    expect(promptDirections('bright sparkly short blip').sort()).toEqual(['brighter', 'shorter']);
    expect(promptDirections('a coin')).toEqual([]);
    expect(promptDirections('bright but dark')).toEqual([]); // contradictions cancel
  });
});

describe('perturb and crossover', () => {
  it('keeps 200 mutations schema-valid, waveforms fixed, and changes something', () => {
    const a = getArchetype('laser');
    const rand = mulberry32(3);
    let changed = 0;
    for (let i = 0; i < 200; i++) {
      const m = perturb(a.template, rand, a);
      expect(parsePatch(m).ok).toBe(true);
      m.layers.forEach((l, k) => { if (l.source.type === 'osc') expect(l.source.wave).toBe((a.template.layers[k].source as any).wave); });
      if (JSON.stringify(m) !== JSON.stringify(a.template)) changed++;
    }
    expect(changed).toBeGreaterThan(190);
  });

  it('crossover at t=0 is the first parent and interpolates numbers in between', () => {
    const a = coin();
    const b = { ...coin(), layers: [{ ...coin().layers[0], amp: { ...coin().layers[0].amp, decay: 0.48 } }] };
    expect(crossover(a, b, 0).layers[0].amp.decay).toBeCloseTo(0.12);
    expect(crossover(a, b, 0.5).layers[0].amp.decay).toBeCloseTo(Math.sqrt(0.12 * 0.48), 3);
  });

  it('scores movement along requested directions', () => {
    const parent = new Array(FEATURE_NAMES.length).fill(0);
    const brighter = [...parent]; brighter[FEATURE_NAMES.indexOf('brightness')] = 1;
    expect(directionScore(parent, brighter, ['brighter'])).toBeGreaterThan(0);
    expect(directionScore(parent, brighter, ['darker'])).toBeLessThan(0);
  });
});

describe.skipIf(!(await chromiumAvailable()))('generate and mutate in Chromium', () => {
  let host: RenderHost;
  beforeAll(async () => { process.env.AGENT_BEEPS_HOME = mkdtempSync(join(tmpdir(), 'beeps-home-')); host = await openRenderHost(); });
  afterAll(async () => { await host?.close(); });

  it('generates a diverse, lint-clean set with a contact sheet, then darkens a candidate', async () => {
    const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-gen-')));
    const set = await generate(host, p, { archetype: 'coin', count: 4, seed: 11, prompt: 'coin' });
    expect(set.candidates).toHaveLength(4);
    expect(existsSync(set.sheet!)).toBe(true);
    const vecs = set.candidates.map(c => featureVector(c.features as any));
    for (let i = 0; i < vecs.length; i++) for (let j = i + 1; j < vecs.length; j++) expect(vecs[i]).not.toEqual(vecs[j]);

    const parentName = set.candidates[0].name;
    const { loadPatch } = await import('../src/project.ts');
    const parent = loadPatch(p, parentName);
    const darker = await mutate(host, p, { parent, toward: ['darker'], count: 3, seed: 5 });
    expect(darker.candidates.length).toBeGreaterThan(0);
    const b = (c: any) => c.features.centroidHz as number;
    const strong = darker.candidates.filter(c => !c.weak);
    expect(strong.length).toBeGreaterThan(0);
    for (const c of strong) expect(b(c)).toBeLessThan(b(set.candidates[0]));
  });
});
