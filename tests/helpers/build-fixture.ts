// A tiny audio project for `beeps build` tests: two sfx, one adaptive song that plays a project patch as an instrument, one plain song.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { coin } from './patches.ts';
import { PAD, songInput } from './songs.ts';
import { loadConfig, type BuildConfig } from '../../src/build/config.ts';

/** A tonal stand-in for the hat: a noise layer would not survive the music-role codec check. */
const PLUCK = { ...PAD, name: 'pluck', duration: 0.5, layers: [{ ...PAD.layers[0], source: { type: 'osc', wave: 'triangle', pitch: 'G4' } }] };

export interface Fixture {
  dir: string; cfg(over?: Partial<BuildConfig>): BuildConfig;
  write(rel: string, value: unknown): void; read(rel: string): any; path(rel: string): string;
}

export function makeFixture(over: { workDir?: string; config?: Record<string, unknown> } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'beeps-build-'));
  const path = (rel: string) => join(dir, rel);
  const write = (rel: string, value: unknown) => { mkdirSync(dirname(path(rel)), { recursive: true }); writeFileSync(path(rel), JSON.stringify(value, null, 2) + '\n'); };
  const read = (rel: string): any => JSON.parse(readFileSync(path(rel), 'utf8'));
  write('beeps.build.json', { recipes: 'recipes.json', out: 'public/audio', lock: 'audio.lock.json', project: 'project.json', patches: 'patches', workDir: over.workDir ?? '.work', jobs: 2, ...over.config });
  write('project.json', { schema: 'beeps/project@1' });
  write('sfx/coin.json', coin());
  write('sfx/blip.json', { ...coin(), name: 'blip', family: 'blip', duration: 0.2 });
  write('patches/lead.json', { ...PAD, name: 'lead' });
  write('songs/theme.json', songInput({
    name: 'theme', loop: true,
    tracks: { pad: { instrument: 'lead' }, hat: { instrument: PLUCK, gainDb: -6 } },
    adaptive: { layers: { bed: ['pad'], pulse: ['hat'] }, states: { calm: ['bed'], full: ['bed', 'pulse'] }, initial: 'calm' },
  }));
  write('songs/plain.json', songInput({ name: 'plain', loop: true }));
  write('recipes.json', {
    coin: { source: 'sfx/coin.json', role: 'sfx' },
    blip: { source: 'sfx/blip.json', role: 'sfx' },
    theme: { source: 'songs/theme.json', role: 'music' },
    plain: { source: 'songs/plain.json', role: 'ambience' },
  });
  return { dir, path, write, read, cfg: (o = {}) => ({ ...loadConfig(dir), ...o }) };
}

/** A copy of a built fixture (outputs, lock and render cache included), so each test mutates its own project without re-rendering. */
export function cloneFixture(fx: Fixture): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'beeps-build-'));
  cpSync(fx.dir, dir, { recursive: true });
  const path = (rel: string) => join(dir, rel);
  return {
    dir, path,
    write: (rel, value) => { mkdirSync(dirname(path(rel)), { recursive: true }); writeFileSync(path(rel), JSON.stringify(value, null, 2) + '\n'); },
    read: (rel: string): any => JSON.parse(readFileSync(path(rel), 'utf8')),
    cfg: (o = {}) => ({ ...loadConfig(dir), ...o }),
  };
}

/** Every file under `dir` -> sha256, for "nothing else changed" comparisons. */
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else out[relative(dir, f).split(sep).join('/')] = createHash('sha256').update(readFileSync(f)).digest('hex'); } };
  if (existsSync(dir)) walk(dir);
  return out;
}

export const diffKeys = (a: Record<string, string>, b: Record<string, string>): string[] =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k]).sort();
