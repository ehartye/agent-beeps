// The runtime voice on the recording context: no browser. The claims: `build` plans and `start` creates exactly the graph the
// renderer builds (plus one silent, unconnected timer), a live input adds no node and automates only parameters the engine never
// schedules itself, hold voices release with the patch's own envelope, dispose frees, a shared reverb bus replaces the
// per-voice convolver, and the noise cache stays bounded however many seeds a game plays.
import { afterEach, describe, expect, it } from 'vitest';
import { build, createReverbBus, noiseCacheStats, parseCue, setNoiseCacheLimit, NOISE_CACHE_BYTES } from '../../runtime/engine/index.js';
import { applyParams } from '../../runtime/engine/params.js';
import { buildPatch } from '../../runtime/engine/patch.js';
import { type Patch } from '../../src/schema/patch.ts';
import { makeCue } from '../../src/runtime/cue.ts';
import { FakeContext, FakeParam, asCtx } from '../helpers/fake-context.ts';
import { dumpGraph } from '../helpers/graph-dump.ts';
import { example, exampleProject } from '../helpers/runtime-examples.ts';
import { patch as parse } from '../helpers/patches.ts';

const drone = example('engine-drone');
const out = (f: FakeContext) => f.createGain() as unknown as AudioNode;
const kinds = (f: FakeContext) => f.created.map(n => n.kind).filter(k => k !== 'constant');

const events = (f: FakeContext) => f.created.flatMap(n => Object.entries(n).filter(([, v]) => v instanceof FakeParam).map(([k, v]) => ({ kind: n.kind, param: k, events: (v as FakeParam).events, value: (v as FakeParam).value })));

describe('build and start', () => {
  it('plans without touching the graph, then start creates exactly the renderer\'s graph', () => {
    const f = new FakeContext();
    const o = out(f);
    const n0 = f.created.length;
    const v = build(asCtx(f), o, example('shield-ripple'), { seed: 3, trimDb: -2.4, variant: 1 });
    expect(f.created.length).toBe(n0);
    expect(v.started).toBe(false);
    expect(v.end).toBeUndefined();
    v.start();
    expect(v.started).toBe(true);
    const plain = new FakeContext();
    const p = example('shield-ripple');
    buildPatch(asCtx(plain), applyParams(p).patch, { destination: out(plain) as any, seed: 3, trimDb: -2.4, variant: 1 });
    // The voice makes one extra node: the silent timer that says when it is finished. It is connected to nothing.
    expect(f.created.filter(n => n.kind === 'constant').length).toBe(1);
    expect(f.created.find(n => n.kind === 'constant')!.outputs).toEqual([]);
    expect(dumpGraph(f).filter((n: any) => n.kind !== 'constant').map((n: any) => ({ ...n, i: 0 }))).toEqual(dumpGraph(plain).map((n: any) => ({ ...n, i: 0 })));
  });

  it('refuses an unparsed patch, an unknown input and a value that is not a number', () => {
    const f = new FakeContext();
    expect(() => build(asCtx(f), out(f), { schema: 'beeps/patch@1', name: 'x', layers: 3 } as any)).toThrow(/parsed/);
    expect(() => build(asCtx(f), out(f), drone, { params: { nope: 1 } })).toThrow(/unknown input "nope" \(declared: speed, load\)/);
    expect(() => build(asCtx(f), out(f), drone, { params: { speed: NaN } })).toThrow(/finite number/);
    expect(() => build(asCtx(f), out(f), example('shield-ripple'), { params: { x: 1 } })).toThrow(/declares no inputs|declared:/);
  });

  it('a voice plays once', () => {
    const f = new FakeContext();
    const v = build(asCtx(f), out(f), example('shield-ripple')).start();
    expect(() => v.start()).toThrow(/already started/);
    v.dispose();
  });

  it('start(at) begins at that time', () => {
    const f = new FakeContext();
    build(asCtx(f), out(f), example('shield-ripple')).start(2.5);
    expect(f.nodes('osc')[0].startedAt).toBe(2.5);
  });

  it('plays a cue with its measured trim, seed and scale unless told otherwise', () => {
    const p = example('shield-ripple');
    const cue = makeCue(p, exampleProject(), 261037, -2.42);
    expect(parseCue(JSON.parse(JSON.stringify(cue)))).toEqual(cue);
    const a = new FakeContext();
    build(asCtx(a), out(a), cue).start();
    const b = new FakeContext();
    build(asCtx(b), out(b), p, { seed: 261037, trimDb: -2.42, scale: exampleProject().scale }).start();
    expect(dumpGraph(a)).toEqual(dumpGraph(b));
    const c = new FakeContext();
    build(asCtx(c), out(c), cue, { scale: null }).start();
    expect(dumpGraph(c)).not.toEqual(dumpGraph(a));
  });
});

