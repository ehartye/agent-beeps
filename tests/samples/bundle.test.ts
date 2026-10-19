import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWav } from '../../src/audio/wav.ts';
import { importSample, prepareSample } from '../../src/samples/prepare.ts';
import { sampleId, samplePaths } from '../../src/samples/store.ts';
import { initProject, loadPatch, openProject, parseOrThrow, savePatch } from '../../src/project.ts';
import { chromiumAvailable } from '../../src/render/host.ts';
import { sha256 } from '../../src/hash.ts';

const bin = join(import.meta.dirname, '../../scripts/beeps.mjs'), dirs: string[] = [], hasChromium = await chromiumAvailable();
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'beeps-bundle-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const cli = (cwd: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  const json = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };
  return { status: r.status, out: json(r.stdout), err: json(r.stderr)?.error, stderr: r.stderr };
};
const json = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const files = (d: string) => existsSync(d) ? readdirSync(d, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => join(e.parentPath, e.name).slice(d.length + 1).replaceAll('\\', '/')).sort() : [];
const snapshot = (d: string) => Object.fromEntries(files(d).map(f => [f, sampleId(readFileSync(join(d, f)))]));
function fixture(long = false) {
  const d = dir(), p = initProject(d), file = join(d, 'private-original.wav');
  writeFileSync(file, writeWav([Float32Array.from({ length: long ? 480001 : 9600 }, (_, i) => Math.sin(i * .07) * .1)], 48000, { bits: 32 }));
  const imported = importSample(p, file, { origin: 'private original path must stay private', license: 'CC0' });
  const first = prepareSample(p, { schema: 'beeps/sample-prep@1', source: imported.normalizedId, startFrame: 100, endFrame: 9000, fadeInFrames: 50, fadeOutFrames: 200, gainDb: -3 });
  const prepared = prepareSample(p, { schema: 'beeps/sample-prep@1', source: first.outputId, startFrame: 0, endFrame: 8000, fadeInFrames: 0, fadeOutFrames: 100, gainDb: 0 });
  const patch = parseOrThrow({ schema: 'beeps/patch@1', name: 'hybrid', family: 'test', duration: .3, layers: [
    { source: { type: 'sample', asset: prepared.outputId }, amp: { attack: 0, decay: 0, sustain: 1, release: 0 } },
    { source: { type: 'noise', color: 'pink' }, gainDb: -30, amp: { attack: .005, decay: .1, sustain: 0, release: .02 } },
  ] }, 'test'); savePatch(p, patch);
  const bundle = join(d, 'bundle');
  return { d, p, file, imported, first, prepared, patch, bundle };
}
function bundled(full = false, long = false) {
  const f = fixture(long), r = cli(f.d, 'sample', 'bundle', 'hybrid', '--out', f.bundle, ...(full ? ['--include-preparation'] : []));
  expect(r.status, r.stderr).toBe(0); return { ...f, manifest: json(join(f.bundle, 'samples.json')) };
}

