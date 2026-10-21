import { describe, expect, it } from 'vitest';
import { lazyRenderHost, withRenderHost, type RenderHost } from '../../src/render/host.ts';
import { BeepsError } from '../../src/errors.ts';
import { song } from '../helpers/songs.ts';

/** An opener that counts launches and hands back a fake host recording what it was asked and whether it was closed. */
function fakeOpener() {
  const state = { opens: 0, closes: 0, calls: [] as string[], page: { fake: 'page' }, url: 'http://fake' };
  const host = {
    page: state.page, url: state.url,
    async render() { state.calls.push('render'); return []; },
    async looks() { state.calls.push('looks'); return []; },
    async renderSong() { state.calls.push('renderSong'); return { id: 1, sampleRate: 48000, frames: 10, sections: [] }; },
    async pullSong() { state.calls.push('pullSong'); return []; },
    async songDiff() { state.calls.push('songDiff'); return { differing: 0, first: -1, maxAbs: 0, frames: 10 }; },
    async songLook() { state.calls.push('songLook'); return Buffer.alloc(0); },
    async songPcmLook() { state.calls.push('songPcmLook'); return Buffer.alloc(0); },
    async freeSong() { state.calls.push('freeSong'); },
    async close() { state.closes++; },
  } as unknown as RenderHost;
  return { state, open: async () => { state.opens++; return host; } };
}

describe('lazyRenderHost', () => {
  it('does not launch until a method is called, and close() without use launches nothing', async () => {
    const { state, open } = fakeOpener();
    const host = lazyRenderHost(open);
    expect(state.opens).toBe(0);
    await host.close();
    expect(state.opens).toBe(0);
    expect(state.closes).toBe(0);
  });

  it('opens once on first use, forwards every method to the real host, and closes it', async () => {
    const { state, open } = fakeOpener();
    const host = lazyRenderHost(open);
    await Promise.all([host.render([]), host.looks([]), host.renderSong(song(), {})]);
    await host.pullSong(1, 10);
    await host.songDiff(1, 2);
    await host.songLook(1, {}, 'x');
    await host.songPcmLook([], {}, 'x');
    await host.freeSong(1);
    expect(state.opens).toBe(1);
    expect(state.calls.sort()).toEqual(['freeSong', 'looks', 'pullSong', 'render', 'renderSong', 'songDiff', 'songLook', 'songPcmLook']);
    await host.close();
    expect(state.closes).toBe(1);
  });

  it('exposes page and url once opened and refuses them before', async () => {
    const { state, open } = fakeOpener();
    const host = lazyRenderHost(open);
    expect(() => host.page).toThrow(BeepsError);
    expect(() => host.url).toThrow(/before the first render call/);
    await host.render([]);
    expect(host.page).toBe(state.page);
    expect(host.url).toBe('http://fake');
  });

  it('close() after a failed launch does not throw, and the launch error reaches the caller', async () => {
    const host = lazyRenderHost(async () => { throw new BeepsError('E_BROWSER_MISSING', 'no chromium'); });
    await expect(host.render([])).rejects.toMatchObject({ code: 'E_BROWSER_MISSING' });
    await expect(host.close()).resolves.toBeUndefined();
  });
});

describe('withRenderHost', () => {
  it('launches nothing when fn never renders, and still closes cleanly', async () => {
    const { state, open } = fakeOpener();
    expect(await withRenderHost(async () => 'cached', { open })).toBe('cached');
    expect(state.opens).toBe(0);
  });

  it('opens on first render and closes the real host when fn finishes or throws', async () => {
    const { state, open } = fakeOpener();
    await withRenderHost(async h => { await h.render([]); }, { open });
    expect([state.opens, state.closes]).toEqual([1, 1]);
    await expect(withRenderHost(async h => { await h.render([]); throw new Error('boom'); }, { open })).rejects.toThrow('boom');
    expect([state.opens, state.closes]).toEqual([2, 2]);
  });

  it('keeps verifyDeterminism working on top of the lazy host: a song render opens it and renders twice', async () => {
    const { state, open } = fakeOpener();
    await withRenderHost(async h => { await h.renderSong(song(), {}); }, { open, verifyDeterminism: true });
    expect(state.opens).toBe(1);
    expect(state.calls).toEqual(['renderSong', 'renderSong', 'songDiff', 'freeSong']);
    const unverified = fakeOpener();
    await withRenderHost(async h => { await h.renderSong(song(), {}); }, { open: unverified.open });
    expect(unverified.state.calls).toEqual(['renderSong']);
  });
});