describe('parseCue', () => {
  const good = () => JSON.parse(JSON.stringify(makeCue(drone, exampleProject(), 1, -9)));
  it('accepts a cue and refuses another schema, a malformed cue and another engine', () => {
    expect(parseCue(good()).id).toBe('engine-drone');
    expect(() => parseCue({ schema: 'beeps/patch@1' })).toThrow(/not a beeps\/runtime-cue@1/);
    expect(() => parseCue({ ...good(), seed: 'x' })).toThrow(/needs id, seed, trimDb/);
    expect(() => parseCue({ ...good(), engine: '1' })).toThrow(/engine 1/);
    expect(parseCue({ ...good(), engine: '1' }, { allowEngineMismatch: true }).engine).toBe('1');
  });
});

describe('engine-drone: live inputs', () => {
  it('adds no node: the graph is the plain patch graph', () => {
    const live = new FakeContext();
    build(asCtx(live), out(live), drone, { trimDb: -9.4 }).start();
    const plain = new FakeContext();
    const { xRuntime: _, ...bare } = drone;
    buildPatch(asCtx(plain), bare as Patch, { destination: out(plain) as any, trimDb: -9.4, hold: true });
    expect(kinds(live)).toEqual(plain.created.map(n => n.kind));
  });

  it('starts at the input\'s starting value with a plain value write, and schedules nothing', () => {
    const f = new FakeContext();
    build(asCtx(f), out(f), drone, { params: { speed: 1, load: 0 }, trimDb: -9.4 }).start();
    const osc = f.nodes('osc')[0];
    // 3 unison voices: detune is the voice's spread plus the transposition from speed 0.4 -> 1 (range -5..12): 10.2 semitones.
    expect(osc.detune.value).toBeCloseTo(-14 / 2 + 1020, 6);
    expect(osc.detune.events).toEqual([]);
    const noiseGain = f.created.filter(n => n.kind === 'gain').find(n => Math.abs(n.gain.value - 10 ** ((-16 + 10.8) / 20)) < 1e-9);
    expect(noiseGain, 'layer 2 gain moved +10.8 dB').toBeTruthy();
  });

  it('set() cancels from now and approaches the new value; unrelated parameters are untouched', () => {
    const f = new FakeContext();
    const v = build(asCtx(f), out(f), drone, { trimDb: -9.4 }).start();
    const before = JSON.stringify(events(f));
    v.set('speed', 1, 0.5, 0.05);
    const after = events(f);
    const touched = after.filter((e, i) => JSON.stringify(e) !== JSON.stringify(JSON.parse(before)[i]));
    expect(touched.length).toBeGreaterThan(0);
    for (const t of touched) {
      expect(t.events.slice(-2).map(e => e.kind)).toEqual(['cancel', 'target']);
      expect(t.events.slice(-1)[0]).toMatchObject({ time: 0.5, extra: 0.05 });
      // none of them is a parameter the engine schedules itself: amp envelopes, filter frequency, pitch envelopes
      expect(['detune', 'gain']).toContain(t.param);
    }
    const ampGains = f.nodes('gain').filter(n => n.gain.events.some((e: any) => e.kind === 'linear'));
    for (const a of ampGains) expect(a.gain.events.some((e: any) => e.kind === 'target' && e.time === 0.5)).toBe(false);
  });

  it('tau 0 steps, an input outside its range is clamped, and an unknown input throws', () => {
    const f = new FakeContext();
    const v = build(asCtx(f), out(f), drone, { trimDb: -9.4 }).start();
    v.set('load', 9, 1, 0);
    const trim = events(f).find(e => e.kind === 'gain' && e.events.some(x => x.kind === 'set' && x.time === 1))!;
    expect(trim.events.at(-1)).toMatchObject({ kind: 'set', time: 1, value: expect.closeTo(10 ** ((-9.4 + 4) / 20), 9) });
    expect(() => v.set('nope', 1)).toThrow(/unknown input/);
  });

  it('a static input is set before start; after start it throws and says why', () => {
    const p = parse({
      schema: 'beeps/patch@1', name: 'two', family: 'test', duration: 0.4,
      layers: [{ source: { type: 'osc', wave: 'sine', pitch: 440 }, amp: { attack: 0.01, decay: 0.2, sustain: 0, release: 0.05 } }],
      xRuntime: { inputs: { size: { min: 0, max: 1, default: 0.5 }, vol: { min: 0, max: 1, default: 0.5 } }, bind: [
        { input: 'size', target: '/layers/0/amp/decay', range: [-0.5, 0.5] },
        { input: 'vol', target: '/layers/0/gainDb', range: [-6, 6], live: true },
      ] },
    });
    const f = new FakeContext();
    const v = build(asCtx(f), out(f), p);
    v.set('size', 1);
    v.start();
    expect(() => v.set('size', 0)).toThrow(/fixes when it is built/);
    expect(() => v.set('vol', 1, 0.1)).not.toThrow();
    const g = new FakeContext();
    build(asCtx(g), out(g), p, { params: { size: 1 } }).start();
    expect(dumpGraph(f).filter((n: any) => n.kind !== 'constant').length).toBeGreaterThan(0);
    const ampOf = (c: FakeContext) => c.nodes('gain').find(n => n.gain.events.some((e: any) => e.kind === 'target'))!.gain.events.find((e: any) => e.kind === 'target').extra;
    expect(ampOf(f)).toBe(ampOf(g));
  });
});

