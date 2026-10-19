import { describe, expect, it } from 'vitest';
import { buildPatch } from '../../runtime/engine/patch.js';
import { scheduleEnvelope, type EnvelopePoint } from '../../runtime/engine/envelope.js';
import { buildSource } from '../../runtime/engine/sources.js';
import { build } from '../../runtime/engine/voice.js';
import { applyParams } from '../../runtime/engine/params.js';
import { FakeContext, FakeNode, FakeParam, asCtx } from '../helpers/fake-context.ts';
import { dumpGraph } from '../helpers/graph-dump.ts';
import { patch, withSource } from '../helpers/patches.ts';

type Point = EnvelopePoint;
const schedule = (param: FakeParam, points: Point[], options: { when: number; scale: number }) => {
  scheduleEnvelope(param as unknown as AudioParam, points, options);
};

const curve: Point[] = [[0, 0], [0.01, 1], [0.1, 0.25, 'exp'], [0.2, 0.5, 'step'], [0.4, 0, 'linear']];
const fm = (indexEnv: Point[] | null = curve) => ({
  type: 'fm', pitch: 200,
  operators: [{ ratio: 1.5 }, { ratio: 2, index: 4, ...(indexEnv ? { indexEnv } : {}) }],
  algorithm: [[1, 0]],
});
const gainOf = (operator: FakeNode, outgoing = 0): FakeParam => (operator.outputs[outgoing] as FakeNode).gain;
const event = (kind: string, value: number, time: number) => ({ kind, value, time });
const curveEvents = (when: number, peak: number) => [
  event('set', 0, when), event('linear', peak, when + 0.01), event('exponential', peak * 0.25, when + 0.1),
  event('set', peak * 0.5, when + 0.2), event('linear', 0, when + 0.4),
];

