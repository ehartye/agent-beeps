// Songs in the project store, and the instruments they play: project patches, the bundled
// instrument library, or patches written inline in the song.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BeepsError } from './errors.ts';
import { parseOrThrow, readJsonFile, type OpenProject } from './project.ts';
import { inlinePatchInput, parseSong, type Song } from './schema/song.ts';
import type { Patch } from './schema/patch.ts';

export const LIBRARY_DIR = join(import.meta.dirname, '..', 'library');
export const INSTRUMENTS_DIR = join(LIBRARY_DIR, 'instruments');
export const SONG_LIBRARY_DIR = join(LIBRARY_DIR, 'songs');

export function songOrThrow(input: unknown, where: string): Song {
  const r = parseSong(input);
  if (r.ok) return r.song;
  const first = r.issues[0];
  throw new BeepsError('E_SCHEMA', `${where}: ${first.message}${r.issues.length > 1 ? ` (+${r.issues.length - 1} more)` : ''}`, {
    pointer: first.pointer, hint: first.hint, details: r.issues.length > 1 ? { issues: r.issues.slice(0, 10) } : {},
  });
}

/** Library songs live one folder deep (library/songs/<collection>/<name>.json). */
function librarySongFiles(): { name: string; collection: string; file: string }[] {
  if (!existsSync(SONG_LIBRARY_DIR)) return [];
  return readdirSync(SONG_LIBRARY_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).flatMap(d =>
    readdirSync(join(SONG_LIBRARY_DIR, d.name)).filter(f => f.endsWith('.json')).map(f => ({ name: f.slice(0, -5), collection: d.name, file: join(SONG_LIBRARY_DIR, d.name, f) })));
}

/** A song by path, project name, or library name. */
export function loadSong(p: OpenProject, ref: string): Song {
  if (ref.endsWith('.json') && existsSync(ref)) return songOrThrow(readJsonFile(ref), ref);
  const own = join(p.paths.songs, `${ref}.json`);
  if (existsSync(own)) return songOrThrow(readJsonFile(own), own);
  const lib = librarySongFiles().find(s => s.name === ref);
  if (lib) return songOrThrow(readJsonFile(lib.file), lib.file);
  throw new BeepsError('E_NOT_FOUND', `no song "${ref}"`, { hint: 'use a name from "beeps song list", or a path to a .json song' });
}

export function saveSong(p: OpenProject, song: Song, { force = false } = {}): string {
  const file = join(p.paths.songs, `${song.name}.json`);
  if (existsSync(file) && !force) throw new BeepsError('E_CONFLICT', `song "${song.name}" already exists`, { hint: 'pass --force to replace it' });
  mkdirSync(p.paths.songs, { recursive: true });
  writeFileSync(file, JSON.stringify(song, null, 2) + '\n');
  return file;
}

export function listSongs(p: OpenProject): { name: string; title?: string; source: string; file: string }[] {
  const own = existsSync(p.paths.songs) ? readdirSync(p.paths.songs).filter(f => f.endsWith('.json')).map(f => ({ name: f.slice(0, -5), source: 'project', file: join(p.paths.songs, f) })) : [];
  const lib = librarySongFiles().map(s => ({ name: s.name, source: `library/${s.collection}`, file: s.file }));
  return [...own, ...lib.filter(l => !own.some(o => o.name === l.name))].map(s => {
    try { const song = songOrThrow(readJsonFile(s.file), s.file); return { ...s, ...(song.title ? { title: song.title } : {}) }; } catch { return s; }
  });
}

export function libraryInstruments(): { name: string; description?: string; tags: string[] }[] {
  if (!existsSync(INSTRUMENTS_DIR)) return [];
  return readdirSync(INSTRUMENTS_DIR).filter(f => f.endsWith('.json')).sort().map(f => {
    const patch = parseOrThrow(readJsonFile(join(INSTRUMENTS_DIR, f)), f);
    return { name: patch.name, ...(patch.meta?.description ? { description: patch.meta.description } : {}), tags: patch.tags };
  });
}

/** Instrument patch per track: inline, else a project patch, else a library instrument. */
export function resolveInstruments(p: OpenProject, song: Song): Record<string, Patch> {
  const out: Record<string, Patch> = {};
  for (const [track, t] of Object.entries(song.tracks)) {
    const at = `/tracks/${track}/instrument`;
    if (typeof t.instrument !== 'string') { out[track] = parseOrThrow(inlinePatchInput(track, t.instrument), `${song.name} ${at}`); continue; }
    const own = join(p.paths.patches, `${t.instrument}.json`);
    const lib = join(INSTRUMENTS_DIR, `${t.instrument}.json`);
    if (existsSync(own)) out[track] = parseOrThrow(readJsonFile(own), own);
    else if (existsSync(lib)) out[track] = parseOrThrow(readJsonFile(lib), lib);
    else throw new BeepsError('E_NOT_FOUND', `no instrument "${t.instrument}" for track "${track}"`, { pointer: at, hint: `a project patch name, a library instrument (beeps instruments), or an inline patch` });
  }
  return out;
}