describe('portable recorded source bundles', () => {
  it('exports exact prepared closure by default, excludes all preparation/private provenance and is idempotent', () => {
    const f = bundled();
    expect(f.manifest).toMatchObject({ schema: 'beeps/sample-bundle@1', includePreparation: false, recipes: {} });
    expect(Object.keys(f.manifest.samples)).toEqual([f.prepared.outputId]);
    expect(files(f.bundle)).toEqual([`patches/hybrid.json`, 'samples.json', `samples/${f.prepared.outputId.slice(7)}.wav`]);
    expect(JSON.stringify(f.manifest)).not.toContain(f.file);
    const before = snapshot(f.bundle);
    expect(cli(f.d, 'sample', 'bundle', 'hybrid', '--out', f.bundle).status).toBe(0);
    expect(snapshot(f.bundle)).toEqual(before);
    writeFileSync(join(f.bundle, 'private.txt'), 'must not silently retain this');
    expect(cli(f.d, 'sample', 'bundle', 'hybrid', '--out', f.bundle).err.code).toBe('E_CONFLICT');
    expect(readFileSync(join(f.bundle, 'private.txt'), 'utf8')).toBe('must not silently retain this');
  });

  it('exports recursive replay closure explicitly and replays after sync and original removal', () => {
    const f = bundled(true, true), moved = dir(); initProject(moved);
    expect(Object.keys(f.manifest.samples).sort()).toEqual([f.imported.normalizedId, f.first.outputId, f.prepared.outputId].sort());
    expect(Object.keys(f.manifest.recipes).sort()).toEqual([f.first.recipeId, f.prepared.recipeId].sort());
    expect(files(f.bundle).some(p => /original|imports/.test(p))).toBe(false);
    rmSync(f.file); rmSync(samplePaths(f.p).originals, { recursive: true });
    const synced = cli(moved, 'sample', 'sync', f.bundle);
    expect(synced.status, synced.stderr).toBe(0);
    expect(synced.out).toMatchObject({ added: ['hybrid'], updated: [], unchanged: [] });
    const replay = cli(moved, 'sample', 'prepare', '--recipe', join(samplePaths(moved).recipes, `${f.prepared.recipeId.slice(7)}.json`));
    expect(replay.status, replay.stderr).toBe(0); expect(replay.out.outputId).toBe(f.prepared.outputId);
    expect(readFileSync(replay.out.objectPath)).toEqual(readFileSync(f.prepared.objectPath));
    expect(cli(moved, 'sample', 'sync', f.bundle).out.unchanged).toEqual(['hybrid']);
    const before = snapshot(f.bundle);
    expect(cli(f.d, 'sample', 'bundle', 'hybrid', '--out', f.bundle).err.code).toBe('E_CONFLICT');
    expect(snapshot(f.bundle)).toEqual(before);
  });

  it.skipIf(!hasChromium)('relocates a hybrid patch through normal new/render/bundle/sync/render operations', () => {
    const f = bundled(), moved = dir(); initProject(moved);
    const authored = cli(f.d, 'render', 'hybrid'); expect(authored.status, authored.stderr).toBe(0);
    rmSync(f.file); rmSync(samplePaths(f.p).dir, { recursive: true });
    const synced = cli(moved, 'sample', 'sync', f.bundle); expect(synced.status, synced.stderr).toBe(0);
    const rendered = cli(moved, 'render', 'hybrid'); expect(rendered.status, rendered.stderr).toBe(0);
    expect(readFileSync(rendered.out.renders[0].wav)).toEqual(readFileSync(authored.out.renders[0].wav));
    expect(loadPatch(openProject(moved), 'hybrid').layers.map(l => l.source.type)).toEqual(['sample', 'noise']);
  }, 120000);

  it('validates malformed source closures before changing any destination files', () => {
    const f = bundled(true), moved = dir(); initProject(moved);
    const before = snapshot(join(moved, '.agent-beeps'));
    const probes: ((b: string, m: any) => void)[] = [
      (b, m) => { rmSync(join(b, m.samples[f.prepared.outputId].file)); },
      (b, m) => { writeFileSync(join(b, m.samples[f.prepared.outputId].file), 'corrupt'); },
      (_b, m) => { m.samples[f.prepared.outputId].frames++; },
      (_b, m) => { m.samples[f.prepared.outputId].file = '../outside.wav'; },
      (b) => { writeFileSync(join(b, 'extra.json'), '{}'); },
      (_b, m) => { m.samples[`sha256:${'0'.repeat(64)}`] = { ...m.samples[f.prepared.outputId], file: `samples/${'0'.repeat(64)}.wav` }; },
      (b, m) => { const path = join(b, m.recipes[f.prepared.recipeId].file), receipt = json(path); receipt.outputId = f.first.outputId; writeFileSync(path, JSON.stringify(receipt)); },
      (_b, m) => { delete m.recipes[f.prepared.recipeId]; },
      (_b, m) => { m.includePreparation = false; },
      (_b, m) => { m.patches.hybrid.sha256 = '0'.repeat(64); },
    ];
    for (const mutate of probes) {
      const base = dir(), b = join(base, 'bundle'); cpSync(f.bundle, b, { recursive: true }); const m = json(join(b, 'samples.json'));
      mutate(b, m); writeFileSync(join(b, 'samples.json'), JSON.stringify(m));
      const r = cli(moved, 'sample', 'sync', b); expect(r.status, r.stderr).not.toBe(0);
      expect(snapshot(join(moved, '.agent-beeps'))).toEqual(before);
    }
  });

  it('rejects symlinks and unexpected canonical headers even when hashes are updated', () => {
    const f = bundled(), moved = dir(); initProject(moved); const before = snapshot(join(moved, '.agent-beeps'));
    const external = dir(); writeFileSync(join(external, 'hidden.txt'), 'private');
    symlinkSync(external, join(f.bundle, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(cli(moved, 'sample', 'sync', f.bundle).status).not.toBe(0);
    rmSync(join(f.bundle, 'linked')); // Remove only the link, never its target.
    const old = f.prepared.outputId, bytes = readFileSync(join(f.bundle, f.manifest.samples[old].file)); bytes.writeUInt32LE(44100, 24);
    const id = sampleId(bytes), m = f.manifest; m.samples[id] = { ...m.samples[old], file: `samples/${id.slice(7)}.wav` }; delete m.samples[old];
    rmSync(join(f.bundle, `samples/${old.slice(7)}.wav`)); writeFileSync(join(f.bundle, m.samples[id].file), bytes);
    const p = json(join(f.bundle, 'patches/hybrid.json')); p.layers[0].source.asset = id;
    const text = JSON.stringify(p); writeFileSync(join(f.bundle, 'patches/hybrid.json'), text); m.patches.hybrid.sha256 = sha256(text); writeFileSync(join(f.bundle, 'samples.json'), JSON.stringify(m));
    expect(cli(moved, 'sample', 'sync', f.bundle).err.code).toBe('E_SCHEMA');
    expect(snapshot(join(moved, '.agent-beeps'))).toEqual(before);
  });

  it('preflights corrupt destination objects and receipts, dry-runs and updates patches like patch-only sync', () => {
    const f = bundled(true), moved = dir(), p = initProject(moved), dest = samplePaths(p);
    mkdirSync(dest.objects, { recursive: true }); writeFileSync(join(dest.objects, `${f.prepared.outputId.slice(7)}.wav`), 'broken');
    let before = snapshot(p.paths.dir);
    expect(cli(moved, 'sample', 'sync', f.bundle).err.code).toBe('E_VERIFY'); expect(snapshot(p.paths.dir)).toEqual(before);
    rmSync(dest.objects, { recursive: true }); mkdirSync(dest.recipes, { recursive: true }); writeFileSync(join(dest.recipes, `${f.prepared.recipeId.slice(7)}.json`), '{}');
    before = snapshot(p.paths.dir); expect(cli(moved, 'sample', 'sync', f.bundle).err.code).toBe('E_VERIFY'); expect(snapshot(p.paths.dir)).toEqual(before);
    rmSync(dest.recipes, { recursive: true }); before = snapshot(p.paths.dir);
    expect(cli(moved, 'sample', 'sync', f.bundle, '--dry-run').out).toMatchObject({ dryRun: true, added: ['hybrid'] }); expect(snapshot(p.paths.dir)).toEqual(before);
    savePatch(p, { ...f.patch, duration: .4 });
    expect(cli(moved, 'sample', 'sync', f.bundle).out).toMatchObject({ added: [], updated: ['hybrid'] });
    const patchOnly = join(f.d, 'ordinary'); mkdirSync(patchOnly); writeFileSync(join(patchOnly, 'hybrid.json'), JSON.stringify({ ...f.patch, duration: .5 }));
    expect(cli(moved, 'sync', patchOnly).out.updated).toEqual(['hybrid']);
    expect(cli(moved, 'sample', 'sync', patchOnly).status).not.toBe(0);
  });

  it('preflights a nondirectory recipe destination before publishing any audio', () => {
    const f = bundled(true), moved = dir(), p = initProject(moved), dest = samplePaths(p);
    mkdirSync(dest.dir, { recursive: true }); writeFileSync(dest.recipes, 'this is a file');
    const before = snapshot(p.paths.dir), r = cli(moved, 'sample', 'sync', f.bundle);
    expect(r.status, r.stderr).not.toBe(0);
    expect(snapshot(p.paths.dir)).toEqual(before);
  });

  it('rejects an internally hashed extra object and a long source promoted into a patch', () => {
    const f = bundled(true, true), moved = dir(), p = initProject(moved), before = snapshot(p.paths.dir);
    const unused = writeWav([new Float32Array([.5])], 48000, { bits: 32 }), id = sampleId(unused), file = `samples/${id.slice(7)}.wav`;
    writeFileSync(join(f.bundle, file), unused); f.manifest.samples[id] = { file, sampleRate: 48000, channels: 1, frames: 1, bytes: unused.length };
    writeFileSync(join(f.bundle, 'samples.json'), JSON.stringify(f.manifest));
    expect(cli(moved, 'sample', 'sync', f.bundle).err.message).toMatch(/dependency closure/); expect(snapshot(p.paths.dir)).toEqual(before);
    rmSync(join(f.bundle, file)); delete f.manifest.samples[id];
    const patch = json(join(f.bundle, 'patches/hybrid.json')); patch.layers.push({ source: { type: 'sample', asset: f.imported.normalizedId }, amp: { attack: 0, decay: 0, sustain: 1, release: 0 } });
    const bytes = JSON.stringify(patch); writeFileSync(join(f.bundle, 'patches/hybrid.json'), bytes); f.manifest.patches.hybrid.sha256 = sha256(bytes); writeFileSync(join(f.bundle, 'samples.json'), JSON.stringify(f.manifest));
    expect(cli(moved, 'sample', 'sync', f.bundle).err.message).toMatch(/480000/); expect(snapshot(p.paths.dir)).toEqual(before);
  });

  it('checks patch hashes over exact bytes before decoding JSON or changing the destination', () => {
    const f = bundled(), moved = dir(), p = initProject(moved), before = snapshot(p.paths.dir);
    const patch = json(join(f.bundle, 'patches/hybrid.json')); patch.meta = { description: 'X' };
    const text = JSON.stringify(patch), bytes = Buffer.from(text); bytes[text.indexOf('"X"') + 1] = 0xff;
    writeFileSync(join(f.bundle, 'patches/hybrid.json'), bytes);
    f.manifest.patches.hybrid.sha256 = sha256(bytes.toString('utf8')); writeFileSync(join(f.bundle, 'samples.json'), JSON.stringify(f.manifest));
    const r = cli(moved, 'sample', 'sync', f.bundle);
    expect(r.err?.code).toBe('E_VERIFY'); expect(snapshot(p.paths.dir)).toEqual(before);
  });

  it('rejects a dangling destination junction before importing any other sample or patch', () => {
    const f = bundled(true), moved = dir(), p = initProject(moved), dest = samplePaths(p);
    mkdirSync(dest.objects, { recursive: true }); const target = dir(), path = join(dest.objects, `${f.prepared.outputId.slice(7)}.wav`);
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir'); rmSync(target, { recursive: true });
    const before = snapshot(p.paths.dir), r = cli(moved, 'sample', 'sync', f.bundle);
    expect(r.err?.code).toBe('E_VERIFY'); expect(snapshot(p.paths.dir)).toEqual(before);
  });
});