describe('reusable normalized breakpoint scheduler', () => {
  it('schedules each arrival curve in seconds, scaled and offset from the caller onset', () => {
    const param = new FakeParam(999);
    schedule(param, curve, { when: 3, scale: 800 });
    expect(param.events).toEqual(curveEvents(3, 800));
  });

  it('sets a single point once, leaving its value held indefinitely', () => {
    const param = new FakeParam();
    schedule(param, [[0, 0.25]], { when: 1.5, scale: 120 });
    expect(param.events).toEqual([event('set', 30, 1.5)]);
  });

  it('schedules only zero at onset when the base scale is zero, including exponential curves', () => {
    const param = new FakeParam();
    schedule(param, [[0, 1], [0.1, 0.1, 'exp']], { when: 2, scale: 0 });
    expect(param.events).toEqual([event('set', 0, 2)]);
  });

  it('does not mutate points or share schedules between target parameters', () => {
    const points: Point[] = [[0, 1], [0.5, 0.5]];
    const before = structuredClone(points);
    const a = new FakeParam(), b = new FakeParam();
    schedule(a, points, { when: 0, scale: 10 });
    schedule(b, points, { when: 1, scale: 20 });
    expect(points).toEqual(before);
    expect(a.events).toEqual([event('set', 10, 0), event('linear', 5, 0.5)]);
    expect(b.events).toEqual([event('set', 20, 1), event('linear', 10, 1.5)]);
  });

  it.each([
    { points: null, message: /envelope.*array/i },
    { points: [], message: /envelope.*1.*64/i },
    { points: Array.from({ length: 65 }, (_, i) => [i / 64, 1]), message: /envelope.*1.*64/i },
    { points: [[0, 1], [0.1]], message: /envelope.*point 1.*tuple/i },
    { points: [[0, 1], [0.1, 1, 'linear', 'extra']], message: /envelope.*point 1.*tuple/i },
    { points: [[0.01, 1]], message: /envelope.*point 0.*time 0/i },
    { points: [[0, 1], [-0.1, 1]], message: /envelope.*point 1.*time/i },
    { points: [[0, 1], [10.01, 1]], message: /envelope.*point 1.*time/i },
    { points: [[0, 1], [Infinity, 1]], message: /envelope.*point 1.*finite/i },
    { points: [[0, 1], [NaN, 1]], message: /envelope.*point 1.*finite/i },
    { points: [[0, 1], [0, 0.5]], message: /envelope.*point 1.*strictly increasing/i },
    { points: [[0, 1], [0.2, 0.5], [0.1, 0]], message: /envelope.*point 2.*strictly increasing/i },
    { points: [[0, 1], [0.1, -0.1]], message: /envelope.*point 1.*scale/i },
    { points: [[0, 1], [0.1, 1.1]], message: /envelope.*point 1.*scale/i },
    { points: [[0, 1], [0.1, Infinity]], message: /envelope.*point 1.*finite/i },
    { points: [[0, 1], [0.1, NaN]], message: /envelope.*point 1.*finite/i },
    { points: [[0, 1], [0.1, 0.5, 'spline']], message: /envelope.*point 1.*curve/i },
    { points: [[0, 0], [0.1, 1, 'exp']], message: /envelope.*point 1.*positive/i },
    { points: [[0, 1], [0.1, 0, 'exp']], message: /envelope.*point 1.*positive/i },
  ])('validates the whole runtime curve before writing any events: $points', ({ points, message }) => {
    const param = new FakeParam();
    expect(() => schedule(param, points as unknown as Point[], { when: 1, scale: 200 })).toThrow(message);
    expect(param.events).toEqual([]);
  });

  it.each([
    { points: [[0, 1], [0.1, 1e-50, 'exp']], scale: 800, message: /envelope.*point 1.*exponential.*positive.*Float32/i },
    { points: [[0, 1e-50], [0.1, 1, 'exp']], scale: 800, message: /envelope.*point 1.*exponential.*positive.*Float32/i },
    { points: [[0, 1]], scale: Number.MAX_VALUE, message: /envelope.*point 0.*finite.*Float32/i },
    { points: [[0, 0], [0.1, 1]], scale: Number.MAX_VALUE, message: /envelope.*point 1.*finite.*Float32/i },
  ])('preflights every scaled AudioParam target before any event: $points', ({ points, scale, message }) => {
    const param = new FakeParam();
    expect(() => schedule(param, points as unknown as Point[], { when: 1, scale })).toThrow(message);
    expect(param.events).toEqual([]);
  });

  it('allows a tiny linear target to round to zero without clamping the authored curve', () => {
    const param = new FakeParam();
    schedule(param, [[0, 1], [0.1, 1e-50]], { when: 1, scale: 800 });
    expect(param.events).toEqual([event('set', 800, 1), event('linear', 8e-48, 1.1)]);
  });

  it('validates normalized points even when the peak is zero', () => {
    const param = new FakeParam();
    expect(() => schedule(param, [[0, 1], [0.1, 0, 'exp']], { when: 1, scale: 0 })).toThrow(/positive/i);
    expect(param.events).toEqual([]);
  });

  it.each([
    { when: 0, scale: -1, message: /envelope.*scale.*finite.*nonnegative/i },
    { when: 0, scale: NaN, message: /envelope.*scale.*finite.*nonnegative/i },
    { when: 0, scale: Infinity, message: /envelope.*scale.*finite.*nonnegative/i },
    { when: -0.1, scale: 10, message: /envelope.*onset.*finite.*nonnegative/i },
    { when: NaN, scale: 10, message: /envelope.*onset.*finite.*nonnegative/i },
    { when: Infinity, scale: 10, message: /envelope.*onset.*finite.*nonnegative/i },
  ])('rejects invalid scheduling options before writing events: when=$when scale=$scale', ({ when, scale, message }) => {
    const param = new FakeParam();
    expect(() => schedule(param, [[0, 1], [0.1, 0.5, 'exp']], { when, scale })).toThrow(message);
    expect(param.events).toEqual([]);
  });
});

