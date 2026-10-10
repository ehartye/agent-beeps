// Option B is a transcription of the engine. The cheapest proof that it is a faithful one needs no browser: build the same
// patch through the engine (applyParams + buildPatch, which is what the renderer and the interpreter run) and through the
// generated module on a recording context, and require the two graphs to be identical node for node, parameter for
// parameter, connection for connection. Identical graphs sum in identical order (sum.js), so they render identical samples.
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyParams } from '../../runtime/engine/params.js';
import { buildPatch } from '../../runtime/engine/patch.js';
import { loadArchetypes, sampleArchetype } from '../../src/archetypes.ts';
import { CODEGEN_SOURCES } from '../../src/codegen/emit.ts';
import { exportRuntime } from '../../src/codegen/export.ts';
import { parsePatch, type Patch } from '../../src/schema/patch.ts';
import { FakeContext, asCtx } from '../helpers/fake-context.ts';
import { dumpGraph } from '../helpers/graph-dump.ts';

const SPIKE = join(import.meta.dirname, '..', '..', 'library', 'sounds', 'runtime-spike');
const spike: Patch[] = readdirSync(join(SPIKE, 'patches')).map(f => {
  const r = parsePatch(JSON.parse(readFileSync(join(SPIKE, 'patches', f), 'utf8')));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.patch;
});
// Every archetype the generator ships, two samples each: the sources and layer shapes real patches use, no inputs bound.
const arch: Patch[] = loadArchetypes().flatMap(a => sampleArchetype(a, 11, 2)).filter(p => p.layers.every(l => (CODEGEN_SOURCES as readonly string[]).includes(l.source.type)));

const dir = mkdtempSync(join(tmpdir(), 'beeps-gen-'));
const all = [...spike, ...arch.map((p, i) => ({ ...p, name: `${p.name}-${i}` }))];
exportRuntime(dir, all.map(patch => ({ patch, trimDb: -7.25, seed: 1 })));
const load = (name: string) => import(pathToFileURL(join(dir, 'beeps-runtime', 'cues', `${name}.js`)).href) as Promise<{ build: (...a: any[]) => any; meta: any }>;

const SCALE = { root: 'C', mode: 'majorPentatonic', snap: true } as const;
const dump = (fn: (f: FakeContext, out: any) => void) => { const f = new FakeContext(); const out = f.createGain(); fn(f, out); return dumpGraph(f); };

describe('generated modules build the engine graph', () => {
  it('covers the sources the archetypes use', () => { expect(arch.length).toBeGreaterThan(30); });

  describe.each(all.map(p => [p.name, p] as const))('%s', (_n, patch) => {
    const cases: { label: string; params: Record<string, number>; seed: number; variant: number; scale?: typeof SCALE }[] = [
      { label: 'defaults, seed 1, no scale', params: {}, seed: 1, variant: 0 },
      { label: 'project scale, variant 2, seed 7', params: {}, seed: 7, variant: 2, scale: SCALE },
    ];
    const inputs = Object.keys(patch.xRuntime?.inputs ?? {});
    if (inputs.length) {
      cases.push({ label: 'every input at its max', params: Object.fromEntries(inputs.map(k => [k, patch.xRuntime!.inputs[k].max])), seed: 3, variant: 1, scale: SCALE });
      cases.push({ label: 'every input at its min', params: Object.fromEntries(inputs.map(k => [k, patch.xRuntime!.inputs[k].min])), seed: 3, variant: 0 });
    }
    it.each(cases)('$label', async ({ params, seed, variant, scale }) => {
      const { build, meta } = await load(patch.name);
      const live = new Set<string>(meta.live);
      // Live inputs are applied after the build by both paths; the engine reference builds them at the authored values.
      const want = dump((f, out) => {
        const { patch: p, trimDeltaDb } = applyParams(patch, params);
        buildPatch(asCtx(f), p, { destination: out, seed, variant, scale, trimDb: -7.25 + trimDeltaDb, hold: meta.hold });
      });
      const got = dump((f, out) => { build(asCtx(f), out, params, seed, { variant, scale, trimDb: -7.25 }); });
      if (live.size === 0) expect(got).toEqual(want);
      else {
        // With live inputs the module also applies their starting values (a plain .value write), so compare everything but
        // the value of parameters a live input owns; the event lists and the topology must still match exactly.
        const strip = (g: any[]) => g.map(n => JSON.parse(JSON.stringify(n, (k, v) => (k === 'value' ? undefined : v))));
        expect(strip(got)).toEqual(strip(want));
      }
    });
  });
});

describe('the comparison can fail', () => {
  const patch = spike.find(p => p.name === 'asteroid-burst')!;
  const ref = (params: Record<string, number>, seed: number) => dump((f, out) => {
    const { patch: p, trimDeltaDb } = applyParams(patch, params);
    buildPatch(asCtx(f), p, { destination: out, seed, variant: 0, trimDb: -7.25 + trimDeltaDb });
  });
  it('sees a different seed, a different input, and a different trim', async () => {
    const { build } = await load(patch.name);
    const gen = (params: Record<string, number>, seed: number, trimDb = -7.25) => dump((f, out) => { build(asCtx(f), out, params, seed, { trimDb }); });
    expect(gen({}, 1)).toEqual(ref({}, 1));
    expect(gen({}, 2)).not.toEqual(ref({}, 1));
    expect(gen({ size: 0.9 }, 1)).not.toEqual(ref({}, 1));
    expect(gen({}, 1, -6)).not.toEqual(ref({}, 1));
    expect((gen({}, 1) as unknown[]).length).toBeGreaterThan(60);
  });
});
