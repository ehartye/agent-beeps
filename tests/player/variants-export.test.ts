import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { initProject, savePatch } from '../../src/project.ts';
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