describe('FM index envelope depth automation', () => {
  it('waits for source.start and then schedules the outgoing depth, leaving pitch parameters alone', () => {
    const f = new FakeContext();
    const source = withSource(fm()).layers[0].source;
    const built = buildSource(asCtx(f), source, { pitchHz: 300, seed: 1, length: 1 });
    const [carrier, mod] = f.nodes('osc');
    const depth = gainOf(mod);
    expect(depth.events).toEqual([]);
    built.start(2);
    expect(depth.events).toEqual(curveEvents(2, 4 * 300 * 1.5));
    expect(carrier.frequency.events).toEqual([]);
    expect(mod.frequency.events).toEqual([]);
    expect([carrier.startedAt, mod.startedAt]).toEqual([2, 2]);
  });

  it('scales every fan-out edge by its destination ratio and uses each chained operator own curve', () => {
    const f = new FakeContext();
    buildPatch(asCtx(f), withSource({
      type: 'fm', pitch: 200,
      operators: [
        { ratio: 1.5 }, { ratio: 2, index: 3, indexEnv: [[0, 1], [0.2, 0.5]] },
        { ratio: 4, index: 5, indexEnv: [[0, 0.25], [0.3, 1, 'step']] }, { ratio: 0.75, index: 2 },
      ],
      algorithm: [[1, 0], [1, 2], [2, 0], [3, 1]],
    }), { when: 1 });
    const ops = f.nodes('osc');
    expect(gainOf(ops[1], 0).events).toEqual([event('set', 3 * 200 * 1.5, 1), event('linear', 3 * 200 * 1.5 * 0.5, 1.2)]);
    expect(gainOf(ops[1], 1).events).toEqual([event('set', 3 * 200 * 4, 1), event('linear', 3 * 200 * 4 * 0.5, 1.2)]);
    expect(gainOf(ops[2]).events).toEqual([event('set', 5 * 200 * 1.5 * 0.25, 1), event('set', 5 * 200 * 1.5, 1.3)]);
    expect(gainOf(ops[3]).value).toBe(2 * 200 * 2);
    expect(gainOf(ops[3]).events).toEqual([]);
    expect(f.maxFanIn()).toBeLessThanOrEqual(2);
  });

  it('adds no nodes and changes only modulation-depth events compared with the static source', () => {
    const staticContext = new FakeContext(), shaped = new FakeContext();
    buildPatch(asCtx(staticContext), withSource(fm(null)), { when: 2 });
    buildPatch(asCtx(shaped), withSource(fm()), { when: 2 });
    gainOf(shaped.nodes('osc')[1]).events = [];
    expect(dumpGraph(shaped)).toEqual(dumpGraph(staticContext));
  });

  it('leaves the exact static depth path without an authored envelope', () => {
    const f = new FakeContext();
    buildPatch(asCtx(f), withSource(fm(null)), { when: 3 });
    expect(gainOf(f.nodes('osc')[1]).value).toBe(4 * 200 * 1.5);
    expect(gainOf(f.nodes('osc')[1]).events).toEqual([]);
  });

  it('uses absolute layer onset for each overlapping voice and keeps the patch immutable', () => {
    const f = new FakeContext();
    const input = withSource(fm(), { start: 0.25 });
    const before = structuredClone(input);
    buildPatch(asCtx(f), input, { when: 1 });
    const first = gainOf(f.nodes('osc')[1]);
    const beforeSecond = structuredClone(first.events);
    buildPatch(asCtx(f), input, { when: 1.1 });
    const second = gainOf(f.nodes('osc')[3]);
    expect(first).not.toBe(second);
    expect(first.events).toEqual(curveEvents(1.25, 4 * 200 * 1.5));
    expect(second.events).toEqual(curveEvents(1.35, 4 * 200 * 1.5));
    expect(first.events).toEqual(beforeSecond);
    expect(input).toEqual(before);
  });

  it('keeps held and finite envelopes on the onset clock when the amp releases', () => {
    const heldContext = new FakeContext(), finiteContext = new FakeContext();
    const input = withSource(fm([[0, 1], [0.1, 0.5, 'exp'], [5, 0]]), { start: 0.25 });
    const held = buildPatch(asCtx(heldContext), input, { when: 2, hold: true });
    buildPatch(asCtx(finiteContext), input, { when: 2 });
    const depth = gainOf(heldContext.nodes('osc')[1]);
    const before = structuredClone(depth.events);
    expect(depth.events).toEqual(gainOf(finiteContext.nodes('osc')[1]).events);
    held.release(2.6);
    expect(depth.events).toEqual(before);
    expect(depth.events.at(-1)).toEqual(event('linear', 0, 7.25));
    expect(heldContext.nodes('osc')[1].stoppedAt).toBeLessThan(7.25);
  });

  it('multiplies the whole curve by static runtime index bindings and the played transposed fundamental', () => {
    const input = patch({
      ...withSource(fm([[0, 1], [0.2, 0.25, 'exp']])),
      xRuntime: {
        inputs: { energy: { min: 0, max: 1, default: 0 } },
        bind: [
          { input: 'energy', target: '/layers/0/source/operators/1/index', range: [0, 4] },
          { input: 'energy', target: '/out/transpose', range: [0, 12] },
        ],
      },
    });
    for (const [energy, peak] of [[0, 4 * 200 * 1.5], [1, 8 * 400 * 1.5]]) {
      const f = new FakeContext();
      build(asCtx(f), f.destination as unknown as AudioNode, input, { params: { energy } }).start(1);
      expect(gainOf(f.nodes('osc')[1]).events).toEqual([event('set', peak, 1), event('exponential', peak * 0.25, 1.2)]);
    }
  });

  it('keeps a mapped zero index silent without attempting exponential ramps to zero', () => {
    const input = patch({
      ...withSource(fm([[0, 1], [0.2, 0.25, 'exp']])),
      xRuntime: {
        inputs: { energy: { min: 0, max: 1, default: 1 } },
        bind: [{ input: 'energy', target: '/layers/0/source/operators/1/index', range: [0, 4] }],
      },
    });
    const f = new FakeContext();
    build(asCtx(f), f.destination as unknown as AudioNode, input, { params: { energy: 0 } }).start(1);
    expect(gainOf(f.nodes('osc')[1]).events).toEqual([event('set', 0, 1)]);
  });

  it('preflights all FM curves before creating any source nodes', () => {
    const source = withSource(fm()).layers[0].source;
    if (source.type !== 'fm') throw new Error('expected FM fixture');
    source.operators.push({ ratio: 3, index: 2, wave: 'sine', indexEnv: [[0, 1], [0.2, 0.5], [0.1, 0]] });
    source.algorithm.push([2, 1]);
    const f = new FakeContext();
    expect(() => buildSource(asCtx(f), source, { pitchHz: 200, seed: 1, length: 1 })).toThrow(/envelope.*point 2.*strictly increasing/i);
    expect(f.created).toEqual([]);
  });

  it('rechecks a curve mutated after building before source.start can automate or start oscillators', () => {
    const source = withSource(fm()).layers[0].source;
    if (source.type !== 'fm') throw new Error('expected FM fixture');
    const f = new FakeContext();
    const built = buildSource(asCtx(f), source, { pitchHz: 200, seed: 1, length: 1 });
    source.operators[1].indexEnv![2][0] = 0.005;
    expect(() => built.start(1)).toThrow(/envelope.*point 2.*strictly increasing/i);
    expect(gainOf(f.nodes('osc')[1]).events).toEqual([]);
    expect(f.nodes('osc').every(o => o.startedAt === undefined)).toBe(true);
  });

  it('rejects an actual mixed runtime input combination missed by sampled schema corners', () => {
    const input = patch({
      ...withSource(fm([[0, 1], [0.1, 0.5], [0.17, 0]])),
      xRuntime: {
        inputs: { a: { min: 0, max: 1, default: 0.5 }, b: { min: 0, max: 1, default: 0.5 } },
        bind: [
          { input: 'a', target: '/layers/0/source/operators/1/indexEnv/1/0', range: [-0.05, 0.05] },
          { input: 'b', target: '/layers/0/source/operators/1/indexEnv/2/0', range: [-0.05, 0.05] },
        ],
      },
    });
    const mapped = applyParams(input, { a: 1, b: 0 }).patch.layers[0].source;
    if (mapped.type !== 'fm') throw new Error('expected FM fixture');
    expect(mapped.operators[1].indexEnv![1][0]).toBeCloseTo(0.15);
    expect(mapped.operators[1].indexEnv![2][0]).toBeCloseTo(0.12);
    const f = new FakeContext();
    const voice = build(asCtx(f), f.destination as unknown as AudioNode, input, { params: { a: 1, b: 0 } });
    expect(() => voice.start(1)).toThrow(/envelope.*point 2.*strictly increasing/i);
    expect(f.nodes('osc')).toEqual([]);
    expect(f.created.every(n => n.startedAt === undefined)).toBe(true);
  });

  it('rejects a negative peak index from combined runtime bindings before any depth events or source starts', () => {
    const input = patch({
      ...withSource(fm([[0, 1], [0.2, 0.25, 'exp']])),
      xRuntime: {
        inputs: { a: { min: 0, max: 1, default: 0.5 }, b: { min: 0, max: 1, default: 0.5 } },
        bind: [
          { input: 'a', target: '/layers/0/source/operators/1/index', range: [-3, 3] },
          { input: 'b', target: '/layers/0/source/operators/1/index', range: [3, -3] },
        ],
      },
    });
    const mapped = applyParams(input, { a: 0, b: 1 }).patch.layers[0].source;
    if (mapped.type !== 'fm') throw new Error('expected FM fixture');
    expect(mapped.operators[1].index).toBe(-2);
    const f = new FakeContext();
    const voice = build(asCtx(f), f.destination as unknown as AudioNode, input, { params: { a: 0, b: 1 } });
    expect(() => voice.start(1)).toThrow(/envelope.*scale.*finite.*nonnegative/i);
    expect(f.nodes('osc')).toEqual([]);
    expect(f.nodes('osc').every(o => o.startedAt === undefined)).toBe(true);
  });
});

