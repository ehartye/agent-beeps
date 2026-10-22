// tests/player/dispose.test.ts
// player.dispose(): everything stops, every timer and in-flight load is cancelled (the loader's fetcher gets an
// AbortSignal), the AudioContext is closed only when the player made it, and later calls are silent no-ops.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlayer } from '../../runtime/player/player.js';
import { createLoader } from '../../runtime/player/loader.js';
import { asCtx, FakeContext } from '../helpers/fake-context.ts';

const catalog = { assets: {
  coin: { file: 'coin.wav', loop: false, priority: 3 },
  calm: { file: 'calm.wav', loop: true },
  rain: { file: 'rain.wav', loop: true },
  theme: { file: 'theme.wav', loop: true, bpm: 120, meter: 4, durationSec: 16,
    layers: [{ name: 'bed', file: 'theme.bed.wav' }, { name: 'pulse', file: 'theme.pulse.wav' }],
    states: { calm: ['bed'], busy: ['bed', 'pulse'] }, initialState: 'calm' },
} };

type Gate = { url: string; signal?: AbortSignal; open: () => void };
type CloseableContext = FakeContext & { close: ReturnType<typeof vi.fn> };
const closeable = () => { const c = new FakeContext() as CloseableContext; c.close = vi.fn(async () => {}); return c; };

function setup(over: Record<string, unknown> = {}, { gated = [] as string[] } = {}) {
  const ctx = closeable();
  const errors: { code: string; id?: string }[] = [];
  const gates: Gate[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const player = createPlayer({
    catalog: catalog as never, baseUrl: '/audio/', voices: 8, defaults: { cooldownSec: 0 },
    contextFactory: () => asCtx(ctx) as AudioContext,
    fetcher: async (url: string, init?: { signal: AbortSignal }) => {
      signals.push(init?.signal);
      if (gated.some(g => url.endsWith(g))) await new Promise<void>(open => gates.push({ url, ...(init ? { signal: init.signal } : {}), open }));
      return { ok: true, json: async () => catalog, arrayBuffer: async () => new ArrayBuffer(8) };
    },
    onError: (e: { code: string; id?: string }) => errors.push(e),
    ...over,
  });
  const open = (suffix: string) => { const i = gates.findIndex(g => g.url.endsWith(suffix)); gates.splice(i, 1)[0].open(); };
  return { ctx, player, errors, gates, signals, open };
}
const settle = () => new Promise(r => setTimeout(r, 0));
const sources = (ctx: FakeContext) => ctx.nodes('bufferSource');

afterEach(() => { vi.useRealTimers(); });

describe('dispose: what it stops', () => {
  it('stops playing voices and both beds at once, and silences the buses', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    const h = player.play('coin');
    await h!.ready;
    await player.music('calm');
    await player.ambience('rain', { slot: 'weather' });
    expect(sources(ctx).length).toBe(3);
    expect(sources(ctx).every(s => s.stoppedAt === undefined)).toBe(true);
    player.dispose();
    expect(sources(ctx).every(s => s.stoppedAt !== undefined)).toBe(true);
    expect(sources(ctx).every(s => s.disconnected === true)).toBe(true);
    expect(player.inspect()).toMatchObject({ running: false, voices: 0, music: null, ambience: null, ambienceSlots: {} });
    // the master chain is cut from the destination
    expect(ctx.nodes('shaper')[0].disconnected).toBe(true);
  });

  it('releases every held buffer (adaptive song layers included)', async () => {
    const { player } = setup();
    await player.unlock();
    await player.music('theme');
    await (player.play('coin'))!.ready;
    expect(player.memory().pinnedBuffers).toBeGreaterThan(0);
    player.dispose();
    expect(player.memory()).toMatchObject({ buffers: 0, decodedBytes: 0, pinnedBuffers: 0, pinnedBytes: 0 });
  });

  it('does not report anything through onError', async () => {
    const { player, errors } = setup();
    await player.unlock();
    await player.music('calm');
    player.dispose();
    await settle();
    expect(errors).toEqual([]);
  });

  it('a handle stopped after dispose is harmless', async () => {
    const { player } = setup();
    await player.unlock();
    const h = player.play('coin');
    await h!.ready;
    player.dispose();
    expect(() => h!.stop()).not.toThrow();
  });
});

