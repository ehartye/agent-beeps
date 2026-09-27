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

// Chance hits and random arp orders are drawn from one song-wide stream, and the hat is seeded noise:
// a layer only nulls if it plays exactly the notes (and noise) the mix played.
it.skipIf(!hasChromium)('layers of a song with chance hits, a random arp and noise still sum to the mix', () => {
  const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-layers-rand-')));
  const base = songInput();
  writeFileSync(join(p.paths.root, 'rand.json'), JSON.stringify(songInput({
    name: 'random-demo', loop: true,
    tracks: { ...base.tracks, arp: { instrument: { ...base.tracks.pad.instrument, name: 'arp' }, gainDb: -6 }, ghost: { instrument: { ...base.tracks.pad.instrument, name: 'ghost' } } },
    patterns: { ...base.patterns,
      'arp-a': { bars: 2, arp: { progression: 'a', octave: 5, shape: 'random', rate: 4, rhythm: 'x??x' } },
      'hat-a': { bars: 1, steps: 'x?x?x?x?x?x?x?x?' } },
    sections: { a: { bars: 2, play: { pad: 'pad-a', arp: 'arp-a', hat: 'hat-a' } } },
    adaptive: { layers: { bed: ['pad'], lead: ['arp'], pulse: ['hat'], ghost: ['ghost'] }, states: { calm: ['bed'], full: ['bed', 'lead', 'pulse', 'ghost'] }, initial: 'calm' },
  })));
  const s = run(p.paths.root, 'song', 'new', 'rand.json'); expect(s.status, s.stderr).toBe(0);
  const r = run(p.paths.root, 'song', 'export', 'random-demo', '--wav', 'audio/rand.wav', '--layers');
  expect(r.status, r.stderr).toBe(0);
  expect(r.data.nullResidualDb).toBeLessThan(-60);
  // A layer whose tracks never play in any section is almost certainly a mistake.
  expect(r.data.warnings).toContain('layer "ghost" is silent in every section');
});

// One layer holding every track renders the very notes of the mix: a perfect null must still be a number.
it.skipIf(!hasChromium)('reports a perfect null as a finite number', () => {
  const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-layers-one-')));
  writeFileSync(join(p.paths.root, 'one.json'), JSON.stringify(songInput({ name: 'one-layer', loop: true,
    adaptive: { layers: { all: ['pad', 'hat'] }, states: { on: ['all'] }, initial: 'on' } })));
  const s = run(p.paths.root, 'song', 'new', 'one.json'); expect(s.status, s.stderr).toBe(0);
  const r = run(p.paths.root, 'song', 'export', 'one-layer', '--wav', 'audio/one.wav', '--layers');
  expect(r.status, r.stderr).toBe(0);
  expect(typeof r.data.nullResidualDb).toBe('number');
  expect(r.data.nullResidualDb).toBeLessThanOrEqual(-60);
});
