import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { initProject, savePatch } from '../../src/project.ts';
import { addToKit, emptyKit, writeKit } from '../../src/kit.ts';
import { chromiumAvailable } from '../../src/render/host.ts';
import { coin } from '../helpers/patches.ts';

const bin = join(import.meta.dirname, '..', '..', 'scripts/beeps.mjs');
const hasChromium = await chromiumAvailable();
function run(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  return { ...r, data: r.stdout.trim() ? JSON.parse(r.stdout) : undefined };
}

it.skipIf(!hasChromium)('exports every declared variant with one sidecar listing them', () => {
  const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-variants-')));
  savePatch(p, { ...coin(), variation: { pitchCents: 30, gainDb: 1, variants: 3, noRepeat: true, weights: [2, 1, 1] }, meta: { priority: 4, intent: 'oneshot' } });
  const r = run(p.paths.root, 'export', 'coin', '--wav', 'audio/coin.wav', '--variants', '--manifest');
  expect(r.status, r.stderr).toBe(0);
  expect(r.data.wavs.map((f: string) => basename(f))).toEqual(['coin.0.wav', 'coin.1.wav', 'coin.2.wav']);
  expect(r.data.wav).toBe(r.data.wavs[0]);
  const m = JSON.parse(readFileSync(join(p.paths.root, 'audio/coin.wav.json'), 'utf8'));
  expect(m).toMatchObject({ id: 'coin', file: 'coin.0.wav', priority: 4, noRepeat: true,
    variants: [{ file: 'coin.0.wav', weight: 2 }, { file: 'coin.1.wav', weight: 1 }, { file: 'coin.2.wav', weight: 1 }] });

  const two = run(p.paths.root, 'export', 'coin', '--wav', 'audio/two.wav', '--variants', '2');
  expect(two.status, two.stderr).toBe(0);
  expect(two.data.wavs).toHaveLength(2);

  const bad = run(p.paths.root, 'export', 'coin', '--wav', 'audio/bad.wav', '--variants', '0');
  expect(bad.status).not.toBe(0);
  expect(JSON.parse(bad.stderr).error.code).toBe('E_USAGE');
});

it.skipIf(!hasChromium)('warns when the kit priority differs from meta.priority, and keeps meta.priority in the sidecar', () => {
  const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-variants-')));
  savePatch(p, { ...coin(), meta: { priority: 2, intent: 'oneshot' } });
  writeKit(p.paths.root, addToKit(emptyKit(), { name: 'coin', family: 'coin', priority: 5 }));
  const r = run(p.paths.root, 'export', 'coin', '--wav', 'audio/coin.wav', '--manifest');
  expect(r.status, r.stderr).toBe(0);
  expect(r.data.warnings).toEqual(['kit priority (5) differs from meta.priority (2); the sidecar uses meta.priority']);
  const m = JSON.parse(readFileSync(join(p.paths.root, 'audio/coin.wav.json'), 'utf8'));
  expect(m.priority).toBe(2);
});

it.skipIf(!hasChromium)('warns, rather than errors, when --variants exceeds the declared count', () => {
  const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-variants-')));
  savePatch(p, { ...coin(), variation: { pitchCents: 30, gainDb: 1, variants: 2, noRepeat: true } });
  const r = run(p.paths.root, 'export', 'coin', '--wav', 'audio/coin.wav', '--variants', '4');
  expect(r.status, r.stderr).toBe(0);
  expect(r.data.wavs).toHaveLength(4);
  expect(r.data.warnings).toEqual([`--variants 4 exceeds the patch's declared 2 variant(s)`]);
});

it.skipIf(!hasChromium)('rejects --variant combined with --variants and writes no files', () => {
  const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-variants-')));
  savePatch(p, { ...coin(), variation: { pitchCents: 30, gainDb: 1, variants: 3, noRepeat: true } });
  const r = run(p.paths.root, 'export', 'coin', '--wav', 'audio/x.wav', '--variant', '1', '--variants', '2');
  expect(r.status).not.toBe(0);
  expect(JSON.parse(r.stderr).error.code).toBe('E_USAGE');
  expect(existsSync(join(p.paths.root, 'audio'))).toBe(false);
});
