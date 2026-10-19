import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { runBuild, openBuildProject } from '../../src/build/build.ts';
import { readLock, writeLock, emptyLock, currentToolchain } from '../../src/build/lock.ts';
import { verifyOutputs, verifyParity } from '../../src/build/verify.ts';
import { packAsset, unpackAsset } from '../../src/build/store.ts';
import { canonicalJson } from '../../src/hash.ts';
import { makeCue, cueText } from '../../src/runtime/cue.ts';
import { defaultProject } from '../../src/schema/project.ts';
import { samplePaths, writeSampleObject } from '../../src/samples/store.ts';
import { initProject, savePatch } from '../../src/project.ts';
import { sampleFixture } from '../helpers/samples.ts';
import { writeWav } from '../../src/audio/wav.ts';
import { makeFixture, cloneFixture, snapshot } from '../helpers/build-fixture.ts';

const hash = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const owned = (cue: string, asset: string) => `sample-${hash(canonicalJson({ cue, asset }))}.wav`;
function fixture() {
  const fx = makeFixture({ config: { target: 'wav-master' } }), f = sampleFixture({ hybrid: true });
  writeSampleObject(samplePaths(openBuildProject(fx.cfg())).objects, f.wav);
  const names = ['recorded', 'hybrid', 'a'.repeat(60)];
  names.forEach((name, i) => fx.write(`sfx/${name}.json`, { ...f.patch, name, ...(i === 0 ? { layers: [f.patch.layers[0]] } : {}) }));
  fx.write('recipes.json', Object.fromEntries(names.map((name, i) => [name, { source: `sfx/${name}.json`, role: 'sfx', delivery: ['baked', 'both', 'runtime'][i] }])));
  return { fx, f, names };
}

