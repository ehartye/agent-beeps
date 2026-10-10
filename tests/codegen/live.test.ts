// Live inputs and held voices, on the recording context: no browser. The claims: a live input adds no node, automates only
// parameters the engine never schedules itself, starts from its input's starting value without scheduling anything, and
// the generated module and the interpreter do exactly the same thing.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createVoice } from '../../runtime/engine/live.js';
import { applyParams } from '../../runtime/engine/params.js';
import { buildPatch } from '../../runtime/engine/patch.js';
import { exportRuntime } from '../../src/codegen/export.ts';
import { parsePatch, type Patch } from '../../src/schema/patch.ts';
import { FakeContext, FakeParam, asCtx } from '../helpers/fake-context.ts';
import { dumpGraph } from '../helpers/graph-dump.ts';

const SPIKE = join(import.meta.dirname, '..', '..', 'library', 'sounds', 'runtime-spike', 'patches');
const load = (name: string): Patch => {
  const r = parsePatch(JSON.parse(readFileSync(join(SPIKE, `${name}.json`), 'utf8')));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.patch;
};
const drone = load('engine-drone');
const dir = mkdtempSync(join(tmpdir(), 'beeps-live-'));
exportRuntime(dir, [{ patch: drone, trimDb: -9.4, seed: 1 }]);
const gen = () => import(pathToFileURL(join(dir, 'beeps-runtime', 'cues', 'engine-drone.js')).href) as Promise<{ build: (...a: any[]) => any }>;

const events = (f: FakeContext) => f.created.flatMap(n => Object.entries(n).filter(([, v]) => v instanceof FakeParam).map(([k, v]) => ({ kind: n.kind, param: k, events: (v as FakeParam).events, value: (v as FakeParam).value })));

describe('engine-drone: live inputs', () => {
  it('adds no node: the graph is the plain patch graph', () => {
    const live = new FakeContext();
    createVoice(asCtx(live), drone, live.createGain() as any, {}, 1, { trimDb: -9.4 });
    const plain = new FakeContext();
    const { xRuntime: _, ...bare } = drone;
    buildPatch(asCtx(plain), bare as Patch, { destination: plain.createGain() as any, trimDb: -9.4, hold: true });
    expect(live.created.map(n => n.kind)).toEqual(plain.created.map(n => n.kind));
  });

  it('starts at the input\'s starting value with a plain value write, and schedules nothing', () => {
    const f = new FakeContext();
    createVoice(asCtx(f), drone, f.createGain() as any, { speed: 1, load: 0 }, 1, { trimDb: -9.4 });
    const osc = f.nodes('osc')[0];
    // 3 unison voices: detune is the voice's spread plus the transposition from speed 0.4 -> 1 (range -5..12): 10.2 semitones.
    expect(osc.detune.value).toBeCloseTo(-14 / 2 + 1020, 6);
    expect(osc.detune.events).toEqual([]);
    const noiseGain = f.created.filter(n => n.kind === 'gain').find(n => Math.abs(n.gain.value - 10 ** ((-16 + 10.8) / 20)) < 1e-9);
    expect(noiseGain, 'layer 2 gain moved +10.8 dB').toBeTruthy();
  });

  it('set() cancels from now and approaches the new value; unrelated parameters are untouched', () => {
    const f = new FakeContext();
    const v = createVoice(asCtx(f), drone, f.createGain() as any, {}, 1, { trimDb: -9.4 });
    const before = JSON.stringify(events(f));
    v.set('speed', 1, 0.5, 0.05);
    const after = events(f);
    const touched = after.filter((e, i) => JSON.stringify(e) !== JSON.stringify(JSON.parse(before)[i]));
    expect(touched.length).toBeGreaterThan(0);
    for (const t of touched) {
      expect(t.events.slice(-2).map(e => e.kind)).toEqual(['cancel', 'target']);
      expect(t.events.slice(-1)[0]).toMatchObject({ time: 0.5, extra: 0.05 });
    }
    // none of them is a parameter the engine schedules itself: amp envelopes, filter frequency, pitch envelopes
    for (const t of touched) expect(['detune', 'gain']).toContain(t.param);
    const ampGains = f.nodes('gain').filter(n => n.gain.events.some((e: any) => e.kind === 'linear'));
    for (const a of ampGains) expect(a.gain.events.some((e: any) => e.kind === 'target' && e.time === 0.5)).toBe(false);
  });

  it('tau 0 steps, an input outside its range is clamped, and an unknown input throws', () => {
    const f = new FakeContext();
    const v = createVoice(asCtx(f), drone, f.createGain() as any, {}, 1, { trimDb: -9.4 });
    v.set('load', 9, 1, 0);
    const trim = events(f).find(e => e.kind === 'gain' && e.events.some(x => x.kind === 'set' && x.time === 1))!;
    expect(trim.events.at(-1)).toMatchObject({ kind: 'set', time: 1, value: expect.closeTo(10 ** ((-9.4 + 4) / 20), 9) });
    expect(() => v.set('nope', 1)).toThrow(/unknown input/);
  });

  it('the generated module does exactly what the interpreter does', async () => {
    const { build } = await gen();
    const run = (make: (f: FakeContext, out: any) => any) => {
      const f = new FakeContext();
      const v = make(f, f.createGain());
      v.set('speed', 0.9, 0.3, 0.04);
      v.set('load', 0.7, 0.35, 0.02);
      v.set('speed', 0.2, 0.6, 0.04);
      return dumpGraph(f);
    };
    const a = run((f, out) => createVoice(asCtx(f), drone, out, { speed: 0.55 }, 4, { trimDb: -9.4 }));
    const b = run((f, out) => build(asCtx(f), out, { speed: 0.55 }, 4, { trimDb: -9.4 }));
    expect(b).toEqual(a);
  });
});

