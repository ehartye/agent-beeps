// Albums: a set of rendered songs the owner listens to on the LAN page, with an append-only log of
// their marks (love / keep / dud), tags and notes. The agent reads the folded state back.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BeepsError } from './errors.ts';
import { newId } from './sets.ts';
import type { OpenProject } from './project.ts';

export const ALBUM_TAGS = [
  'gorgeous', 'great melody', 'great groove', 'fits exploring', 'too busy', 'too sparse', 'too dark', 'too bright',
  'muddy', 'harsh', 'repetitive', 'boring', 'wrong mood', 'loop seam', 'too loud part', 'too quiet part',
] as const;

const Track = z.object({
  index: z.number().int().positive(),
  name: z.string(), title: z.string(), description: z.string().optional(),
  loop: z.boolean(), durationSec: z.number().nonnegative().default(0),
  status: z.enum(['pending', 'ready', 'failed']).default('ready'),
  error: z.string().optional(), renderKey: z.string().optional(),
  wav: z.string().default(''), look: z.string().default(''),
  sections: z.array(z.object({ name: z.string(), start: z.number(), end: z.number() })).default([]),
  features: z.record(z.string(), z.unknown()).default({}),
}).refine(t => t.status !== 'ready' || (t.wav && t.look && t.durationSec > 0), 'ready track needs rendered media')
  .transform(t => ({ ...t, renderKey: t.renderKey ?? (t.status === 'ready' ? `legacy:${basename(dirname(t.wav))}` : undefined) }));
export const AlbumSchema = z.object({
  schema: z.literal('beeps/album@1'),
  id: z.string(), title: z.string(), createdAt: z.string(),
  tracks: z.array(Track).min(1),
});
export type Album = z.infer<typeof AlbumSchema>;
export type AlbumTrack = z.infer<typeof Track>;

export const AlbumEvent = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('mark'), index: z.number().int().positive(), mark: z.enum(['love', 'keep', 'dud']).nullable() }),
  z.strictObject({ type: z.literal('tags'), index: z.number().int().positive(), tags: z.array(z.string().max(40)).max(20) }),
  z.strictObject({ type: z.literal('note'), index: z.number().int().positive().optional(), text: z.string().max(4000) }),
  z.strictObject({ type: z.literal('play'), index: z.number().int().positive(), pos: z.number().min(0).optional() }),
  z.strictObject({ type: z.literal('moment'), index: z.number().int().positive(), pos: z.number().nonnegative(), text: z.string().trim().min(1).max(4000), renderKey: z.string().min(1) }),
]);
export type AlbumEvent = z.infer<typeof AlbumEvent>;

export const albumDir = (p: OpenProject, id: string) => {
  if (!/^[a-z0-9-]+$/.test(id)) throw new BeepsError('E_NOT_FOUND', 'invalid album id');
  return join(p.paths.albums, id);
};

