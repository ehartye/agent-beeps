// `beeps ci export`: the vendored zero-dependency fetch.mjs materialises the audio from a store with only Node built-ins.
import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { chromiumAvailable } from '../../src/render/host.ts';
import { findFfmpeg } from '../../src/compress.ts';
import { runBuild } from '../../src/build/build.ts';
import { readLock } from '../../src/build/lock.ts';
import { DirStore, storeName } from '../../src/build/store.ts';
import { ciExport } from '../../src/build/store-ops.ts';
import { makeFixture, snapshot, type Fixture } from '../helpers/build-fixture.ts';

const hasFfmpeg = (() => { try { findFfmpeg(); return true; } catch { return false; } })();
const ok = (await chromiumAvailable()) && hasFfmpeg;

describe('fetch.mjs source', () => {
  it('imports only Node built-ins', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'runtime', 'ci', 'fetch.mjs'), 'utf8');
    const specs = [...src.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1]);
    expect(specs.length).toBeGreaterThan(2);
    for (const s of specs) expect(s, s).toMatch(/^node:/);
    expect(src).not.toMatch(/require\(|import\(/);
  });
});

describe('fetch.mjs against a release store (mocked GitHub)', () => {
  // Regression: the release index loads lazily, and the parallel workers all asked for it before the first load finished, so every
  // asset after the first looked "not in the store". A preload replaces fetch with a slow in-memory GitHub; no network, no ffmpeg.
  it('downloads every asset when the workers start together', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-fetch-release-'));
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const tar = (name: string, data: Buffer) => {
      const h = Buffer.alloc(512);
      h.write(name, 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
      h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257);
      let sum = 0; for (const b of h) sum += b;
      h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
      return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512), Buffer.alloc(1024)]);
    };
    const assets: Record<string, unknown> = {};
    const tars: Record<string, string> = {};
    for (let n = 0; n < 8; n++) {
      const data = Buffer.from(`asset-${n}`);
      const hash = sha(Buffer.from(`in${n}`));
      assets[`a${n}`] = { inputHash: `sha256:${hash}`, outputs: [{ file: `a${n}.ogg`, bytes: data.length, sha256: sha(data) }], role: 'sfx', source: `a${n}.json` };
      tars[`${hash}.tar`] = tar(`a${n}.ogg`, data).toString('base64');
    }
    mkdirSync(join(dir, 'tools'), { recursive: true });
    cpSync(join(import.meta.dirname, '..', '..', 'runtime', 'ci', 'fetch.mjs'), join(dir, 'tools', 'fetch.mjs'));
    writeFileSync(join(dir, 'lock.json'), JSON.stringify({ schema: 'beeps/build-lock@1', assets }));
    writeFileSync(join(dir, 'mock.mjs'), `
      const tars = ${JSON.stringify(tars)};
      const names = Object.keys(tars);
      const delay = () => new Promise((r) => setTimeout(r, 30));
      const json = (o) => new Response(JSON.stringify(o), { status: 200 });
      globalThis.fetch = async (url) => {
        await delay();
        const u = String(url);
        if (u.endsWith('/releases/tags/audio-store')) return json({ id: 7 });
        if (u.includes('/releases/tags/')) return new Response('{}', { status: 404 });
        if (u.includes('/releases/7/assets?')) return json(names.map((name, i) => ({ id: i + 1, name })));
        const m = u.match(/releases\\/assets\\/(\\d+)$/);
        if (m) return new Response(Buffer.from(tars[names[Number(m[1]) - 1]], 'base64'), { status: 200 });
        return new Response('{}', { status: 500 });
      };`);
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(dir, 'mock.mjs')).href, 'tools/fetch.mjs', '--lock', 'lock.json', '--out', 'out', '--store', 'release:o/r'], { cwd: dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, GITHUB_TOKEN: 't' } });
    const json = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(json, r.stderr).toMatchObject({ assets: 8, fetched: 8, missing: [] });
    expect(readdirSync(join(dir, 'out')).filter(n => n.endsWith('.ogg'))).toHaveLength(8);
  });
});

