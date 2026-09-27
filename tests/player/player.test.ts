// tests/player/player.test.ts
import { describe, expect, it } from 'vitest';
import { createPlayer } from '../../runtime/player/player.js';
import { clipperCurve } from '../../runtime/engine/fx.js';
import { asCtx, FakeContext, FakeNode, FakeParam } from '../helpers/fake-context.ts';

const catalog = { assets: {
  coin: { file: 'coin.wav', loop: false, priority: 3 },
  hit: { file: 'hit.wav', loop: false, priority: 1 },
  step: { file: 'step.0.wav', loop: false, noRepeat: true, variants: [{ file: 'step.0.wav' }, { file: 'step.1.wav' }] },
  calm: { file: 'calm.wav', loop: true },
  storm: { file: 'storm.wav', loop: true },
  theme: { file: 'theme.wav', loop: true, bpm: 120, meter: 4, durationSec: 16,
    layers: [{ name: 'bed', file: 'theme.bed.wav' }, { name: 'pulse', file: 'theme.pulse.wav' }, { name: 'threat', file: 'theme.threat.wav' }],
    states: { calm: ['bed'], explore: ['bed', 'pulse'], danger: ['bed', 'pulse', 'threat'] }, initialState: 'explore' },
} };
type Gate = { url: string; open: () => void };

function setup(over: Record<string, unknown> = {}, { failing = [] as string[], gated = [] as string[] } = {}) {
  const ctx = new FakeContext();
  const fetched: string[] = [];
  const errors: { code: string }[] = [];
  const gates: Gate[] = [];
  let contexts = 0;
  const player = createPlayer({
    catalog: '/audio/index.json', voices: 8, defaults: { cooldownSec: 0 },
    contextFactory: () => { contexts++; return asCtx(ctx) as AudioContext; },
    fetcher: async (url: string) => {
      fetched.push(url);
      if (gated.some(g => url.endsWith(g))) await new Promise<void>(open => gates.push({ url, open }));
      return { ok: !failing.some(f => url.endsWith(f)), json: async () => catalog, arrayBuffer: async () => new ArrayBuffer(8) };
    },
    onError: (e: { code: string }) => errors.push(e),
    ...over,
  });
  return { ctx, player, fetched, errors, gates, contexts: () => contexts };
}
const settle = () => new Promise(r => setTimeout(r, 0));
const sources = (ctx: FakeContext) => ctx.nodes('bufferSource');

describe('player graph', () => {
  it('routes every bus through the master into the safety clipper, never a compressor', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    const [shaper] = ctx.nodes('shaper');
    expect(Array.from(shaper.curve as Float32Array)).toEqual(Array.from(clipperCurve()));
    expect(shaper.oversample).toBe('none');
    expect(shaper.outputs).toContain(ctx.destination);
    const [master, ...buses] = ctx.nodes('gain');
    expect(master.outputs).toContain(shaper);
    expect(buses.slice(0, 3).every(b => b.outputs.includes(master))).toBe(true);
    expect(ctx.count('compressor')).toBe(0);
  });

  it('creates no context and plays nothing before unlock', () => {
    const { player, contexts } = setup();
    expect(player.play('coin')).toBeNull();
    expect(contexts()).toBe(0);
  });

  it('plays nothing after re-enabling until the next unlock resumes the context', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    player.setEnabled(false);
    await settle();
    player.setEnabled(true);
    expect(player.play('coin')).toBeNull();
    expect(ctx.state).toBe('suspended');
    await player.unlock();
    expect(player.play('coin')).not.toBeNull();
  });

  it('reports a context that cannot be created instead of throwing, and retries on the next unlock', async () => {
    let fail = true;
    const { player, errors, ctx } = setup({ contextFactory: () => { if (fail) throw new Error('no audio'); return asCtx(ctx) as AudioContext; } });
    expect(await player.unlock()).toBe(false);
    expect(errors.map(e => e.code)).toContain('E_CONTEXT');
    expect(player.play('coin')).toBeNull();
    fail = false;
    expect(await player.unlock()).toBe(true);
  });

  it('clamps levels and ignores non-numbers', () => {
    const { player } = setup();
    player.setLevel('music', 5); player.setLevel('sfx', -1); player.setLevel('ambience', NaN); player.setLevel('nope', 0.5);
    expect(player.inspect().levels).toEqual({ music: 1, ambience: 1, sfx: 0, master: 1 });
  });
});

