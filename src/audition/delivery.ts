// Delivery-format audition: encode sounds or songs through the compress presets (MP3 CBR and VBR, Ogg Opus) next to the lossless WAV
// master as a hidden reference and a low-passed anchor (MUSHRA style), into a scratch directory under the project. The owner then
// rates them blind on a phone-friendly page. Read-only on masters; nothing here touches the build store or export outputs.
//
// Taste: results never enter verdicts.jsonl. A delivery preference is not a pairwise sound verdict (the same sound at different bitrates
// has identical taste features), so it goes to its own delivery.jsonl and `beeps taste fit` cannot see it. No prediction seal applies:
// the mode has no candidate lineup for an agent to call, so E_PREDICTION_REQUIRED is never raised here.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { BeepsError } from '../errors.ts';
import { readWav } from '../audio/wav.ts';
import { encoderArgs, ffmpegFingerprint, findFfmpeg } from '../compress.ts';
import { ExportManifestSchema } from '../export-manifest.ts';
import { readAlbum } from '../album.ts';
import { newId, readSet } from '../sets.ts';
import type { OpenProject } from '../project.ts';
import { globalTasteDir } from '../taste/verdicts.ts';

export type Role = 'music' | 'ambience' | 'sfx';
export type Family = 'wav' | 'mp3' | 'opus';

export interface Preset { id: string; label: string; kind: 'reference' | 'anchor' | 'mp3-cbr' | 'mp3-vbr' | 'opus'; family: Family; ext: string; mime: string; kbps?: number; vbrQuality?: number }

const MIME: Record<Family, string> = { wav: 'audio/wav', mp3: 'audio/mpeg', opus: 'audio/ogg' };
const preset = (p: Omit<Preset, 'family' | 'ext' | 'mime' | 'label'> & { label?: string }): Preset => {
  const family: Family = p.kind === 'reference' || p.kind === 'anchor' ? 'wav' : p.kind === 'opus' ? 'opus' : 'mp3';
  const label = p.label ?? (p.kind === 'mp3-cbr' ? `MP3 CBR ${p.kbps}` : p.kind === 'mp3-vbr' ? `MP3 VBR V${p.vbrQuality}` : p.kind === 'opus' ? `Ogg Opus ${p.kbps}` : p.id);
  return { ...p, label, family, ext: family === 'opus' ? 'ogg' : family, mime: MIME[family] };
};

export const ANCHOR_HZ = 3500;
export const PRESETS: Preset[] = [
  preset({ id: 'wav', kind: 'reference', label: 'WAV master (hidden reference)' }),
  preset({ id: 'mp3-64', kind: 'mp3-cbr', kbps: 64 }), preset({ id: 'mp3-96', kind: 'mp3-cbr', kbps: 96 }), preset({ id: 'mp3-128', kind: 'mp3-cbr', kbps: 128 }),
  preset({ id: 'mp3-v5', kind: 'mp3-vbr', vbrQuality: 5 }), preset({ id: 'mp3-v2', kind: 'mp3-vbr', vbrQuality: 2 }),
  preset({ id: 'opus-32', kind: 'opus', kbps: 32 }), preset({ id: 'opus-48', kind: 'opus', kbps: 48 }), preset({ id: 'opus-64', kind: 'opus', kbps: 64 }), preset({ id: 'opus-96', kind: 'opus', kbps: 96 }),
  preset({ id: 'anchor', kind: 'anchor', label: `${ANCHOR_HZ / 1000} kHz low-pass anchor` }),
];
/** What `beeps audition formats` encodes unless --presets says otherwise: a spread around the sizes games ship, the reference and the anchor. */
export const DEFAULT_PRESETS = ['wav', 'mp3-64', 'mp3-96', 'mp3-v5', 'opus-32', 'opus-48', 'opus-64', 'anchor'];

