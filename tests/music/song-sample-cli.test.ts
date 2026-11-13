import { afterAll, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { initProject } from '../../src/project.ts';
import { readAlbum } from '../../src/album.ts';
import { registerSongCommands } from '../../src/commands/songs.ts';
import { chromiumAvailable } from '../../src/render/host.ts';
import { samplePaths, writeSampleObject } from '../../src/samples/store.ts';
import { writeWav } from '../../src/audio/wav.ts';
import { songInput } from '../helpers/songs.ts';

// Keep the album command's real resolver, renderer, files and state transitions. Only the
// unrelated persistent LAN daemon is replaced, so this test leaves no background process.
vi.mock('../../src/commands/audition.ts', () => ({ ensureServer: async () => ({ url: 'http://test:1234', port: 1234, token: 'tok', host: '127.0.0.1' }) }));

const dir = mkdtempSync(join(tmpdir(), 'beeps-sample-song-cli-'));
const p = initProject(dir);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it.skipIf(!(await chromiumAvailable()))('renders/exports/builds fixed sample songs and makes album slots ready through real production paths', async () => {
  const source = writeSampleObject(samplePaths(p).objects, writeWav([
    Float32Array.from({ length: 24000 }, (_, i) => .2 * Math.sin(i * Math.PI / 80)),
  ], 48000, { bits: 32 }));
  const file = join(p.paths.songs, 'recorded.json');
  writeFileSync(file, JSON.stringify(songInput({ name: 'recorded', loop: true,
    tracks: { hit: { fixed: true, instrument: { duration: .5, layers: [{ source: { type: 'sample', asset: source.id },
      amp: { attack: .001, decay: 0, sustain: 1, release: .02 } }] } } },
    patterns: { pulse: { bars: 1, steps: 'x.x.x.x.', gate: 'patch' } },
    sections: { a: { bars: 1, play: { hit: 'pulse' } } }, form: ['a'],
    adaptive: { layers: { pulse: ['hit'] }, states: { full: ['pulse'] }, initial: 'full' },
  })));
  const run = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, '../../scripts/beeps.mjs'), ...args], {
    cwd: dir, encoding: 'utf8', windowsHide: true,
  });
  const render = run('song', 'render', 'recorded');
  expect(render.status, render.stderr).toBe(0);
  expect(JSON.parse(render.stdout).songs[0].name).toBe('recorded');
  const exported = run('song', 'export', 'recorded', '--wav', join(dir, 'recorded.wav'), '--manifest', '--layers');
  expect(exported.status, exported.stderr).toBe(0);
  expect(existsSync(join(dir, 'recorded.pulse.wav'))).toBe(true);
  writeFileSync(join(dir, 'beeps.build.json'), JSON.stringify({ recipes: 'recipes.json', out: 'audio', target: 'wav-master', workDir: '.work' }));
  writeFileSync(join(dir, 'recipes.json'), JSON.stringify({ recorded: { source: file, role: 'music' } }));
  const built = run('build');
  expect(built.status, built.stderr).toBe(0);
  expect(JSON.parse(built.stdout).built).toEqual(['recorded']);
  const check = run('build', '--check');
  expect(check.status, check.stderr).toBe(0);
  expect(JSON.parse(check.stdout).unchanged).toEqual(['recorded']);
  const wav = readFileSync(source.path);
  writeFileSync(source.path, Buffer.from(wav).fill(0, 44));
  try {
    const broken = run('build', '--check');
    expect(broken.status).not.toBe(0);
    expect(broken.stdout + broken.stderr).toMatch(/hash mismatch/);
  } finally { writeFileSync(source.path, wav); }

  const homeBefore = process.env.AGENT_BEEPS_HOME;
  process.env.AGENT_BEEPS_HOME = join(dir, 'home');
  const output: any[] = [], progress = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    const cmd = new Command();
    registerSongCommands(cmd, { projectDir: () => dir, emit: value => { output.push(value); } });
    await cmd.parseAsync(['album', 'open', 'recorded', '--jobs', '1'], { from: 'user' });
    const album = readAlbum(p, output[0].album);
    expect(album.tracks[0]).toMatchObject({ status: 'ready', name: 'recorded' });
    expect(existsSync(album.tracks[0].wav!)).toBe(true);
  } finally {
    progress.mockRestore();
    if (homeBefore === undefined) delete process.env.AGENT_BEEPS_HOME; else process.env.AGENT_BEEPS_HOME = homeBefore;
  }
}, 60000);
