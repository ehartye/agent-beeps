// Songs in the project store, and the instruments they play: project patches, the bundled
// instrument library, or patches written inline in the song.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BeepsError } from './errors.ts';
import { parseOrThrow, readJsonFile, type OpenProject } from './project.ts';
import { inlinePatchInput, isOverride, parseSong, type Song } from './schema/song.ts';
import { parsePatch } from './schema/patch.ts';
import { setPointer } from './pointer.ts';
import type { Patch } from './schema/patch.ts';
import { instrumentSpan } from '../runtime/engine/song.js';
import { hzToMidi, noteToHz } from '../runtime/engine/notes.js';

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

const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const midiName = (m: number) => { const r = Math.round(m); return `${NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`; };

/** How an instrument plays: its root, where its layers sound relative to a note, held or one-shot. */
export function instrumentInfo(patch: Patch) {
  const span = instrumentSpan(patch);
  const held = patch.layers.some(l => l.amp.sustain > 0);
  return {
    root: span ? midiName(span.root) : null,
    pitched: span !== null,
    // Offsets in semitones from the written note: -12 means a layer sounds an octave below it.
    layers: span ? patch.layers.map(l => { const src = l.source as { type: string; pitch?: string | number }; return src.pitch === undefined ? src.type : `${src.type} ${Math.round(hzToMidi(noteToHz(src.pitch)) - span.root) >= 0 ? '+' : ''}${Math.round(hzToMidi(noteToHz(src.pitch)) - span.root)}`; }) : patch.layers.map(l => l.source.type),
    plays: held ? 'held (lasts the note length)' : `one-shot (rings ~${Math.round(Math.max(...patch.layers.map(l => l.start + l.amp.attack + l.amp.decay + l.amp.release)) * 10) / 10} s)`,
  };
}

export function libraryInstruments() {
  if (!existsSync(INSTRUMENTS_DIR)) return [];
  return readdirSync(INSTRUMENTS_DIR).filter(f => f.endsWith('.json')).sort().map(f => {
    const patch = parseOrThrow(readJsonFile(join(INSTRUMENTS_DIR, f)), f);
    return { name: patch.name, ...(patch.meta?.description ? { description: patch.meta.description } : {}), tags: patch.tags, ...instrumentInfo(patch) };
  });
}

/**
 * Instrument patch per track. A name resolves to the song's own instruments, then project patches,
 * then the library; {base, set} copies a named instrument and applies JSON-pointer overrides.
 */
export function resolveInstruments(p: OpenProject, song: Song): Record<string, Patch> {
  const resolving = new Set<string>();
  const byName = (name: string, at: string): Patch => {
    if (name in song.instruments) {
      if (resolving.has(name)) throw new BeepsError('E_SCHEMA', `instrument "${name}" is based on itself`, { pointer: `/instruments/${name}` });
      resolving.add(name);
      try { return fromSpec(song.instruments[name], `/instruments/${name}`, name); } finally { resolving.delete(name); }
    }
    const own = join(p.paths.patches, `${name}.json`);
    const lib = join(INSTRUMENTS_DIR, `${name}.json`);
    if (existsSync(own)) return parseOrThrow(readJsonFile(own), own);
    if (existsSync(lib)) return parseOrThrow(readJsonFile(lib), lib);
    throw new BeepsError('E_NOT_FOUND', `no instrument "${name}"`, { pointer: at, hint: 'a song instrument, a project patch name, a library instrument (beeps instruments), or an inline patch' });
  };
  const fromSpec = (spec: unknown, at: string, name: string): Patch => {
    if (typeof spec === 'string') return byName(spec, at);
    const raw = isOverride(spec)
      ? (() => {
        const base = structuredClone(byName(spec.base, `${at}/base`)) as unknown as Record<string, unknown>;
        for (const [ptr, value] of Object.entries(spec.set ?? {})) {
          try { setPointer(base, ptr, value); } catch (e) { throw new BeepsError('E_SCHEMA', `${(e as Error).message}`, { pointer: `${at}/set` }); }
        }
        return { ...base, name };
      })()
      : inlinePatchInput(name, spec as Record<string, unknown>);
    const r = parsePatch(raw);
    if (!r.ok) {
      const first = r.issues[0];
      throw new BeepsError('E_SCHEMA', `${song.name} ${at}: ${first.message}`, { pointer: at + first.pointer, hint: first.hint });
    }
    return r.patch;
  };
  return Object.fromEntries(Object.entries(song.tracks).map(([track, t]) => [track, fromSpec(t.instrument, `/tracks/${track}/instrument`, typeof t.instrument === 'string' ? t.instrument : track)]));
}

/**
 * A copy of the song with only some tracks playing and/or only some sections in the form: for
 * hearing (looking at) one part alone. Solo renders never loop, so each part's own tail is visible.
 */
export function soloSong(song: Song, { only, sections }: { only?: string[]; sections?: string[] }): Song {
  const out = structuredClone(song);
  for (const t of only ?? []) if (!(t in song.tracks)) throw new BeepsError('E_USAGE', `no track "${t}"`, { hint: `tracks: ${Object.keys(song.tracks).join(', ')}` });
  for (const x of sections ?? []) if (!(x in song.sections)) throw new BeepsError('E_USAGE', `no section "${x}"`, { hint: `sections: ${Object.keys(song.sections).join(', ')}` });
  if (only?.length) for (const sec of Object.values(out.sections)) sec.play = Object.fromEntries(Object.entries(sec.play).filter(([t]) => only.includes(t)));
  if (sections?.length) out.form = out.form.filter(f => sections.includes(f));
  if (!out.form.length) throw new BeepsError('E_USAGE', 'no sections left to render');
  out.loop = false;
  return out;
}