describe('hold: the voice sounds until released', () => {
  it('is endless while held, and release(duration) schedules exactly what the unheld voice schedules', async () => {
    const { build } = await gen();
    const { xRuntime: _, ...bare } = drone;
    const plain = new FakeContext();
    const pe = buildPatch(asCtx(plain), bare as Patch, { destination: plain.createGain() as any, trimDb: -9.4 }).end;

    const viaEngine = new FakeContext();
    const held = createVoice(asCtx(viaEngine), drone, viaEngine.createGain() as any, {}, 1, { trimDb: -9.4 });
    expect(held.end).toBe(Infinity);
    expect(viaEngine.nodes('osc').every(n => n.stoppedAt === undefined)).toBe(true);
    expect(held.release(drone.duration)).toBeCloseTo(pe, 9);

    const viaGen = new FakeContext();
    const g = build(asCtx(viaGen), viaGen.createGain(), {}, 1, { trimDb: -9.4 });
    expect(g.end).toBe(Infinity);
    expect(g.release(drone.duration)).toBeCloseTo(pe, 9);

    // The unheld graph and both held-then-released graphs carry the same amp events and stop times everywhere.
    const strip = (d: any[]) => d.map(n => ({ ...n, value: undefined }));
    expect(strip(dumpGraph(viaEngine))).toEqual(strip(dumpGraph(plain)));
    expect(strip(dumpGraph(viaGen))).toEqual(strip(dumpGraph(plain)));
  });

  it('a release before the attack finishes still starts from the analytic level', () => {
    const f = new FakeContext();
    const v = createVoice(asCtx(f), drone, f.createGain() as any, {}, 1, { trimDb: -9.4 });
    v.release(0.1);
    const amp = f.nodes('gain').find(n => n.gain.events.some((e: any) => e.kind === 'linear' && e.time === 0.1 + 0.35));
    expect(amp).toBeTruthy();
    const set = amp!.gain.events.find((e: any) => e.kind === 'set' && e.time === 0.1)!;
    expect(set.value).toBeGreaterThan(0);
    expect(set.value).toBeLessThan(1);
  });
});

describe('a patch without bindings', () => {
  it('plays through createVoice exactly as buildPatch builds it', () => {
    const p = load('shield-ripple');
    const { xRuntime: _, ...bare } = p;
    const a = new FakeContext(); createVoice(asCtx(a), p, a.createGain() as any, {}, 3, { trimDb: -2.4, variant: 1 });
    const b = new FakeContext(); buildPatch(asCtx(b), applyParams(bare as Patch).patch, { destination: b.createGain() as any, seed: 3, trimDb: -2.4, variant: 1 });
    expect(dumpGraph(a)).toEqual(dumpGraph(b));
  });
});
