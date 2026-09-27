import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../../src/project.ts';
import { chromiumAvailable } from '../../src/render/host.ts';
import { readChannels } from '../../src/render/layers.ts';
import { songInput } from '../helpers/songs.ts';

const bin = join(import.meta.dirname, '..', '..', 'scripts/beeps.mjs');
const hasChromium = await chromiumAvailable();
function run(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  return { ...r, data: r.stdout.trim() ? JSON.parse(r.stdout) : undefined };
}

/** Residual (dB) of b against a after the best gain match: solo previews use their own trim. */
function scaledResidualDb(a: Float32Array[], b: Float32Array[]) {
  let ab = 0, bb = 0, aa = 0;
  for (let c = 0; c < a.length; c++) for (let i = 0; i < a[c].length; i++) { ab += a[c][i] * b[c][i]; bb += b[c][i] ** 2; aa += a[c][i] ** 2; }
  const g = ab / bb;
  let r = 0;
  for (let c = 0; c < a.length; c++) for (let i = 0; i < a[c].length; i++) r += (a[c][i] - g * b[c][i]) ** 2;
  return 10 * Math.log10(r / aa);
}

it.skipIf(!hasChromium)('song render --only plays the same chance hits and noise as the mix', () => {
  const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-only-')));
  // The pad rolls chance hits before the hat does, so a solo that drops the pad shifts the hat's rolls.
  // The hat carries the mix, so its stem sits far above the 16-bit floor the comparison can see.
  const base = songInput();
  writeFileSync(join(p.paths.root, 'song.json'), JSON.stringify(songInput({
    tracks: { pad: { ...base.tracks.pad, gainDb: -24 }, hat: { ...base.tracks.hat, gainDb: 0 } },
    patterns: {
    'pad-a': { bars: 2, chords: { progression: 'a', octave: 4, rhythm: 'x?x?' } },
    'hat-a': { bars: 1, steps: 'x?x?x?x?x?x?x?x?' },
  } })));
  const s = run(p.paths.root, 'song', 'new', 'song.json'); expect(s.status, s.stderr).toBe(0);
  const solo = run(p.paths.root, 'song', 'render', 'test-song', '--only', 'hat');
  expect(solo.status, solo.stderr).toBe(0);
  expect(solo.data.songs[0].solo).toEqual({ tracks: ['hat'], level: 'solo-normalized' });
  const stems = run(p.paths.root, 'song', 'stems', 'test-song');
  expect(stems.status, stems.stderr).toBe(0);
  const hatStem = stems.data.stems.find((x: { track: string }) => x.track === 'hat').wav;
  expect(scaledResidualDb(readChannels(hatStem), readChannels(solo.data.songs[0].wav))).toBeLessThan(-60);
});

it.skipIf(!hasChromium)('song render --only rejects inherited property names as tracks', () => {
  const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-only-bad-')));
  writeFileSync(join(p.paths.root, 'song.json'), JSON.stringify(songInput()));
  expect(run(p.paths.root, 'song', 'new', 'song.json').status).toBe(0);
  const r = run(p.paths.root, 'song', 'render', 'test-song', '--only', 'constructor');
  expect(r.status).not.toBe(0);
  expect(JSON.parse(r.stderr).error.code).toBe('E_USAGE');
});
