// The content-addressed store: dir and release backends, build --push/--pull, immutability, sha verification.
import { beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromiumAvailable } from '../../src/render/host.ts';
import { findFfmpeg } from '../../src/compress.ts';
import { runBuild } from '../../src/build/build.ts';
import { readLock } from '../../src/build/lock.ts';
import { DirStore, ReleaseStore, openStore, packAsset, sha256Hex, storeName, unpackAsset, type Fetch, type HttpResponse } from '../../src/build/store.ts';
import { createTar, readTar } from '../../src/build/tar.ts';
import { storePull, storePush, storeStatus } from '../../src/build/store-ops.ts';
import { verifyOutputs } from '../../src/build/verify.ts';
import { cloneFixture, makeFixture, snapshot, type Fixture } from '../helpers/build-fixture.ts';

const hasFfmpeg = (() => { try { findFfmpeg(); return true; } catch { return false; } })();
const ok = (await chromiumAvailable()) && hasFfmpeg;
const tmp = () => mkdtempSync(join(tmpdir(), 'beeps-store-'));

describe('tar', () => {
  it('round-trips flat files deterministically', () => {
    const entries = [{ name: 'a.ogg', data: Buffer.from('hello') }, { name: 'b.json', data: Buffer.alloc(1000, 7) }, { name: 'empty', data: Buffer.alloc(0) }];
    const tar = createTar(entries);
    expect(tar.length % 512).toBe(0);
    expect(createTar(entries).equals(tar)).toBe(true);
    expect(readTar(tar).map(e => [e.name, e.data.length])).toEqual([['a.ogg', 5], ['b.json', 1000], ['empty', 0]]);
    expect(readTar(tar)[1].data.equals(entries[1].data)).toBe(true);
  });
  it('refuses paths that could leave the output directory, and corrupt headers', () => {
    for (const name of ['../x', 'a/b', 'a\\b', 'C:x']) expect(() => readTar(createTar([{ name, data: Buffer.from('x') }]))).toThrow(/flat file name/);
    const tar = createTar([{ name: 'a', data: Buffer.from('x') }]);
    tar[10] ^= 0xff;
    expect(() => readTar(tar)).toThrow(/corrupt tar header/);
    expect(() => readTar(createTar([{ name: 'a', data: Buffer.alloc(2000) }]).subarray(0, 800))).toThrow(/truncated/);
  });
});

describe('store entries', () => {
  const data = Buffer.from('opus bytes');
  const outputs = [{ file: 'x.ogg', sha256: sha256Hex(data), bytes: data.length }];
  const hash = 'sha256:' + 'ab'.repeat(32);
  it('are named by the input hash and verify every file against their manifest', () => {
    expect(storeName(hash)).toBe('ab'.repeat(32) + '.tar');
    const tar = packAsset('x', hash, outputs, () => data);
    expect(unpackAsset(tar, { inputHash: hash, outputs }).files.get('x.ogg')!.equals(data)).toBe(true);
    // A flipped byte in the payload is rejected.
    const bad = Buffer.from(tar);
    bad[bad.indexOf(data)] ^= 1;
    expect(() => unpackAsset(bad)).toThrow(/does not match its manifest/);
    // An entry for another hash, or with a file the lock does not expect, is rejected.
    expect(() => unpackAsset(tar, { inputHash: 'sha256:' + 'cd'.repeat(32) })).toThrow(/is for/);
    expect(() => unpackAsset(tar, { inputHash: hash, outputs: [{ ...outputs[0], sha256: '0'.repeat(64) }] })).toThrow(/not the file the lock expects/);
  });
});

describe('dir store', () => {
  it('is immutable: the first writer wins and the entry is never replaced', async () => {
    const s = new DirStore(join(tmp(), 'store'));
    expect(await s.has('a.tar')).toBe(false);
    expect(await s.get('a.tar')).toBeUndefined();
    expect(await s.put('a.tar', Buffer.from('first'))).toBe('stored');
    expect(await s.put('a.tar', Buffer.from('second'))).toBe('exists');
    expect((await s.get('a.tar'))!.toString()).toBe('first');
    expect(s.names()).toEqual(['a.tar']); // no temp files left behind
    // Two writers at once: exactly one stores.
    const r = await Promise.all([s.put('b.tar', Buffer.from('x')), s.put('b.tar', Buffer.from('y'))]);
    expect(r.filter(x => x === 'stored').length).toBe(1);
  });
  it('parses store specs', () => {
    expect(openStore('dir:x', { base: tmp() })).toBeInstanceOf(DirStore);
    expect(openStore('release:o/r@tag', { token: 't' })).toBeInstanceOf(ReleaseStore);
    expect(() => openStore('s3:bucket')).toThrow(/unknown store/);
  });
});