describe.skipIf(!ok)('fetch.mjs against a dir store', () => {
  let base: Fixture, store: string, scriptDir: string;
  beforeAll(async () => {
    base = makeFixture();
    store = join(mkdtempSync(join(tmpdir(), 'beeps-fetch-store-')), 'store');
    await runBuild(base.cfg(), { push: true, store: new DirStore(store) });
    scriptDir = base.path('tools/audio');
    const r = ciExport(base.cfg(), scriptDir, `dir:${store}`);
    expect(r.defaults).toEqual({ lock: '../../audio.lock.json', out: '../../public/audio', store: `dir:${store}` });
  }, 180000);

  /** A CI checkout: the lock and the script, nothing else (no sources, no beeps, no render cache). */
  const checkout = () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-ci-'));
    mkdirSync(join(dir, 'tools/audio'), { recursive: true });
    cpSync(join(scriptDir, 'fetch.mjs'), join(dir, 'tools/audio/fetch.mjs'));
    cpSync(base.path('audio.lock.json'), join(dir, 'audio.lock.json'));
    return dir;
  };
  const run = (cwd: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, ['tools/audio/fetch.mjs', ...args], { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, PATH: '' } });
    return { ...r, json: r.stdout.trim() ? JSON.parse(r.stdout.trim().split('\n').pop()!) : undefined };
  };

  it('materialises every output from the store and regenerates the catalog byte for byte', () => {
    const dir = checkout();
    const r = run(dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.json).toMatchObject({ ok: true, assets: 4, present: 0, fetched: 4, missing: [] });
    expect(snapshot(join(dir, 'public/audio'))).toEqual(snapshot(base.path('public/audio'))); // including index.json
    // Idempotent: a second run finds everything in place and downloads nothing.
    const again = run(dir);
    expect(again.json).toMatchObject({ ok: true, present: 4, fetched: 0 });
  });

  it('--check verifies without a store and fails on a missing or modified output', () => {
    const dir = checkout();
    expect(run(dir, '--check').status).toBe(1);
    expect(run(dir).status).toBe(0);
    expect(run(dir, '--check').status).toBe(0);
    writeFileSync(join(dir, 'public/audio/coin.0.ogg'), 'x');
    const r = run(dir, '--check');
    expect(r.status).toBe(1);
    expect(r.json.problems[0]).toMatch(/coin/);
  });

  it('names the assets the store lacks and fails', () => {
    const dir = checkout();
    const partial = join(mkdtempSync(join(tmpdir(), 'beeps-fetch-partial-')), 'store');
    cpSync(store, partial, { recursive: true });
    const lock = readLock(join(dir, 'audio.lock.json'))!;
    rmSync(join(partial, storeName(lock.assets.coin.inputHash)));
    const r = run(dir, '--store', `dir:${partial}`);
    expect(r.status).toBe(1);
    expect(r.json.missing[0]).toMatch(/^coin /);
    expect(r.stderr).toMatch(/not in the store.*coin/s);
    expect(existsSync(join(dir, 'public/audio/blip.0.ogg'))).toBe(true); // the rest was still fetched
    expect(existsSync(join(dir, 'public/audio/index.json'))).toBe(false); // but no catalog for an incomplete set
  });

  it('rejects a store entry that does not match the lock, and writes nothing of it', () => {
    const dir = checkout();
    const bad = join(mkdtempSync(join(tmpdir(), 'beeps-fetch-bad-')), 'store');
    cpSync(store, bad, { recursive: true });
    const lock = readLock(join(dir, 'audio.lock.json'))!;
    const f = join(bad, storeName(lock.assets.blip.inputHash));
    const buf = readFileSync(f);
    buf[buf.length - 1500] ^= 0xff;
    writeFileSync(f, buf);
    const r = run(dir, '--store', `dir:${bad}`);
    expect(r.status).toBe(1);
    expect(r.json.problems.join()).toMatch(/blip.*does not match the lock/);
    expect(readdirSync(join(dir, 'public/audio')).some(n => n.startsWith('blip'))).toBe(false);
  });

  it('refuses a store entry that is valid but is not what the lock asks for', () => {
    const dir = checkout();
    const swapped = join(mkdtempSync(join(tmpdir(), 'beeps-fetch-swap-')), 'store');
    cpSync(store, swapped, { recursive: true });
    const lock = readLock(join(dir, 'audio.lock.json'))!;
    // coin's entry stored under blip's name: the files are intact but the lock's hashes do not match.
    rmSync(join(swapped, storeName(lock.assets.blip.inputHash)));
    cpSync(join(store, storeName(lock.assets.coin.inputHash)), join(swapped, storeName(lock.assets.blip.inputHash)));
    const r = run(dir, '--store', `dir:${swapped}`, '--only', 'blip');
    expect(r.status).toBe(1);
    expect(r.json.problems.join()).toMatch(/blip/);
  });
});
