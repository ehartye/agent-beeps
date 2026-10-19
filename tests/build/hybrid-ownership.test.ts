import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {makeFixture, cloneFixture, snapshot, type Fixture} from '../helpers/build-fixture.ts';
import {sampleFixture} from '../helpers/samples.ts';
import {runBuild, openBuildProject} from '../../src/build/build.ts';
import {readLock, writeLock, type LockAsset} from '../../src/build/lock.ts';
import {DirStore, packAsset, sha256Hex, storeName} from '../../src/build/store.ts';
import {ciExport, storePull, storePush, storeStatus} from '../../src/build/store-ops.ts';
import {samplePaths, writeSampleObject} from '../../src/samples/store.ts';
import {sampleFile} from '../../src/runtime/dependencies.ts';
import {validateDeliveredAsset} from '../../src/runtime/inventory.ts';

const fixtures: Fixture[] = [];
let base: Fixture;
const clone = () => {const fx = cloneFixture(base); fixtures.push(fx); return fx;};
const ref = (file: string, data: Buffer) => ({file, bytes: data.length, sha256: sha256Hex(data)});
const filesOf = (fx: Fixture, asset: LockAsset) => new Map(asset.outputs.map(o => [o.file, fs.readFileSync(join(fx.cfg().out, o.file))]));
const fetchOnly = (fx: Fixture, check = false) => {
  const script = ciExport(fx.cfg(), fx.path('tools'), `dir:${fx.path('store')}`);
  const r = spawnSync(process.env.BEEPS_TEST_NODE20 ?? process.execPath, [script.file, '--only', 'a', ...(check ? ['--check'] : [])],
    {cwd: fx.dir, windowsHide: true, encoding: 'utf8', env: {...process.env, PATH: '', BEEPS_FFMPEG: ''}});
  return {...r, json: r.stdout.trim() ? JSON.parse(r.stdout.trim().split('\n').pop()!) : undefined};
};
beforeAll(async () => {
  base = makeFixture({config: {target: 'wav-master'}}); fixtures.push(base);
  const s = sampleFixture({hybrid: true});
  writeSampleObject(samplePaths(openBuildProject(base.cfg())).objects, s.wav);
  base.write('recipes.json', Object.fromEntries(['a', 'b'].map(id => [id, {source: `sfx/${id}.json`, role: 'sfx', delivery: 'runtime'}])));
  for (const name of ['a', 'b']) base.write(`sfx/${name}.json`, {...s.patch, name});
  await runBuild(base.cfg());
}, 120000);
afterAll(() => {for (const fx of fixtures) fs.rmSync(fx.dir, {recursive: true, force: true});});

