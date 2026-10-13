// `beeps build` end to end on a tiny project: incremental, minimal-diff, atomic, check, adopt.
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromiumAvailable, openRenderHost } from '../../src/render/host.ts';
import { findFfmpeg } from '../../src/compress.ts';
import { openBuildProject, runBuild } from '../../src/build/build.ts';
import { lockText, readLock } from '../../src/build/lock.ts';
import { SONG_PIPELINE_VERSION } from '../../src/render/song-pipeline.ts';
import { verifyOutputs } from '../../src/build/verify.ts';
import { cloneFixture, diffKeys, makeFixture, snapshot, type Fixture } from '../helpers/build-fixture.ts';
import { exportPatchOne } from '../../src/export-assets.ts';
import { loadPatch } from '../../src/project.ts';
import { pcm16 } from '../../src/audio/post.ts';

const hasFfmpeg = (() => { try { findFfmpeg(); return true; } catch { return false; } })();
const hasChromium = await chromiumAvailable();
const ok = hasChromium && hasFfmpeg;

describe.skipIf(!hasChromium)('patch build post options', () => {
  it('matches direct export samples, length and channels, then refuses changed or corrupt outputs', async () => {
    const fx = makeFixture({ config: { target: 'wav-master', jobs: 1 } });
    const recipe = { source: 'sfx/coin.json', role: 'sfx', seed: 47, variants: 1, channels: 1, trimTail: -60 };
    fx.write('recipes.json', { coin: recipe });
    const cfg = fx.cfg(), p = openBuildProject(cfg), host = await openRenderHost();
    try {
      // Render once through the direct owner; build reuses that raw render cache.
      const direct = await exportPatchOne(host, p, loadPatch(p, fx.path('sfx/coin.json')), { dest: fx.path('direct/coin.wav'), seed: 47, variant: 0, role: 'sfx', manifest: true, post: { channels: 1, trimTailDb: -60 } });
      const original = pcm16(readFileSync(direct.rendered.wavPath));
      const expected = pcm16(readFileSync(fx.path('direct/coin.wav')));
      expect(original.channels).toHaveLength(2);
      expect(expected.channels).toHaveLength(1);
      expect(expected.channels[0].length).toBeLessThan(original.channels[0].length);
      const cached = snapshot(p.paths.renders);
      expect(Object.keys(cached).length).toBeGreaterThan(0);
      expect((await runBuild(cfg)).built).toEqual(['coin']);
      const built = pcm16(readFileSync(fx.path('public/audio/coin.0.wav')));
      expect(built.sampleRate).toBe(expected.sampleRate);
      expect(built.channels).toHaveLength(expected.channels.length);
      expect(built.channels[0]).toHaveLength(expected.channels[0].length);
      expect(built.channels).toEqual(expected.channels);
      expect(snapshot(p.paths.renders)).toEqual(cached);
      // The direct path has no variant suffix; both sidecars keep the authored id.
      const directSide = fx.read('direct/coin.wav.json'), builtSide = fx.read('public/audio/coin.wav.json');
      expect(directSide).toMatchObject({ id: 'coin', file: 'coin.wav', channels: 1, frames: expected.channels[0].length });
      expect(builtSide).toMatchObject({ id: 'coin', file: 'coin.0.wav', channels: 1, frames: expected.channels[0].length, renderKey: directSide.renderKey });
      expect(verifyOutputs({ lock: cfg.lock, out: cfg.out })).toMatchObject({ ok: true, problems: [] });
      const before = snapshot(fx.dir), files = Object.keys(before).map(f => fx.path(f)), mtimes = files.map(f => statSync(f).mtimeMs);
      expect((await runBuild(cfg, { check: true })).ok).toBe(true);
      expect((await runBuild(cfg)).built).toEqual([]);
      expect(snapshot(fx.dir)).toEqual(before);
      expect(files.map(f => statSync(f).mtimeMs)).toEqual(mtimes);

      fx.write('recipes.json', { coin: { ...recipe, trimTail: -50 } });
      expect((await runBuild(cfg, { check: true })).stale).toEqual([{ id: 'coin', reasons: [expect.stringMatching(/^inputs changed \(export\):/)] }]);
      expect(snapshot(fx.path('public/audio'))).toEqual(Object.fromEntries(Object.entries(before).filter(([f]) => f.startsWith('public/audio/')).map(([f, hash]) => [f.slice('public/audio/'.length), hash])));
      fx.write('recipes.json', { coin: recipe });
      const wav = fx.path('public/audio/coin.0.wav'), corrupt = readFileSync(wav);
      corrupt[44] ^= 1; // same size: the lock must check actual bytes.
      writeFileSync(wav, corrupt);
      const verification = verifyOutputs({ lock: cfg.lock, out: cfg.out });
      expect(verification.ok).toBe(false);
      expect(verification.problems).toEqual(expect.arrayContaining([expect.objectContaining({ asset: 'coin', file: 'coin.0.wav', problem: expect.stringMatching(/sha256/) })]));
      expect((await runBuild(cfg, { check: true })).stale[0].reasons).toContain('output modified: coin.0.wav');
    } finally {
      await host.close();
      rmSync(fx.dir, { recursive: true, force: true });
    }
  }, 60000);
});

