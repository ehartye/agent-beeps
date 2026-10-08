// tests/player/eviction.test.ts
// Decoded-buffer eviction under memoryBudgetBytes, unload(), prefetch scheduling and layerLoading 'state'.
import { describe, expect, it } from 'vitest';
import { createPlayer } from '../../runtime/player/player.js';
import { defaultPrefetchConcurrency } from '../../runtime/player/loader.js';
import { asCtx, FakeContext } from '../helpers/fake-context.ts';

const FRAMES = 1000;
const BUF = FRAMES * 2 * 4; // one decoded stereo buffer
const song = (n: string, extra: Record<string, unknown> = {}) => ({
  file: `${n}.wav`, loop: true, bpm: 120, meter: 4, durationSec: 16, frames: FRAMES,
  layers: [{ name: 'bed', file: `${n}.bed.wav` }, { name: 'pulse', file: `${n}.pulse.wav` }],
  states: { calm: ['bed'], busy: ['bed', 'pulse'] }, initialState: 'calm', ...extra,
});
const catalog = { assets: {
  a: song('a'), b: song('b'), c: song('c'),
  plain: { file: 'plain.wav', loop: true, frames: FRAMES },
  coin: { file: 'coin.wav', loop: false, priority: 3 },
  hit: { file: 'hit.wav', loop: false, priority: 3 },
} };

function setup(over: Record<string, unknown> = {}, { failing = [] as string[], gated = [] as string[] } = {}) {
  const ctx = new FakeContext();
  ctx.decodeAudioData = async () => ctx.createBuffer(2, FRAMES, 48000) as unknown as AudioBuffer;
  const fetched: string[] = [];
  const errors: { code: string; id?: string }[] = [];
  const gates: { url: string; open: () => void }[] = [];
  let failNow = [...failing];
  const player = createPlayer({
    catalog: catalog as never, baseUrl: '/audio/', voices: 8, defaults: { cooldownSec: 0 },
    contextFactory: () => asCtx(ctx) as AudioContext,
    fetcher: async (url: string) => {
      fetched.push(url);
      if (gated.some(g => url.endsWith(g))) await new Promise<void>(open => gates.push({ url, open }));
      return { ok: !failNow.some(f => url.endsWith(f)), json: async () => catalog, arrayBuffer: async () => new ArrayBuffer(8) };
    },
    onError: (e: { code: string; id?: string }) => errors.push(e),
    ...over,
  });
  const count = (suffix: string) => fetched.filter(u => u.endsWith(suffix)).length;
  const open = (suffix: string) => { const i = gates.findIndex(g => g.url.endsWith(suffix)); gates.splice(i, 1)[0].open(); };
  return { ctx, player, fetched, errors, gates, count, open, setFailing: (f: string[]) => { failNow = f; } };
}
const settle = () => new Promise(r => setTimeout(r, 0));
const sources = (ctx: FakeContext) => ctx.nodes('bufferSource');
/** What a browser does once a source has stopped: fire onended. */
const end = (ctx: FakeContext, from = 0, to?: number) => { for (const s of sources(ctx).slice(from, to)) s.onended?.(); };

describe('default behaviour (no budget)', () => {
  it('never evicts, and counts what it decodes', async () => {
    const { player, fetched } = setup();
    await player.unlock();
    await player.music('a'); await player.music('b'); await player.music('c');
    expect(player.memory()).toMatchObject({ budgetBytes: null, buffers: 6, decodedBytes: 6 * BUF, evictions: 0, unloads: 0 });
    await player.music('a');
    expect(fetched.filter(u => u.endsWith('a.bed.wav'))).toHaveLength(1);
  });
});

