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
/**
 * Flush: waits one macrotask. The fake fetcher, the lifecycle queue and bed starts are all promise
 * (microtask) chains, and every queued microtask runs before a timer fires, so one call settles them.
 */
const settle = () => new Promise(r => setTimeout(r, 0));
/** Longer than the player's post-fade suspend delay (RAMP + 10 ms) after setEnabled(false). */
const afterSuspendDelay = () => new Promise(r => setTimeout(r, 60));
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
    await afterSuspendDelay();
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
    player.setLevel('music', 5); player.setLevel('sfx', -1); player.setLevel('ambience', NaN); player.setLevel('nope' as 'music', 0.5); // an untyped caller: the runtime guard ignores it
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
    await afterSuspendDelay();
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

describe('click-free fades, hidden tabs, graph cleanup and catalog recovery', () => {
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
    await settle();
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

describe('bar-line holds and catalog retry throttling', () => {
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
    expect(catalogFetches).toBe(2); // unlock's attempt, then one immediate retry; the rest are throttled
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
    expect(catalogFetches).toBe(3);
  });
});

describe('bed and state races', () => {
  it('a direct request during unlock wins over the bed queued before it', async () => {
    const { ctx, player, gates } = setup({}, { gated: ['index.json'] });
    await player.music('calm'); // queued: no context yet
    const unlocking = player.unlock();
    await settle(); // context resumed; unlock now waits for the catalog
    const storm = player.music('storm');
    gates.forEach(g => g.open());
    await unlocking;
    expect(await storm).toBe(true);
    await settle();
    expect(sources(ctx)).toHaveLength(1);
    expect(player.inspect().music).toMatchObject({ id: 'storm' });
  });

  it('re-queues a bed whose buffers arrive while hidden and starts it when shown', async () => {
    const { ctx, player, gates } = setup({}, { gated: ['storm.wav'] });
    await player.unlock();
    const storm = player.music('storm');
    await settle();
    player.setHidden(true);
    await settle();
    gates.forEach(g => g.open());
    expect(await storm).toBe(false);
    expect(sources(ctx)).toHaveLength(0);
    player.setHidden(false);
    await settle();
    expect(sources(ctx)).toHaveLength(1);
    expect(player.inspect().music).toMatchObject({ id: 'storm' });
  });

  it('forgets a non-looping bed once it ends, so the same id plays again', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    expect(await player.music('coin')).toBe(true);
    expect(sources(ctx)[0].loop).toBe(false);
    sources(ctx)[0].onended?.();
    expect(player.inspect().music).toBeNull();
    expect(await player.music('coin')).toBe(true);
    expect(sources(ctx)).toHaveLength(2);
  });

  it('a state set while new music loads applies to that music, not the old bed', async () => {
    const { player, errors, gates } = setup({}, { gated: ['bed.wav', 'pulse.wav', 'threat.wav'] });
    await player.unlock();
    await player.music('calm');
    const theme = player.music('theme');
    await settle();
    player.setState('danger');
    gates.forEach(g => g.open());
    expect(await theme).toBe(true);
    expect(errors.map(e => e.code)).not.toContain('E_NOT_ADAPTIVE');
    expect(player.inspect().music).toMatchObject({ id: 'theme', state: 'danger', layers: { bed: 1, pulse: 1, threat: 1 } });
  });

  it('fades the old bed out from the moment the new one fades in', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    await player.music('calm');
    ctx.currentTime = 5;
    await player.music('storm', { fadeSec: 2 });
    const [old, fresh] = sources(ctx);
    const oldGroup = (old.outputs[0] as FakeNode).outputs[0] as FakeNode;
    const t = fresh.startedAt as number;
    expect(t).toBeGreaterThan(5);
    expect((oldGroup.gain as FakeParam).events.at(-1)).toMatchObject({ kind: 'linear', value: 0, time: t + 2 });
    expect(old.stoppedAt).toBe(t + 2);
  });

  it('disabling suspends only after the stop fade, and play() is already dropped', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    await player.music('calm');
    player.setEnabled(false);
    expect(player.play('coin')).toBeNull();
    await settle();
    expect(ctx.state).toBe('running'); // still fading out
    await afterSuspendDelay();
    expect(ctx.state).toBe('suspended');
  });

  it('closes a context whose graph failed to build', async () => {
    const { ctx, player, errors } = setup();
    let closed = 0;
    Object.assign(ctx, { close: async () => { closed++; }, createWaveShaper: () => { throw new Error('no shaper'); } });
    expect(await player.unlock()).toBe(false);
    expect(errors.map(e => e.code)).toContain('E_CONTEXT');
    expect(closed).toBe(1);
  });
});

