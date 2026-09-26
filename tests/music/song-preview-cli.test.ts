import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initProject } from '../../src/project.ts';
import { chromiumAvailable } from '../../src/render/host.ts';
import { songInput } from '../helpers/songs.ts';

it.skipIf(!(await chromiumAvailable()))('labels --only plus --sections as a solo excerpt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeps-preview-cli-'));
  initProject(dir);
  const file = join(dir, 'song.json');
  writeFileSync(file, JSON.stringify(songInput()));
  const run = spawnSync(process.execPath, [join(import.meta.dirname, '../../scripts/beeps.mjs'), 'song', 'render', file, '--only', 'pad', '--sections', 'a'], {
    cwd: dir, encoding: 'utf8', windowsHide: true,
  });
  expect(run.status, run.stderr).toBe(0);
  const result = JSON.parse(run.stdout).songs[0];
  expect(result.solo).toEqual({ tracks: ['pad'], level: 'solo-normalized' });
  expect(result.title).toMatch(/pad solo/);
  expect(result.excerpt.sourceRanges).toHaveLength(1);
  expect(result).not.toHaveProperty('lint');
});
