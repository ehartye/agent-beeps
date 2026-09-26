import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARCHETYPES_DIR, getArchetype, getPointer, loadArchetypes, sampleArchetype, setPointer, type Archetype } from '../src/archetypes.ts';
import { BeepsError } from '../src/errors.ts';
import { parsePatch } from '../src/schema/patch.ts';
import { defaultProject } from '../src/schema/project.ts';
import { chromiumAvailable, openRenderHost, type RenderHost } from '../src/render/host.ts';
import { renderAndMeasure, type Rendered } from '../src/render/pipeline.ts';
import { noteToHz } from '../runtime/engine/notes.js';

const NAMES = ['alarm', 'blip', 'coin', 'coin-arp', 'coin-bell', 'confirm', 'explosion', 'hit', 'jump', 'land', 'laser', 'no', 'pickup',
  'powerdown', 'powerup', 'ui-click', 'ui-hover', 'whoosh'];

const all = loadArchetypes();
const hz = (v: unknown) => noteToHz(v as string | number);

function thrown(f: () => unknown): BeepsError {
  try { f(); } catch (e) { return e as BeepsError; }
  throw new Error('expected a throw');
}

/** A throwaway archetype directory holding one coin variant. */
function dirWith(mutate: (a: any) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'beeps-arch-'));
  const a = JSON.parse(readFileSync(join(ARCHETYPES_DIR, 'coin.json'), 'utf8'));
  mutate(a);
  writeFileSync(join(dir, 'coin.json'), JSON.stringify(a));
  return dir;
}

describe('JSON pointers', () => {
  it('get and set with RFC 6901 escaping and array indices', () => {
    const doc: any = { 'a/b': { 'm~n': 1 }, list: [{ x: 1 }, { x: 2 }] };
    expect(getPointer(doc, '/a~1b/m~0n')).toBe(1);
    expect(getPointer(doc, '/list/1/x')).toBe(2);
    expect(getPointer(doc, '/list/2/x')).toBeUndefined();
    expect(getPointer(doc, '')).toBe(doc);
    setPointer(doc, '/a~1b/m~0n', 5);
    setPointer(doc, '/list/0/x', 9);
    setPointer(doc, '/top', true);
    expect(doc['a/b']['m~n']).toBe(5);
    expect(doc.list[0].x).toBe(9);
    expect(doc.top).toBe(true);
    expect(() => setPointer(doc, '/list/7', 1)).toThrow();
  });
});

describe('archetype library', () => {
  it('holds the v1 archetypes (16 families, coin with three structures), sorted by name', () => {
    expect(all.map(a => a.name)).toEqual(NAMES);
  });

  it('every template is a valid patch named after its archetype', () => {
    for (const a of all) {
      const r = parsePatch(a.template);
      expect(r.ok, a.name).toBe(true);
      expect(a.template.name).toBe(a.name);
      expect(a.template.family).toBe(a.family);
      expect(a.template.archetype).toBe(a.name);
    }
  });

  it('every range pointer and ratioOf target resolves in its template', () => {
    for (const a of all) {
      expect(Object.keys(a.ranges).length, a.name).toBeGreaterThanOrEqual(3);
      for (const [ptr, range] of Object.entries(a.ranges)) {
        expect(getPointer(a.template, ptr), `${a.name} ${ptr}`).not.toBeUndefined();
        if ('ratioOf' in range) expect(getPointer(a.template, range.ratioOf), `${a.name} ${range.ratioOf}`).not.toBeUndefined();
      }
    }
  });

  it('craft basics hold in the templates', () => {
    for (const a of all) {
      for (const l of a.template.layers) {
        if (a.name === 'ui-click') expect(a.template.meta?.intent).toBe('click');
        else expect(l.amp.attack, a.name).toBeGreaterThanOrEqual(0.004);
      }
    }
    for (const n of ['coin', 'pickup', 'hit', 'laser', 'blip', 'ui-click', 'land', 'jump']) {
      const v = getArchetype(n).template.variation;
      expect(v?.pitchCents, n).toBeGreaterThanOrEqual(15);
      expect(v?.pitchCents, n).toBeLessThanOrEqual(60);
    }
    const blip = getArchetype('blip').template;
    expect(blip.tags).toContain('repeating');
    expect(blip.variation!.variants).toBeGreaterThanOrEqual(3);
    expect(blip.variation!.pitchCents).toBeGreaterThanOrEqual(20);
    expect(getArchetype('alarm').template.variation).toBeUndefined();
    expect(getArchetype('no').template.layers.every(l => l.source.type === 'osc' && ['triangle', 'sine'].includes(l.source.wave))).toBe(true);
  });

  it('getArchetype names the choices when the archetype is unknown', () => {
    expect(getArchetype('coin').name).toBe('coin');
    const e = thrown(() => getArchetype('kazoo'));
    expect(e.code).toBe('E_NOT_FOUND');
    expect(e.hint).toContain('coin');
  });
});