describe('sound effects', () => {
  it('warns once about an unknown asset', async () => {
    const { player, errors } = setup();
    await player.unlock();
    expect(player.play('nope')).toBeNull();
    expect(player.play('nope')).toBeNull();
    expect(errors.filter(e => e.code === 'E_UNKNOWN_ASSET')).toHaveLength(1);
  });

  it('keeps to the voice budget and lets only a more important sound steal', async () => {
    const { ctx, player } = setup({ voices: 2 });
    await player.unlock();
    const a = player.play('coin')!; ctx.currentTime = 0.1;
    const b = player.play('coin')!; ctx.currentTime = 0.2;
    await Promise.all([a.ready, b.ready]);
    expect(player.play('coin')).toBeNull();
    const hit = player.play('hit')!;
    expect(await hit.ready).toBe(true);
    expect(sources(ctx)[0].stoppedAt).toBeDefined();
    expect(player.inspect().voices).toBe(2);
  });

  it('never repeats a variant back to back', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    const files: string[] = [];
    for (let i = 0; i < 6; i++) { ctx.currentTime = i; files.push(player.play('step')!.file); }
    for (let i = 1; i < files.length; i++) expect(files[i]).not.toBe(files[i - 1]);
  });

  it('reports a failed load, stays silent, and retries only once', async () => {
    const { ctx, player, errors, fetched } = setup({}, { failing: ['coin.wav'] });
    await player.unlock();
    for (let i = 0; i < 3; i++) { ctx.currentTime = i; const h = player.play('coin'); expect(await h!.ready).toBe(false); }
    expect(errors.filter(e => e.code === 'E_LOAD')).toHaveLength(2);
    expect(fetched.filter(u => u.endsWith('coin.wav'))).toHaveLength(2);
    expect(sources(ctx)).toHaveLength(0);
  });
});

describe('music and ambience beds', () => {
  it('crossfades to a new bed and ignores a repeat request', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    expect(await player.music('calm')).toBe(true);
    expect(await player.music('calm')).toBe(true);
    expect(sources(ctx)).toHaveLength(1);
    expect(sources(ctx)[0].loop).toBe(true);
    await player.music('storm');
    expect(sources(ctx)).toHaveLength(2);
    expect(sources(ctx)[0].stoppedAt).toBeDefined();
    expect(player.inspect().music).toMatchObject({ id: 'storm' });
  });

  it('starts only the latest of overlapping requests', async () => {
    const { ctx, player, gates } = setup({}, { gated: ['calm.wav'] });
    await player.unlock();
    const first = player.music('calm');
    await settle();
    await player.music('storm');
    gates.forEach(g => g.open());
    expect(await first).toBe(false);
    expect(sources(ctx)).toHaveLength(1);
    expect(player.inspect().music).toMatchObject({ id: 'storm' });
  });

  it('queues a bed requested before unlock and starts it on unlock', async () => {
    const { ctx, player } = setup();
    await player.ambience('calm');
    expect(sources(ctx)).toHaveLength(0);
    await player.unlock();
    expect(sources(ctx)).toHaveLength(1);
    expect(player.inspect().ambience).toMatchObject({ id: 'calm' });
  });

  it('stops everything and cancels pending loads when disabled', async () => {
    const { ctx, player, gates } = setup({}, { gated: ['storm.wav'] });
    await player.unlock();
    await player.music('calm');
    const pending = player.ambience('storm');
    await settle();
    player.setEnabled(false);
    gates.forEach(g => g.open());
    expect(await pending).toBe(false);
    await settle();
    expect(sources(ctx).every(s => s.stoppedAt !== undefined)).toBe(true);
    expect(ctx.state).toBe('suspended');
    expect(player.inspect().music).toBeNull();
  });
});

describe('adaptive layers', () => {
  it('starts every layer together, looping, in the initial state', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    await player.music('theme');
    const started = sources(ctx).map(s => s.startedAt);
    expect(started).toHaveLength(3);
    expect(new Set(started).size).toBe(1);
    expect(sources(ctx).every(s => s.loop)).toBe(true);
    expect(player.inspect().music).toMatchObject({ state: 'explore', layers: { bed: 1, pulse: 1, threat: 0 } });
  });

  it('fades layers at the next bar line when asked', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    await player.music('theme');
    const start = sources(ctx)[0].startedAt as number;
    ctx.currentTime = start + 1;
    expect(player.setState('danger', { at: 'bar', fadeSec: 1 })).toBe(true);
    const threat = ctx.nodes('gain').find(g => g.outputs.length && (g.gain as FakeParam).events.some(e => e.kind === 'linear' && e.value === 1 && Math.abs(e.time - (start + 3)) < 1e-9));
    expect(threat).toBeDefined();
    expect(player.inspect().music).toMatchObject({ state: 'danger', layers: { bed: 1, pulse: 1, threat: 1 } });
  });

  it('reports unknown and non-adaptive states', async () => {
    const { player, errors } = setup();
    await player.unlock();
    await player.music('calm');
    expect(player.setState('danger')).toBe(false);
    await player.music('theme');
    expect(player.setState('boss')).toBe(false);
    expect(errors.map(e => e.code)).toEqual(expect.arrayContaining(['E_NOT_ADAPTIVE', 'E_UNKNOWN_STATE']));
  });
});