describe('reserved sample inventories', () => {
  it.each(['foreign', 'foreign-case', 'same-owner', 'no-cue'] as const)('rejects %s orphan output across local/store/fetch paths without changing B', async kind => {
    const fx = clone(), lock = readLock(fx.cfg().lock)!, a = lock.assets.a, b = lock.assets.b;
    const files = filesOf(fx, a), bSource = b.outputs.find(o => o.file.startsWith('sample-'))!;
    const bytes = Buffer.from(fs.readFileSync(join(fx.cfg().out, bSource.file)));
    if (kind === 'same-owner') bytes.writeFloatLE(.25, 44);
    const file = kind === 'same-owner' ? sampleFile('a', `sha256:${sha256Hex(bytes)}`) : kind === 'foreign-case' ? bSource.file.toUpperCase() : bSource.file;
    files.set(file, bytes);
    if (kind === 'no-cue') {for (const name of [...files.keys()]) if (name !== file) files.delete(name); delete a.delivery;}
    a.outputs = [...files].map(([name, data]) => ref(name, data)); writeLock(fx.cfg().lock, lock);
    for (const [name, data] of files) fs.writeFileSync(join(fx.cfg().out, name), data);
    const before = snapshot(fx.cfg().out), store = new DirStore(fx.path('store'));
    expect(() => validateDeliveredAsset('a', a, name => files.get(name))).toThrow(/orphan.*sample/i);
    expect((await storeStatus(fx.cfg(), undefined, ['a'])).localOk).toBe(0);
    expect((await storePush(fx.cfg(), store, ['a'])).ok).toBe(false);
    expect(fetchOnly(fx, true).status).toBe(1);
    expect(snapshot(fx.cfg().out)).toEqual(before);
    if (kind !== 'same-owner') {
      const poison = Buffer.from(bytes); poison.fill(0, 44); files.set(file, poison);
      a.outputs = [...files].map(([name, data]) => ref(name, data)); writeLock(fx.cfg().lock, lock);
    }
    await store.put(storeName(a.inputHash), packAsset('a', a.inputHash, a.outputs, name => files.get(name)!));
    expect((await storePull(fx.cfg(), store, ['a'])).ok).toBe(false);
    expect(fetchOnly(fx).status).toBe(1);
    expect(snapshot(fx.cfg().out)).toEqual(before);
    // Fresh fetches must validate closure BEFORE installing even one otherwise valid A file.
    for (const o of a.outputs) if (!b.outputs.some(other => other.file.toLowerCase() === o.file.toLowerCase())) fs.rmSync(join(fx.cfg().out, o.file));
    const fresh = snapshot(fx.cfg().out);
    expect((await storePull(fx.cfg(), store, ['a'])).ok).toBe(false);
    const fetched = fetchOnly(fx); expect(fetched.status, fetched.stderr).toBe(1);
    expect(fetched.json.fetched).toBe(0); expect(snapshot(fx.cfg().out)).toEqual(fresh);
    expect((await storeStatus(fx.cfg(), undefined, ['b'])).localOk).toBe(1);
  });

  it('rejects an orphan source in direct --pull before overwriting B', async () => {
    const fx = clone(), lock = readLock(fx.cfg().lock)!, a = lock.assets.a;
    const files = filesOf(fx, a), bSource = lock.assets.b.outputs.find(o => o.file.startsWith('sample-'))!;
    const poison = Buffer.from(fs.readFileSync(join(fx.cfg().out, bSource.file))); poison.fill(0, 44);
    files.set(bSource.file, poison);
    const outputs = [...files].map(([file, data]) => ref(file, data)), store = new DirStore(fx.path('store'));
    await store.put(storeName(a.inputHash), packAsset('a', a.inputHash, outputs, name => files.get(name)!));
    delete lock.assets.a; writeLock(fx.cfg().lock, lock);
    for (const o of a.outputs) fs.rmSync(join(fx.cfg().out, o.file));
    const before = snapshot(fx.cfg().out), lockBefore = fs.readFileSync(fx.cfg().lock);
    await expect(runBuild(fx.cfg(), {pull: true, store, only: ['a']})).rejects.toThrow(/orphan.*sample/i);
    expect(snapshot(fx.cfg().out)).toEqual(before); expect(fs.readFileSync(fx.cfg().lock)).toEqual(lockBefore);
  });
});