describe('hybrid delivered files', () => {
  let base: ReturnType<typeof fixture>;
  beforeAll(async () => { base = fixture(); await runBuild(base.fx.cfg()); }, 120000);

  it('owns exact canonical bytes in runtime and both lock outputs; baked owns no sources', () => {
    const { fx, f, names } = base, lock = readLock(fx.cfg().lock)!;
    expect(lock.assets.recorded.outputs.some(o => o.file.startsWith('sample-'))).toBe(false);
    for (const name of names.slice(1)) {
      const file = owned(name, f.id), cue = fx.read(`public/audio/${name}.runtime.json`);
      expect(cue.assets).toEqual({ [f.id]: { file, bytes: f.wav.length, frames: 57600, channels: 2, sampleRate: 48000 } });
      expect(file.length).toBe(75);
      expect(lock.assets[name].outputs.map(o => o.file)).toContain(file);
      expect(fs.readFileSync(fx.path(`public/audio/${file}`))).toEqual(f.wav);
    }
    expect(verifyOutputs({ lock, out: fx.cfg().out }).problems).toEqual([]);
    const long = names[2], asset = lock.assets[long];
    const tar = packAsset(long, asset.inputHash, asset.outputs, name => fs.readFileSync(join(fx.cfg().out, name)));
    expect(unpackAsset(tar).files.get(owned(long, f.id))).toEqual(f.wav);
  });

  it.each(['baked', 'runtime', 'both'] as const)('rejects missing/corrupt author bytes before warm %s check/adopt/reuse', async delivery => {
    const fx = cloneFixture(base.fx), name = base.names[['baked', 'both', 'runtime'].indexOf(delivery)];
    const objects = samplePaths(openBuildProject(fx.cfg())).objects, file = join(objects, `${base.f.id.slice(7)}.wav`);
    fs.writeFileSync(file, Buffer.from('corrupt'));
    for (const options of [{}, { check: true }, { adopt: true }]) await expect(runBuild(fx.cfg(), { ...options, only: [name] })).rejects.toMatchObject({ code: 'E_VERIFY' });
    fs.rmSync(file);
    await expect(runBuild(fx.cfg(), { check: true, only: [name] })).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
  });

  it('rebuilds and removes one owner without deleting the other owner of the same source', async () => {
    const fx = cloneFixture(base.fx), name = base.names[2], other = owned(name, base.f.id);
    const p = fx.read('sfx/hybrid.json'); p.layers = p.layers.filter((l: any) => l.source.type !== 'sample'); fx.write('sfx/hybrid.json', p);
    await runBuild(fx.cfg());
    expect(fs.existsSync(fx.path(`public/audio/${owned('hybrid', base.f.id)}`))).toBe(false);
    expect(fs.readFileSync(fx.path(`public/audio/${other}`))).toEqual(base.f.wav);
    // Restore its recorded layer, then exercise recipe removal while it owns a source.
    fx.write('sfx/hybrid.json', base.fx.read('sfx/hybrid.json'));
    await runBuild(fx.cfg());
    const recipes = fx.read('recipes.json'); delete recipes.hybrid; fx.write('recipes.json', recipes);
    await runBuild(fx.cfg());
    expect(fs.existsSync(fx.path(`public/audio/${owned('hybrid', base.f.id)}`))).toBe(false);
    expect(fs.readFileSync(fx.path(`public/audio/${other}`))).toEqual(base.f.wav);
  }, 120000);

  it('verifies native sample-only and hybrid parity using delivered sources after removing the author store', async () => {
    const fx = cloneFixture(base.fx);
    // Include sample-only runtime parity as well as the hybrid source+noise path.
    fx.write('recipes.json', { recorded: { source: 'sfx/recorded.json', role: 'sfx', delivery: 'runtime' }, hybrid: { source: 'sfx/hybrid.json', role: 'sfx', delivery: 'both' } });
    await runBuild(fx.cfg());
    fs.rmSync(samplePaths(openBuildProject(fx.cfg())).dir, { recursive: true });
    const r = await verifyParity({ lock: fx.cfg().lock, out: fx.cfg().out, engines: ['chromium'] });
    expect(r.problems).toEqual([]);
    expect(r.parity.verdicts).toHaveLength(2);
    expect(r.parity.verdicts.every(v => v.ok && v.measured.maxAbsDb === -Infinity)).toBe(true);
  }, 120000);

  it('counts fixed source/cue/sidecar bytes when changing only the baked bitrate', async () => {
    const { fx, f } = fixture(); fx.write('recipes.json', { hybrid: { source: 'sfx/hybrid.json', role: 'sfx', delivery: 'both' } });
    const cfg = fx.cfg({ target: 'web-universal', kbps: { sfx: 96 } });
    await runBuild(cfg);
    const lock = readLock(cfg.lock)!, outputs = lock.assets.hybrid.outputs;
    expect(fs.readFileSync(fx.path(`public/audio/${owned('hybrid', f.id)}`))).toEqual(f.wav);
    expect(outputs.some(o => /\.ogg$/.test(o.file))).toBe(true);
    const fixed = outputs.filter(o => !/\.(ogg|mp3)$/.test(o.file)).reduce((n, o) => n + o.bytes, 0);
    const encoded = outputs.filter(o => /\.(ogg|mp3)$/.test(o.file)).reduce((n, o) => n + o.bytes, 0);
    const r = await runBuild({ ...cfg, kbps: { sfx: 48 } }, { check: true });
    expect(r.estimate.totalBytes).toBe(fixed + Math.ceil(encoded / 2));
  }, 120000);
});