describe('memoryBudgetBytes', () => {
  it('keeps a crossfading song and the new one, then evicts the old one once its sources end', async () => {
    const { ctx, player, errors, count } = setup({ memoryBudgetBytes: 2 * BUF });
    await player.unlock();
    await player.music('a');
    await player.music('b', { fadeSec: 2 });
    // a fades out under b: both are playing, so nothing may go even though 4 buffers exceed the budget of 2
    expect(player.memory()).toMatchObject({ buffers: 4, evictions: 0, pinnedBuffers: 4 });
    expect(errors.map(e => e.code)).toContain('W_MEMORY_BUDGET');
    end(ctx, 0, 2); // a's two sources end after the crossfade
    expect(player.memory()).toMatchObject({ buffers: 2, decodedBytes: 2 * BUF, evictions: 2, pinnedBuffers: 2 });
    // coming back to a loads it again, transparently
    await player.music('a');
    expect(count('a.bed.wav')).toBe(2);
    expect(player.inspect().music).toMatchObject({ id: 'a' });
  });

  it('evicts the least recently used idle buffer first', async () => {
    const { ctx, player } = setup({ memoryBudgetBytes: 4 * BUF });
    await player.unlock();
    await player.music('a');
    await player.music('b', { fadeSec: 0.1 }); end(ctx, 0, 2);
    await player.music('c', { fadeSec: 0.1 }); end(ctx, 2, 4);
    const m = player.memory();
    expect(m.decodedBytes).toBeLessThanOrEqual(4 * BUF);
    expect(m.pinnedBuffers).toBe(2); // c only
    await player.music('a', { fadeSec: 0.1 }); // a was evicted before b (oldest)
    expect(player.memory().reloads).toBeGreaterThan(0);
  });

  it('never evicts a sound effect that is playing, and reloads it after it ends', async () => {
    const { ctx, player, count } = setup({ memoryBudgetBytes: 1 * BUF }); // room for one buffer
    await player.unlock();
    const coin = player.play('coin')!; await coin.ready;
    const hit = player.play('hit')!; await hit.ready;
    expect(player.memory()).toMatchObject({ buffers: 2, evictions: 0 }); // both sounding
    end(ctx);
    expect(player.memory().buffers).toBeLessThanOrEqual(1);
    ctx.currentTime = 100;
    const again = player.play('coin')!; expect(await again.ready).toBe(true);
    expect(count('coin.wav')).toBe(2);
  });

  it('a state change mid-load starts the music in the new state without losing its buffers', async () => {
    const { ctx, player, gates, open } = setup({ memoryBudgetBytes: 10 * BUF }, { gated: ['a.bed.wav'] });
    await player.unlock();
    const started = player.music('a');
    await settle();
    expect(player.setState('busy')).toBe(false); // kept for the music that is loading
    open('a.bed.wav');
    expect(await started).toBe(true);
    expect(gates).toHaveLength(0);
    expect(player.inspect().music).toMatchObject({ state: 'busy', layers: { bed: 1, pulse: 1 } });
    expect(sources(ctx)).toHaveLength(2);
  });

  it('shares one load between duplicate requests', async () => {
    const { player, count } = setup({ memoryBudgetBytes: 10 * BUF });
    await player.unlock();
    await Promise.all([player.music('a'), player.music('a'), player.prefetch(['a'])]);
    expect(count('a.bed.wav')).toBe(1);
    expect(count('a.pulse.wav')).toBe(1);
  });

  it('a start superseded while loading releases its holds, so those buffers can go', async () => {
    const { player, open } = setup({ memoryBudgetBytes: 2 * BUF }, { gated: ['a.pulse.wav'] });
    await player.unlock();
    const first = player.music('a');
    await settle();
    const second = player.music('b'); // supersedes a
    await settle();
    open('a.pulse.wav');
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(player.memory().decodedBytes).toBeLessThanOrEqual(2 * BUF);
    expect(player.memory().pinnedBuffers).toBe(2);
  });

  it('a sync-phase crossfade keeps the old song until it ends', async () => {
    const { ctx, player } = setup({ memoryBudgetBytes: 1 * BUF });
    await player.unlock();
    await player.music('a');
    ctx.currentTime = 5;
    expect(await player.music('b', { sync: true, fadeSec: 3 })).toBe(true);
    expect(player.memory()).toMatchObject({ buffers: 4, evictions: 0 });
    expect(sources(ctx)[2].offset).toBeGreaterThan(0);
  });

  it('retries after a failed reload of an evicted buffer: twice, then silent until retry()', async () => {
    const { ctx, player, errors, setFailing, count } = setup({ memoryBudgetBytes: 1 * BUF });
    await player.unlock();
    await player.music('plain', { fadeSec: 0.1 });
    await player.music('a', { fadeSec: 0.1 });
    end(ctx, 0, 1);
    expect(player.memory().evictions).toBeGreaterThan(0);
    setFailing(['plain.wav']);
    expect(await player.music('plain')).toBe(false);
    expect(await player.music('plain')).toBe(false);
    expect(await player.music('plain')).toBe(false); // silent now
    expect(errors.filter(e => e.code === 'E_LOAD')).toHaveLength(2);
    expect(count('plain.wav')).toBe(3);
    setFailing([]);
    player.retry();
    expect(await player.music('plain')).toBe(true);
  });

  it('reports W_MEMORY_THRASH once when a buffer is needed right after its eviction', async () => {
    const { ctx, player, errors } = setup({ memoryBudgetBytes: 1 * BUF });
    await player.unlock();
    for (let i = 0; i < 3; i++) {
      const from = sources(ctx).length;
      const c = player.play('coin')!; await c.ready; end(ctx, from);
      const h = player.play('hit')!; await h.ready; end(ctx, from);
    }
    expect(player.memory().thrash).toBeGreaterThan(0);
    expect(errors.filter(e => e.code === 'W_MEMORY_THRASH')).toHaveLength(2); // coin and hit, once each
  });

  it('makes room before the decode when the catalog gives the size', async () => {
    const seen: number[] = [];
    const { ctx, player } = setup({ memoryBudgetBytes: 2 * BUF });
    const decode = ctx.decodeAudioData.bind(ctx);
    ctx.decodeAudioData = async d => { seen.push(player.memory().decodedBytes); return decode(d); };
    await player.unlock();
    await player.music('plain', { fadeSec: 0.1 }); // 1 buffer
    await player.music('a', { fadeSec: 0.1 }); // a.bed: 2 buffers held after, plain still fading
    end(ctx, 0);
    await player.music('b', { fadeSec: 0.1 });
    expect(Math.max(...seen)).toBeLessThanOrEqual(2 * BUF);
  });
});