function saveAlbum(p: OpenProject, album: Album) {
  const dir = albumDir(p, album.id);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `album-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(album, null, 2) + '\n');
    renameSync(temp, join(dir, 'album.json'));
  } finally { rmSync(temp, { force: true }); }
}

export function writeAlbum(p: OpenProject, a: { title: string; tracks: Omit<z.input<typeof Track>, 'index'>[]; id?: string }): Album {
  const album = AlbumSchema.parse({
    schema: 'beeps/album@1', id: a.id ?? newId(`album-${a.title.toLowerCase()}`.slice(0, 40)), title: a.title,
    createdAt: new Date().toISOString(), tracks: a.tracks.map((t, i) => ({ ...t, index: i + 1 })),
  });
  if (existsSync(join(albumDir(p, album.id), 'album.json'))) throw new BeepsError('E_CONFLICT', `album ${album.id} already exists`);
  saveAlbum(p, album);
  return album;
}

/** A render settles its original slot once. Read immediately before the atomic synchronous write. */
export function updateAlbumTrack(p: OpenProject, id: string, index: number, patch: Partial<AlbumTrack>): Album {
  const album = readAlbum(p, id);
  const t = album.tracks.find(t => t.index === index);
  if (!t) throw new BeepsError('E_NOT_FOUND', `no track ${index}`);
  if (t.status !== 'pending') throw new BeepsError('E_CONFLICT', `track ${index} is already settled`);
  if (patch.status !== 'ready' && patch.status !== 'failed') throw new BeepsError('E_SCHEMA', 'track must become ready or failed');
  Object.assign(t, Track.parse({ ...t, ...patch, index: t.index, name: t.name, title: t.title }));
  saveAlbum(p, album);
  return album;
}

export function readAlbum(p: OpenProject, id: string): Album {
  const file = join(albumDir(p, id), 'album.json');
  if (!existsSync(file)) throw new BeepsError('E_NOT_FOUND', `no album ${id}`, { hint: 'beeps album list' });
  return AlbumSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export function listAlbums(p: OpenProject): Album[] {
  if (!existsSync(p.paths.albums)) return [];
  return readdirSync(p.paths.albums).flatMap(id => { try { return [readAlbum(p, id)]; } catch { return []; } })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function appendAlbumEvent(p: OpenProject, id: string, raw: unknown): AlbumEvent & { at: string; section?: string | null } {
  const album = readAlbum(p, id);
  const r = AlbumEvent.safeParse(raw);
  if (!r.success) throw new BeepsError('E_SCHEMA', `bad album event: ${r.error.issues[0]?.message}`);
  const e = r.data;
  if ('index' in e && e.index !== undefined && !album.tracks.some(t => t.index === e.index)) throw new BeepsError('E_SCHEMA', `no track ${e.index} in album ${id}`);
  let section: string | null = null;
  if (e.type === 'moment') {
    const t = album.tracks.find(t => t.index === e.index)!;
    if (t.status !== 'ready') throw new BeepsError('E_SCHEMA', 'track is not ready');
    if (e.renderKey !== t.renderKey) throw new BeepsError('E_CONFLICT', 'render changed; reload the album before adding a moment note');
    if (e.pos > t.durationSec) throw new BeepsError('E_SCHEMA', 'moment is past the end of the track');
    section = t.sections.find(s => e.pos >= s.start && e.pos < s.end)?.name ?? null;
  }
  const row = { ...e, at: new Date().toISOString(), ...(e.type === 'moment' ? { section } : {}) };
  appendFileSync(join(albumDir(p, id), 'events.jsonl'), JSON.stringify(row) + '\n');
  return row;
}

export interface AlbumState {
  note: string;
  tracks: { index: number; name: string; title: string; mark: 'love' | 'keep' | 'dud' | null; tags: string[]; note: string; plays: number; moments: { pos: number; text: string; renderKey: string; section: string | null; at: string }[] }[];
}

export function foldAlbum(album: Album, p: OpenProject): AlbumState {
  const file = join(albumDir(p, album.id), 'events.jsonl');
  const rows = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as AlbumEvent & { at: string; section?: string | null }) : [];
  const state: AlbumState = { note: '', tracks: album.tracks.map(t => ({ index: t.index, name: t.name, title: t.title, mark: null, tags: [], note: '', plays: 0, moments: [] })) };
  const at = (i: number) => state.tracks.find(t => t.index === i)!;
  for (const e of rows) {
    if (e.type === 'mark') at(e.index).mark = e.mark;
    else if (e.type === 'tags') at(e.index).tags = e.tags;
    else if (e.type === 'note') { if (e.index === undefined) state.note = e.text; else at(e.index).note = e.text; }
    else if (e.type === 'play') at(e.index).plays++;
    else if (e.type === 'moment') at(e.index).moments.push({ pos: e.pos, text: e.text, renderKey: e.renderKey, section: e.section ?? null, at: e.at });
  }
  return state;
}
