import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { RUNTIME_DIR } from '../../src/render/host.ts';
import { makeFixture, cloneFixture, snapshot, type Fixture } from '../helpers/build-fixture.ts';
import { sampleFixture } from '../helpers/samples.ts';
import { makeCue } from '../../src/runtime/cue.ts';
import { parseProject } from '../../src/schema/project.ts';
import { sampleFile } from '../../src/runtime/dependencies.ts';
import { DirStore, packAsset, sha256Hex, storeName } from '../../src/build/store.ts';
import { ciExport, storePull, storePush, storeStatus } from '../../src/build/store-ops.ts';
import { runBuild, openBuildProject } from '../../src/build/build.ts';
import { readLock, writeLock, type LockAsset } from '../../src/build/lock.ts';
import { samplePaths, writeSampleObject } from '../../src/samples/store.ts';

const fixtures: Fixture[] = [];
const make = () => { const fx = makeFixture({ config: { target: 'wav-master' } }); fixtures.push(fx); return fx; };
const clone = (base: Fixture) => { const fx = cloneFixture(base); fixtures.push(fx); return fx; };
afterAll(() => { for (const f of fixtures) fs.rmSync(f.dir, { recursive: true, force: true }); });
const ref = (file: string, bytes: Buffer) => ({ file, bytes: bytes.length, sha256: sha256Hex(bytes) });
const faults = ['no-cue', 'wrong-cue-name', 'extra-foreign-cue', 'header', 'metadata', 'metadata-disagreement', 'foreign-source-file', 'noncanonical', 'nonfinite', 'missing-source', 'tampered-source', 'omitted-lock-source', 'foreign-owner', 'escaping-dependency'] as const;
type Fault = typeof faults[number];
function poisoned(fx: Fixture, fault?: Fault) {
  const s = sampleFixture({ hybrid: true }), owner = 'hybrid';
  let id = s.id, wav = Buffer.from(s.wav);
  if (fault === 'noncanonical') wav.writeUInt16LE(1, 20);
  if (fault === 'nonfinite') wav.writeFloatLE(NaN, 44);
  if (fault === 'noncanonical' || fault === 'nonfinite') id = `sha256:${sha256Hex(wav)}`;
  const file = sampleFile(owner, id);
  const patch = structuredClone(s.patch); patch.name = owner;
  (patch.layers[0].source as {asset: string}).asset = id;
  const cue = makeCue(patch, parseProject({ schema: 'beeps/project@1' }), 1, 0, {
    [id]: { file, bytes: wav.length, frames: 57600, channels: 2, sampleRate: 48000 },
  });
  if (fault === 'header') (cue as any).schema = 'wrong';
  if (fault === 'metadata') cue.assets![id].channels = 1;
  if (fault === 'metadata-disagreement') {cue.assets![id].channels = 1; cue.assets![id].frames *= 2;}
  if (fault === 'foreign-source-file') cue.assets![id].file = sampleFile('other', id);
  if (fault === 'foreign-owner') cue.id = 'other';
  if (fault === 'escaping-dependency') cue.assets![id].file = '../private.wav';
  if (fault === 'tampered-source') wav[100] ^= 1;
  const files = new Map([[fault === 'wrong-cue-name' ? 'other.runtime.json' : 'hybrid.runtime.json', Buffer.from(JSON.stringify(cue))], [file, wav]]);
  if (fault === 'extra-foreign-cue') files.set('other.runtime.json', Buffer.from(JSON.stringify(cue)));
  if (fault === 'foreign-source-file') {files.delete(file); files.set(cue.assets![id].file, wav);}
  if (fault === 'no-cue') files.delete('hybrid.runtime.json');
  if (fault === 'missing-source' || fault === 'omitted-lock-source') files.delete(file);
  const outputs = [...files].map(([f, b]) => ref(f, b));
  if (fault === 'missing-source') outputs.push(ref(file, s.wav));
  const asset: LockAsset = { inputHash: 'sha256:' + 'a'.repeat(64), role: 'sfx', delivery: 'runtime', outputs };
  fx.write('audio.lock.json', {schema: 'beeps/build-lock@1', assets: { hybrid: asset }});
  return { files, asset };
}
function local(fx: Fixture, files: Map<string, Buffer>) {
  fs.mkdirSync(fx.cfg().out, {recursive: true});
  for (const [f, b] of files) fs.writeFileSync(join(fx.cfg().out, f), b);
}
function runFetch(fx: Fixture, check = false, only?: string) {
  const script = ciExport(fx.cfg(), fx.path('tools'), `dir:${fx.path('store')}`);
  const r = spawnSync(process.env.BEEPS_TEST_NODE20 ?? process.execPath, [script.file, ...(check ? ['--check'] : []), ...(only ? ['--only', only] : [])], {
    cwd: fx.dir, encoding: 'utf8', windowsHide: true, env: {...process.env, PATH: '', BEEPS_FFMPEG: ''},
  });
  return { ...r, json: r.stdout.trim() ? JSON.parse(r.stdout.trim().split('\n').pop()!) : undefined };
}