describe('promises never reject', () => {
  const throwingSources = (ctx: FakeContext) => { ctx.createBufferSource = () => { throw new Error('no source'); }; };
  const throwingStarts = (ctx: FakeContext, after = 0) => {
    const make = FakeContext.prototype.createBufferSource.bind(ctx);
    let n = 0;
    ctx.createBufferSource = () => { const s = make(); if (n++ >= after) s.start = () => { throw new Error('start failed'); }; return s; };
  };

  it('a thrown createBufferSource resolves ready false, reports E_PLAYBACK and frees the voice', async () => {
    const { ctx, player, errors } = setup();
    await player.unlock();
    throwingSources(ctx);
    const h = player.play('coin')!;
    await expect(h.ready).resolves.toBe(false);
    expect(errors).toContainEqual(expect.objectContaining({ code: 'E_PLAYBACK', id: 'coin' }));
    expect(player.inspect().voices).toBe(0);
  });

  it('a thrown start resolves ready false, reports E_PLAYBACK and frees the voice', async () => {
    const { ctx, player, errors } = setup();
    await player.unlock();
    throwingStarts(ctx);
    const h = player.play('coin')!;
    await expect(h.ready).resolves.toBe(false);
    expect(errors).toContainEqual(expect.objectContaining({ code: 'E_PLAYBACK', id: 'coin' }));
    expect(player.inspect().voices).toBe(0);
  });

  it('a thrown createBufferSource resolves music false and leaves no bed', async () => {
    const { ctx, player, errors } = setup();
    await player.unlock();
    throwingSources(ctx);
    await expect(player.music('calm')).resolves.toBe(false);
    expect(errors).toContainEqual(expect.objectContaining({ code: 'E_PLAYBACK', id: 'calm' }));
    expect(player.inspect().music).toBeNull();
  });

  it('a layer whose start throws resolves music false and stops the layers already started', async () => {
    const { ctx, player, errors } = setup();
    await player.unlock();
    throwingStarts(ctx, 1);
    await expect(player.music('theme')).resolves.toBe(false);
    expect(errors).toContainEqual(expect.objectContaining({ code: 'E_PLAYBACK', id: 'theme' }));
    expect(player.inspect().music).toBeNull();
    expect(sources(ctx).filter(s => s.startedAt !== undefined).every(s => s.stoppedAt !== undefined)).toBe(true);
  });

  it('a queued bed that throws on unlock still lets unlock resolve', async () => {
    const { ctx, player, errors } = setup();
    await player.ambience('calm');
    throwingSources(ctx);
    await expect(player.unlock()).resolves.toBe(true);
    expect(errors).toContainEqual(expect.objectContaining({ code: 'E_PLAYBACK', id: 'calm' }));
    expect(player.inspect().ambience).toBeNull();
  });
});

