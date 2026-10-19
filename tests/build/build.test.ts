// `beeps build` end to end on a tiny project: incremental, minimal-diff, atomic, check, adopt.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromiumAvailable, openRenderHost, type RenderHost } from '../../src/render/host.ts';
import { findFfmpeg } from '../../src/compress.ts';
import { openBuildProject, runBuild } from '../../src/build/build.ts';
import { lockText, readLock } from '../../src/build/lock.ts';
import { SONG_PIPELINE_VERSION } from '../../src/render/song-pipeline.ts';
import { verifyOutputs } from '../../src/build/verify.ts';
import { cloneFixture, diffKeys, makeFixture, snapshot, type Fixture } from '../helpers/build-fixture.ts';
import { exportPatchOne, exportPatchVariants, exportSongAssets } from '../../src/export-assets.ts';
import { loadPatch } from '../../src/project.ts';
import { pcm16 } from '../../src/audio/post.ts';
import { loadRecipes } from '../../src/build/config.ts';
import { loadSong } from '../../src/music.ts';

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

  it('switches one baked recipe to an existing authored source without renaming it or rebuilding unrelated assets', async () => {
    const fx = cloneFixture(base);
    try {
      const cfg = fx.cfg(), p = openBuildProject(cfg), prior = readLock(cfg.lock)!, before = snapshot(cfg.out), cached = snapshot(p.paths.renders);
      const sources = { coin: readFileSync(fx.path('sfx/coin.json')), blip: readFileSync(fx.path('sfx/blip.json')) };
      const authored = fx.read('public/audio/blip.0.ogg.json');
      // This tuple is already genuinely rendered/encoded by the existing warm blip fixture.
      fx.write('recipes.json', { ...fx.read('recipes.json'), coin: { source: 'sfx/blip.json', role: 'sfx' } });
      const report = await runBuild(cfg, { only: ['coin'], jobs: 1 });
      expect(report).toMatchObject({ ok: true, built: ['coin'], pulled: [], removed: [] });
      const lock = readLock(cfg.lock)!;
      expect(lock.assets.coin).toMatchObject({ source: 'sfx/blip.json', role: 'sfx', parts: { renders: prior.assets.blip.parts!.renders } });
      expect(lock.assets.coin.inputHash).not.toBe(prior.assets.coin.inputHash);
      expect(lock.assets.coin.parts!.export).not.toBe(prior.assets.blip.parts!.export);
      expect(fx.read('public/audio/coin.0.ogg.json')).toEqual({
        ...authored, id: 'coin', file: 'coin.0.ogg', variants: authored.variants.map((v: { file: string; weight?: number }) => ({ ...v, file: v.file.replace(/^blip/, 'coin') })),
      });
      expect(fx.read('public/audio/index.json').assets.coin).toMatchObject({ id: 'coin', label: 'Blip', file: 'coin.0.ogg', renderKey: authored.renderKey });
      expect(readFileSync(fx.path('public/audio/coin.0.ogg'))).toEqual(readFileSync(fx.path('public/audio/blip.0.ogg')));
      const delivered = snapshot(cfg.out);
      expect(diffKeys(before, delivered).every(file => file === 'index.json' || file.startsWith('coin.'))).toBe(true);
      for (const id of ['blip', 'plain', 'theme']) {
        expect(lock.assets[id]).toEqual(prior.assets[id]);
        for (const output of prior.assets[id].outputs) expect(delivered[output.file]).toBe(before[output.file]);
      }
      // Installation must retire any previous coin variant paths absent from the replacement.
      const owned = new Set(lock.assets.coin.outputs.map(output => output.file));
      for (const previous of prior.assets.coin.outputs) if (!owned.has(previous.file)) expect(existsSync(fx.path(`public/audio/${previous.file}`))).toBe(false);
      expect(lock.assets.coin.outputs.map(output => output.file)).toEqual(['coin.0.ogg', 'coin.0.ogg.json']);
      expect(snapshot(p.paths.renders)).toEqual(cached);
      expect(readFileSync(fx.path('sfx/coin.json'))).toEqual(sources.coin);
      expect(readFileSync(fx.path('sfx/blip.json'))).toEqual(sources.blip);
      expect(verifyOutputs({ lock: cfg.lock, out: cfg.out })).toMatchObject({ ok: true, problems: [] });
      const accepted = snapshot(fx.dir), files = Object.keys(accepted).map(file => fx.path(file)), mtimes = files.map(file => statSync(file).mtimeMs);
      expect((await runBuild(cfg, { check: true })).ok).toBe(true);
      expect((await runBuild(cfg, { only: ['coin'], jobs: 1 })).built).toEqual([]);
      expect(snapshot(fx.dir)).toEqual(accepted);
      expect(files.map(file => statSync(file).mtimeMs)).toEqual(mtimes);
    } finally { rmSync(fx.dir, { recursive: true, force: true }); }
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
    const encodedBytes = ['blip', 'coin'].flatMap(id => baseLock().assets[id].outputs).filter(o => /\.(ogg|mp3)$/.test(o.file)).reduce((s, o) => s + o.bytes, 0);
    // The sidecars stay fixed when only the encoded baked bitrate is halved.
    expect(full.estimate.totalBytes - half.estimate.totalBytes).toBeCloseTo(encodedBytes / 2, -1);
  }, 120000);
});