describe('pre-render runtime budgets', () => {
  it.each(['runtime', 'both'])('includes actual source bytes and cue overhead for new %s output', async delivery => {
    const { fx, f } = fixture(); fx.write('recipes.json', { hybrid: { source: 'sfx/hybrid.json', role: 'sfx', delivery } });
    await expect(runBuild(fx.cfg({ budgetBytes: f.wav.length - 1 }))).rejects.toMatchObject({ code: 'E_BUDGET' });
    expect(fs.existsSync(fx.cfg().out)).toBe(false);
  });
  it.each(['larger-recording', 'procedural-to-sample', 'baked-to-both'])('uses current dependency/delivery sizes before warm %s replacement', async change => {
    const fx = makeFixture({ config: { target: 'web-universal' } }), f = sampleFixture();
    const objects = samplePaths(openBuildProject(fx.cfg())).objects;
    writeSampleObject(objects, f.wav);
    const initial = structuredClone(f.patch);
    if (change === 'larger-recording') {
      const small = writeSampleObject(objects, writeWav(f.pcm.map(c => c.slice(0, 4800)), 48000, { bits: 32 }));
      initial.layers[0].source = { type: 'sample', asset: small.id };
    }
    if (change === 'procedural-to-sample') initial.layers[0].source = { type: 'noise', color: 'pink' };
    fx.write('sfx/current.json', initial);
    fx.write('recipes.json', { [f.patch.name]: { source: 'sfx/current.json', role: 'sfx', delivery: change === 'baked-to-both' ? 'baked' : 'runtime' } });
    const cfg = fx.cfg({ budgetBytes: 100000 });
    const first = await runBuild(cfg);
    expect(first.estimate.totalBytes).toBeLessThan(cfg.budgetBytes!);
    const before = snapshot(cfg.out), lockBefore = fs.readFileSync(cfg.lock);
    fx.write('sfx/current.json', f.patch);
    fx.write('recipes.json', { [f.patch.name]: { source: 'sfx/current.json', role: 'sfx', delivery: change === 'baked-to-both' ? 'both' : 'runtime' } });
    const check = await runBuild(cfg, { check: true });
    await expect(runBuild(cfg)).rejects.toMatchObject({ code: 'E_BUDGET' });
    expect(check.estimate.totalBytes).toBeGreaterThan(f.wav.length);
    expect(snapshot(cfg.out)).toEqual(before);
    expect(fs.readFileSync(cfg.lock)).toEqual(lockBefore);
  }, 120000);
});

describe('standalone runtime export', () => {
  it('exports exact owned sources and preserves unrelated/foreign referenced files when replacing a cue', () => {
    const fx = makeFixture(), p = initProject(fx.path('author')), f = sampleFixture();
    savePatch(p, f.patch); writeSampleObject(samplePaths(p).objects, f.wav);
    const out = fx.path('export'), bin = join(import.meta.dirname, '../../scripts/beeps.mjs');
    const run = () => spawnSync(process.execPath, [bin, 'runtime', 'export', f.patch.name, '--out', out], { cwd: fx.path('author'), encoding: 'utf8', windowsHide: true });
    let r = run(); expect(r.status, r.stderr).toBe(0);
    const file = owned(f.patch.name, f.id), cuePath = join(out, `${f.patch.name}.runtime.json`);
    expect(fs.readFileSync(join(out, file))).toEqual(f.wav);
    expect(JSON.parse(fs.readFileSync(cuePath, 'utf8')).assets[f.id].file).toBe(file);
    const verify = () => spawnSync(process.execPath, [bin, 'runtime', 'verify', out, f.patch.name, '--no-trim'], { cwd: fx.path('author'), encoding: 'utf8', windowsHide: true });
    r = verify(); expect(r.status, r.stderr).toBe(0);
    fs.rmSync(join(out, file));
    r = verify(); expect(r.status, r.stderr).toBe(1);
    const tampered = Buffer.from(f.wav); tampered[tampered.length - 1] ^= 1;
    fs.writeFileSync(join(out, file), tampered);
    r = verify(); expect(r.status, r.stderr).toBe(1); expect(r.stdout).toMatch(/hash mismatch/);
    fs.rmSync(join(out, file));
    const target = fx.path('external'); fs.mkdirSync(target);
    fs.symlinkSync(target, join(out, file), process.platform === 'win32' ? 'junction' : 'dir');
    r = verify(); expect(r.status, r.stderr).toBe(1); expect(r.stdout).toMatch(/not a regular file/);
    fs.rmSync(join(out, file));
    fs.writeFileSync(join(out, file), f.wav);
    const altered = JSON.parse(fs.readFileSync(cuePath, 'utf8'));
    Object.assign(altered.assets[f.id], { frames: 115200, channels: 1 });
    fs.writeFileSync(cuePath, JSON.stringify(altered));
    r = verify(); expect(r.status, r.stderr).toBe(1); expect(r.stdout).toMatch(/metadata disagrees/);
    fs.writeFileSync(cuePath, cueText({ ...altered, assets: { [f.id]: { ...altered.assets[f.id], frames: 57600, channels: 2 } } }));
    const goodCue = fs.readFileSync(cuePath);
    fs.writeFileSync(cuePath, '{');
    r = verify(); expect(r.status, r.stderr).toBe(1); expect(r.stdout).toMatch(/invalid cue JSON/);
    fs.rmSync(cuePath);
    fs.writeFileSync(join(target, 'outside.runtime.json'), goodCue);
    fs.symlinkSync(target, cuePath, process.platform === 'win32' ? 'junction' : 'dir');
    r = verify(); expect(r.status, r.stderr).toBe(1); expect(r.stdout).toMatch(/not a regular file/);
    fs.rmSync(cuePath); fs.writeFileSync(cuePath, goodCue);
    // A hand-edited previous manifest must not authorize deletion of somebody else's file.
    const prior = JSON.parse(fs.readFileSync(cuePath, 'utf8')); prior.assets[f.id].file = 'unrelated.wav';
    fs.writeFileSync(cuePath, JSON.stringify(prior)); fs.writeFileSync(join(out, 'unrelated.wav'), 'keep');
    f.patch.layers[0].source = { type: 'noise', color: 'pink' }; savePatch(p, f.patch, { force: true });
    r = run(); expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(join(out, 'unrelated.wav'), 'utf8')).toBe('keep');
    expect(fs.existsSync(join(out, file))).toBe(false);
    expect(JSON.parse(fs.readFileSync(cuePath, 'utf8')).assets).toBeUndefined();
  }, 120000);
});