export function resolvePresets(spec: string[] | undefined, opts: { anchor?: boolean } = {}): Preset[] {
  const ids = (spec?.length ? spec : DEFAULT_PRESETS).filter(i => opts.anchor !== false || i !== 'anchor');
  const out: Preset[] = [];
  for (const id of ids) {
    const found = PRESETS.find(p => p.id === id);
    if (!found) throw new BeepsError('E_USAGE', `unknown preset "${id}"`, { hint: `choose from ${PRESETS.map(p => p.id).join(', ')}` });
    if (!out.includes(found)) out.push(found);
  }
  if (!out.some(p => p.kind === 'reference')) out.unshift(PRESETS[0]); // the hidden reference is what makes the ratings meaningful
  const codecs = out.filter(p => p.kind !== 'reference' && p.kind !== 'anchor');
  if (!codecs.length) throw new BeepsError('E_USAGE', 'name at least one MP3 or Opus preset');
  if (out.length > 26) throw new BeepsError('E_USAGE', 'at most 26 presets (one blind letter each)');
  return out;
}

/** ffmpeg arguments between input and output. CBR and Opus reuse the compress encoder args, so what is heard is what `beeps compress` ships. */
export function presetArgs(p: Preset): string[] {
  switch (p.kind) {
    case 'mp3-cbr': return encoderArgs('mp3', p.kbps!);
    case 'opus': return encoderArgs('opus', p.kbps!);
    case 'mp3-vbr': return ['-map_metadata', '-1', '-c:a', 'libmp3lame', '-q:a', String(p.vbrQuality), '-write_xing', '1', '-id3v2_version', '0', '-ar', '48000'];
    case 'anchor': return ['-map_metadata', '-1', '-af', `lowpass=f=${ANCHOR_HZ}`, '-c:a', 'pcm_s16le'];
    default: return [];
  }
}

export interface Source { name: string; wav: string; role: Role; loop: boolean }
export interface PlannedJob { item: string; preset: string; file: string }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';

/** Pure: which files get encoded where, relative to the delivery's `enc` folder. Item ids are i1, i2... so URLs carry nothing about codecs. */
export function planEncodes(sources: Source[], presets: Preset[]): PlannedJob[] {
  return sources.flatMap((s, i) => presets.map(p => ({ item: `i${i + 1}`, preset: p.id, file: `i${i + 1}-${slug(s.name)}.${p.id}.${p.ext}` })));
}

/** Blind letters for one item: a seeded shuffle (mulberry32), so a delivery re-opened later keeps its letters. */
export function blindLetters(count: number, seed: number): number[] {
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  return order;
}
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// ---- sources ----

const guessRole = (sec: number): Role => (sec >= 20 ? 'music' : 'sfx');
function wavInfo(file: string) {
  const w = readWav(readFileSync(file));
  return { frames: w.channels[0]?.length ?? 0, sampleRate: w.sampleRate, channels: w.channels.length };
}