// Baked delivery keys belong to the export, while source names and render caches stay authored.

const coinRecipe = { source: 'sfx/coin.json', role: 'sfx', seed: 11, variants: 1 };
const themeRecipe = { source: 'songs/theme.json', role: 'music', kind: 'song' };
const normalRecipes = { coin: coinRecipe, theme: themeRecipe };

describe('delivery ID preflight', () => {
  it('refuses nonportable recipe IDs before build or check writes', async () => {
    const fx = makeFixture({ config: { target: 'wav-master', jobs: 1 } });
    try {
      const invalid = ['', '.', '..', '../escape', 'a/b', 'a\\b', 'C:drive', 'with space', 'UPPER', 'trailing.', 'nul', 'con', 'prn', 'aux', 'com1', 'lpt9'];
      for (const id of invalid) {
        fx.write('recipes.json', { [id]: coinRecipe });
        const before = snapshot(fx.dir);
        expect(() => loadRecipes(fx.cfg()), id).toThrow(/id/i);
        await expect(runBuild(fx.cfg(), { check: true }), id).rejects.toMatchObject({ code: 'E_SCHEMA' });
        await expect(runBuild(fx.cfg()), id).rejects.toMatchObject({ code: 'E_SCHEMA' });
        expect(snapshot(fx.dir), id).toEqual(before);
        // Array form must use the same admission as object keys.
        fx.write('recipes.json', [{ ...coinRecipe, id }]);
        expect(() => loadRecipes(fx.cfg()), `array id ${id}`).toThrow();
      }
    } finally { rmSync(fx.dir, { recursive: true, force: true }); }
  });

  it('bounds new aliases without tightening the existing authored-name length contract', async () => {
    const fx = makeFixture({ config: { target: 'wav-master', jobs: 1 } }), id = 'a'.repeat(129);
    try {
      fx.write('recipes.json', { [id]: coinRecipe });
      const before = snapshot(fx.dir);
      await expect(runBuild(fx.cfg(), { check: true })).rejects.toMatchObject({ code: 'E_SCHEMA' });
      expect(snapshot(fx.dir)).toEqual(before);
      // Authored schemas historically admit this name; matched IDs keep that contract.
      fx.write('sfx/coin.json', { ...fx.read('sfx/coin.json'), name: id });
      expect(loadRecipes(fx.cfg())[0].id).toBe(id);
      const matched = snapshot(fx.dir);
      expect((await runBuild(fx.cfg(), { check: true })).stale[0].id).toBe(id);
      expect(snapshot(fx.dir)).toEqual(matched);
    } finally { rmSync(fx.dir, { recursive: true, force: true }); }
  });

  it('keeps runtime and both delivery tied to the authored patch name before writes', async () => {
    const fx = makeFixture({ config: { target: 'wav-master', jobs: 1 } });
    const authoredPatch = fx.read('sfx/coin.json');
    try {
      for (const delivery of ['runtime', 'both']) {
        fx.write('recipes.json', { 'inspect-0': { ...coinRecipe, delivery } });
        const before = snapshot(fx.dir);
        await expect(runBuild(fx.cfg(), { check: true })).rejects.toMatchObject({ code: 'E_SCHEMA', message: expect.stringMatching(/inspect-0.*coin/) });
        await expect(runBuild(fx.cfg())).rejects.toMatchObject({ code: 'E_SCHEMA', message: expect.stringMatching(/inspect-0.*coin/) });
        expect(snapshot(fx.dir)).toEqual(before);
        fx.write('sfx/coin.json', { ...authoredPatch, xRuntime: { delivery, inputs: {}, bind: [] } });
        fx.write('recipes.json', { 'inspect-0': coinRecipe });
        const inherited = snapshot(fx.dir);
        await expect(runBuild(fx.cfg(), { check: true })).rejects.toMatchObject({ code: 'E_SCHEMA', message: expect.stringMatching(/inspect-0.*coin/) });
        expect(snapshot(fx.dir)).toEqual(inherited);
        // An explicit baked recipe retains the existing ability to override a runtime default.
        fx.write('recipes.json', { 'inspect-0': { ...coinRecipe, delivery: 'baked' } });
        expect((await runBuild(fx.cfg(), { check: true })).stale[0].id).toBe('inspect-0');
      }
    } finally { rmSync(fx.dir, { recursive: true, force: true }); }
  });
});