describe('hold: the voice sounds until stopped', () => {
  it('is endless while held, and stop(duration) schedules exactly what the unheld voice schedules', () => {
    const { xRuntime: _, ...bare } = drone;
    const plain = new FakeContext();
    const pe = buildPatch(asCtx(plain), bare as Patch, { destination: out(plain) as any, trimDb: -9.4 }).end;

    const f = new FakeContext();
    const held = build(asCtx(f), out(f), drone, { trimDb: -9.4 }).start();
    expect(held.end).toBe(Infinity);
    expect(f.nodes('osc').every(n => n.stoppedAt === undefined)).toBe(true);
    expect(held.stop(drone.duration)).toBeCloseTo(pe, 9);
    expect(held.end).toBeCloseTo(pe, 9);

    // The unheld graph and the held-then-released one carry the same amp events and stop times everywhere.
    const strip = (d: any[]) => d.filter(n => n.kind !== 'constant').map(n => ({ ...n, value: undefined, i: 0 }));
    expect(strip(dumpGraph(f))).toEqual(strip(dumpGraph(plain)));
  });

  it('a release before the attack finishes still starts from the analytic level', () => {
    const f = new FakeContext();
    build(asCtx(f), out(f), drone, { trimDb: -9.4 }).start().stop(0.1);
    const amp = f.nodes('gain').find(n => n.gain.events.some((e: any) => e.kind === 'linear' && e.time === 0.1 + 0.35));
    expect(amp).toBeTruthy();
    const set = amp!.gain.events.find((e: any) => e.kind === 'set' && e.time === 0.1)!;
    expect(set.value).toBeGreaterThan(0);
    expect(set.value).toBeLessThan(1);
  });

  it('a one-shot stop fades the trim out instead', () => {
    const f = new FakeContext();
    const v = build(asCtx(f), out(f), example('shield-ripple'), { trimDb: -2.4 }).start();
    const natural = v.end!;
    const silent = v.stop(0.05, 0.04);
    expect(silent).toBeCloseTo(0.09, 9);
    expect(v.end).toBeCloseTo(0.09, 9);
    expect(natural).toBeGreaterThan(silent);
    const trim = f.nodes('gain').find(n => n.gain.events.some((e: any) => e.kind === 'target' && e.time === 0.05 && e.value === 0))!;
    expect(trim.gain.events.at(-1)).toMatchObject({ kind: 'target', extra: 0.01 });
  });
});

