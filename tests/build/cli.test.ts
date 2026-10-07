// The command line: build, build --check, verify, store, ci export, with real exit codes and the JSON error shape.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromiumAvailable } from '../../src/render/host.ts';
import { findFfmpeg } from '../../src/compress.ts';
import { makeFixture } from '../helpers/build-fixture.ts';

const hasFfmpeg = (() => { try { findFfmpeg(); return true; } catch { return false; } })();
const ok = (await chromiumAvailable()) && hasFfmpeg;
const bin = join(import.meta.dirname, '..', '..', 'scripts', 'beeps.mjs');
const beeps = (cwd: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  const parse = (s: string) => { try { return JSON.parse(s.trim().split('\n').pop()!); } catch { return undefined; } };
  return { status: r.status, out: parse(r.stdout), err: parse(r.stderr)?.error, stderr: r.stderr };
};

describe('beeps build usage errors', () => {
  it('needs a config, and rejects an unknown target or store', () => {
    const empty = mkdtempSync(join(tmpdir(), 'beeps-cli-'));
    const r = beeps(empty, 'build');
    expect(r.status).toBe(1);
    expect(r.err.code).toBe('E_NOT_FOUND');
    expect(r.err.message).toMatch(/beeps\.build\.json/);
    const fx = makeFixture();
    expect(beeps(fx.dir, 'build', '--check', '--target', 'nope').err.code).toBe('E_USAGE');
    expect(beeps(fx.dir, 'build', '--pull').err.code).toBe('E_USAGE');
    expect(beeps(fx.dir, 'store', 'push', '--store', 's3:x').err.code).toBe('E_USAGE');
    expect(beeps(fx.dir, 'build', '--check', '--project', fx.dir, '--config', join(fx.dir, 'missing.json')).err.code).toBe('E_NOT_FOUND');
  });
  it('rejects a malformed config with a pointer', () => {
    const fx = makeFixture();
    writeFileSync(fx.path('beeps.build.json'), JSON.stringify({ recipes: 'recipes.json' }));
    const r = beeps(fx.dir, 'build', '--check');
    expect(r.err).toMatchObject({ code: 'E_SCHEMA', pointer: '/out' });
  });
});

describe.skipIf(!ok)('beeps build over the CLI', () => {
  it('check fails before the first build and passes after; verify, store and ci export work', () => {
    const fx = makeFixture();
    const store = join(mkdtempSync(join(tmpdir(), 'beeps-cli-store-')), 'store');

    const stale = beeps(fx.dir, 'build', '--check');
    expect(stale.status).toBe(1);
    expect(stale.out.ok).toBe(false);
    expect(stale.out.stale.map((s: any) => s.id)).toEqual(['blip', 'coin', 'plain', 'theme']);
    expect(existsSync(fx.path('audio.lock.json'))).toBe(false);

    const built = beeps(fx.dir, 'build', '--store', `dir:${store}`, '--push');
    expect(built.status, built.stderr).toBe(0);
    expect(built.out).toMatchObject({ ok: true, built: expect.any(Array), pushed: expect.any(Array) });
    expect(built.out.built.length).toBe(4);

    expect(beeps(fx.dir, 'build', '--check').status).toBe(0);
    const again = beeps(fx.dir, 'build');
    expect(again.out).toMatchObject({ built: [], catalogWritten: false });

    // verify: by config, by directory, by lock file
    expect(beeps(fx.dir, 'verify').out).toMatchObject({ ok: true, assets: 4 });
    expect(beeps(fx.dir, 'verify', fx.path('public/audio'), '--lock', fx.path('audio.lock.json')).status).toBe(0);
    expect(beeps(fx.dir, 'verify', fx.path('audio.lock.json'), '--out', fx.path('public/audio'), '--decode').status).toBe(0);
    writeFileSync(fx.path('public/audio/coin.0.ogg'), 'x');
    const bad = beeps(fx.dir, 'verify');
    expect(bad.status).toBe(1);
    expect(bad.out.problems[0]).toMatchObject({ asset: 'coin', file: 'coin.0.ogg' });
    rmSync(fx.path('public/audio/coin.0.ogg'));

    // store status / pull / push
    expect(beeps(fx.dir, 'store', 'status', '--store', `dir:${store}`).out).toMatchObject({ assets: 4, localOk: 3, inStore: 4 });
    const pull = beeps(fx.dir, 'store', 'pull', '--store', `dir:${store}`);
    expect(pull.out).toMatchObject({ ok: true, pulled: ['coin'] });
    expect(beeps(fx.dir, 'verify').status).toBe(0);
    expect(beeps(fx.dir, 'store', 'push', '--store', `dir:${store}`).out).toMatchObject({ ok: true, pushed: [] });

    // ci export
    const ci = beeps(fx.dir, 'ci', 'export', 'tools/audio', '--store', `dir:${store}`);
    expect(ci.status).toBe(0);
    expect(existsSync(fx.path('tools/audio/fetch.mjs'))).toBe(true);
    const fetched = spawnSync(process.execPath, [fx.path('tools/audio/fetch.mjs'), '--check'], { encoding: 'utf8' });
    expect(fetched.status).toBe(0);
  }, 180000);
});
