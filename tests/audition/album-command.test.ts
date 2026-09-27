import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { initProject } from '../../src/project.ts';
import { readAlbum } from '../../src/album.ts';
import { saveSong } from '../../src/music.ts';
import { song } from '../helpers/songs.ts';
import { registerSongCommands } from '../../src/commands/songs.ts';
import { renderSong } from '../../src/render/song-pipeline.ts';

vi.mock('../../src/render/song-pipeline.ts', () => ({ renderSong: vi.fn() }));
vi.mock('../../src/commands/shared.ts', async importOriginal => ({ ...await importOriginal<object>(), withHost: async (fn: (host: object) => unknown) => fn({}) }));
vi.mock('../../src/commands/audition.ts', () => ({ ensureServer: async () => ({ url: 'http://test:1234', port: 1234, token: 'tok', host: '127.0.0.1' }) }));
afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });

it('emits one pending album link before rendering and settles each slot despite a failure', async () => {
  process.env.AGENT_BEEPS_HOME = mkdtempSync(join(tmpdir(), 'beeps-command-home-'));
  const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-album-command-')));
  for (const name of ['one', 'broken', 'three']) saveSong(p, song({ name }));
  const output: any[] = [];
  const progress = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const observed: string[][] = [];
  vi.mocked(renderSong).mockImplementation(async (_host, s) => {
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ status: 'rendering', url: expect.stringContaining('/a/') });
    observed.push(readAlbum(p, output[0].album).tracks.map(t => t.status));
    if (s.name === 'broken') throw new Error('render failed');
    return { song: s, key: `key-${s.name}`, wavPath: join(p.paths.renders, s.name, 'delivered.wav'), lookPath: join(p.paths.renders, s.name, 'look.png'), features: { durationSec: 10, sections: [{ name: 'a', start: 0, end: 10 }], arc: [] } } as any;
  });
  const cmd = new Command();
  registerSongCommands(cmd, { projectDir: () => p.paths.root, emit: value => { output.push(value); } });
  await cmd.parseAsync(['album', 'open', 'one', 'broken', 'three', '--jobs', '1'], { from: 'user' });
  expect(output).toHaveLength(1);
  expect(observed).toEqual([['pending', 'pending', 'pending'], ['ready', 'pending', 'pending'], ['ready', 'failed', 'pending']]);
  const a = readAlbum(p, output[0].album);
  expect(a.tracks.map(t => t.status)).toEqual(['ready', 'failed', 'ready']);
  expect(a.tracks[0].renderKey).toBe('key-one');
  expect(a.tracks[1].error).toContain('render failed');
  expect(progress.mock.calls.map(c => JSON.parse(String(c[0]))).at(-1)).toMatchObject({ status: 'complete', ready: 2, failed: 1 });
  expect(process.exitCode).toBe(1);
});