describe('voice bookkeeping and API contracts', () => {
  it('handle.stop() releases the voice and fades the source out', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    const h = player.play('coin')!;
    await h.ready;
    expect(player.inspect().voices).toBe(1);
    h.stop();
    expect(player.inspect().voices).toBe(0);
    expect(sources(ctx)[0].stoppedAt).toBeCloseTo(0.02, 9);
  });

  it('frees the voice when a sound ends on its own', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    await player.play('coin')!.ready;
    sources(ctx)[0].onended?.();
    expect(player.inspect().voices).toBe(0);
    expect(sources(ctx)[0].disconnected).toBe(true);
  });

  it('stopAll() frees every voice', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    await Promise.all([player.play('coin')!.ready, player.play('hit')!.ready]);
    expect(player.inspect().voices).toBe(2);
    player.stopAll();
    expect(player.inspect().voices).toBe(0);
    expect(sources(ctx).every(s => s.stoppedAt !== undefined)).toBe(true);
  });

  it('replaces the oldest instance of a sound at its cap', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    await player.play('coin', { cap: 1 })!.ready;
    ctx.currentTime = 0.1;
    const second = player.play('coin', { cap: 1 })!;
    expect(await second.ready).toBe(true);
    expect(sources(ctx)[0].stoppedAt).toBeDefined();
    expect(sources(ctx)[1].stoppedAt).toBeUndefined();
    expect(player.inspect().voices).toBe(1);
  });

  it('drops sound effects while hidden', async () => {
    const { player } = setup();
    await player.unlock();
    player.setHidden(true);
    await settle();
    expect(player.play('coin')).toBeNull();
    expect(player.inspect().voices).toBe(0);
  });

  it('applies a state set before any music when that music starts', async () => {
    const { player } = setup();
    await player.unlock();
    expect(player.setState('calm')).toBe(false);
    await player.music('theme');
    expect(player.inspect().music).toMatchObject({ state: 'calm', layers: { bed: 1, pulse: 0, threat: 0 } });
  });

  it('keeps playing when the game\'s onError handler throws', async () => {
    const { ctx, player } = setup({ onError: () => { throw new Error('game bug'); } });
    await player.unlock();
    expect(player.play('nope')).toBeNull();
    expect(await player.play('coin')!.ready).toBe(true);
    expect(sources(ctx)).toHaveLength(1);
  });

  it('setLevel after unlock ramps the real bus gain', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    const [master, music, ambience, sfx] = ctx.nodes('gain');
    expect(master.outputs).toContain(ctx.nodes('shaper')[0]);
    expect([music, ambience, sfx].every(b => b.outputs.includes(master))).toBe(true);
    ctx.currentTime = 3;
    player.setLevel('sfx', 0.5);
    player.setLevel('master', 0.25);
    expect((sfx.gain as FakeParam).events.at(-1)).toMatchObject({ kind: 'linear', value: 0.5, time: 3.02 });
    expect((master.gain as FakeParam).events.at(-1)).toMatchObject({ kind: 'linear', value: 0.25, time: 3.02 });
    expect((music.gain as FakeParam).events).toHaveLength(0);
  });
});

describe('context ownership and stale pending state', () => {
  it('re-enabling inside the suspend delay keeps the context running, with no unlock needed', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    player.setEnabled(false);
    player.setEnabled(true);
    await afterSuspendDelay();
    expect(ctx.state).toBe('running');
    expect(await player.play('coin')!.ready).toBe(true);
  });

  it('never closes a context the game passed in', async () => {
    const ctx = new FakeContext();
    let closed = 0;
    Object.assign(ctx, { close: async () => { closed++; }, createWaveShaper: () => { throw new Error('no shaper'); } });
    const { player, errors } = setup({ contextFactory: undefined, context: asCtx(ctx) as AudioContext });
    expect(await player.unlock()).toBe(false);
    await settle();
    expect(errors.map(e => e.code)).toContain('E_CONTEXT');
    expect(closed).toBe(0);
  });

  it('a queued request for the current music makes setState apply to it, not to an older load', async () => {
    const { player, gates } = setup({}, { gated: ['storm.wav'] });
    await player.unlock();
    await player.music('theme');
    const storm = player.music('storm'); // loading
    await settle();
    player.setHidden(true);
    await settle();
    await player.music('theme'); // queued while hidden: back to the current music
    expect(player.setState('danger')).toBe(true);
    expect(player.inspect().music).toMatchObject({ id: 'theme', state: 'danger' });
    gates.forEach(g => g.open());
    expect(await storm).toBe(false);
  });

  it('drops a pending state when the music it was meant for fails to load', async () => {
    let up = false;
    const { player } = setup({
      fetcher: async (url: string) => {
        const ok = up || !/theme\.\w+\.wav$/.test(url);
        return { ok, json: async () => catalog, arrayBuffer: async () => new ArrayBuffer(8) };
      },
    });
    await player.unlock();
    expect(player.setState('danger')).toBe(false);
    expect(await player.music('theme')).toBe(false);
    up = true;
    expect(await player.music('theme')).toBe(true);
    expect(player.inspect().music).toMatchObject({ id: 'theme', state: 'explore' });
  });
});