describe('spec review fixes', () => {
  const layerGain = (ctx: FakeContext, i: number) => (sources(ctx)[i].outputs[0] as FakeNode).gain as FakeParam;
  const allTimesFinite = (ctx: FakeContext) => ctx.created.every(n =>
    Object.values(n).every(v => !(v instanceof FakeParam) || v.events.every(e => Number.isFinite(e.time)))
    && (n.stoppedAt === undefined || Number.isFinite(n.stoppedAt)));

  it('a state change mid-fade starts from the current gain, not the previous goal (fallback path)', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    await player.music('theme');
    ctx.currentTime = 1;
    player.setState('danger', { fadeSec: 2 });
    const threat = layerGain(ctx, 2);
    threat.value = 0.4; // halfway up the fade
    ctx.currentTime = 2;
    player.setState('explore', { fadeSec: 2 });
    const sets = threat.events.filter(e => e.kind === 'set' && e.time === 2);
    expect(sets.map(e => e.value)).toEqual([0.4]);
    expect(threat.events.at(-1)).toMatchObject({ kind: 'linear', value: 0, time: 4 });
  });

  it('uses cancelAndHoldAtTime when the browser has it', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    await player.music('theme');
    const threat = layerGain(ctx, 2) as FakeParam & { cancelAndHoldAtTime?: (t: number) => void };
    const held: number[] = [];
    threat.cancelAndHoldAtTime = (t: number) => { held.push(t); };
    ctx.currentTime = 1;
    player.setState('danger', { fadeSec: 1 });
    expect(held).toEqual([1]);
    expect(threat.events.filter(e => e.kind === 'set' || e.kind === 'cancel')).toHaveLength(0);
    expect(threat.events.at(-1)).toMatchObject({ kind: 'linear', value: 1, time: 2 });
  });

  it('never schedules a non-finite time for a NaN fadeSec', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    await player.music('theme', { fadeSec: NaN });
    player.setState('danger', { fadeSec: NaN });
    player.setState('calm', { fadeSec: NaN, at: 'bar' });
    await player.music('storm', { fadeSec: NaN });
    await player.ambience('calm', { fadeSec: NaN });
    const h = player.play('coin')!;
    await h.ready;
    h.stop(NaN);
    player.stopAll(NaN);
    expect(allTimesFinite(ctx)).toBe(true);
  });

  it('starts a bed requested while hidden once the tab is shown again, without another unlock', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    player.setHidden(true);
    await settle();
    expect(await player.music('storm')).toBe(false);
    expect(sources(ctx)).toHaveLength(0);
    player.setHidden(false);
    for (let i = 0; i < 5; i++) await settle();
    expect(ctx.state).toBe('running');
    expect(sources(ctx)).toHaveLength(1);
    expect(player.inspect().music).toMatchObject({ id: 'storm' });
  });

  it('disconnects an old bed once its faded-out sources end', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    await player.music('calm');
    await player.music('storm');
    const [old] = sources(ctx);
    const gain = old.outputs[0] as FakeNode;
    const group = gain.outputs[0] as FakeNode;
    expect(group.disconnected).toBeUndefined();
    old.onended?.();
    expect(old.disconnected).toBe(true);
    expect(gain.disconnected).toBe(true);
    expect(group.disconnected).toBe(true);
    expect((sources(ctx)[1].outputs[0] as FakeNode).outputs[0]).not.toBe(group);
  });

  it('gives each sound its own variant pattern', async () => {
    const three = (p: string) => ({ file: `${p}.0.wav`, loop: false, variants: [0, 1, 2].map(i => ({ file: `${p}.${i}.wav` })) });
    const { player } = setup({ catalog: { assets: { a: three('a'), b: three('b') } } });
    await player.unlock();
    const seq = (id: string) => Array.from({ length: 16 }, () => player.play(id)!.file.split('.')[1]).join('');
    expect(seq('a')).not.toBe(seq('b'));
  });

  it('retries a failed catalog when a sound is played', async () => {
    let catalogFetches = 0;
    const { player, errors } = setup({
      fetcher: async (url: string) => {
        const ok = !url.endsWith('index.json') || catalogFetches++ > 0;
        return { ok, json: async () => catalog, arrayBuffer: async () => new ArrayBuffer(8) };
      },
    });
    await player.unlock();
    expect(errors.map(e => e.code)).toContain('E_CATALOG');
    expect(player.play('coin')).toBeNull();
    await settle();
    expect(player.play('coin')).not.toBeNull();
    expect(catalogFetches).toBe(2);
  });
});

describe('spec re-review fixes', () => {
  it('fallback bar change holds the scheduled target, not the level now', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    await player.music('theme');
    const start = sources(ctx)[0].startedAt as number; // bar = 2 s at 120 bpm in 4
    const threat = (sources(ctx)[2].outputs[0] as FakeNode).gain as FakeParam;
    ctx.currentTime = start + 0.5;
    player.setState('danger', { fadeSec: 1 }); // threat reaches 1 at start + 1.5, before the bar
    threat.value = 0.3; // mid-fade, now
    ctx.currentTime = start + 1;
    player.setState('calm', { at: 'bar', fadeSec: 1 });
    const atBar = threat.events.filter(e => e.kind === 'set' && Math.abs(e.time - (start + 2)) < 1e-9);
    expect(atBar.map(e => e.value)).toEqual([1]);
  });

  it('throttles catalog retries from play() and reports the failure once', async () => {
    let up = false;
    let catalogFetches = 0;
    const { ctx, player, errors } = setup({
      fetcher: async (url: string) => {
        if (url.endsWith('index.json')) catalogFetches++;
        const ok = !url.endsWith('index.json') || up;
        return { ok, json: async () => catalog, arrayBuffer: async () => new ArrayBuffer(8) };
      },
    });
    await player.unlock();
    for (let i = 0; i < 10; i++) { expect(player.play('coin')).toBeNull(); await settle(); }
    expect(catalogFetches).toBeLessThanOrEqual(2);
    expect(errors.filter(e => e.code === 'E_CATALOG')).toHaveLength(1);
    up = true;
    ctx.currentTime = 1; // still inside the retry window
    expect(player.play('coin')).toBeNull();
    await settle();
    expect(player.play('coin')).toBeNull();
    ctx.currentTime = 6; // past it
    expect(player.play('coin')).toBeNull();
    await settle();
    expect(player.play('coin')).not.toBeNull();
    expect(catalogFetches).toBeLessThanOrEqual(3);
  });
});