describe('archetype validation', () => {
  it('rejects a range pointer that does not resolve, naming file and pointer', () => {
    const dir = dirWith(a => { a.ranges['/layers/3/source/pitch'] = { min: 1, max: 2 }; });
    const e = thrown(() => loadArchetypes(dir));
    expect(e.code).toBe('E_SCHEMA');
    expect(e.message).toContain('coin.json');
    expect(e.pointer).toBe('/layers/3/source/pitch');
  });

  it('rejects a ratioOf target that comes after its dependent', () => {
    const dir = dirWith(a => {
      const { '/layers/0/source/pitch': pitch, ...rest } = a.ranges;
      a.ranges = { ...rest, '/layers/0/source/pitch': pitch };
    });
    const e = thrown(() => loadArchetypes(dir));
    expect(e.code).toBe('E_SCHEMA');
    expect(e.pointer).toBe('/layers/0/pitchEnv/0/to');
  });

  it('rejects an invalid template and a wrong schema literal', () => {
    expect(thrown(() => loadArchetypes(dirWith(a => { a.template.layers[0].amp.attack = -1; }))).pointer).toBe('/template/layers/0/amp/attack');
    expect(thrown(() => loadArchetypes(dirWith(a => { a.schema = 'beeps/archetype@2'; }))).code).toBe('E_SCHEMA');
  });
});

describe('sampling', () => {
  it('is deterministic per seed and differs across seeds', () => {
    for (const a of all) {
      const x = sampleArchetype(a, 7, 4);
      expect(sampleArchetype(a, 7, 4)).toEqual(x);
      expect(JSON.stringify(sampleArchetype(a, 8, 4).map(p => p.layers))).not.toBe(JSON.stringify(x.map(p => p.layers)));
      expect(new Set(x.map(p => JSON.stringify(p.layers))).size, a.name).toBeGreaterThan(1);
    }
  });

  it('names samples <archetype>-<seed>-<i> and honours a prefix', () => {
    const [p0, p1] = sampleArchetype(getArchetype('ui-click'), 42, 2);
    expect([p0.name, p1.name]).toEqual(['ui-click-42-0', 'ui-click-42-1']);
    expect(p0.archetype).toBe('ui-click');
    expect(sampleArchetype(getArchetype('coin'), 3, 1, { namePrefix: 'Shop-Coin' })[0].name).toBe('shop-coin-3-0');
  });

  it('never changes the template', () => {
    const a = getArchetype('laser');
    const before = JSON.stringify(a.template);
    sampleArchetype(a, 5, 10);
    expect(JSON.stringify(a.template)).toBe(before);
  });

  const within = (a: Archetype, seed: number, n: number) => {
    for (const p of sampleArchetype(a, seed, n)) {
      for (const [ptr, range] of Object.entries(a.ranges)) {
        const v = getPointer(p, ptr);
        const at = `${a.name} ${ptr}`;
        if ('ratioOf' in range) {
          const ratio = (v as number) / hz(getPointer(p, range.ratioOf));
          if ('choices' in range) expect(range.choices.some(c => Math.abs(c - ratio) <= 1e-3 * c), `${at} ratio ${ratio}`).toBe(true);
          else {
            expect(ratio, at).toBeGreaterThanOrEqual(range.min * (1 - 1e-3));
            expect(ratio, at).toBeLessThanOrEqual(range.max * (1 + 1e-3));
          }
        } else if ('choices' in range) {
          expect(range.choices.map(c => JSON.stringify(c)), at).toContain(JSON.stringify(v));
        } else {
          expect(v, at).toBeGreaterThanOrEqual(range.min);
          expect(v, at).toBeLessThanOrEqual(range.max);
        }
      }
    }
  };

  it('keeps sampled values within their ranges, ratioOf relative to the sampled target', () => {
    for (const a of all) within(a, 11, 20);
  });

  it('50 samples of every archetype parse as patches', () => {
    for (const a of all) {
      const ps = sampleArchetype(a, 2026, 50);
      expect(ps).toHaveLength(50);
      for (const p of ps) expect(parsePatch(p).ok, p.name).toBe(true);
    }
  });

  it('rejects a non-integer seed', () => {
    expect(thrown(() => sampleArchetype(all[0], 1.5, 1)).code).toBe('E_USAGE');
  });
});

