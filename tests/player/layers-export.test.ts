// tests/player/layers-export.test.ts
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../../src/project.ts';
import { chromiumAvailable } from '../../src/render/host.ts';
import { songInput } from '../helpers/songs.ts';

const bin = join(import.meta.dirname, '..', '..', 'scripts/beeps.mjs');
const hasChromium = await chromiumAvailable();
function run(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  return { ...r, data: r.stdout.trim() ? JSON.parse(r.stdout) : undefined };
}

it.skipIf(!hasChromium)('exports adaptive layers next to the mix and they sum back to it', () => {
  const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-layers-')));
  writeFileSync(join(p.paths.root, 'adaptive.json'), JSON.stringify(songInput({ name: 'adaptive-demo', loop: true,
    adaptive: { layers: { bed: ['pad'], pulse: ['hat'] }, states: { calm: ['bed'], full: ['bed', 'pulse'] }, initial: 'calm' } })));
  writeFileSync(join(p.paths.root, 'plain.json'), JSON.stringify(songInput()));
  for (const f of ['adaptive.json', 'plain.json']) { const s = run(p.paths.root, 'song', 'new', f); expect(s.status, s.stderr).toBe(0); }

  const r = run(p.paths.root, 'song', 'export', 'adaptive-demo', '--wav', 'audio/theme.wav', '--layers', '--manifest');
  expect(r.status, r.stderr).toBe(0);
  expect(r.data.nullResidualDb).toBeLessThan(-60);
  for (const f of ['theme.wav', 'theme.bed.wav', 'theme.pulse.wav']) expect(existsSync(join(p.paths.root, 'audio', f)), f).toBe(true);
  expect(JSON.parse(readFileSync(join(p.paths.root, 'audio/theme.wav.json'), 'utf8'))).toMatchObject({
    loop: true, bpm: 120, meter: 4, layers: [{ name: 'bed', file: 'theme.bed.wav' }, { name: 'pulse', file: 'theme.pulse.wav' }],
    states: { calm: ['bed'], full: ['bed', 'pulse'] }, initialState: 'calm',
  });

  const plain = run(p.paths.root, 'song', 'export', 'test-song', '--wav', 'audio/plain.wav', '--layers');
  expect(plain.status).not.toBe(0);
  expect(JSON.parse(plain.stderr).error.code).toBe('E_USAGE');
});