// Deliberately construct manifests independently of the delivery helper, then re-hash the
// cue and lock after attacks: lock byte hashes alone must never bless broken dependencies.
describe('semantic delivered dependency verification', () => {
  function setup() {
    const fx = makeFixture(), f = sampleFixture(), file = owned(f.patch.name, f.id);
    const cue = { ...makeCue(f.patch, defaultProject(), 1, -3), assets: { [f.id]: { file, bytes: f.wav.length, sampleRate: 48000 as const, channels: 2 as const, frames: 57600 } } };
    const lock = emptyLock({}, currentToolchain());
    lock.assets[cue.id] = { role: 'sfx', inputHash: `sha256:${'a'.repeat(64)}`, delivery: 'runtime', outputs: [] };
    const put = (name: string, b: Buffer | string) => { fs.mkdirSync(fx.cfg().out, { recursive: true }); fs.writeFileSync(join(fx.cfg().out, name), b); return { file: name, bytes: Buffer.byteLength(b), sha256: hash(b) }; };
    const refresh = () => { lock.assets[cue.id].outputs = [put(`${cue.id}.runtime.json`, cueText(cue)), put(file, f.wav)]; };
    refresh();
    return { fx, f, file, cue, lock, refresh, put, verify: () => verifyOutputs({ lock, out: fx.cfg().out }) };
  }
  it('accepts a valid independent cue/lock', () => expect(setup().verify().problems).toEqual([]));
  it.each(['runtime', 'both'] as const)('requires the expected cue in each %s inventory, even when all remaining hashes match', delivery => {
    const x = setup(), asset = x.lock.assets[x.cue.id]; asset.delivery = delivery;
    asset.outputs.shift();
    fs.rmSync(join(x.fx.cfg().out, `${x.cue.id}.runtime.json`));
    const report = verifyOutputs({ lock: x.lock, out: x.fx.cfg().out, catalog: false });
    expect(report.ok).toBe(false);
    expect(report.problems).toContainEqual({ asset: x.cue.id, problem: expect.stringMatching(/required runtime cue.*missing.*inventory/) });
  });
  it.each([false, true])('rejects a foreign cue filename even with matching cue ID/content and hashes (expected cue also present=%s)', keepExpected => {
    const x = setup(), wrong = x.put('wrong.runtime.json', cueText(x.cue));
    if (!keepExpected) x.lock.assets[x.cue.id].outputs.shift();
    x.lock.assets[x.cue.id].outputs.push(wrong);
    const report = x.verify();
    expect(report.ok).toBe(false);
    expect(report.problems.map(p => p.problem).join()).toMatch(/runtime cue filename.*owner/);
  });
  it('keeps baked-only delivery valid without any runtime cue', () => {
    const x = setup(), asset = x.lock.assets[x.cue.id];
    delete asset.delivery;
    asset.outputs = [x.put(`${x.cue.id}.wav`, x.f.wav)];
    expect(verifyOutputs({ lock: x.lock, out: x.fx.cfg().out, catalog: false }).problems).toEqual([]);
  });
  it.each(['missing', 'tampered', 'metadata', 'canonical', 'escape', 'omitted', 'foreign', 'extra'])('rejects hash-consistent %s dependencies', attack => {
    const x = setup(), meta = x.cue.assets[x.f.id];
    if (attack === 'metadata') Object.assign(meta, { frames: 115200, channels: 1 }); // same byte count, different valid metadata
    if (attack === 'escape') meta.file = '../outside.wav';
    if (attack === 'foreign') meta.file = owned('another-cue', x.f.id);
    if (attack === 'extra') x.cue.assets[`sha256:${'b'.repeat(64)}`] = { ...meta, file: owned(x.cue.id, `sha256:${'b'.repeat(64)}`) };
    if (attack === 'canonical') { x.f.wav.writeUInt32LE(44100, 24); const id = `sha256:${hash(x.f.wav)}`; (x.cue.patch.layers[0].source as any).asset = id; delete x.cue.assets[x.f.id]; x.cue.assets[id] = { ...meta, file: owned(x.cue.id, id) }; }
    x.refresh();
    if (attack === 'canonical') { const id = `sha256:${hash(x.f.wav)}`; x.lock.assets[x.cue.id].outputs[1] = x.put(x.cue.assets[id].file, x.f.wav); }
    if (attack === 'missing') fs.rmSync(join(x.fx.cfg().out, x.file));
    if (attack === 'omitted') x.lock.assets[x.cue.id].outputs.pop();
    if (attack === 'tampered') { x.f.wav[x.f.wav.length - 1] ^= 1; x.lock.assets[x.cue.id].outputs[1] = x.put(x.file, x.f.wav); }
    if (attack === 'foreign') { x.lock.assets[x.cue.id].outputs.pop(); x.lock.assets['another-cue'] = { role: 'sfx', inputHash: 'x', outputs: [x.put(meta.file, x.f.wav)] }; }
    const report = x.verify();
    expect(report.ok).toBe(false);
    if (attack === 'canonical') expect(report.problems.map(p => p.problem).join()).toMatch(/canonical 48 kHz/);
    if (attack === 'metadata') expect(report.problems.map(p => p.problem).join()).toMatch(/metadata disagrees/);
  });
  it.each(['../outside.wav', 'nested/a.wav', 'C:outside.wav', '/absolute.wav', 'a\\b.wav'])('rejects unsafe in-memory lock name %s before reading any output', file => {
    const x = setup(); x.lock.assets[x.cue.id].outputs[1].file = file;
    // Reading even the first (otherwise safe) output would throw EISDIR. Reject the
    // complete inventory before attempting any output reads, including earlier entries.
    const first = join(x.fx.cfg().out, x.lock.assets[x.cue.id].outputs[0].file);
    fs.rmSync(first); fs.mkdirSync(first);
    expect(x.verify().ok).toBe(false);
  });
  it('rejects unsafe on-disk lock names on load before build can reuse or remove them', () => {
    const x = setup(); x.lock.assets[x.cue.id].outputs[0].file = '../outside.wav';
    writeLock(x.fx.cfg().lock, x.lock);
    expect(() => readLock(x.fx.cfg().lock)).toThrow(/unsafe output/);
  });
});
