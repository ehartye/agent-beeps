import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWav } from '../../src/audio/wav.ts';
import { initProject, loadPatch, openProject } from '../../src/project.ts';
import { sampleId, samplePaths } from '../../src/samples/store.ts';
import { chromiumAvailable } from '../../src/render/host.ts';

const bin = join(import.meta.dirname, '../../scripts/beeps.mjs'), dirs: string[] = [];
const hasChromium = await chromiumAvailable();
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'beeps-authoring-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const cli = (cwd: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  const json = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };
  return { status: r.status, out: json(r.stdout), err: json(r.stderr)?.error, stderr: r.stderr };
};
const imported = () => {
  const d = dir(); initProject(d);
  const file = join(d, 'take.wav');
  writeFileSync(file, writeWav([Float32Array.from({ length: 9600 }, (_, i) => Math.sin(i * 2 * Math.PI * 440 / 48000) * .1)], 48000, { bits: 32 }));
  const r = cli(d, 'sample', 'import', file, '--origin', 'public field take', '--license', 'CC0');
  expect(r.status, r.stderr).toBe(0);
  return { d, file, r: r.out };
};
const snapshot = (root: string) => existsSync(root) ? Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => { const p = join(e.parentPath, e.name); return [p.slice(root.length), sampleId(readFileSync(p))]; })) : {};