describe('dispose and onEnded', () => {
  it('stops every source, cuts the voice from its output, and reports once', () => {
    const f = new FakeContext();
    let ended = 0;
    const v = build(asCtx(f), out(f), drone, { onEnded: () => { ended++; } }).start();
    f.currentTime = 1;
    v.dispose();
    v.dispose();
    v.stop();
    expect(ended).toBe(1);
    const sources = [...f.nodes('osc'), ...f.nodes('bufferSource')];
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every(n => n.stoppedAt === 1)).toBe(true);
    expect(f.created.filter(n => n.disconnected).length).toBeGreaterThanOrEqual(2);
    expect(() => v.start()).toThrow();
  });

  it('a voice that ends on its own disposes itself when the timer source ends', () => {
    const f = new FakeContext();
    let ended = 0;
    const v = build(asCtx(f), out(f), example('shield-ripple'), { onEnded: () => { ended++; } }).start();
    const timer = f.nodes('constant')[0];
    expect(timer.stoppedAt).toBeGreaterThan(v.end!);
    timer.onended();
    expect(ended).toBe(1);
    expect(f.nodes('osc').every(n => n.stoppedAt !== undefined)).toBe(true);
  });

  it('dispose or stop before start cancels the voice', () => {
    const f = new FakeContext();
    let ended = 0;
    const v = build(asCtx(f), out(f), drone, { onEnded: () => { ended++; } });
    v.stop();
    expect(ended).toBe(1);
    expect(() => v.start()).toThrow(/stopped or disposed/);
  });
});

describe('a shared reverb bus', () => {
  const rev = example('shield-ripple');
  const withReverb = parse({ ...rev, fx: { reverb: { preset: 'hall', sendDb: -9 } } });

  it('replaces the per-voice convolver with a send gain into the bus', () => {
    const own = new FakeContext();
    build(asCtx(own), out(own), withReverb, { trimDb: -4 }).start();
    expect(own.count('convolver')).toBe(1);

    const f = new FakeContext();
    const bus = createReverbBus(asCtx(f), out(f), { preset: 'hall' });
    expect(f.count('convolver')).toBe(1);
    const v = build(asCtx(f), out(f), withReverb, { trimDb: -4, reverb: bus }).start();
    build(asCtx(f), out(f), withReverb, { trimDb: -4, reverb: bus }).start();
    expect(f.count('convolver')).toBe(1);
    const sends = f.created.filter(n => n.outputs.includes(bus.input as any));
    expect(sends.length).toBe(2);
    // The send carries the loudness trim, so the wet signal is as loud as it is inside a voice that has its own reverb.
    expect(sends[0].gain.value).toBeCloseTo(10 ** ((-9 - 4) / 20), 9);
    // The voice is over when its dry signal is; the bus rings on by itself.
    const dry = new FakeContext();
    const dryEnd = buildPatch(asCtx(dry), parse({ ...withReverb, fx: undefined, xRuntime: undefined }), { destination: out(dry) as any }).end;
    expect(v.end!).toBeCloseTo(dryEnd, 9);
  });

  it('takes buses by preset, and a preset it lacks keeps the voice\'s own reverb', () => {
    const f = new FakeContext();
    const room = createReverbBus(asCtx(f), out(f), { preset: 'room' });
    build(asCtx(f), out(f), withReverb, { reverb: { room } }).start();
    expect(f.count('convolver')).toBe(2);
    expect(f.created.filter(n => n.outputs.includes(room.input as any)).length).toBe(0);
    const g = new FakeContext();
    const one = createReverbBus(asCtx(g), out(g), { preset: 'room' });
    build(asCtx(g), out(g), withReverb, { reverb: one }).start();
    expect(g.count('convolver')).toBe(1);
  });

  it('a live reverb send moves the bus send, and dispose cuts it', () => {
    const p = parse({ ...rev, fx: { reverb: { preset: 'room', sendDb: -12 } }, xRuntime: { inputs: { wet: { min: 0, max: 1, default: 0 } }, bind: [{ input: 'wet', target: '/fx/reverb/sendDb', range: [0, 12], live: true }] } });
    const f = new FakeContext();
    const bus = createReverbBus(asCtx(f), out(f), { preset: 'room' });
    const v = build(asCtx(f), out(f), p, { reverb: bus, trimDb: 0 }).start();
    const send = f.created.find(n => n.outputs.includes(bus.input as any))!;
    v.set('wet', 1, 0.2, 0.01);
    expect(send.gain.events.at(-1)).toMatchObject({ kind: 'target', time: 0.2, value: expect.closeTo(10 ** (0 / 20), 9) });
    v.dispose();
    expect(send.disconnected).toBe(true);
  });
});