describe.skipIf(!(await chromiumAvailable()))('archetypes rendered', () => {
  let host: RenderHost;
  const project = defaultProject();
  const rendersDir = mkdtempSync(join(tmpdir(), 'beeps-arch-renders-'));
  mkdirSync(rendersDir, { recursive: true });
  let byName: Map<string, Rendered[]>;

  beforeAll(async () => {
    host = await openRenderHost();
    const patches = all.flatMap(a => sampleArchetype(a, 1, 3));
    const out = await renderAndMeasure(host, patches.map(patch => ({ patch })), { project, rendersDir });
    for (const r of out) expect(r.ok, r.ok ? '' : `${r.patchName}: ${r.error}`).toBe(true);
    byName = new Map();
    for (const r of out as Rendered[]) byName.set(r.patch.archetype!, [...(byName.get(r.patch.archetype!) ?? []), r]);
  }, 300000);
  afterAll(async () => { await host?.close(); });

  it('renders 3 samples of each archetype under the true-peak ceiling', () => {
    expect([...byName.keys()].sort()).toEqual(NAMES);
    for (const rs of byName.values()) {
      expect(rs).toHaveLength(3);
      for (const r of rs) expect(r.features.delivered.truePeakDb, r.patch.name).toBeLessThan(-0.5);
    }
  });

  it('attacks match the craft intent', () => {
    for (const [name, rs] of byName) for (const r of rs) {
      const a = r.features.attackSec;
      if (name === 'ui-click') expect(a, r.patch.name).toBeLessThan(0.004);
      else if (name === 'whoosh') expect(a, r.patch.name).toBeGreaterThanOrEqual(0.05);
      else if (name === 'no') expect(a, r.patch.name).toBeGreaterThanOrEqual(0.006);
      // A 4 ms linear ramp measures ~3 ms from 10 % to 90 % on a 2 ms RMS envelope.
      else expect(a, r.patch.name).toBeGreaterThanOrEqual(0.0025);
    }
  });

  it('ticks and text blips are short', () => {
    for (const name of ['ui-click', 'blip']) for (const r of byName.get(name)!) {
      expect(r.features.energyLengthSec, r.patch.name).toBeLessThanOrEqual(0.08);
    }
  });

  it('pitch moves the way each archetype says', () => {
    const dir = (name: string) => byName.get(name)!.filter(r => r.features.pitchStrength >= 0.7).map(r => r.features.pitchDirection);
    for (const d of dir('no')) expect(d).toBeLessThan(0);
    for (const d of dir('jump')) expect(d).toBeGreaterThan(0);
    for (const d of dir('powerup')) expect(d).toBeGreaterThan(0);
    expect(dir('no').length + dir('jump').length + dir('powerup').length).toBeGreaterThanOrEqual(6);
  });

  it('noise archetypes are noisy', () => {
    for (const name of ['explosion', 'whoosh']) for (const r of byName.get(name)!) {
      expect(r.features.flatness, r.patch.name).toBeGreaterThan(0.2);
    }
  });
});
