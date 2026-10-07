// `beeps ci export`: the vendored zero-dependency fetch.mjs materialises the audio from a store with only Node built-ins.
import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