/** A fake GitHub: releases by tag, assets, uploads, public download URLs. */
function fakeGithub(o: { maxPerRelease?: number } = {}) {
  type Rel = { id: number; tag: string; assets: { id: number; name: string; data: Buffer }[] };
  const releases: Rel[] = [];
  const calls: { method: string; url: string; auth?: string }[] = [];
  let next = 1;
  const res = (status: number, body: unknown, raw?: Buffer): HttpResponse => ({
    status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body),
    arrayBuffer: async () => { const b = raw ?? Buffer.alloc(0); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; },
  });
  const asset = (r: Rel, a: Rel['assets'][number]) => ({ id: a.id, name: a.name, size: a.data.length, browser_download_url: `https://github.com/o/r/releases/download/${r.tag}/${a.name}` });
  const fetch: Fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, auth: init.headers?.authorization });
    const u = new URL(url);
    let m;
    if (u.hostname === 'github.com' && (m = u.pathname.match(/^\/o\/r\/releases\/download\/([^/]+)\/(.+)$/))) {
      const a = releases.find(r => r.tag === m![1])?.assets.find(x => x.name === m![2]);
      return a ? res(200, {}, a.data) : res(404, {});
    }
    if ((m = u.pathname.match(/^\/repos\/o\/r\/releases\/tags\/(.+)$/))) {
      const r = releases.find(x => x.tag === m![1]);
      return r ? res(200, { id: r.id }) : res(404, {});
    }
    if ((m = u.pathname.match(/^\/repos\/o\/r\/releases\/(\d+)\/assets$/)) && method === 'GET') {
      const r = releases.find(x => x.id === Number(m![1]))!;
      const page = Number(u.searchParams.get('page')), per = Number(u.searchParams.get('per_page'));
      return res(200, r.assets.slice((page - 1) * per, page * per).map(a => asset(r, a)));
    }
    if ((m = u.pathname.match(/^\/repos\/o\/r\/releases\/assets\/(\d+)$/))) {
      for (const r of releases) { const a = r.assets.find(x => x.id === Number(m![1])); if (a) return res(200, {}, a.data); }
      return res(404, {});
    }
    if (u.pathname === '/repos/o/r/releases' && method === 'POST') {
      const body = JSON.parse(init.body!.toString());
      if (releases.some(x => x.tag === body.tag_name)) return res(422, { message: 'already_exists' });
      const r: Rel = { id: next++, tag: body.tag_name, assets: [] };
      releases.push(r);
      return res(201, { id: r.id });
    }
    if (u.hostname === 'uploads.github.com' && (m = u.pathname.match(/^\/repos\/o\/r\/releases\/(\d+)\/assets$/))) {
      const r = releases.find(x => x.id === Number(m![1]))!;
      const name = u.searchParams.get('name')!;
      if (r.assets.some(a => a.name === name)) return res(422, { message: 'already_exists' });
      if (o.maxPerRelease && r.assets.length >= o.maxPerRelease) return res(422, { message: 'too many assets' });
      const a = { id: next++, name, data: Buffer.from(init.body!) };
      r.assets.push(a);
      return res(201, asset(r, a));
    }
    return res(404, { message: `unhandled ${method} ${url}` });
  };
  return { fetch, releases, calls };
}