describe.skipIf(!hasChromium)('baked delivery identities', () => {
  let base: Fixture;
  // A cache miss is a failure here: these exports must reuse genuinely rendered authored inputs.
  const cacheOnlyHost = new Proxy({} as RenderHost, { get: () => () => { throw new Error('delivery identity unexpectedly requested rendering'); } });

  beforeAll(async () => {
    base = makeFixture({ config: { target: 'wav-master', jobs: 1 } });
    base.write('recipes.json', normalRecipes);
    const cfg = base.cfg(), p = openBuildProject(cfg), host = await openRenderHost();
    try {
      const patch = loadPatch(p, base.path('sfx/coin.json'));
      // One owned host warms each genuine source/options tuple once, including both footstep-style seeds.
      for (const seed of [11, 18]) await exportPatchVariants(host, p, patch, { dest: base.path(`direct/${seed}/coin.wav`), seed, n: 1, role: 'sfx', manifest: true });
      await exportSongAssets(host, p, loadSong(p, base.path('songs/theme.json')), { dest: base.path('direct/theme/theme.wav'), role: 'music', manifest: true, layers: true });
    } finally { await host.close(); }
    expect((await runBuild(cfg)).built).toEqual(['coin', 'theme']);
  }, 120000);
  afterAll(() => { if (base) rmSync(base.dir, { recursive: true, force: true }); });

  it('preserves ordinary matched-ID export bytes, hashes and unchanged checks', async () => {
    const fx = cloneFixture(base);
    try {
      for (const [direct, delivered] of [['direct/11/coin.0.wav', 'public/audio/coin.0.wav'], ['direct/11/coin.wav.json', 'public/audio/coin.wav.json'], ['direct/theme/theme.wav', 'public/audio/theme.wav'], ['direct/theme/theme.wav.json', 'public/audio/theme.wav.json']]) {
        expect(readFileSync(fx.path(delivered))).toEqual(readFileSync(fx.path(direct)));
      }
      const cfg = fx.cfg(), before = snapshot(fx.dir), files = Object.keys(before).map(f => fx.path(f)), mtimes = files.map(f => statSync(f).mtimeMs);
      expect((await runBuild(cfg, { check: true })).ok).toBe(true);
      expect((await runBuild(cfg)).built).toEqual([]);
      expect(snapshot(fx.dir)).toEqual(before);
      expect(files.map(f => statSync(f).mtimeMs)).toEqual(mtimes);
    } finally { rmSync(fx.dir, { recursive: true, force: true }); }
  });

  it('builds two delivery IDs from one unchanged patch at distinct seeds using its raw cache', async () => {
    const fx = cloneFixture(base);
    try {
      fx.write('recipes.json', { ...normalRecipes, 'inspect-0': coinRecipe, 'inspect-1': { ...coinRecipe, seed: 18 } });
      const cfg = fx.cfg(), p = openBuildProject(cfg), source = readFileSync(fx.path('sfx/coin.json')), cached = snapshot(p.paths.renders), original = snapshot(cfg.out);
      // Current causal RED: buildOne rejects the genuinely exported authored id "coin".
      expect((await runBuild(cfg)).built).toEqual(['inspect-0', 'inspect-1']);
      const lock = readLock(cfg.lock)!;
      for (const [id, seed] of [['inspect-0', 11], ['inspect-1', 18]] as const) {
        const side = fx.read(`public/audio/${id}.wav.json`), authored = fx.read(`direct/${seed}/coin.wav.json`);
        expect(side).toEqual({ ...authored, id, file: `${id}.0.wav`, variants: [{ file: `${id}.0.wav`, weight: 1 }] });
        expect(readFileSync(fx.path(`public/audio/${id}.0.wav`))).toEqual(readFileSync(fx.path(`direct/${seed}/coin.0.wav`)));
        expect(lock.assets[id]).toMatchObject({ source: 'sfx/coin.json', role: 'sfx' });
      }
      expect(fx.read('public/audio/inspect-0.wav.json').renderKey).not.toBe(fx.read('public/audio/inspect-1.wav.json').renderKey);
      expect(lock.assets['inspect-0'].parts!.renders).toBe(lock.assets.coin.parts!.renders);
      expect(lock.assets['inspect-0'].parts!.export).not.toBe(lock.assets.coin.parts!.export);
      expect(snapshot(p.paths.renders)).toEqual(cached);
      expect(readFileSync(fx.path('sfx/coin.json'))).toEqual(source);
      for (const [file, hash] of Object.entries(original).filter(([file]) => file !== 'index.json')) expect(snapshot(cfg.out)[file]).toBe(hash);
      expect(fx.read('public/audio/index.json').assets).toMatchObject({ 'inspect-0': { id: 'inspect-0' }, 'inspect-1': { id: 'inspect-1' } });
      expect(verifyOutputs({ lock: cfg.lock, out: cfg.out }).ok).toBe(true);
      const built = snapshot(fx.dir);
      expect((await runBuild(cfg)).built).toEqual([]);
      expect((await runBuild(cfg, { check: true })).ok).toBe(true);
      expect(snapshot(fx.dir)).toEqual(built);
    } finally { rmSync(fx.dir, { recursive: true, force: true }); }
  });

  it('treats a constructor delivery ID absent from an existing lock as a new asset', async () => {
    const fx = cloneFixture(base);
    try {
      fx.write('recipes.json', { ...normalRecipes, constructor: coinRecipe });
      const cfg = fx.cfg(), p = openBuildProject(cfg), prior = readLock(cfg.lock)!, source = readFileSync(fx.path('sfx/coin.json')), cached = snapshot(p.paths.renders), original = snapshot(cfg.out);
      expect(Object.hasOwn(prior.assets, 'constructor')).toBe(false);
      const beforeCheck = snapshot(fx.dir), existingFiles = Object.keys(beforeCheck).map(file => fx.path(file)), existingMtimes = existingFiles.map(file => statSync(file).mtimeMs);
      // Current causal RED: inherited Object.prototype.constructor is mistaken for a locked asset.
      expect(await runBuild(cfg, { check: true })).toMatchObject({
        ok: false, unchanged: ['coin', 'theme'], stale: [{ id: 'constructor', reasons: ['new: not in the lock'] }],
      });
      expect(snapshot(fx.dir)).toEqual(beforeCheck);
      expect(existingFiles.map(file => statSync(file).mtimeMs)).toEqual(existingMtimes);
      expect((await runBuild(cfg, { only: ['constructor'], jobs: 1 })).built).toEqual(['constructor']);
      const lock = readLock(cfg.lock)!;
      expect(Object.hasOwn(lock.assets, 'constructor')).toBe(true);
      expect(lock.assets['constructor']).toMatchObject({ source: 'sfx/coin.json', role: 'sfx', parts: { renders: prior.assets.coin.parts!.renders } });
      expect(fx.read('public/audio/constructor.wav.json')).toMatchObject({ id: 'constructor', label: 'Coin', file: 'constructor.0.wav', renderKey: fx.read('public/audio/coin.wav.json').renderKey });
      expect(readFileSync(fx.path('public/audio/constructor.0.wav'))).toEqual(readFileSync(fx.path('public/audio/coin.0.wav')));
      expect(fx.read('public/audio/index.json').assets['constructor']).toMatchObject({ id: 'constructor', file: 'constructor.0.wav' });
      const delivered = snapshot(cfg.out);
      for (const id of ['coin', 'theme']) {
        expect(lock.assets[id]).toEqual(prior.assets[id]);
        for (const output of prior.assets[id].outputs) expect(delivered[output.file]).toBe(original[output.file]);
      }
      expect(snapshot(p.paths.renders)).toEqual(cached);
      expect(readFileSync(fx.path('sfx/coin.json'))).toEqual(source);
      expect(verifyOutputs({ lock: cfg.lock, out: cfg.out })).toMatchObject({ ok: true, problems: [] });
      const accepted = snapshot(fx.dir), files = Object.keys(accepted).map(file => fx.path(file)), mtimes = files.map(file => statSync(file).mtimeMs);
      expect((await runBuild(cfg, { check: true })).ok).toBe(true);
      expect((await runBuild(cfg, { only: ['constructor'], jobs: 1 })).built).toEqual([]);
      expect(snapshot(fx.dir)).toEqual(accepted);
      expect(files.map(file => statSync(file).mtimeMs)).toEqual(mtimes);

      // These bytes were genuinely built above. Change only the scheme marker as a controlled
      // foreign-lock adoption fixture, without inventing source or render provenance.
      const foreign = readLock(cfg.lock)!, unselected = foreign.assets['constructor'];
      const beforeAdopt = snapshot(cfg.out), outputFiles = Object.keys(beforeAdopt).map(file => fx.path(`public/audio/${file}`)), outputMtimes = outputFiles.map(file => statSync(file).mtimeMs);
      fx.write('audio.lock.json', { ...foreign, keyScheme: 'game-v0' });
      expect(await runBuild(cfg, { adopt: true, only: ['coin'], jobs: 1 })).toMatchObject({ ok: true, adopted: ['coin'], built: [], pulled: [] });
      const adopted = readLock(cfg.lock)!;
      // Second causal RED, after own-entry reads are fixed: `id in assets` drops this unselected entry.
      expect(adopted.assets['constructor']).toEqual(unselected);
      expect(Object.hasOwn(adopted.assets, 'constructor')).toBe(true);
      expect(adopted.assets.theme).toEqual(foreign.assets.theme);
      expect(snapshot(cfg.out)).toEqual(beforeAdopt);
      expect(outputFiles.map(file => statSync(file).mtimeMs)).toEqual(outputMtimes);
      expect(snapshot(p.paths.renders)).toEqual(cached);
      expect(readFileSync(fx.path('sfx/coin.json'))).toEqual(source);
      expect(verifyOutputs({ lock: cfg.lock, out: cfg.out })).toMatchObject({ ok: true, problems: [], warnings: [] });
      const adoptedState = snapshot(fx.dir);
      expect((await runBuild(cfg, { check: true })).ok).toBe(true);
      expect(snapshot(fx.dir)).toEqual(adoptedState);
    } finally { rmSync(fx.dir, { recursive: true, force: true }); }
  });

  it('builds a song delivery ID while preserving authored metadata, aligned layers and raw cache', async () => {
    const fx = cloneFixture(base);
    try {
      fx.write('recipes.json', { ...normalRecipes, 'music-garden': themeRecipe });
      const cfg = fx.cfg(), p = openBuildProject(cfg), source = readFileSync(fx.path('songs/theme.json')), cached = snapshot(p.paths.renders);
      // Current causal RED: buildOne rejects the real rendered song's authored id "theme".
      expect((await runBuild(cfg)).built).toEqual(['music-garden']);
      const side = fx.read('public/audio/music-garden.wav.json'), authored = fx.read('direct/theme/theme.wav.json');
      const layers = authored.layers.map((layer: { name: string; file: string }) => ({ ...layer, file: layer.file.replace(/^theme/, 'music-garden') }));
      expect(side).toEqual({ ...authored, id: 'music-garden', file: 'music-garden.wav', layers });
      for (const file of [authored.file, ...authored.layers.map((layer: { file: string }) => layer.file)]) expect(readFileSync(fx.path(`public/audio/${file.replace(/^theme/, 'music-garden')}`))).toEqual(readFileSync(fx.path(`direct/theme/${file}`)));
      const lock = readLock(cfg.lock)!;
      expect(lock.assets['music-garden']).toMatchObject({ source: 'songs/theme.json', role: 'music', parts: { renders: lock.assets.theme.parts!.renders } });
      expect(lock.assets['music-garden'].parts!.export).not.toBe(lock.assets.theme.parts!.export);
      expect(snapshot(p.paths.renders)).toEqual(cached);
      expect(readFileSync(fx.path('songs/theme.json'))).toEqual(source);
      expect(fx.read('public/audio/index.json').assets['music-garden']).toMatchObject({ id: 'music-garden', role: 'music', loop: true });
      expect(verifyOutputs({ lock: cfg.lock, out: cfg.out }).ok).toBe(true);
    } finally { rmSync(fx.dir, { recursive: true, force: true }); }
  });

  it('allows shared exporters to opt into a manifest ID without renaming source objects', async () => {
    const fx = cloneFixture(base);
    try {
      const p = openBuildProject(fx.cfg()), patch = loadPatch(p, fx.path('sfx/coin.json')), song = loadSong(p, fx.path('songs/theme.json'));
      const sources = JSON.stringify({ patch, song }), cached = snapshot(p.paths.renders);
      const patchOptions = { dest: fx.path('alias/inspect-0.wav'), seed: 11, n: 1, role: 'sfx' as const, manifest: true, manifestId: 'inspect-0' };
      const songOptions = { dest: fx.path('alias/music-garden.wav'), role: 'music' as const, manifest: true, layers: true, manifestId: 'music-garden' };
      await exportPatchVariants(cacheOnlyHost, p, patch, patchOptions);
      await exportSongAssets(cacheOnlyHost, p, song, songOptions);
      expect(fx.read('alias/inspect-0.wav.json')).toMatchObject({ id: 'inspect-0', label: 'Coin', renderKey: fx.read('direct/11/coin.wav.json').renderKey });
      expect(fx.read('alias/music-garden.wav.json')).toMatchObject({ id: 'music-garden', label: 'Theme', renderKey: fx.read('direct/theme/theme.wav.json').renderKey });
      expect(JSON.stringify({ patch, song })).toBe(sources);
      expect(snapshot(p.paths.renders)).toEqual(cached);
    } finally { rmSync(fx.dir, { recursive: true, force: true }); }
  });

  it('refuses malformed exporter aliases before writing any delivered file', async () => {
    const fx = cloneFixture(base);
    try {
      const p = openBuildProject(fx.cfg()), patch = loadPatch(p, fx.path('sfx/coin.json')), song = loadSong(p, fx.path('songs/theme.json'));
      for (const manifestId of ['', '../escape', 'a/b', 'a\\b', 'nul', 'a'.repeat(129)]) {
        const before = snapshot(fx.dir);
        const patchOptions = { dest: fx.path('alias/inspect.wav'), seed: 11, n: 1, role: 'sfx' as const, manifest: true, manifestId };
        const songOptions = { dest: fx.path('alias/music.wav'), role: 'music' as const, manifest: true, layers: true, manifestId };
        await expect(exportPatchVariants(cacheOnlyHost, p, patch, patchOptions)).rejects.toMatchObject({ code: 'E_SCHEMA' });
        expect(snapshot(fx.dir)).toEqual(before);
        await expect(exportSongAssets(cacheOnlyHost, p, song, songOptions)).rejects.toMatchObject({ code: 'E_SCHEMA' });
        expect(snapshot(fx.dir)).toEqual(before);
      }
    } finally { rmSync(fx.dir, { recursive: true, force: true }); }
  });

  it('refuses a manifest-only identity when no manifest was requested before writes', async () => {
    const fx = cloneFixture(base);
    try {
      const p = openBuildProject(fx.cfg()), patch = loadPatch(p, fx.path('sfx/coin.json')), song = loadSong(p, fx.path('songs/theme.json')), before = snapshot(fx.dir);
      const patchOptions = { dest: fx.path('alias/inspect.wav'), seed: 11, n: 1, role: 'sfx' as const, manifest: false, manifestId: 'inspect-0' };
      const songOptions = { dest: fx.path('alias/music.wav'), role: 'music' as const, manifest: false, layers: true, manifestId: 'music-garden' };
      await expect(exportPatchVariants(cacheOnlyHost, p, patch, patchOptions)).rejects.toMatchObject({ code: 'E_USAGE' });
      expect(snapshot(fx.dir)).toEqual(before);
      await expect(exportSongAssets(cacheOnlyHost, p, song, songOptions)).rejects.toMatchObject({ code: 'E_USAGE' });
      expect(snapshot(fx.dir)).toEqual(before);
    } finally { rmSync(fx.dir, { recursive: true, force: true }); }
  });
});
