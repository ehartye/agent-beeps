// 0.29.0: the archetypes the target use cases were missing: notification, stinger, fanfare, riser, transition.
// Every one must sample cleanly across many seeds, render, and pass the craft rules, so `generate` never hands back a set it had to rebuild.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getArchetype, loadArchetypes, sampleArchetype } from '../src/archetypes.ts';
import { initProject } from '../src/project.ts';
import { renderAndMeasure } from '../src/render/pipeline.ts';
import { renderOptions } from '../src/render/options.ts';
import { screen } from '../src/set-report.ts';
import { chromiumAvailable, openRenderHost, type RenderHost } from '../src/render/host.ts';

const NEW = ['notification', 'stinger', 'fanfare', 'riser', 'transition'] as const;
const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);

describe('the new archetypes', () => {
  it('are in the library, each with its own family and a recipe', () => {
    const all = new Map(loadArchetypes().map(a => [a.name, a]));
    for (const n of NEW) {
      const a = all.get(n);
      expect(a, n).toBeDefined();
      expect(a!.family).toBe(n);
      expect(a!.recipe.length).toBeGreaterThanOrEqual(40);
      expect(a!.template.archetype).toBe(n);
    }
  });

  it('sample into valid patches for 40 seeds, deterministically', () => {
    for (const n of NEW) {
      const a = getArchetype(n);
      for (const seed of SEEDS) expect(() => sampleArchetype(a, seed, 3), `${n} seed ${seed}`).not.toThrow();
      expect(JSON.stringify(sampleArchetype(a, 7, 2))).toBe(JSON.stringify(sampleArchetype(a, 7, 2)));
      expect(JSON.stringify(sampleArchetype(a, 7, 2))).not.toBe(JSON.stringify(sampleArchetype(a, 8, 2)));
    }
  });

  it('vary: forty seeds do not collapse to a few sounds', () => {
    for (const n of NEW) {
      const keys = new Set(SEEDS.map(seed => JSON.stringify(sampleArchetype(getArchetype(n), seed, 1)[0].layers)));
      expect(keys.size, n).toBeGreaterThanOrEqual(38);
    }
  });

  it('keep their time ranges: a riser builds, a fanfare steps four notes, a notification is two', () => {
    const duration = (n: string) => SEEDS.map(s => sampleArchetype(getArchetype(n), s, 1)[0].duration);
    expect(Math.min(...duration('riser'))).toBeGreaterThanOrEqual(1.5);
    expect(Math.max(...duration('riser'))).toBeLessThanOrEqual(3);
    expect(Math.min(...duration('transition'))).toBeGreaterThanOrEqual(0.6);
    expect(Math.max(...duration('transition'))).toBeLessThanOrEqual(1.4);
    for (const s of SEEDS) {
      const f = sampleArchetype(getArchetype('fanfare'), s, 1)[0];
      expect(f.layers).toHaveLength(4);
      const starts = f.layers.map(l => l.start);
      expect([...starts].sort((a, b) => a - b), `fanfare seed ${s}`).toEqual(starts);
      const hz = f.layers.map(l => l.source.type === 'osc' ? Number(l.source.pitch) : NaN);
      expect([...hz].sort((a, b) => a - b), `fanfare seed ${s}`).toEqual(hz);
      expect(sampleArchetype(getArchetype('notification'), s, 1)[0].layers).toHaveLength(2);
      const r = sampleArchetype(getArchetype('riser'), s, 1)[0];
      expect(r.layers[0].amp.attack, `riser seed ${s}`).toBeLessThan(r.duration);
    }
  });
});

describe.skipIf(!(await chromiumAvailable()))('rendered and linted', () => {
  let host: RenderHost;
  beforeAll(async () => { process.env.AGENT_BEEPS_HOME = mkdtempSync(join(tmpdir(), 'beeps-home-')); host = await openRenderHost(); });
  afterAll(async () => { await host?.close(); });

  for (const n of NEW) {
    it(`${n}: 40 seeds all render and pass every error-level craft rule`, async () => {
      const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-arch-')));
      const patches = SEEDS.map(seed => sampleArchetype(getArchetype(n), seed, 1)[0]);
      const out = await renderAndMeasure(host, patches.map(patch => ({ patch, seed: 1 })), renderOptions(p));
      const { usable, dropped } = screen(out, p);
      expect(dropped, n).toEqual([]);
      expect(usable).toHaveLength(40);
      const lengths = usable.map(r => r.features.durationSec);
      if (n === 'riser') expect(Math.min(...lengths)).toBeGreaterThan(1.4);
      if (n === 'stinger' || n === 'notification') expect(Math.max(...usable.map(r => r.features.energyLengthSec))).toBeLessThan(1);
    }, 120_000);
  }
});