describe('unload()', () => {
  it('frees an idle asset, skips one that plays, and reloads on demand', async () => {
    const { ctx, player, count } = setup();
    await player.unlock();
    await player.music('a');
    expect(player.unload('a')).toBe(0); // playing
    await player.music(null, { fadeSec: 0.1 });
    end(ctx);
    expect(player.unload('a')).toBe(2 * BUF);
    expect(player.unload('a')).toBe(0);
    expect(player.unload('nope')).toBe(0);
    expect(player.memory()).toMatchObject({ buffers: 0, unloads: 2 });
    await player.music('a');
    expect(count('a.bed.wav')).toBe(2);
  });
});

describe('prefetch()', () => {
  it('runs at most the concurrency cap at a time, and a music() request goes ahead of the queue', async () => {
    const { player, gates, open, count } = setup({ prefetchConcurrency: 1 }, { gated: ['.wav'] });
    await player.unlock();
    const pre = player.prefetch(['a', 'b']);
    await settle();
    expect(gates.map(g => g.url.split('/').pop())).toEqual(['a.bed.wav']); // one at a time
    const music = player.music('b'); // b.* are queued prefetches: promoted at once
    await settle();
    expect(gates.map(g => g.url.split('/').pop()).sort()).toEqual(['a.bed.wav', 'b.bed.wav', 'b.pulse.wav']);
    while (gates.length) { open(gates[0].url.split('/').pop()!); await settle(); }
    expect(await music).toBe(true);
    expect(await pre).toBe(4);
    expect(count('b.bed.wav')).toBe(1);
  });

  it('waits while a foreground load is in flight', async () => {
    const { player, gates, open } = setup({ prefetchConcurrency: 2 }, { gated: ['plain.wav'] });
    await player.unlock();
    const music = player.music('plain');
    await settle();
    void player.prefetch(['a']);
    await settle();
    expect(gates).toHaveLength(1);
    expect(player.memory().loading).toBe(3); // plain, and a's two files queued behind it
    open('plain.wav');
    await music;
    await settle();
    expect(player.memory().buffers).toBeGreaterThanOrEqual(3);
  });

  it('skips what would not fit beside what is playing instead of evicting it', async () => {
    const { player, fetched } = setup({ memoryBudgetBytes: 2 * BUF });
    await player.unlock();
    await player.music('a');
    fetched.length = 0;
    expect(await player.prefetch(['b'])).toBe(0);
    expect(player.memory()).toMatchObject({ buffers: 2, evictions: 0, skippedPrefetch: 2 });
    expect(player.inspect().music).toMatchObject({ id: 'a' });
  });

  it('queues until unlock() when called before the context exists', async () => {
    const { player, fetched } = setup();
    expect(await player.prefetch(['plain'])).toBe(0);
    expect(fetched).toEqual([]);
    await player.unlock();
    await settle();
    expect(fetched.some(u => u.endsWith('plain.wav'))).toBe(true);
    expect(player.memory().buffers).toBe(1);
  });

  it('reports an unknown id and ignores bad input without rejecting', async () => {
    const { player, errors } = setup();
    await player.unlock();
    expect(await player.prefetch(['nope'])).toBe(0);
    expect(errors.map(e => e.code)).toContain('E_UNKNOWN_ASSET');
    expect(await player.prefetch(null as never)).toBe(0);
  });

  it('picks a phone-friendly default concurrency', () => {
    expect(defaultPrefetchConcurrency(undefined)).toBe(2);
    expect(defaultPrefetchConcurrency({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/150' })).toBe(2);
    expect(defaultPrefetchConcurrency({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148' })).toBe(1);
    expect(defaultPrefetchConcurrency({ userAgent: 'x', userAgentData: { mobile: true } })).toBe(1);
    expect(defaultPrefetchConcurrency({ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(1);
  });
});

describe("layerLoading: 'state'", () => {
  it('loads only the current state layers, then the others when a state needs them, in phase', async () => {
    const { ctx, player, count } = setup({ layerLoading: 'state' });
    await player.unlock();
    expect(await player.music('a')).toBe(true);
    expect(count('a.pulse.wav')).toBe(0);
    expect(player.inspect().music).toMatchObject({ state: 'calm', layers: { bed: 1, pulse: 0 } });
    ctx.currentTime = 4;
    expect(player.setState('busy', { fadeSec: 1 })).toBe(true);
    await settle();
    expect(count('a.pulse.wav')).toBe(1);
    const pulse = sources(ctx)[1];
    expect(pulse.startedAt).toBeGreaterThanOrEqual(4);
    expect(pulse.offset).toBeCloseTo(pulse.startedAt - sources(ctx)[0].startedAt, 5); // same phase as the bed
    expect(player.inspect().music).toMatchObject({ state: 'busy', layers: { bed: 1, pulse: 1 } });
  });

  it('retires a layer once its state is left, freeing it for eviction', async () => {
    const { ctx, player } = setup({ layerLoading: 'state', memoryBudgetBytes: 1 * BUF });
    await player.unlock();
    await player.music('a', { fadeSec: 0.1 });
    player.setState('busy', { fadeSec: 0.5 }); await settle();
    player.setState('calm', { fadeSec: 0.5 });
    const pulse = sources(ctx)[1];
    expect(pulse.stoppedAt).toBeGreaterThan(0.5);
    pulse.onended();
    expect(player.memory()).toMatchObject({ buffers: 1, evictions: 1, pinnedBuffers: 1 });
    expect(player.inspect().music).toMatchObject({ layers: { bed: 1, pulse: 0 } });
  });

  it('drops a late layer quietly when the state moved on before it loaded', async () => {
    const { ctx, player, open } = setup({ layerLoading: 'state' }, { gated: ['a.pulse.wav'] });
    await player.unlock();
    await player.music('a');
    player.setState('busy'); await settle();
    player.setState('calm');
    open('a.pulse.wav'); await settle();
    expect(sources(ctx)).toHaveLength(1);
    expect(player.inspect().music).toMatchObject({ state: 'calm', layers: { bed: 1, pulse: 0 } });
    expect(player.memory().pinnedBuffers).toBe(1);
  });

  it('prefetch({ id, state }) loads just that state of the next song', async () => {
    const { player, count } = setup({ layerLoading: 'state' });
    await player.unlock();
    expect(await player.prefetch([{ id: 'b', state: 'busy' }, 'c'])).toBe(3);
    expect(count('b.pulse.wav')).toBe(1);
    expect(count('c.pulse.wav')).toBe(0);
    const before = count('b.bed.wav');
    await player.music('b');
    expect(count('b.bed.wav')).toBe(before);
  });
});