describe('portable hybrid integrity', () => {
  it.each(faults)('rejects hash-consistent %s locally and before store/fetch installation', async fault => {
    const fx = make(), {files, asset} = poisoned(fx, fault), store = new DirStore(fx.path('store'));
    local(fx, files);
    expect((await storeStatus(fx.cfg(), undefined)).localOk).toBe(0);
    const pushed = await storePush(fx.cfg(), store);
    expect(pushed.ok).toBe(false);
    expect(store.names()).toEqual([]);
    const before = snapshot(fx.cfg().out);
    const check = runFetch(fx, true);
    expect(check.status, check.stderr).toBe(1);
    expect(snapshot(fx.cfg().out)).toEqual(before);
    // Publish deliberately hash-consistent poison without going through push validation.
    // A missing source has an inventory entry but no bytes, represented by a missing tar entry.
    const packed = fault === 'missing-source' ? asset.outputs.filter(o => files.has(o.file)) : asset.outputs;
    await store.put(storeName(asset.inputHash), packAsset('hybrid', asset.inputHash, packed, f => files.get(f)!));
    // Already present outputs cannot bypass validation even without --check.
    expect(runFetch(fx).status).toBe(1);
    fs.rmSync(fx.cfg().out, {recursive: true});
    const pulled = await storePull(fx.cfg(), store);
    expect(pulled.ok).toBe(false);
    expect(pulled.present).toEqual([]);
    expect(snapshot(fx.cfg().out)).toEqual({});
    const fetched = runFetch(fx);
    expect(fetched.status, fetched.stderr).toBe(1);
    expect(fetched.json.fetched).toBe(0);
    expect(snapshot(fx.cfg().out)).toEqual({});
  });

  it('checks local integrity even when a store entry already exists', async () => {
    const fx = make(), {files, asset} = poisoned(fx, 'no-cue'), store = new DirStore(fx.path('store'));
    local(fx, files);
    await store.put(storeName(asset.inputHash), packAsset('hybrid', asset.inputHash, asset.outputs, f => files.get(f)!));
    expect((await storePush(fx.cfg(), store)).ok).toBe(false);
  });

  it('rejects a foreign store manifest owner before installation', async () => {
    const fx = make(), {files, asset} = poisoned(fx), store = new DirStore(fx.path('store'));
    await store.put(storeName(asset.inputHash), packAsset('foreign', asset.inputHash, asset.outputs, f => files.get(f)!));
    expect((await storePull(fx.cfg(), store)).problems[0].problem).toMatch(/owner/);
    const fetched = runFetch(fx); expect(fetched.status, fetched.stderr).toBe(1);
    expect(fetched.json.problems.join()).toMatch(/owner/);
    expect(snapshot(fx.cfg().out)).toEqual({});
  });

  it.each(['../escape.wav', 'CON.wav', 'safe..wav'])('rejects unsafe lock filename %s before fetch writes', file => {
    const fx = make(), {asset} = poisoned(fx);
    asset.outputs.push(ref(file, Buffer.from('escape')));
    fx.write('audio.lock.json', {schema: 'beeps/build-lock@1', assets: {hybrid: asset}});
    const fetched = runFetch(fx); expect(fetched.status).toBe(1);
    expect(fetched.json.problems.join()).toMatch(/unsafe output filename/);
    expect(fs.existsSync(fx.cfg().out)).toBe(false);
  });

  it('rejects actual Windows junction outputs without following the target', async () => {
    const fx = make(), {files} = poisoned(fx); local(fx, files);
    const cue = join(fx.cfg().out, 'hybrid.runtime.json'), outside = fx.path('outside');
    fs.mkdirSync(outside); fs.writeFileSync(join(outside, 'sentinel'), 'untouched');
    fs.rmSync(cue); fs.symlinkSync(outside, cue, 'junction');
    expect(fs.lstatSync(cue).isSymbolicLink()).toBe(true);
    expect((await storeStatus(fx.cfg(), undefined)).localOk).toBe(0);
    const result = runFetch(fx, true); expect(result.status, result.stderr).toBe(1);
    expect(result.json.problems.join()).toMatch(/not a regular file/);
    expect(fs.readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('untouched');
  });

  it('does not bless nonregular local outputs in store status or standalone check', async () => {
    const fx = make(), { files } = poisoned(fx);
    local(fx, files);
    fs.rmSync(join(fx.cfg().out, 'hybrid.runtime.json'));
    fs.mkdirSync(join(fx.cfg().out, 'hybrid.runtime.json'));
    expect((await storeStatus(fx.cfg(), undefined)).localOk).toBe(0);
    expect(runFetch(fx, true).status).toBe(1);
  });
});

describe('real hybrid store and direct build pulls', () => {
  let base: Fixture;
  beforeAll(async () => {
    base = make(); const s = sampleFixture({hybrid: true});
    writeSampleObject(samplePaths(openBuildProject(base.cfg())).objects, s.wav);
    base.write('recipes.json', Object.fromEntries(['baked', 'runtime', 'both'].map(delivery => [delivery, {source: `sfx/${delivery}.json`, role:'sfx', delivery}])));
    for (const name of ['baked', 'runtime', 'both']) base.write(`sfx/${name}.json`, {...s.patch, name});
    await runBuild(base.cfg());
  }, 120000);

  it('relocates all three delivery modes through store pull and standalone fetch with no author store', async () => {
    const fx = clone(base), store = new DirStore(fx.path('store'));
    expect((await storePush(fx.cfg(), store)).pushed).toEqual(['baked', 'both', 'runtime']);
    const expected = snapshot(fx.cfg().out);
    fs.rmSync(samplePaths(openBuildProject(fx.cfg())).dir, {recursive: true});
    fs.rmSync(fx.cfg().out, {recursive: true});
    expect((await storePull(fx.cfg(), store)).ok).toBe(true);
    expect(snapshot(fx.cfg().out)).toEqual(expected);
    fs.rmSync(fx.cfg().out, {recursive: true});
    const r = runFetch(fx); expect(r.status, r.stderr).toBe(0);
    expect(r.json).toMatchObject({fetched: 3, present: 0});
    expect(snapshot(fx.cfg().out)).toEqual(expected);
    fs.rmSync(fx.path('store'), {recursive: true});
    expect(runFetch(fx, true).status).toBe(0);
    expect(runFetch(fx).json).toMatchObject({fetched: 0, present: 3});
  });

  it('isolates --only from an unrelated malformed hybrid cue', async () => {
    const fx = clone(base), store = new DirStore(fx.path('store'));
    expect((await storePush(fx.cfg(), store, ['both'])).ok).toBe(true);
    const lock = readLock(fx.cfg().lock)!, cue = fx.read('public/audio/runtime.runtime.json'); cue.schema = 'wrong';
    fx.write('public/audio/runtime.runtime.json', cue);
    lock.assets.runtime.outputs = lock.assets.runtime.outputs.map(o => o.file === 'runtime.runtime.json' ? ref(o.file, fs.readFileSync(join(fx.cfg().out, o.file))) : o);
    writeLock(fx.cfg().lock, lock);
    for (const o of lock.assets.both.outputs) fs.rmSync(join(fx.cfg().out, o.file));
    const before = snapshot(fx.cfg().out);
    expect((await storePull(fx.cfg(), store, ['both'])).pulled).toEqual(['both']);
    for (const [file, hash] of Object.entries(before)) expect(snapshot(fx.cfg().out)[file]).toBe(hash);
    expect(runFetch(fx, true, 'both').status).toBe(0);
    expect(runFetch(fx, true, 'runtime').status).toBe(1);
  });

  it('checks locked byte counts as well as hashes on direct build --pull', async () => {
    const fx = clone(base), store = new DirStore(fx.path('store'));
    await storePush(fx.cfg(), store, ['runtime']);
    const lock = readLock(fx.cfg().lock)!; lock.assets.runtime.outputs[0].bytes++;
    writeLock(fx.cfg().lock, lock);
    fs.rmSync(fx.cfg().out, {recursive: true});
    const before = fs.readFileSync(fx.cfg().lock);
    await expect(runBuild(fx.cfg(), {pull: true, store, only: ['runtime']})).rejects.toThrow(/does not match the lock/);
    expect(snapshot(fx.cfg().out)).toEqual({});
    expect(fs.readFileSync(fx.cfg().lock)).toEqual(before);
  });

  it('pulls a new hybrid build from its manifest before any render', async () => {
    const fx = clone(base), store = new DirStore(fx.path('store'));
    await storePush(fx.cfg(), store);
    const expected = snapshot(fx.cfg().out);
    fs.rmSync(fx.cfg().out, {recursive: true}); fs.rmSync(fx.cfg().lock);
    const r = await runBuild(fx.cfg(), {pull: true, store, hooks: {afterBuild: () => {throw new Error('unexpected render');}}});
    expect(r.pulled.sort()).toEqual(['baked', 'both', 'runtime']); expect(r.built).toEqual([]);
    expect(snapshot(fx.cfg().out)).toEqual(expected);
  });

  it.each(['runtime', 'both'])('does not reuse or adopt hash-consistent malformed %s cues', async id => {
    const fx = clone(base), lock = readLock(fx.cfg().lock)!, asset = lock.assets[id];
    const file = `${id}.runtime.json`, cue = fx.read(`public/audio/${file}`); cue.schema = 'wrong';
    fx.write(`public/audio/${file}`, cue);
    asset.outputs = asset.outputs.map(o => o.file === file ? ref(file, fs.readFileSync(join(fx.cfg().out, file))) : o);
    writeLock(fx.cfg().lock, lock);
    const before = snapshot(fx.cfg().out);
    const checked = await runBuild(fx.cfg(), {check: true, only: [id]});
    expect(checked.ok).toBe(false); expect(checked.unchanged).not.toContain(id);
    expect(checked.stale[0].reasons.join()).toMatch(/runtime-cue/);
    lock.keyScheme = 'foreign'; writeLock(fx.cfg().lock, lock);
    const adopted = await runBuild(fx.cfg(), {check: true, adopt: true, only: [id]});
    expect(adopted.ok).toBe(false); expect(adopted.adopted).toEqual([]);
    expect(snapshot(fx.cfg().out)).toEqual(before);
  });

  it('plays actually fetched runtime and baked hybrid PCM on a static project subpath', async () => {
    const fx = clone(base), store = new DirStore(fx.path('store'));
    await storePush(fx.cfg(), store);
    fs.rmSync(samplePaths(openBuildProject(fx.cfg())).dir, {recursive: true});
    fs.rmSync(fx.cfg().out, {recursive: true});
    const fetched = runFetch(fx); expect(fetched.status, fetched.stderr).toBe(0);
    fs.rmSync(fx.path('store'), {recursive: true});
    // The server sees only copied delivered files and public runtime modules.
    const site = fx.path('site');
    fs.mkdirSync(join(site, 'game'), {recursive: true});
    fs.cpSync(fx.cfg().out, join(site, 'game/audio'), {recursive: true});
    fs.cpSync(join(RUNTIME_DIR, 'engine'), join(site, 'game/engine'), {recursive: true});
    fs.cpSync(join(RUNTIME_DIR, 'player'), join(site, 'game/player'), {recursive: true});
    const requests: string[] = [];
    const server = createServer((req, res) => {
      const path = new URL(req.url!, 'http://localhost').pathname; requests.push(path);
      if (path === '/game/test.html') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Fetched audio proof</title>'); return; }
      if (!/^\/game\/(audio|engine|player)\/[a-zA-Z0-9_.-]+$/.test(path)) {res.writeHead(404).end(); return;}
      const file = join(site, path);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {res.writeHead(404).end(); return;}
      res.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.json') ? 'application/json' : 'audio/wav');
      res.end(fs.readFileSync(file));
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as {port: number}).port;
    const browser = await chromium.launch({args: ['--autoplay-policy=no-user-gesture-required']});
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/game/test.html`);
      const result = await page.evaluate(async () => {
        const engineURL = '/game/engine/index.js', playerURL = '/game/player/player.js';
        const loadModule = new Function('url', 'return import(url)');
        const {parseCue, loadCueAssets, build} = await loadModule(engineURL);
        const {createPlayer} = await loadModule(playerURL);
        const stats = (pcm: Float32Array) => ({finite: pcm.every(Number.isFinite), peak: pcm.reduce((n, x) => Math.max(n, Math.abs(x)), 0)});
        const runtime = [];
        for (const id of ['runtime', 'both']) {
          const cueURL = new URL(`/game/audio/${id}.runtime.json`, location.href);
          const cue = parseCue(await (await fetch(cueURL)).json());
          const render = async (silent: boolean) => {
            const ctx = new OfflineAudioContext(2, 120000, 48000);
            const samples = await loadCueAssets(ctx, cue, {baseURL: new URL('./', cueURL)});
            if (silent) for (const sample of Object.values(samples) as AudioBuffer[]) for (let c = 0; c < sample.numberOfChannels; c++) sample.getChannelData(c).fill(0);
            const voice = build(ctx, ctx.destination, cue, {samples}); voice.start(0);
            const rendered = await ctx.startRendering();
            return rendered.getChannelData(0).slice();
          };
          const pcm = await render(false), silent = await render(true);
          runtime.push({id, ...stats(pcm), changedSourceDelta: pcm.reduce((n, x, i) => Math.max(n, Math.abs(x - silent[i])), 0)});
        }
        const ctx = new AudioContext({sampleRate: 48000}), analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        const muted = ctx.createGain(); muted.gain.value = 0;
        analyser.connect(muted); muted.connect(ctx.destination);
        // Add a native PCM tap at the player's real output; preserve every native connection.
        const connect = AudioNode.prototype.connect;
        AudioNode.prototype.connect = function(this: AudioNode, ...args: any[]) {
          const value = (connect as any).apply(this, args);
          if (args[0] === ctx.destination) (connect as any).call(this, analyser);
          return value;
        } as typeof connect;
        const errors: unknown[] = [];
        try {
          const player = createPlayer({catalog: '/game/audio/index.json', context: ctx, onError: (e: unknown) => errors.push(e)});
          const unlocked = await player.unlock();
          const handle = player.play('both');
          const ready = handle && await handle.ready;
          let peak = 0, finite = true;
          const pcm = new Float32Array(analyser.fftSize);
          for (let n = 0; n < 150 && peak <= .001; n++) {
            await new Promise(done => setTimeout(done, 20)); analyser.getFloatTimeDomainData(pcm);
            const s = stats(pcm); peak = Math.max(peak, s.peak); finite &&= s.finite;
          }
          player.stopAll();
          return {runtime, baked: {unlocked, ready, peak, finite, file: handle?.file, errors}};
        } finally {AudioNode.prototype.connect = connect; await ctx.close();}
      });
      if (process.env.BEEPS_TEST_STATIC_PROOF) fs.writeFileSync(process.env.BEEPS_TEST_STATIC_PROOF, JSON.stringify({browser: browser.version(), node: spawnSync(process.env.BEEPS_TEST_NODE20 ?? process.execPath, ['--version'], {encoding: 'utf8', windowsHide: true}).stdout.trim(), result, requests}, null, 2));
      expect(result.runtime).toHaveLength(2);
      for (const r of result.runtime) {expect(r.finite).toBe(true); expect(r.peak).toBeGreaterThan(.001); expect(r.changedSourceDelta).toBeGreaterThan(.001);}
      expect(result.baked).toMatchObject({unlocked: true, ready: true, finite: true, errors: []});
      expect(result.baked.peak).toBeGreaterThan(.001);
      expect(result.baked.file).toMatch(/^both.*\.wav$/);
      expect(requests).toContain('/game/audio/index.json');
      expect(requests).toContain(`/game/audio/${result.baked.file}`);
      const lock = readLock(fx.cfg().lock)!;
      const owned = ['runtime', 'both'].map(id => lock.assets[id].outputs.find(o => o.file.startsWith('sample-'))!.file);
      expect(new Set(owned).size).toBe(2);
      for (const name of owned) expect(requests).toContain(`/game/audio/${name}`);
      expect(requests.every(p => p.startsWith('/game/'))).toBe(true);
    } finally {await browser.close(); await new Promise<void>((done, reject) => server.close(e => e ? reject(e) : done()));}
  }, 120000);

  it.each(['no-cue', 'wrong-cue-name', 'header', 'omitted-lock-source', 'foreign-owner'] as const)('rejects direct build --pull %s before installing or changing lock', async fault => {
    const fx = clone(base), lock = readLock(fx.cfg().lock)!, original = lock.assets.runtime;
    const temp = make(), bad = poisoned(temp, fault), files = new Map<string, Buffer>();
    for (const [file, data] of bad.files) files.set(file.replace('hybrid.runtime.json', 'runtime.runtime.json'), data);
    // Re-owner the sample and cue so each mutation isolates its intended invariant.
    for (const [file, data] of [...files]) if (file.endsWith('.runtime.json')) {
      const c = JSON.parse(data.toString()); c.id = fault === 'foreign-owner' ? 'other' : 'runtime'; c.patch.name = 'runtime';
      const sample = Object.keys(c.assets)[0], old = c.assets[sample].file, owned = sampleFile('runtime', sample);
      c.assets[sample].file = owned;
      if (files.has(old)) { files.set(owned, files.get(old)!); files.delete(old); }
      files.set(file, Buffer.from(JSON.stringify(c)));
    }
    const outputs = [...files].map(([f,b]) => ref(f,b));
    const store = new DirStore(fx.path('store'));
    await store.put(storeName(original.inputHash), packAsset('runtime', original.inputHash, outputs, f => files.get(f)!));
    // Without a prior entry, build trusts the store manifest for its new output inventory.
    // Keep the same planned input hash: output semantics must guard this path independently.
    delete lock.assets.runtime; writeLock(fx.cfg().lock, lock);
    fs.rmSync(fx.cfg().out, {recursive: true});
    const before = fs.readFileSync(fx.cfg().lock);
    const problem = {
      'no-cue': /required runtime cue/, 'wrong-cue-name': /runtime cue filename/,
      header: /not a beeps\/runtime-cue/, 'omitted-lock-source': /missing from this asset's lock outputs/,
      'foreign-owner': /cue id.*is not the asset id/,
    }[fault];
    await expect(runBuild(fx.cfg(), {pull: true, store, only: ['runtime']})).rejects.toThrow(problem);
    expect(snapshot(fx.cfg().out)).toEqual({});
    expect(fs.readFileSync(fx.cfg().lock)).toEqual(before);
  });
});