/** A bundle directory (sidecars give role and loop) or, without sidecars, every WAV in it. */
export function sourcesFromDir(dir: string, role?: Role): Source[] {
  const abs = resolve(dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new BeepsError('E_NOT_FOUND', `${abs} is not a directory`);
  const sidecars = readdirSync(abs).filter(n => n.endsWith('.wav.json')).sort();
  if (sidecars.length) {
    return sidecars.map(n => {
      const m = ExportManifestSchema.parse(JSON.parse(readFileSync(join(abs, n), 'utf8')));
      return { name: m.id, wav: join(abs, m.file), role: role ?? m.role, loop: m.loop };
    });
  }
  return readdirSync(abs).filter(n => /\.wav$/i.test(n)).sort().map(n => sourceFromFile(join(abs, n), role));
}

export function sourceFromFile(file: string, role?: Role): Source {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new BeepsError('E_NOT_FOUND', `${abs} does not exist`);
  if (!/\.wav$/i.test(abs)) throw new BeepsError('E_USAGE', `${abs}: only WAV masters can be auditioned (encode from the lossless file)`);
  const side = existsSync(`${abs}.json`) ? ExportManifestSchema.safeParse(JSON.parse(readFileSync(`${abs}.json`, 'utf8'))) : undefined;
  if (side?.success) return { name: side.data.id, wav: abs, role: role ?? side.data.role, loop: side.data.loop };
  const i = wavInfo(abs), sec = i.frames / i.sampleRate;
  return { name: basename(abs).replace(/\.wav$/i, ''), wav: abs, role: role ?? guessRole(sec), loop: false };
}

export function sourcesFromSet(p: OpenProject, setId: string, role?: Role): Source[] {
  const set = readSet(p, setId);
  const out = set.candidates.filter(c => c.wav && existsSync(c.wav)).map(c => ({ name: c.name, wav: c.wav, role: role ?? 'sfx' as Role, loop: false }));
  if (!out.length) throw new BeepsError('E_NOT_FOUND', `set ${setId} has no rendered WAVs on disk`, { hint: 'regenerate the set, or pass the exported WAV files' });
  return out;
}

export function sourcesFromAlbum(p: OpenProject, albumId: string, role?: Role): Source[] {
  const out = readAlbum(p, albumId).tracks.filter(t => t.status === 'ready' && t.wav && existsSync(t.wav)).map(t => ({ name: t.name, wav: t.wav, role: role ?? 'music' as Role, loop: t.loop }));
  if (!out.length) throw new BeepsError('E_NOT_FOUND', `album ${albumId} has no ready tracks on disk`);
  return out;
}

// ---- the delivery session ----

const Track = z.object({ preset: z.string(), letter: z.string().regex(/^[A-Z]$/), file: z.string(), bytes: z.number().int().nonnegative() });
const Item = z.object({
  id: z.string().regex(/^i\d+$/), name: z.string(), role: z.enum(['music', 'ambience', 'sfx']), loop: z.boolean(),
  durationSec: z.number().nonnegative(), frames: z.number().int().nonnegative(), sampleRate: z.number().int().positive(),
  tracks: z.array(Track),
});
export const DeliverySchema = z.object({
  schema: z.literal('beeps/delivery@1'),
  id: z.string(), title: z.string(), createdAt: z.string(), project: z.string(),
  presets: z.array(z.object({ id: z.string(), label: z.string(), kind: z.string(), family: z.enum(['wav', 'mp3', 'opus']), ext: z.string(), mime: z.string(), kbps: z.number().optional(), vbrQuality: z.number().optional() })),
  items: z.array(Item).min(1),
  /** Seconds of audio per role in the whole catalog, to scale the measured bytes per second to a library. */
  catalog: z.record(z.string(), z.number().nonnegative()).optional(),
  encoder: z.object({ ffmpeg: z.string(), libavcodec: z.string() }).optional(),
});
export type Delivery = z.infer<typeof DeliverySchema>;

export const deliveryRoot = (p: OpenProject) => join(p.paths.dir, 'delivery');
export const deliveryDir = (p: OpenProject, id: string) => join(deliveryRoot(p), id);
export const encDir = (p: OpenProject, id: string) => join(deliveryDir(p, id), 'enc');

export function readDelivery(p: OpenProject, id: string): Delivery {
  const file = join(deliveryDir(p, id), 'delivery.json');
  if (!/^[a-z0-9-]+$/.test(id) || !existsSync(file)) throw new BeepsError('E_NOT_FOUND', `no delivery audition ${id}`);
  return DeliverySchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/** Where a blind letter's file is on disk, or null for anything the delivery does not list. */
export function trackFile(p: OpenProject, d: Delivery, item: string, letter: string): { file: string; mime: string } | null {
  const it = d.items.find(i => i.id === item), t = it?.tracks.find(x => x.letter === letter);
  const pr = t && d.presets.find(x => x.id === t.preset);
  return t && pr ? { file: join(encDir(p, d.id), basename(t.file)), mime: pr.mime } : null;
}

export type Encoder = (ffmpeg: string, wav: string, out: string, preset: Preset) => void;
export const ffmpegEncode: Encoder = (ffmpeg, wav, out, p) => {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, ...presetArgs(p), out], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new BeepsError('E_RENDER', `ffmpeg failed for ${p.id} on ${basename(wav)}: ${r.stderr?.toString().trim() || r.error?.message || r.status}`);
};

export interface EncodeOptions { title?: string; catalog?: Record<string, number>; encoder?: Encoder; ffmpeg?: string; seed?: number; log?: (s: string) => void }

/** Encode every source with every preset into `.agent-beeps/delivery/<id>/enc` and write delivery.json. Masters are only read. */
export function createDelivery(p: OpenProject, sources: Source[], presets: Preset[], opts: EncodeOptions = {}): Delivery {
  if (!sources.length) throw new BeepsError('E_USAGE', 'nothing to audition: no WAV masters found');
  if (sources.length > 60) throw new BeepsError('E_USAGE', `${sources.length} items is too many to listen to; pass at most 60`);
  const encoder = opts.encoder ?? ffmpegEncode;
  const needsFfmpeg = presets.some(x => x.kind !== 'reference');
  const ffmpeg = needsFfmpeg ? (opts.ffmpeg ?? (opts.encoder ? 'fake' : findFfmpeg())) : 'none';
  const id = newId('delivery');
  const enc = encDir(p, id);
  mkdirSync(enc, { recursive: true });
  ensureIgnored(p);
  const jobs = planEncodes(sources, presets);
  const seed = opts.seed ?? randomBytes(4).readUInt32LE(0);
  const items = sources.map((s, i) => {
    const info = wavInfo(s.wav);
    const order = blindLetters(presets.length, seed + i * 7919);
    const tracks = presets.map((pr, k) => {
      const job = jobs.find(j => j.item === `i${i + 1}` && j.preset === pr.id)!;
      const out = join(enc, job.file);
      opts.log?.(`${s.name} -> ${pr.id}`);
      if (pr.kind === 'reference') copyFileSync(s.wav, out); else encoder(ffmpeg, s.wav, out, pr);
      return { preset: pr.id, letter: LETTERS[order[k]], file: job.file, bytes: statSync(out).size };
    }).sort((a, b) => a.letter.localeCompare(b.letter));
    return { id: `i${i + 1}`, name: s.name, role: s.role, loop: s.loop, durationSec: info.frames / info.sampleRate, frames: info.frames, sampleRate: info.sampleRate, tracks };
  });
  const fp = needsFfmpeg && ffmpeg !== 'fake' ? ffmpegFingerprint(ffmpeg) : undefined;
  const d = DeliverySchema.parse({
    schema: 'beeps/delivery@1', id, title: opts.title ?? 'Delivery format audition', createdAt: new Date().toISOString(), project: p.paths.root,
    presets, items, ...(opts.catalog ? { catalog: opts.catalog } : {}), ...(fp ? { encoder: fp } : {}),
  });
  writeFileSync(join(deliveryDir(p, id), 'delivery.json'), JSON.stringify(d, null, 2) + '\n');
  return d;
}

/** The encodes are scratch: keep them out of git even in projects whose .gitignore predates this. */
function ensureIgnored(p: OpenProject) {
  const file = join(p.paths.dir, '.gitignore');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!/^delivery\/\s*$/m.test(text)) writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}delivery/\n`);
}

// ---- byte totals ----

export interface PresetTotal {
  preset: string; label: string; bytes: number; seconds: number; bytesPerSec: number;
  byRole: Record<string, { bytes: number; seconds: number; bytesPerSec: number }>;
  /** Scaled to the catalog's seconds per role, when the delivery names them. */
  projectedBytes?: number;
}

/** Real encoded sizes per preset, and (with catalog seconds per role) a projection for the whole library. */
export function byteTotals(d: Delivery): PresetTotal[] {
  return d.presets.map(pr => {
    const byRole: PresetTotal['byRole'] = {};
    for (const it of d.items) {
      const t = it.tracks.find(x => x.preset === pr.id);
      if (!t) continue;
      const r = (byRole[it.role] ??= { bytes: 0, seconds: 0, bytesPerSec: 0 });
      r.bytes += t.bytes; r.seconds += it.durationSec;
    }
    let bytes = 0, seconds = 0;
    for (const r of Object.values(byRole)) { r.bytesPerSec = r.seconds ? Math.round(r.bytes / r.seconds) : 0; bytes += r.bytes; seconds += r.seconds; }
    const total: PresetTotal = { preset: pr.id, label: pr.label, bytes, seconds, bytesPerSec: seconds ? Math.round(bytes / seconds) : 0, byRole };
    if (d.catalog) total.projectedBytes = Math.round(Object.entries(d.catalog).reduce((s, [role, sec]) => s + sec * (byRole[role]?.bytesPerSec ?? total.bytesPerSec), 0));
    return total;
  });
}

// ---- events and results ----

export const DeliveryEvent = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('device'), report: z.record(z.string(), z.unknown()) }),
  z.strictObject({ type: z.literal('rate'), item: z.string().regex(/^i\d+$/), letter: z.string().regex(/^[A-Z]$/), rating: z.number().int().min(1).max(5).nullable(), worse: z.boolean().optional(), note: z.string().max(1000).optional() }),
  z.strictObject({ type: z.literal('note'), text: z.string().max(4000) }),
  z.strictObject({ type: z.literal('reveal') }),
]);
export type DeliveryEventInput = z.infer<typeof DeliveryEvent>;
export type StoredDeliveryEvent = DeliveryEventInput & { seq: number; at: string };

const eventsFile = (p: OpenProject, id: string) => join(deliveryDir(p, id), 'events.jsonl');
export function readDeliveryEvents(p: OpenProject, id: string): StoredDeliveryEvent[] {
  const f = eventsFile(p, id);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(l => l.trim()).flatMap(l => { try { return [JSON.parse(l) as StoredDeliveryEvent]; } catch { return []; } });
}

export function appendDeliveryEvent(p: OpenProject, id: string, raw: unknown) {
  const d = readDelivery(p, id);
  const parsed = DeliveryEvent.safeParse(raw);
  if (!parsed.success) throw new BeepsError('E_SCHEMA', `bad delivery event: ${parsed.error.issues[0]?.message ?? 'invalid'}`, { pointer: `/${parsed.error.issues[0]?.path.join('/') ?? ''}` });
  const ev = parsed.data;
  if (ev.type === 'rate' && !d.items.find(i => i.id === ev.item)?.tracks.some(t => t.letter === ev.letter)) throw new BeepsError('E_SCHEMA', `no ${ev.item}/${ev.letter} in this delivery audition`);
  const prior = readDeliveryEvents(p, id);
  const stored = { ...ev, seq: (prior.at(-1)?.seq ?? 0) + 1, at: new Date().toISOString() } as StoredDeliveryEvent;
  appendFileSync(eventsFile(p, id), JSON.stringify(stored) + '\n');
  writeResults(p, id);
  return stored;
}

export interface ResultRow { item: string; name: string; role: string; letter: string; preset: string; family: string; rating: number | null; worse: boolean; note: string }
export interface RoleSummary { preset: string; n: number; meanRating: number | null; worse: number; acceptable: boolean | null; bytesPerSec: number }
export interface DeliveryResults {
  schema: 'beeps/delivery-results@1'; id: string; project: string; title: string; createdAt: string; revealed: boolean;
  prediction: 'not-applicable';
  device: Record<string, unknown> | null; notes: string[]; rows: ResultRow[]; totals: PresetTotal[];
  summary: Record<string, { referenceMean: number | null; anchorMean: number | null; screening: { pairs: number; passed: number; reliable: boolean | null }; presets: RoleSummary[]; suggest: string | null }>;
}

const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
/** A codec is acceptable for a role when it is within half a point of the hidden reference and no more than a fifth of its items were flagged worse. */
export const ACCEPT_MARGIN = 0.5, ACCEPT_WORSE_SHARE = 0.2;

export function foldResults(d: Delivery, events: StoredDeliveryEvent[]): DeliveryResults {
  const cur = new Map<string, { rating: number | null; worse: boolean; note: string }>();
  let device: Record<string, unknown> | null = null, revealed = false;
  const notes: string[] = [];
  for (const e of events) {
    if (e.type === 'rate') cur.set(`${e.item}/${e.letter}`, { rating: e.rating, worse: !!e.worse, note: e.note ?? '' });
    else if (e.type === 'device') device = e.report;
    else if (e.type === 'note') { if (e.text.trim()) notes.push(e.text.trim()); }
    else if (e.type === 'reveal') revealed = true;
  }
  const rows: ResultRow[] = d.items.flatMap(it => it.tracks.map(t => {
    const pr = d.presets.find(x => x.id === t.preset)!, c = cur.get(`${it.id}/${t.letter}`);
    return { item: it.id, name: it.name, role: it.role, letter: t.letter, preset: t.preset, family: pr.family, rating: c?.rating ?? null, worse: c?.worse ?? false, note: c?.note ?? '' };
  }));
  const totals = byteTotals(d);
  const bps = new Map(totals.map(t => [t.preset, t.byRole]));
  const summary: DeliveryResults['summary'] = {};
  for (const role of [...new Set(d.items.map(i => i.role))]) {
    const roleRows = rows.filter(r => r.role === role && r.rating !== null);
    const kind = (id: string) => d.presets.find(x => x.id === id)?.kind;
    const ref = mean(roleRows.filter(r => kind(r.preset) === 'reference').map(r => r.rating!)), anchor = mean(roleRows.filter(r => kind(r.preset) === 'anchor').map(r => r.rating!));
    // Listener screening: per item, the hidden reference must beat the low-passed anchor.
    let pairs = 0, passed = 0;
    for (const it of d.items.filter(i => i.role === role)) {
      const r = rows.find(x => x.item === it.id && kind(x.preset) === 'reference')?.rating, a = rows.find(x => x.item === it.id && kind(x.preset) === 'anchor')?.rating;
      if (r != null && a != null) { pairs++; if (r > a) passed++; }
    }
    const itemCount = d.items.filter(i => i.role === role).length;
    const presets: RoleSummary[] = d.presets.filter(x => x.kind !== 'reference' && x.kind !== 'anchor').map(pr => {
      const mine = roleRows.filter(r => r.preset === pr.id);
      const m = mean(mine.map(r => r.rating!)), worse = mine.filter(r => r.worse).length;
      const acceptable = m === null || ref === null ? null : m >= ref - ACCEPT_MARGIN && worse <= Math.max(0, Math.floor(itemCount * ACCEPT_WORSE_SHARE));
      return { preset: pr.id, n: mine.length, meanRating: m, worse, acceptable, bytesPerSec: bps.get(pr.id)?.[role]?.bytesPerSec ?? 0 };
    });
    const suggest = presets.filter(x => x.acceptable).sort((a, b) => a.bytesPerSec - b.bytesPerSec)[0]?.preset ?? null;
    summary[role] = { referenceMean: ref, anchorMean: anchor, screening: { pairs, passed, reliable: pairs ? passed / pairs >= 2 / 3 : null }, presets, suggest };
  }
  return { schema: 'beeps/delivery-results@1', id: d.id, project: d.project, title: d.title, createdAt: d.createdAt, revealed, prediction: 'not-applicable', device, notes, rows, totals, summary };
}

export function writeResults(p: OpenProject, id: string): DeliveryResults {
  const r = foldResults(readDelivery(p, id), readDeliveryEvents(p, id));
  writeFileSync(join(deliveryDir(p, id), 'results.json'), JSON.stringify(r, null, 2) + '\n');
  return r;
}

export function listDeliveries(p: OpenProject): { id: string; title: string; createdAt: string; items: number }[] {
  const root = deliveryRoot(p);
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap(id => { try { const d = readDelivery(p, id); return [{ id, title: d.title, createdAt: d.createdAt, items: d.items.length }]; } catch { return []; } }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---- taste: delivery preferences (kept out of verdicts.jsonl) ----

export const DeliveryPreferenceSchema = z.object({
  schema: z.literal('beeps/delivery-preference@1'),
  at: z.string(), project: z.string(), session: z.string(),
  role: z.enum(['music', 'ambience', 'sfx']), preset: z.string(), family: z.enum(['wav', 'mp3', 'opus']),
  n: z.number().int().positive(), meanRating: z.number(), referenceMean: z.number().nullable(), worse: z.number().int().nonnegative(),
  acceptable: z.boolean().nullable(), reliable: z.boolean().nullable(),
});
export type DeliveryPreference = z.infer<typeof DeliveryPreferenceSchema>;

export const DeliveryResultsHead = z.object({ schema: z.literal('beeps/delivery-results@1') }).passthrough();
export const deliveryPrefsFile = (p: OpenProject) => join(p.paths.taste, 'delivery.jsonl');
export const globalDeliveryPrefsFile = () => join(globalTasteDir(), 'delivery.jsonl');

export function readDeliveryPrefs(file: string): DeliveryPreference[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).flatMap(l => { try { const r = DeliveryPreferenceSchema.safeParse(JSON.parse(l)); return r.success ? [r.data] : []; } catch { return []; } });
}

/** One preference row per role and codec preset from a results file; only presets the owner actually rated. */
export function preferencesFromResults(r: DeliveryResults, d: Delivery): DeliveryPreference[] {
  const out: DeliveryPreference[] = [];
  const at = new Date().toISOString();
  for (const [role, s] of Object.entries(r.summary)) for (const x of s.presets) {
    if (!x.n || x.meanRating === null) continue;
    const pr = d.presets.find(q => q.id === x.preset)!;
    out.push({ schema: 'beeps/delivery-preference@1', at, project: r.project, session: r.id, role: role as Role, preset: x.preset, family: pr.family, n: x.n, meanRating: x.meanRating, referenceMean: s.referenceMean, worse: x.worse, acceptable: x.acceptable, reliable: s.screening.reliable });
  }
  return out;
}

/** Append once per session to the project and global files. Returns false when this session was already imported. */
export function importPreferences(p: OpenProject, rows: DeliveryPreference[]): boolean {
  if (!rows.length) return false;
  const files = [deliveryPrefsFile(p), globalDeliveryPrefsFile()];
  if (readDeliveryPrefs(files[0]).some(r => r.session === rows[0].session)) return false;
  const text = rows.map(r => JSON.stringify(DeliveryPreferenceSchema.parse(r))).join('\n') + '\n';
  for (const f of files) { mkdirSync(dirname(f), { recursive: true }); appendFileSync(f, text); }
  return true;
}

/** Across sessions: the owner's mean rating relative to the hidden reference, per role and preset (screened-out listeners excluded). */
export function summarizePreferences(rows: DeliveryPreference[]) {
  const acc = new Map<string, { role: string; preset: string; n: number; sum: number; worse: number; sessions: Set<string>; accept: number; judged: number }>();
  for (const r of rows) {
    if (r.reliable === false || r.referenceMean === null) continue;
    const a = acc.get(`${r.role}/${r.preset}`) ?? { role: r.role, preset: r.preset, n: 0, sum: 0, worse: 0, sessions: new Set<string>(), accept: 0, judged: 0 };
    a.n += r.n; a.sum += (r.meanRating - r.referenceMean) * r.n; a.worse += r.worse; a.sessions.add(r.session);
    if (r.acceptable !== null) { a.judged++; if (r.acceptable) a.accept++; }
    acc.set(`${r.role}/${r.preset}`, a);
  }
  return [...acc.values()].map(a => ({ role: a.role, preset: a.preset, ratings: a.n, sessions: a.sessions.size, vsReference: Math.round((a.sum / a.n) * 100) / 100, worseFlags: a.worse, acceptable: `${a.accept}/${a.judged}` })).sort((x, y) => x.role.localeCompare(y.role) || y.vsReference - x.vsReference);
}