describe('runtime cue namespace ownership', () => {
  it.each(['A.RUNTIME.JSON', 'B.RUNTIME.JSON'])('requires an exact canonical owner filename for %s', alias => {
    const fx = clone(), lock = readLock(fx.cfg().lock)!, a = lock.assets.a, files = filesOf(fx, a);
    files.set(alias, fs.readFileSync(join(fx.cfg().out, alias.toLowerCase())));
    a.outputs = [...files].map(([file, bytes]) => ref(file, bytes));
    expect(() => validateDeliveredAsset('a', a, file => files.get(file))).toThrow(/runtime cue filename/);
  });

  it('rejects a foreign cue case alias before store or standalone fetch can overwrite B', async () => {
    const fx = clone(), lock = readLock(fx.cfg().lock)!, a = lock.assets.a, files = filesOf(fx, a);
    const alias = 'B.RUNTIME.JSON', bFile = join(fx.cfg().out, 'b.runtime.json'), beforeB = fs.readFileSync(bFile);
    files.set(alias, beforeB);
    a.outputs = [...files].map(([file, bytes]) => ref(file, bytes)); writeLock(fx.cfg().lock, lock);
    const store = new DirStore(fx.path('store'));
    expect((await storeStatus(fx.cfg(), undefined, ['a'])).localOk).toBe(0);
    expect((await storePush(fx.cfg(), store, ['a'])).ok).toBe(false);
    expect(fetchOnly(fx, true).status).toBe(1);
    expect(fetchOnly(fx).status).toBe(1);
    files.set(alias, Buffer.from('{}'));
    a.outputs = [...files].map(([file, bytes]) => ref(file, bytes)); writeLock(fx.cfg().lock, lock);
    await store.put(storeName(a.inputHash), packAsset('a', a.inputHash, a.outputs, file => files.get(file)!));
    for (const o of a.outputs) if (o.file !== alias) fs.rmSync(join(fx.cfg().out, o.file));
    const before = snapshot(fx.cfg().out);
    expect((await storePull(fx.cfg(), store, ['a'])).ok).toBe(false);
    const fetched = fetchOnly(fx); expect(fetched.status, fetched.stderr).toBe(1);
    expect(snapshot(fx.cfg().out)).toEqual(before); expect(fs.readFileSync(bFile)).toEqual(beforeB);
    expect((await storeStatus(fx.cfg(), undefined, ['b'])).localOk).toBe(1);
  });

  it('does not retire an injected foreign cue case alias when removing A', async () => {
    const fx = clone(), lock = readLock(fx.cfg().lock)!, a = lock.assets.a;
    const bFile = join(fx.cfg().out, 'b.runtime.json'), beforeB = fs.readFileSync(bFile);
    a.outputs.push(ref('B.RUNTIME.JSON', beforeB)); writeLock(fx.cfg().lock, lock);
    fx.write('recipes.json', {b: {source: 'sfx/b.json', role: 'sfx', delivery: 'runtime'}});
    expect((await runBuild(fx.cfg())).ok).toBe(true);
    expect(fs.existsSync(join(fx.cfg().out, 'a.runtime.json'))).toBe(false);
    expect(fs.existsSync(bFile)).toBe(true); expect(fs.readFileSync(bFile)).toEqual(beforeB);
    expect((await storeStatus(fx.cfg(), undefined, ['b'])).localOk).toBe(1);
  });
});

describe('source retirement ownership', () => {
  it.each(['warm-rebuild', 'direct-pull', 'remove-recipe', 'remove-recipe-case'] as const)('does not delete injected B outputs during %s, and still retires obsolete A sources', async mode => {
    const fx = clone(), lock = readLock(fx.cfg().lock)!, a = lock.assets.a;
    const originalA = a.outputs.find(o => o.file.startsWith('sample-'))!, bSource = lock.assets.b.outputs.find(o => o.file.startsWith('sample-'))!;
    a.outputs.push({...bSource, ...(mode === 'remove-recipe-case' ? {file: bSource.file.toUpperCase()} : {})});
    // The old cue cannot authorize cleanup: it is corrupt, absent, or contains a lie.
    fs.rmSync(join(fx.cfg().out, 'a.runtime.json'));
    if (mode === 'warm-rebuild') fs.writeFileSync(join(fx.cfg().out, 'a.runtime.json'), '{}');
    writeLock(fx.cfg().lock, lock);
    const patch = fx.read('sfx/a.json'); patch.layers = patch.layers.filter((l: any) => l.source.type !== 'sample');
    fx.write('sfx/a.json', patch);
    const store = new DirStore(fx.path('store'));
    if (mode === 'direct-pull') {
      const good = clone(); good.write('sfx/a.json', patch);
      await runBuild(good.cfg(), {only: ['a']});
      const updated = readLock(good.cfg().lock)!.assets.a;
      await store.put(storeName(updated.inputHash), packAsset('a', updated.inputHash, updated.outputs, name => fs.readFileSync(join(good.cfg().out, name))));
    }
    if (mode.startsWith('remove-recipe')) fx.write('recipes.json', {b: {source: 'sfx/b.json', role: 'sfx', delivery: 'runtime'}});
    const beforeB = fs.readFileSync(join(fx.cfg().out, bSource.file));
    const r = await runBuild(fx.cfg(), mode.startsWith('remove-recipe') ? {} : {only: ['a'], ...(mode === 'direct-pull' ? {pull: true, store} : {})});
    expect(r.ok).toBe(true);
    if (mode === 'direct-pull') expect(r.pulled).toEqual(['a']);
    expect(fs.existsSync(join(fx.cfg().out, originalA.file))).toBe(false);
    expect(fs.existsSync(join(fx.cfg().out, bSource.file))).toBe(true);
    expect(fs.readFileSync(join(fx.cfg().out, bSource.file))).toEqual(beforeB);
    expect((await storeStatus(fx.cfg(), undefined, ['b'])).localOk).toBe(1);
  });
});