describe('patch startup preflight', () => {
  const heldOscillator = withSource({ type: 'osc', wave: 'sine', pitch: 110 }, { amp: { attack: 0, decay: 0, sustain: 1, release: 0.1 } }).layers[0];
  const inputs = { a: { min: 0, max: 1, default: 0.5 }, b: { min: 0, max: 1, default: 0.5 } };

  it.each([
    {
      name: 'reversed later FM times from mixed inputs', points: [[0, 1], [0.1, 0.5], [0.17, 0]] as Point[],
      bindings: [
        { input: 'a', target: '/layers/1/source/operators/1/indexEnv/1/0', range: [-0.05, 0.05] },
        { input: 'b', target: '/layers/1/source/operators/1/indexEnv/2/0', range: [-0.05, 0.05] },
      ],
      params: { a: 1, b: 0 }, message: /envelope.*point 2.*strictly increasing/i,
    },
    {
      name: 'negative later FM depth from mixed inputs', points: [[0, 1], [0.2, 0.25, 'exp']] as Point[],
      bindings: [
        { input: 'a', target: '/layers/1/source/operators/1/index', range: [-3, 3] },
        { input: 'b', target: '/layers/1/source/operators/1/index', range: [3, -3] },
      ],
      params: { a: 0, b: 1 }, message: /envelope.*scale.*finite.*nonnegative/i,
    },
    {
      name: 'later FM exponential target underflow', points: [[0, 1], [0.2, 1e-50, 'exp']] as Point[],
      bindings: [], params: { a: 0.5, b: 0.5 }, message: /envelope.*point 1.*exponential.*positive.*Float32/i,
    },
  ])('does not start or leak an earlier held source on $name', ({ points, bindings, params, message }) => {
    const fmLayer = withSource(fm(points)).layers[0];
    const input = patch({
      schema: 'beeps/patch@1', name: 'atomic-start', family: 'test', duration: 0.5,
      layers: [heldOscillator, fmLayer], xRuntime: { hold: true, inputs, bind: bindings },
    });
    const f = new FakeContext();
    const voice = build(asCtx(f), f.destination as unknown as AudioNode, input, { params });
    expect(() => voice.start(1)).toThrow(message);
    voice.dispose();
    expect(f.nodes('osc').filter(o => o.startedAt !== undefined && o.stoppedAt === undefined)).toHaveLength(0);
    expect(f.created.filter(n => n.startedAt !== undefined)).toHaveLength(0);
    expect(voice.started).toBe(false);
  });
});