describe('sample authoring CLI', () => {
  it('imports exact bytes, resolves seconds to frames and creates a neutral sample patch', () => {
    const { d, file, r } = imported();
    expect(readFileSync(r.originalPath)).toEqual(readFileSync(file));
    expect(r.receipt).toMatchObject({ origin: 'public field take', license: 'CC0' });
    const p = cli(d, 'sample', 'prepare', r.normalizedId, '--start', '0.01001', '--end', '0.10001', '--fade-in', '0.00101', '--fade-out', '0.00201', '--gain', '-3', '--name', 'tap');
    expect(p.status, p.stderr).toBe(0);
    expect(p.out.receipt.recipe).toMatchObject({ startFrame: 480, endFrame: 4800, fadeInFrames: 48, fadeOutFrames: 96, gainDb: -3 });
    const patch = loadPatch(openProject(d), 'tap');
    expect(patch.family).toBe('sfx');
    expect(patch.duration).toBe(.09);
    expect(patch.layers[0]).toMatchObject({ source: { type: 'sample', asset: p.out.outputId }, amp: { attack: 0, decay: 0, sustain: 1, release: 0 } });
    const defaults = cli(d, 'sample', 'prepare', r.normalizedId);
    expect(defaults.status, defaults.stderr).toBe(0);
    expect(defaults.out.receipt.recipe).toMatchObject({ startFrame: 0, endFrame: 9600, fadeInFrames: 0, fadeOutFrames: 0, gainDb: 0 });
  });

  it('preflights invalid seconds, conflicting names and receipt identities before publishing', () => {
    const { d, r } = imported();
    expect(cli(d, 'sample', 'prepare', r.normalizedId, '--end', '.1', '--name', 'tap').status).toBe(0);
    const before = snapshot(join(d, '.agent-beeps'));
    for (const args of [['--start', '-1'], ['--end', 'NaN'], ['--end', '.3'], ['--fade-in', '.11', '--fade-out', '.11'], ['--gain', '1oops'], ['--name', 'BAD'], ['--end', '.05', '--name', 'tap']]) {
      const bad = cli(d, 'sample', 'prepare', r.normalizedId, ...args);
      expect(bad.status, JSON.stringify(args)).not.toBe(0);
      expect(snapshot(join(d, '.agent-beeps'))).toEqual(before);
    }
    const prepared = cli(d, 'sample', 'prepare', r.normalizedId, '--end', '.1').out;
    const receipt = { ...prepared.receipt, outputId: `sha256:${'0'.repeat(64)}` }, f = join(d, 'bad-receipt.json'); writeFileSync(f, JSON.stringify(receipt));
    const beforeReceipt = snapshot(join(d, '.agent-beeps'));
    expect(cli(d, 'sample', 'prepare', '--recipe', f).err.code).toBe('E_VERIFY');
    expect(snapshot(join(d, '.agent-beeps'))).toEqual(beforeReceipt);
    writeFileSync(f, JSON.stringify(prepared.receipt));
    expect(cli(d, 'sample', 'prepare', r.normalizedId, '--recipe', f).err.code).toBe('E_USAGE');
    expect(cli(d, 'sample', 'prepare', '--recipe', f, '--gain', '0').err.code).toBe('E_USAGE');
    expect(cli(d, 'sample', 'prepare', r.normalizedId, '--end', '.05', '--name', 'tap', '--force').status).toBe(0);
  });

  it('replays raw recipes and saved receipts after deleting the original', () => {
    const { d, file, r } = imported(), first = cli(d, 'sample', 'prepare', r.normalizedId, '--end', '.1', '--fade-out', '.005').out;
    rmSync(file); rmSync(r.originalPath);
    const raw = join(d, 'raw.json'); writeFileSync(raw, JSON.stringify(first.receipt.recipe));
    expect(cli(d, 'sample', 'prepare', '--recipe', raw).out.outputId).toBe(first.outputId);
    expect(cli(d, 'sample', 'prepare', '--recipe', first.recipePath).out).toMatchObject({ outputId: first.outputId, receipt: first.receipt });
  });

  it('rejects a directory occupying the named patch even with force before publishing preparation files', () => {
    const { d, r } = imported(), destination = join(d, '.agent-beeps', 'patches', 'occupied.json');
    mkdirSync(destination);
    const before = snapshot(join(d, '.agent-beeps')), prepared = cli(d, 'sample', 'prepare', r.normalizedId, '--end', '.1', '--name', 'occupied', '--force');
    expect(prepared.status, prepared.stderr).not.toBe(0);
    expect(snapshot(join(d, '.agent-beeps'))).toEqual(before);
    expect(lstatSync(destination).isDirectory()).toBe(true);
  });

  it('rejects a dangling junction occupying the named patch before publishing preparation files', () => {
    const { d, r } = imported(), destination = join(d, '.agent-beeps', 'patches', 'occupied.json'), target = join(d, 'target');
    mkdirSync(target); symlinkSync(target, destination, process.platform === 'win32' ? 'junction' : 'dir'); rmSync(target, { recursive: true });
    expect(existsSync(destination)).toBe(false);
    const before = snapshot(join(d, '.agent-beeps')), prepared = cli(d, 'sample', 'prepare', r.normalizedId, '--end', '.1', '--name', 'occupied');
    expect(prepared.status, prepared.stderr).not.toBe(0);
    expect(snapshot(join(d, '.agent-beeps'))).toEqual(before);
    expect(lstatSync(destination).isSymbolicLink()).toBe(true);
  });

  it('rejects invalid named patch ancestor types before publishing preparation files', () => {
    for (const linked of [false, true]) {
      const { d, r } = imported(), patches = join(d, '.agent-beeps', 'patches'); rmSync(patches, { recursive: true });
      if (linked) { const target = join(d, 'target'); mkdirSync(target); symlinkSync(target, patches, process.platform === 'win32' ? 'junction' : 'dir'); }
      else writeFileSync(patches, 'not a directory');
      const before = snapshot(join(d, '.agent-beeps')), prepared = cli(d, 'sample', 'prepare', r.normalizedId, '--end', '.1', '--name', 'occupied', '--force');
      expect(prepared.status, prepared.stderr).not.toBe(0);
      expect(snapshot(join(d, '.agent-beeps'))).toEqual(before);
    }
  });

  it.skipIf(!hasChromium)('renders and relocates sample-only and hybrid patches through the complete real CLI chain', () => {
    const { d, r, file } = imported();
    expect(cli(d, 'sample', 'prepare', r.normalizedId, '--end', '.15', '--fade-in', '.003', '--fade-out', '.02', '--name', 'prepared').status).toBe(0);
    const hybrid = loadPatch(openProject(d), 'prepared'); hybrid.name = 'hybrid';
    hybrid.layers.push({ source: { type: 'noise', color: 'pink' }, start: 0, gainDb: -30, pan: 0, amp: { attack: .005, decay: .1, sustain: 0, release: .02 } });
    const hybridFile = join(d, 'hybrid.json'); writeFileSync(hybridFile, JSON.stringify(hybrid));
    expect(cli(d, 'new', hybridFile).status).toBe(0);
    const rendered = cli(d, 'render', 'prepared', 'hybrid');
    expect(rendered.status, rendered.stderr).toBe(0);
    expect(rendered.out.renders[0].key).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isFinite(rendered.out.renders[0].features.loudnessLufs)).toBe(true);
    const bundle = join(d, 'portable'); expect(cli(d, 'sample', 'bundle', 'prepared', 'hybrid', '--out', bundle).status).toBe(0);
    rmSync(file); rmSync(samplePaths(d).dir, { recursive: true });
    const moved = dir(); initProject(moved); const sync = cli(moved, 'sample', 'sync', bundle);
    expect(sync.status, sync.stderr).toBe(0); expect(sync.out.added).toEqual(['hybrid', 'prepared']);
    const relocated = cli(moved, 'render', 'prepared', 'hybrid'); expect(relocated.status, relocated.stderr).toBe(0);
    for (let i = 0; i < 2; i++) expect(readFileSync(relocated.out.renders[i].wav)).toEqual(readFileSync(rendered.out.renders[i].wav));
  }, 120000);

  it('requires an explicit crop for normalized sources longer than ten seconds', () => {
    const d = dir(); initProject(d); const f = join(d, 'long.wav');
    writeFileSync(f, writeWav([new Float32Array(480001).fill(.01)], 48000, { bits: 32 }));
    const imported = cli(d, 'sample', 'import', f); expect(imported.status, imported.stderr).toBe(0);
    const before = snapshot(samplePaths(d).dir);
    expect(cli(d, 'sample', 'prepare', imported.out.normalizedId).err.code).toBe('E_SCHEMA');
    expect(snapshot(samplePaths(d).dir)).toEqual(before);
    expect(cli(d, 'sample', 'prepare', imported.out.normalizedId, '--end', '10').out.frames).toBe(480000);
  });
});
