// tests/player/loader.test.ts
import { describe, expect, it } from 'vitest';
import { CATALOG_RETRY_SEC, createLoader } from '../../runtime/player/loader.js';

const assets = { coin: { file: 'coin.wav' } };

function setup({ catalogOk = (): boolean => true, fileOk = (_: string): boolean => true } = {}) {
  const fetched: string[] = [];
  const errors: { code: string; id?: string }[] = [];
  let clock = 0;
  const loader = createLoader({
    catalog: '/audio/index.json',
    base: '/audio/',
    fetcher: async (url: string) => {
      fetched.push(url);
      const ok = url.endsWith('index.json') ? catalogOk() : fileOk(url);
      return { ok, json: async () => ({ assets }), arrayBuffer: async () => new ArrayBuffer(8) };
    },
    report: (code: string, _message: string, id?: string) => errors.push({ code, id }),
    now: () => clock,
    decode: async () => ({ duration: 1 }) as unknown as AudioBuffer,
  });
  return { loader, fetched, errors, tick: (sec: number) => { clock += sec; } };
}
const catalogFetches = (fetched: string[]) => fetched.filter(u => u.endsWith('index.json')).length;

describe('catalog loading', () => {
  it('uses an object catalog without fetching', async () => {
    const fetched: string[] = [];
    const loader = createLoader({
      catalog: { assets }, base: '', report: () => {}, now: () => 0,
      fetcher: async (url: string) => { fetched.push(url); throw new Error('unused'); },
      decode: async () => ({}) as AudioBuffer,
    });
    expect(await loader.catalog()).toEqual(assets);
    expect(loader.assets).toEqual(assets);
    expect(fetched).toEqual([]);
  });

  it('fetches a URL catalog once and caches it', async () => {
    const { loader, fetched } = setup();
    await Promise.all([loader.catalog(), loader.catalog()]);
    await loader.catalog();
    expect(catalogFetches(fetched)).toBe(1);
    expect(loader.assets).toEqual(assets);
  });

  it('reports a failed catalog once and resolves null', async () => {
    const { loader, errors } = setup({ catalogOk: () => false });
    expect(await loader.catalog()).toBeNull();
    expect(await loader.catalog()).toBeNull();
    expect(errors.filter(e => e.code === 'E_CATALOG')).toHaveLength(1);
    expect(loader.assets).toBeNull();
  });

  it('reports a catalog with no "assets" object as E_CATALOG, not an empty catalog', async () => {
    const errors: { code: string; id?: string }[] = [];
    const loader = createLoader({
      catalog: '/audio/index.json', base: '/audio/',
      fetcher: async () => ({ ok: true, json: async () => ({ schema: 'beeps/audio-bundle@1' }), arrayBuffer: async () => new ArrayBuffer(8) }),
      report: (code: string, _message: string, id?: string) => errors.push({ code, id }),
      now: () => 0,
      decode: async () => ({}) as unknown as AudioBuffer,
    });
    expect(await loader.catalog()).toBeNull();
    expect(errors).toEqual([{ code: 'E_CATALOG', id: '/audio/index.json' }]);
    expect(loader.assets).toBeNull();
  });

  it('throttles retryCatalog to one attempt per window, then recovers', async () => {
    let up = false;
    const { loader, fetched, tick } = setup({ catalogOk: () => up });
    await loader.catalog(); // fetch 1, fails
    for (let i = 0; i < 10; i++) { loader.retryCatalog(); await Promise.resolve(); }
    await new Promise(r => setTimeout(r, 0));
    expect(catalogFetches(fetched)).toBe(2); // the first retry is immediate; the rest wait
    up = true;
    tick(CATALOG_RETRY_SEC - 1);
    loader.retryCatalog();
    await new Promise(r => setTimeout(r, 0));
    expect(catalogFetches(fetched)).toBe(2);
    tick(1);
    loader.retryCatalog();
    await new Promise(r => setTimeout(r, 0));
    expect(catalogFetches(fetched)).toBe(3);
    expect(loader.assets).toEqual(assets);
  });
});

describe('buffer loading', () => {
  it('caches a decoded buffer and shares a load in flight', async () => {
    const { loader, fetched } = setup();
    const [a, b] = await Promise.all([loader.load('coin.wav'), loader.load('coin.wav')]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(await loader.load('coin.wav')).toBe(a);
    expect(fetched.filter(u => u === '/audio/coin.wav')).toHaveLength(1);
  });

  it('retries a failed file once, then stays silent', async () => {
    const { loader, fetched, errors } = setup({ fileOk: () => false });
    for (let i = 0; i < 3; i++) expect(await loader.load('coin.wav')).toBeNull();
    expect(fetched.filter(u => u === '/audio/coin.wav')).toHaveLength(2);
    expect(errors).toEqual([{ code: 'E_LOAD', id: 'coin.wav' }, { code: 'E_LOAD', id: 'coin.wav' }]);
  });

  it('a fetcher that throws synchronously still resolves null', async () => {
    const errors: string[] = [];
    const loader = createLoader({
      catalog: { assets }, base: '', now: () => 0, report: code => errors.push(code),
      fetcher: () => { throw new Error('sync'); },
      decode: async () => ({}) as AudioBuffer,
    });
    expect(await loader.load('x.wav')).toBeNull();
    expect(errors).toEqual(['E_LOAD']);
  });
});