describe('release store (mocked GitHub)', () => {
  const entry = (n: number) => Buffer.from(`entry-${n}`);

  it('stores, finds and downloads assets named by hash, with a public download and no token for reads', async () => {
    const gh = fakeGithub();
    const w = new ReleaseStore({ repo: 'o/r', token: 'tok', fetch: gh.fetch });
    expect(await w.put('a.tar', entry(1))).toBe('stored');
    expect(gh.releases.map(r => r.tag)).toEqual(['audio-store']);
    expect(await w.put('a.tar', entry(2))).toBe('exists');
    const reader = new ReleaseStore({ repo: 'o/r', fetch: gh.fetch }); // no token: a public store
    expect(await reader.has('a.tar')).toBe(true);
    expect(await reader.has('zz.tar')).toBe(false);
    const before = gh.calls.length;
    expect((await reader.get('a.tar'))!.equals(entry(1))).toBe(true);
    expect(await reader.get('zz.tar')).toBeUndefined();
    const download = gh.calls.slice(before).find(c => c.url.startsWith('https://github.com/'))!;
    expect(download.auth).toBeUndefined();
  });

  it('spills to numbered releases when one is full (1000 assets per release; 2 here)', async () => {
    const gh = fakeGithub();
    const s = new ReleaseStore({ repo: 'o/r', token: 'tok', fetch: gh.fetch, maxAssets: 2 });
    for (let i = 0; i < 5; i++) expect(await s.put(`e${i}.tar`, entry(i))).toBe('stored');
    expect(gh.releases.map(r => [r.tag, r.assets.length])).toEqual([['audio-store', 2], ['audio-store-1', 2], ['audio-store-2', 1]]);
    // A fresh reader finds assets in every release of the chain; an existing name is never uploaded again.
    const r = new ReleaseStore({ repo: 'o/r', token: 'tok', fetch: gh.fetch, maxAssets: 2 });
    for (let i = 0; i < 5; i++) expect((await r.get(`e${i}.tar`))!.equals(entry(i))).toBe(true);
    expect(await r.put('e3.tar', entry(99))).toBe('exists');
    expect(gh.releases.flatMap(x => x.assets).length).toBe(5);
    // A custom tag is the base of the chain.
    const t = new ReleaseStore({ repo: 'o/r', tag: 'fv-audio', token: 'tok', fetch: gh.fetch, maxAssets: 1 });
    await t.put('x.tar', entry(1)); await t.put('y.tar', entry(2));
    expect(gh.releases.map(x => x.tag).slice(3)).toEqual(['fv-audio', 'fv-audio-1']);
  });

  it('pages through more than 100 assets when listing', async () => {
    const gh = fakeGithub();
    const w = new ReleaseStore({ repo: 'o/r', token: 'tok', fetch: gh.fetch });
    await w.put('first.tar', entry(0));
    for (let i = 1; i < 130; i++) gh.releases[0].assets.push({ id: 1000 + i, name: `p${i}.tar`, data: entry(i) });
    const r = new ReleaseStore({ repo: 'o/r', fetch: gh.fetch });
    expect(await r.has('p129.tar')).toBe(true);
    expect((await r.get('p129.tar'))!.equals(entry(129))).toBe(true);
  });

  it('enforces the asset size limit and needs a token to write', async () => {
    const gh = fakeGithub();
    const small = new ReleaseStore({ repo: 'o/r', token: 'tok', fetch: gh.fetch, maxBytes: 10 });
    await expect(small.put('big.tar', Buffer.alloc(11))).rejects.toThrow(/limited to 10/);
    expect(gh.releases.length).toBe(0);
    await expect(new ReleaseStore({ repo: 'o/r', fetch: gh.fetch }).put('a.tar', entry(1))).rejects.toMatchObject({ code: 'E_STORE' });
  });

  it('treats an upload race (422 already exists) as the first writer winning', async () => {
    const gh = fakeGithub();
    const a = new ReleaseStore({ repo: 'o/r', token: 'tok', fetch: gh.fetch });
    const b = new ReleaseStore({ repo: 'o/r', token: 'tok', fetch: gh.fetch });
    await a.has('x.tar'); await b.has('x.tar'); // both load an empty chain
    await a.put('x.tar', entry(1));
    expect(await b.put('x.tar', entry(2))).toBe('exists');
    expect(gh.releases.flatMap(r => r.assets).map(x => x.data.toString())).toEqual(['entry-1']);
  });

  it('rejects an entry whose bytes do not match (a corrupted or poisoned asset)', async () => {
    const gh = fakeGithub();
    const data = Buffer.from('opus bytes'), outputs = [{ file: 'x.ogg', sha256: sha256Hex(data), bytes: data.length }];
    const hash = 'sha256:' + 'ab'.repeat(32);
    const w = new ReleaseStore({ repo: 'o/r', token: 'tok', fetch: gh.fetch });
    const tar = packAsset('x', hash, outputs, () => data);
    await w.put(storeName(hash), tar);
    gh.releases[0].assets[0].data[gh.releases[0].assets[0].data.indexOf(data)] ^= 1; // flip a payload bit on the server
    const got = (await new ReleaseStore({ repo: 'o/r', fetch: gh.fetch }).get(storeName(hash)))!;
    expect(() => unpackAsset(got, { inputHash: hash, outputs })).toThrow(/does not match its manifest/);
  });
});