describe('the noise cache is bounded', () => {
  afterEach(() => setNoiseCacheLimit(NOISE_CACHE_BYTES));
  const noisy = parse({
    schema: 'beeps/patch@1', name: 'hiss', family: 'test', duration: 0.2,
    layers: [{ source: { type: 'noise', color: 'pink' }, amp: { attack: 0.005, decay: 0.1, sustain: 0, release: 0.02 } }, { source: { type: 'noise', color: 'white', stereo: true }, amp: { attack: 0.005, decay: 0.1, sustain: 0, release: 0.02 } }],
  });

  it('10,000 plays with a fresh seed each keep at most the byte budget, however many noise layers they have', () => {
    const f = new FakeContext();
    f.sampleRate = 4000; // 8000-sample buffers: the same logic as 96000, 12x faster
    setNoiseCacheLimit(200_000);
    const o = out(f);
    let peak = 0;
    for (let seed = 1; seed <= 10_000; seed++) {
      build(asCtx(f), o, noisy, { seed }).start().dispose();
      peak = Math.max(peak, noiseCacheStats(asCtx(f)).bytes);
    }
    const s = noiseCacheStats(asCtx(f));
    expect(peak).toBeLessThanOrEqual(200_000);
    expect(s.bytes).toBeLessThanOrEqual(200_000);
    // 8000 samples * 4 B = 32 kB mono, 64 kB stereo: a handful of entries, not 20,000
    expect(s.entries).toBeLessThanOrEqual(8);
    expect(s.entries).toBeGreaterThan(0);
  }, 60_000);

  it('a few fixed seeds are still shared: one buffer per colour and seed, not one per play', () => {
    const f = new FakeContext();
    f.sampleRate = 4000;
    for (let i = 0; i < 100; i++) build(asCtx(f), out(f), noisy, { seed: 5 + (i % 3) }).start().dispose();
    expect(noiseCacheStats(asCtx(f)).entries).toBe(6);
  });

  it('evicts the least recently used buffer first, and never one a playing voice still holds', () => {
    const f = new FakeContext();
    f.sampleRate = 4000;
    const mono = parse({ ...noisy, layers: [noisy.layers[0]] });
    setNoiseCacheLimit(32_000 * 3);
    const play = (seed: number) => { build(asCtx(f), out(f), mono, { seed }).start(); return f.nodes('bufferSource').at(-1)!.buffer; };
    const a = play(1), b = play(2), c = play(3);
    expect(noiseCacheStats(asCtx(f)).entries).toBe(3);
    expect(play(1)).toBe(a); // seed 1 is now the most recently used
    play(4); // evicts 2 (the least recently used), not 1
    expect(play(1)).toBe(a);
    expect(play(2)).not.toBe(b);
    expect(b.getChannelData(0).length).toBe(8000); // the evicted buffer is intact: a voice playing it is unaffected
    expect(c).toBeTruthy();
  });
});
