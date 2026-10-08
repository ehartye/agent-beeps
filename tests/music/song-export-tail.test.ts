import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

it.skipIf(!hasChromium)('song export --trim-tail shortens a non-loop song, refuses a loop, and stems report peak against the mix', () => {
  const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-song-tail-')));
  writeFileSync(join(p.paths.root, 'once.json'), JSON.stringify(songInput({ name: 'once' })));
  writeFileSync(join(p.paths.root, 'loop.json'), JSON.stringify(songInput({ name: 'looped', loop: true })));
  for (const f of ['once.json', 'loop.json']) expect(run(p.paths.root, 'song', 'new', f).status).toBe(0);

  const full = run(p.paths.root, 'song', 'export', 'once', '--wav', 'audio/full.wav', '--manifest');
  expect(full.status, full.stderr).toBe(0);
  const cut = run(p.paths.root, 'song', 'export', 'once', '--wav', 'audio/cut.wav', '--manifest', '--trim-tail', '-30');
  expect(cut.status, cut.stderr).toBe(0);
  const side = (f: string) => JSON.parse(readFileSync(join(p.paths.root, 'audio', `${f}.wav.json`), 'utf8'));
  expect(cut.data.trimmedTailSec).toBeGreaterThan(0);
  expect(side('cut').durationSec).toBeLessThan(side('full').durationSec);
  expect(side('cut').frames).toBe(Math.round(side('cut').durationSec * side('cut').sampleRate));

  const looped = run(p.paths.root, 'song', 'export', 'looped', '--wav', 'audio/l.wav', '--trim-tail', '-30');
  expect(looped.status).not.toBe(0);
  expect(JSON.parse(looped.stderr).error.code).toBe('E_USAGE');

  const stems = run(p.paths.root, 'song', 'stems', 'once');
  expect(stems.status, stems.stderr).toBe(0);
  for (const s of stems.data.stems) { expect(typeof s.peakVsMixDb).toBe('number'); expect(typeof s.crestDb).toBe('number'); }
}, 120000);