describe.skipIf(!ok)('build --push / --pull and store push/pull/status (dir store)', () => {
  let base: Fixture, store: string;
  beforeAll(async () => {
    base = makeFixture();
    store = join(tmp(), 'store');
    const r = await runBuild(base.cfg(), { push: true, store: new DirStore(store) });
    expect(r.pushed.sort()).toEqual(['blip', 'coin', 'plain', 'theme']);
  }, 180000);

  it('publishes one tar per recipe, named by its input hash', () => {
    const lock = readLock(base.path('audio.lock.json'))!;
    expect(readdirSync(store).sort()).toEqual(Object.values(lock.assets).map(a => storeName(a.inputHash)).sort());
  });

  it('a clean checkout pulls everything by hash before rendering anything', async () => {
    // Only the sources and the lock: no outputs, no render cache.
    const fx = makeFixture({ workDir: '.fresh' });
    cpSync(base.path('audio.lock.json'), fx.path('audio.lock.json'));
    const r = await runBuild(fx.cfg(), { pull: true, store: new DirStore(store) });
    expect(r.pulled.sort()).toEqual(['blip', 'coin', 'plain', 'theme']);
    expect(r.built).toEqual([]);
    expect(existsSync(fx.path('.fresh/.agent-beeps/renders'))).toBe(false); // nothing was rendered
    expect(snapshot(fx.path('public/audio'))).toEqual(snapshot(base.path('public/audio')));
    expect(readFileSync(fx.path('audio.lock.json'), 'utf8')).toBe(readFileSync(base.path('audio.lock.json'), 'utf8'));
    expect(verifyOutputs({ lock: fx.path('audio.lock.json'), out: fx.path('public/audio') }).problems).toEqual([]);
  }, 60000);

  it('pulls only what is stale and renders the rest', async () => {
    const fx = cloneFixture(base);
    rmSync(fx.path('public/audio/coin.0.ogg'));
    fx.write('sfx/blip.json', { ...fx.read('sfx/blip.json'), duration: 0.25 }); // not in the store: must render
    const r = await runBuild(fx.cfg(), { pull: true, store: new DirStore(store) });
    expect(r.pulled).toEqual(['coin']);
    expect(r.built).toEqual(['blip']);
  }, 60000);

  it('rejects a corrupted store entry and writes nothing', async () => {
    const bad = join(tmp(), 'bad');
    cpSync(store, bad, { recursive: true });
    const lock = readLock(base.path('audio.lock.json'))!;
    const f = join(bad, storeName(lock.assets.coin.inputHash));
    const buf = readFileSync(f);
    buf[buf.length - 2000] ^= 0xff; // inside a payload
    writeFileSync(f, buf);
    const fx = makeFixture({ workDir: '.fresh' });
    cpSync(base.path('audio.lock.json'), fx.path('audio.lock.json'));
    await expect(runBuild(fx.cfg(), { pull: true, store: new DirStore(bad), only: ['coin'] })).rejects.toMatchObject({ code: 'E_STORE' });
    expect(existsSync(fx.path('public/audio/coin.0.ogg'))).toBe(false);
  }, 60000);

  it('store pull verifies against the lock; store status says what is where; store push is idempotent', async () => {
    const fx = cloneFixture(base);
    rmSync(fx.path('public/audio'), { recursive: true });
    const s = new DirStore(store);
    const before = await storeStatus(fx.cfg(), s);
    expect(before).toMatchObject({ assets: 4, localOk: 0, inStore: 4, missingFromStore: [] });
    const r = await storePull(fx.cfg(), s);
    expect(r).toMatchObject({ ok: true, missing: [], problems: [] });
    expect(r.pulled.length).toBe(4);
    expect(snapshot(fx.path('public/audio'))).toEqual(snapshot(base.path('public/audio'))); // index.json included
    expect(await storeStatus(fx.cfg(), s)).toMatchObject({ localOk: 4, notBuilt: [] });
    const p = await storePush(fx.cfg(), s);
    expect(p).toMatchObject({ ok: true, pushed: [] });
    expect(p.existing.length).toBe(4);
    // A lock that names an asset the store lacks is reported, not invented.
    const empty = new DirStore(join(tmp(), 'empty'));
    rmSync(fx.path('public/audio'), { recursive: true });
    const miss = await storePull(fx.cfg(), empty);
    expect(miss.ok).toBe(false);
    expect(miss.missing.sort()).toEqual(['blip', 'coin', 'plain', 'theme']);
    // Pushing something that is not built refuses it.
    const nb = await storePush(fx.cfg(), empty);
    expect(nb.ok).toBe(false);
    expect(nb.skipped.length).toBe(4);
  }, 60000);

  it('build --push publishes what a plain build produced, to a release store (mocked)', async () => {
    const gh = fakeGithub();
    const fx = cloneFixture(base);
    const store = new ReleaseStore({ repo: 'o/r', token: 'tok', fetch: gh.fetch, maxAssets: 3 });
    const p = await storePush(fx.cfg(), store);
    expect(p.pushed.length).toBe(4);
    expect(gh.releases.map(r => r.assets.length)).toEqual([3, 1]);
    const dir = mkdtempSync(join(tmpdir(), 'beeps-rel-'));
    mkdirSync(dir, { recursive: true });
    const fresh = makeFixture({ workDir: '.fresh' });
    cpSync(base.path('audio.lock.json'), fresh.path('audio.lock.json'));
    const r = await runBuild(fresh.cfg(), { pull: true, store: new ReleaseStore({ repo: 'o/r', fetch: gh.fetch }) });
    expect(r.pulled.length).toBe(4);
    expect(snapshot(fresh.path('public/audio'))).toEqual(snapshot(base.path('public/audio')));
  }, 60000);
});