describe.skipIf(!ok)('beeps build', () => {
  let base: Fixture;
  const baseLock = () => readLock(join(base.dir, 'audio.lock.json'))!;
  beforeAll(async () => {
    base = makeFixture();
    const r = await runBuild(base.cfg());
    expect(r.built.sort()).toEqual(['blip', 'coin', 'plain', 'theme']);
  }, 180000);

  it('writes outputs, a lock, and a catalog that verify', () => {
    const lock = baseLock();
    expect(Object.keys(lock.assets)).toEqual(['blip', 'coin', 'plain', 'theme']);
    expect(lock.assets.theme.outputs.map(o => o.file)).toEqual(['theme.bed.ogg', 'theme.ogg', 'theme.ogg.json', 'theme.pulse.ogg']);
    expect(lock.assets.coin.outputs.every(o => /^[0-9a-f]{64}$/.test(o.sha256) && o.bytes > 0)).toBe(true);
    expect(lock.delivery).toMatchObject({ preset: 'web-universal', format: 'opus', kbps: { music: 44, ambience: 48, sfx: 72, mix: 24 } });
    const r = verifyOutputs({ lock: base.path('audio.lock.json'), out: base.path('public/audio'), decode: true });
    expect(r.problems).toEqual([]);
    expect(r.checkedStatic).toBeGreaterThan(5);
    const side = base.read('public/audio/theme.ogg.json');
    expect(side.frames).toBe(Math.round(side.durationSec * side.sampleRate));
    expect(side.encoding.lead).toBeGreaterThan(0);
  });

  it('is byte-deterministic: the lock is sorted, has no timestamps, and re-encoding everything reproduces it', async () => {
    const fx = cloneFixture(base);
    const text = readFileSync(fx.path('audio.lock.json'), 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T|"time|"date|"generated/i);
    expect(lockText(readLock(fx.path('audio.lock.json'))!)).toBe(text);
    const before = snapshot(fx.path('public/audio'));
    const r = await runBuild(fx.cfg(), { all: true });
    expect(r.built.length).toBe(4);
    expect(readFileSync(fx.path('audio.lock.json'), 'utf8')).toBe(text); // renders from the cache, Opus encode deterministic
    expect(snapshot(fx.path('public/audio'))).toEqual(before);
  }, 120000);

  it('a build with nothing changed renders nothing and touches nothing', async () => {
    const fx = cloneFixture(base);
    const files = ['audio.lock.json', 'public/audio/index.json', 'public/audio/coin.0.ogg', 'public/audio/theme.ogg'].map(f => fx.path(f));
    const mtimes = files.map(f => statSync(f).mtimeMs);
    const t = Date.now();
    const r = await runBuild(fx.cfg());
    expect(r).toMatchObject({ ok: true, built: [], pulled: [], catalogWritten: false });
    expect(r.unchanged.sort()).toEqual(['blip', 'coin', 'plain', 'theme']);
    expect(files.map(f => statSync(f).mtimeMs)).toEqual(mtimes);
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('one recipe change rebuilds that recipe and changes only its files, the lock and the catalog', async () => {
    const fx = cloneFixture(base);
    const before = snapshot(fx.dir);
    fx.write('sfx/blip.json', { ...fx.read('sfx/blip.json'), duration: 0.25 });
    const r = await runBuild(fx.cfg(), { jobs: 1 });
    expect(r.built).toEqual(['blip']);
    expect(r.catalogWritten).toBe(true);
    const changedFiles = diffKeys(before, snapshot(fx.dir)).filter(f => !f.startsWith('.work/'));
    expect(changedFiles.filter(f => f.startsWith('public/audio/')).every(f => /blip|index\.json/.test(f))).toBe(true);
    expect(changedFiles).toEqual(expect.arrayContaining(['audio.lock.json', 'public/audio/index.json', 'sfx/blip.json']));
    expect(changedFiles.some(f => /coin|theme|plain/.test(f) && f.startsWith('public'))).toBe(false);
    // The lock diff is that asset's block only.
    const a = baseLock(), b = readLock(fx.path('audio.lock.json'))!;
    expect(Object.keys(b.assets).filter(id => JSON.stringify(a.assets[id]) !== JSON.stringify(b.assets[id]))).toEqual(['blip']);
  }, 120000);

  it('rebuilds an adaptive song (mix and layers) only when its own instrument changes', async () => {
    const fx = cloneFixture(base);
    fx.write('patches/lead.json', { ...fx.read('patches/lead.json'), duration: 2 });
    const r = await runBuild(fx.cfg());
    expect(r.built).toEqual(['theme']);
  }, 120000);

  describe('--check', () => {
    it('passes on a fresh build and renders nothing', async () => {
      const r = await runBuild(base.cfg(), { check: true });
      expect(r).toMatchObject({ ok: true, stale: [], drift: [] });
    });

    it('lists each stale asset with the reason, and writes nothing', async () => {
      const fx = cloneFixture(base);
      fx.write('sfx/blip.json', { ...fx.read('sfx/blip.json'), duration: 0.25 });
      writeFileSync(fx.path('public/audio/coin.0.ogg'), 'tampered');
      writeFileSync(fx.path('public/audio/plain.ogg'), 'x');
      const before = snapshot(fx.dir);
      const r = await runBuild(fx.cfg(), { check: true });
      expect(r.ok).toBe(false);
      const byId = Object.fromEntries(r.stale.map(s => [s.id, s.reasons.join(' | ')]));
      expect(byId.blip).toMatch(/inputs changed \(renders\)/);
      expect(byId.coin).toMatch(/output modified: coin\.0\.ogg/);
      expect(byId.plain).toMatch(/output modified: plain\.ogg/);
      expect(Object.keys(byId)).not.toContain('theme');
      expect(snapshot(fx.dir)).toEqual(before);
    }, 60000);

    it('reports a delivery change as stale for every asset of the role, naming the part', async () => {
      const r = await runBuild(base.cfg({ kbps: { sfx: 60 } }), { check: true });
      expect(r.stale.map(s => s.id).sort()).toEqual(['blip', 'coin']);
      expect(r.stale[0].reasons[0]).toMatch(/\(delivery\)/);
    });

    it('reports a stale catalog', async () => {
      const fx = cloneFixture(base);
      writeFileSync(fx.path('public/audio/index.json'), readFileSync(fx.path('public/audio/index.json'), 'utf8').replace('"coin"', '"coin2"'));
      const r = await runBuild(fx.cfg(), { check: true });
      expect(r.ok).toBe(false);
      expect(r.drift.join()).toMatch(/index\.json/);
    });
  });

  it('rebuilds a modified output from the render cache, restoring the exact bytes', async () => {
    const fx = cloneFixture(base);
    const want = readFileSync(fx.path('public/audio/coin.0.ogg'));
    writeFileSync(fx.path('public/audio/coin.0.ogg'), 'broken');
    const r = await runBuild(fx.cfg());
    expect(r.built).toEqual(['coin']);
    expect(readFileSync(fx.path('public/audio/coin.0.ogg')).equals(want)).toBe(true);
  }, 60000);

  it('keeps a valid state when the build dies mid-way: finished assets are committed, the interrupted one is untouched', async () => {
    const fx = cloneFixture(base);
    fx.write('sfx/blip.json', { ...fx.read('sfx/blip.json'), duration: 0.25 });
    fx.write('sfx/coin.json', { ...fx.read('sfx/coin.json'), duration: 0.35 });
    const lockBefore = readLock(fx.path('audio.lock.json'))!;
    const filesBefore = snapshot(fx.path('public/audio'));
    await expect(runBuild(fx.cfg(), { jobs: 1, hooks: { beforeInstall: id => { if (id === 'coin') throw new Error('simulated crash'); } } })).rejects.toThrow('simulated crash');
    // blip (built first) is committed; coin's files and lock entry are the old ones, and still verify.
    const lock = readLock(fx.path('audio.lock.json'))!;
    expect(lock.assets.blip.inputHash).not.toBe(lockBefore.assets.blip.inputHash);
    expect(lock.assets.coin).toEqual(lockBefore.assets.coin);
    const filesAfter = snapshot(fx.path('public/audio'));
    for (const f of lock.assets.coin.outputs) expect(filesAfter[f.file]).toBe(filesBefore[f.file]);
    expect(verifyOutputs({ lock: fx.path('audio.lock.json'), out: fx.path('public/audio'), catalog: false }).problems).toEqual([]);
    // The next run finishes the job.
    const r = await runBuild(fx.cfg());
    expect(r.built).toEqual(['coin']);
    expect((await runBuild(fx.cfg(), { check: true })).ok).toBe(true);
  }, 120000);

  it('--only builds just those recipes and keeps the rest of the lock', async () => {
    const fx = cloneFixture(base);
    fx.write('sfx/blip.json', { ...fx.read('sfx/blip.json'), duration: 0.25 });
    fx.write('sfx/coin.json', { ...fx.read('sfx/coin.json'), duration: 0.35 });
    const r = await runBuild(fx.cfg(), { only: ['coin'] });
    expect(r.built).toEqual(['coin']);
    const lock = readLock(fx.path('audio.lock.json'))!;
    expect(Object.keys(lock.assets)).toEqual(['blip', 'coin', 'plain', 'theme']);
    expect(lock.assets.blip).toEqual(baseLock().assets.blip);
    await expect(runBuild(fx.cfg(), { only: ['nope'] })).rejects.toThrow(/no recipe "nope"/);
  }, 120000);

  it('deletes the outputs and lock entry of a recipe that was removed', async () => {
    const fx = cloneFixture(base);
    const recipes = fx.read('recipes.json');
    delete recipes.plain;
    fx.write('recipes.json', recipes);
    const r = await runBuild(fx.cfg());
    expect(r.removed).toEqual(['plain']);
    expect(existsSync(fx.path('public/audio/plain.ogg'))).toBe(false);
    expect(readLock(fx.path('audio.lock.json'))!.assets.plain).toBeUndefined();
    expect(Object.keys(fx.read('public/audio/index.json').assets)).not.toContain('plain');
  }, 60000);

  it('refuses a toolchain change unless told, instead of silently re-rendering everything', async () => {
    const fx = cloneFixture(base);
    const lock = fx.read('audio.lock.json');
    // As if every asset had been built by the previous song pipeline.
    lock.toolchain.songPipeline = 4;
    for (const a of Object.values<any>(lock.assets)) { a.inputHash = 'sha256:' + '0'.repeat(64); a.parts.toolchain = '0'.repeat(12); }
    fx.write('audio.lock.json', lock);
    expect((await runBuild(fx.cfg(), { check: true })).stale[0].reasons[0]).toMatch(/inputs changed \(toolchain\)/);
    await expect(runBuild(fx.cfg())).rejects.toMatchObject({ code: 'E_TOOLCHAIN' });
    const r = await runBuild(fx.cfg(), { allowToolchainChange: true });
    expect(r.built.length).toBe(4); // from the render cache: seconds, not minutes
    expect(readLock(fx.path('audio.lock.json'))!.toolchain.songPipeline).toBe(SONG_PIPELINE_VERSION);
  }, 120000);

  it('rebuilds only the role whose bitrate was changed, without the toolchain guard', async () => {
    const fx = cloneFixture(base);
    const r = await runBuild(fx.cfg({ kbps: { sfx: 60 } }));
    expect(r.built.sort()).toEqual(['blip', 'coin']);
    const lock = readLock(fx.path('audio.lock.json'))!;
    expect(lock.delivery.kbps).toMatchObject({ sfx: 60, music: 44 });
    expect(lock.assets.theme).toEqual(baseLock().assets.theme);
    expect((await runBuild(fx.cfg({ kbps: { sfx: 60 } }), { check: true })).ok).toBe(true);
  }, 120000);

  it('rejects a recipe whose patch name differs from its id', async () => {
    const fx = cloneFixture(base);
    fx.write('recipes.json', { ...fx.read('recipes.json'), coin: { source: 'sfx/blip.json', role: 'sfx' } });
    await expect(runBuild(fx.cfg(), { only: ['coin'] })).rejects.toThrow(/exported asset id "blip"/);
  }, 60000);

  describe('--adopt', () => {
    it('takes over a lock another tool wrote, without rendering, when every output matches', async () => {
      const fx = cloneFixture(base);
      const lock = fx.read('audio.lock.json');
      lock.keyScheme = 'game-v0';
      for (const a of Object.values<any>(lock.assets)) { a.inputHash = 'sha256:' + '0'.repeat(64); delete a.parts; }
      delete lock.toolchain; delete lock.delivery;
      lock.sourcesHash = 'sha256:abc';
      fx.write('audio.lock.json', lock);
      await expect(runBuild(fx.cfg())).rejects.toMatchObject({ code: 'E_LOCK' });
      const files = snapshot(fx.path('public/audio'));
      const r = await runBuild(fx.cfg(), { adopt: true });
      expect(r.built).toEqual([]);
      expect(r.adopted.sort()).toEqual(['blip', 'coin', 'plain', 'theme']);
      expect(snapshot(fx.path('public/audio'))).toEqual(files);
      const after = readLock(fx.path('audio.lock.json'))!;
      expect(after.keyScheme).toBe('beeps-input@1');
      expect(after.sourcesHash).toBe('sha256:abc'); // fields beeps does not know are kept
      expect(after.assets.coin.inputHash).toBe(baseLock().assets.coin.inputHash);
      expect((await runBuild(fx.cfg(), { check: true })).ok).toBe(true);
    }, 60000);

    it('re-keys a lock of an older toolchain without rendering, keeping its files, and refuses when the encoding differs', async () => {
      const fx = cloneFixture(base);
      const lock = fx.read('audio.lock.json');
      lock.toolchain.songPipeline = SONG_PIPELINE_VERSION - 1;
      for (const a of Object.values<any>(lock.assets)) { a.inputHash = 'sha256:' + '0'.repeat(64); a.parts.toolchain = '0'.repeat(12); }
      fx.write('audio.lock.json', lock);
      await expect(runBuild(fx.cfg())).rejects.toMatchObject({ code: 'E_TOOLCHAIN' });
      const files = snapshot(fx.path('public/audio'));
      const logs: string[] = [];
      const r = await runBuild(fx.cfg(), { adopt: true, log: s => logs.push(s) });
      expect(r.built).toEqual([]);
      expect(r.adopted.sort()).toEqual(['blip', 'coin', 'plain', 'theme']);
      expect(logs.join(' ')).toMatch(/toolchain\.songPipeline: \d+ -> \d+/);
      expect(snapshot(fx.path('public/audio'))).toEqual(files);
      const after = readLock(fx.path('audio.lock.json'))!;
      expect(after.toolchain.songPipeline).toBe(SONG_PIPELINE_VERSION);
      expect(after.assets.theme.inputHash).toBe(baseLock().assets.theme.inputHash);
      expect((await runBuild(fx.cfg(), { check: true })).ok).toBe(true);
      // An encoder or bitrate that differs from the lock's means the files were made another way: nothing to keep.
      await expect(runBuild(fx.cfg({ kbps: { sfx: 60 } }), { adopt: true })).rejects.toMatchObject({ code: 'E_LOCK' });
    }, 60000);

    it('a song-pipeline bump leaves the sound effects fresh', () => {
      const lock = baseLock();
      expect(lock.assets.coin.parts!.toolchain).not.toBe(lock.assets.theme.parts!.toolchain);
    });

    it('rebuilds only the assets whose outputs do not match the foreign lock', async () => {
      const fx = cloneFixture(base);
      const lock = fx.read('audio.lock.json');
      lock.keyScheme = 'game-v0';
      lock.assets.coin.outputs[0].sha256 = 'f'.repeat(64);
      fx.write('audio.lock.json', lock);
      const r = await runBuild(fx.cfg(), { adopt: true });
      expect(r.built).toEqual(['coin']);
      expect(r.adopted.sort()).toEqual(['blip', 'plain', 'theme']);
    }, 60000);
  });

  it('enforces a byte budget before rendering anything, and estimates a bitrate change by arithmetic', async () => {
    const fx = cloneFixture(base);
    fx.write('sfx/blip.json', { ...fx.read('sfx/blip.json'), duration: 0.25 });
    await expect(runBuild(fx.cfg({ budgetBytes: 1000 }))).rejects.toMatchObject({ code: 'E_BUDGET' });
    expect(readLock(fx.path('audio.lock.json'))!.assets.blip).toEqual(baseLock().assets.blip);
    const half = await runBuild(base.cfg({ kbps: { sfx: 36 } }), { check: true });
    const full = await runBuild(base.cfg(), { check: true });
    const sfxBytes = ['blip', 'coin'].flatMap(id => baseLock().assets[id].outputs).reduce((s, o) => s + o.bytes, 0);
    expect(full.estimate.totalBytes - half.estimate.totalBytes).toBeGreaterThan(sfxBytes * 0.45);
    expect(full.estimate.totalBytes - half.estimate.totalBytes).toBeLessThan(sfxBytes * 0.55);
  }, 120000);
});