describe('dispose: timers', () => {
  it('clears the post-fade suspend timer that setEnabled(false) scheduled', async () => {
    vi.useFakeTimers();
    const { ctx, player } = setup();
    await player.unlock();
    expect(ctx.state).toBe('running');
    player.setEnabled(false);
    expect(vi.getTimerCount()).toBe(1);
    player.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.state).toBe('running'); // the suspend never ran
  });
});

describe('dispose: loads in flight', () => {
  it('a sound still loading never starts a voice, and its fetch signal is aborted', async () => {
    const { ctx, player, gates, open, errors } = setup({}, { gated: ['coin.wav'] });
    await player.unlock();
    const h = player.play('coin')!;
    await settle();
    expect(gates).toHaveLength(1);
    const signal = gates[0].signal!;
    expect(signal.aborted).toBe(false);
    player.dispose();
    expect(signal.aborted).toBe(true);
    open('coin.wav');
    expect(await h.ready).toBe(false);
    expect(sources(ctx)).toHaveLength(0);
    expect(player.inspect().voices).toBe(0);
    expect(errors).toEqual([]);
  });

  it('a song still loading never starts, resolves false and reports nothing', async () => {
    const { ctx, player, gates, open, errors } = setup({}, { gated: ['theme.pulse.wav'] });
    await player.unlock();
    const started = player.music('theme');
    await settle();
    expect(gates.length).toBeGreaterThan(0);
    player.dispose();
    expect(gates.every(g => g.signal!.aborted)).toBe(true);
    while (gates.length) open(gates[0].url);
    expect(await started).toBe(false);
    expect(sources(ctx)).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  it('an abort-rejecting fetcher is a quiet resolve, not an E_LOAD', async () => {
    const errors: { code: string }[] = [];
    const ctx = closeable();
    const player = createPlayer({
      catalog: catalog as never, baseUrl: '/audio/', contextFactory: () => asCtx(ctx) as AudioContext,
      fetcher: (url: string, init?: { signal: AbortSignal }) => new Promise((resolve, reject) => {
        if (url.endsWith('index.json')) { resolve({ ok: true, json: async () => catalog, arrayBuffer: async () => new ArrayBuffer(8) }); return; }
        init!.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      }),
      onError: e => errors.push(e),
    });
    await player.unlock();
    const started = player.music('calm');
    await settle();
    player.dispose();
    expect(await started).toBe(false);
    await settle();
    expect(errors).toEqual([]);
  });

  it('a prefetch waiting for a slot resolves 0 after dispose', async () => {
    const { player, gates, open, errors } = setup({ prefetchConcurrency: 1 }, { gated: ['calm.wav'] });
    await player.unlock();
    const done = player.prefetch(['calm', 'rain']);
    await settle();
    expect(gates).toHaveLength(1); // calm is in flight, rain waits for the single slot
    player.dispose();
    open('calm.wav'); // this fetcher ignores the signal; a real one would reject
    expect(await done).toBe(0);
    expect(errors).toEqual([]);
  });

  it('a pending catalog fetch is aborted and the catalog stays unloaded', async () => {
    const { player, gates, open, errors } = setup({ catalog: '/audio/index.json' }, { gated: ['index.json'] });
    const unlocking = player.unlock();
    await settle();
    expect(gates).toHaveLength(1);
    const signal = gates[0].signal!;
    player.dispose();
    expect(signal.aborted).toBe(true);
    open('index.json');
    expect(await unlocking).toBe(false);
    expect(errors).toEqual([]);
  });
});

describe('dispose: the AudioContext', () => {
  it('closes a context the player created itself', async () => {
    const ctx = closeable();
    const player = createPlayer({ catalog: catalog as never, contextFactory: () => asCtx(ctx) as AudioContext });
    await player.unlock();
    player.dispose();
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it('never closes a context passed in as opts.context, but still cuts its own nodes from it', async () => {
    const ctx = closeable();
    const player = createPlayer({ catalog: catalog as never, context: asCtx(ctx) as AudioContext });
    await player.unlock();
    await player.music('calm');
    player.dispose();
    expect(ctx.close).not.toHaveBeenCalled();
    expect(ctx.nodes('shaper')[0].disconnected).toBe(true);
    expect(sources(ctx).every(s => s.stoppedAt !== undefined)).toBe(true);
  });

  it('a context that rejects close() is not an unhandled rejection', async () => {
    const ctx = closeable();
    ctx.close = vi.fn(async () => { throw new Error('already closed'); });
    const player = createPlayer({ catalog: catalog as never, contextFactory: () => asCtx(ctx) as AudioContext });
    await player.unlock();
    expect(() => player.dispose()).not.toThrow();
    await settle();
  });

  it('is fine before unlock(): nothing was created, so nothing is closed', () => {
    const { ctx, player } = setup();
    expect(() => player.dispose()).not.toThrow();
    expect(ctx.close).not.toHaveBeenCalled();
  });
});

describe('dispose: after it', () => {
  it('calling it twice is a no-op', async () => {
    const { ctx, player } = setup();
    await player.unlock();
    player.dispose();
    expect(() => player.dispose()).not.toThrow();
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it('play, music, ambience, unlock, setState and prefetch are silent no-ops', async () => {
    const { ctx, player, errors } = setup();
    await player.unlock();
    player.dispose();
    const nodes = ctx.created.length;
    expect(player.play('coin')).toBeNull();
    expect(await player.music('calm')).toBe(false);
    expect(await player.ambience('rain')).toBe(false);
    expect(await player.ambience('rain', { slot: 'weather' })).toBe(false);
    expect(await player.unlock()).toBe(false);
    expect(player.setState('busy')).toBe(false);
    expect(await player.prefetch(['calm'])).toBe(0);
    player.setLevel('music', 0.5); player.duck('music', -6); player.setEnabled(true); player.setEnabled(false);
    player.setHidden(true); player.setHidden(false); player.stopAll(); player.retry();
    expect(player.unload('calm')).toBe(0);
    await settle();
    expect(ctx.created.length).toBe(nodes); // nothing was built
    expect(errors).toEqual([]);
    expect(player.inspect().running).toBe(false);
  });

  it('does not create a context when unlock() comes after dispose()', async () => {
    let made = 0;
    const player = createPlayer({ catalog: catalog as never, contextFactory: () => { made++; return asCtx(new FakeContext()) as AudioContext; } });
    player.dispose();
    expect(await player.unlock()).toBe(false);
    expect(made).toBe(0);
  });

  it('a request queued before unlock() is dropped, not started later', async () => {
    const { ctx, player } = setup();
    const queued = player.music('calm');
    player.dispose();
    expect(await queued).toBe(false);
    await player.unlock();
    expect(sources(ctx)).toHaveLength(0);
  });
});

describe('the fetcher option', () => {
  it('a one-argument fetcher still works, and a two-argument one receives { signal }', async () => {
    const urls: string[] = [];
    const ctx = closeable();
    const player = createPlayer({
      catalog: '/audio/index.json', contextFactory: () => asCtx(ctx) as AudioContext,
      fetcher: async (url: string) => { urls.push(url); return { ok: true, json: async () => catalog, arrayBuffer: async () => new ArrayBuffer(8) }; },
    });
    await player.unlock();
    expect(await player.music('calm')).toBe(true);
    expect(urls).toEqual(['/audio/index.json', '/audio/calm.wav']);
    player.dispose();
  });

  it('the default fetcher passes the signal to fetch', async () => {
    const seen: (RequestInit | undefined)[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push(init);
      return { ok: true, json: async () => catalog, arrayBuffer: async () => new ArrayBuffer(8) };
    }) as never;
    try {
      const ctx = closeable();
      const player = createPlayer({ catalog: '/audio/index.json', contextFactory: () => asCtx(ctx) as AudioContext });
      await player.unlock();
      expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
      player.dispose();
      expect(seen[0]!.signal!.aborted).toBe(true);
    } finally { globalThis.fetch = real; }
  });
});

describe('loader.dispose()', () => {
  it('aborts the signal the fetcher got and resolves later loads null without fetching', async () => {
    const urls: string[] = [];
    let signal: AbortSignal | undefined;
    const errors: string[] = [];
    const loader = createLoader({
      catalog: { assets: {} }, base: '/a/', report: c => errors.push(c), now: () => 0,
      fetcher: async (url: string, init?: { signal: AbortSignal }) => { urls.push(url); signal = init?.signal; return { ok: true, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(8) }; },
      decode: async () => ({ length: 10, numberOfChannels: 2 }) as unknown as AudioBuffer,
    });
    expect(await loader.load('a.wav')).not.toBeNull();
    expect(signal!.aborted).toBe(false);
    loader.dispose();
    expect(signal!.aborted).toBe(true);
    expect(await loader.load('b.wav')).toBeNull();
    expect(urls).toEqual(['/a/a.wav']);
    expect(errors).toEqual([]);
    expect(loader.memory().buffers).toBe(0);
    loader.dispose(); // twice is fine
  });
});
