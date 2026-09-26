// Albums: a set of rendered songs the owner listens to on the LAN page, with an append-only log of
// their marks (love / keep / dud), tags and notes. The agent reads the folded state back.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  loop: z.boolean(), durationSec: z.number(),
  wav: z.string(), look: z.string(),
  sections: z.array(z.object({ name: z.string(), start: z.number(), end: z.number() })),
  features: z.record(z.string(), z.unknown()),
});
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
]);
export type AlbumEvent = z.infer<typeof AlbumEvent>;

export const albumDir = (p: OpenProject, id: string) => {
  if (!/^[a-z0-9-]+$/.test(id)) throw new BeepsError('E_NOT_FOUND', 'invalid album id');
  return join(p.paths.albums, id);
};

export function writeAlbum(p: OpenProject, a: { title: string; tracks: Omit<AlbumTrack, 'index'>[]; id?: string }): Album {
  const album = AlbumSchema.parse({
    schema: 'beeps/album@1', id: a.id ?? newId(`album-${a.title.toLowerCase()}`.slice(0, 40)), title: a.title,
    createdAt: new Date().toISOString(), tracks: a.tracks.map((t, i) => ({ ...t, index: i + 1 })),
  });
  const dir = albumDir(p, album.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'album.json'), JSON.stringify(album, null, 2) + '\n');
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

export function appendAlbumEvent(p: OpenProject, id: string, raw: unknown): AlbumEvent & { at: string } {
  const album = readAlbum(p, id);
  const r = AlbumEvent.safeParse(raw);
  if (!r.success) throw new BeepsError('E_SCHEMA', `bad album event: ${r.error.issues[0]?.message}`);
  const e = r.data;
  if ('index' in e && e.index !== undefined && !album.tracks.some(t => t.index === e.index)) throw new BeepsError('E_SCHEMA', `no track ${e.index} in album ${id}`);
  const row = { ...e, at: new Date().toISOString() };
  appendFileSync(join(albumDir(p, id), 'events.jsonl'), JSON.stringify(row) + '\n');
  return row;
}

export interface AlbumState {
  note: string;
  tracks: { index: number; name: string; title: string; mark: 'love' | 'keep' | 'dud' | null; tags: string[]; note: string; plays: number }[];
}

export function foldAlbum(album: Album, p: OpenProject): AlbumState {
  const file = join(albumDir(p, album.id), 'events.jsonl');
  const rows = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as AlbumEvent) : [];
  const state: AlbumState = { note: '', tracks: album.tracks.map(t => ({ index: t.index, name: t.name, title: t.title, mark: null, tags: [], note: '', plays: 0 })) };
  const at = (i: number) => state.tracks.find(t => t.index === i)!;
  for (const e of rows) {
    if (e.type === 'mark') at(e.index).mark = e.mark;
    else if (e.type === 'tags') at(e.index).tags = e.tags;
    else if (e.type === 'note') { if (e.index === undefined) state.note = e.text; else at(e.index).note = e.text; }
    else if (e.type === 'play') at(e.index).plays++;
  }
  return state;
}
