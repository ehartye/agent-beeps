// The owner's side: a LAN audition server. Pages are static (runtime/audition) and play candidates
// through the same engine the CLI measured; the JSON API is token-guarded and never serves a
// prediction before the owner ships.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { BeepsError } from '../errors.ts';
import { openProject, type OpenProject } from '../project.ts';
import { readKit } from '../kit.ts';
import { setCandidatePatch } from '../sets.ts';
import { RUNTIME_DIR } from '../render/host.ts';
import { beepsHome } from '../taste/verdicts.ts';
import { nextDuel } from '../taste/select.ts';
import { ALBUM_TAGS, appendAlbumEvent, foldAlbum, listAlbums, readAlbum } from '../album.ts';
import { appendEvent, CLIENT_EVENTS, foldSession, loadModel, readEvents, readReveal, readSession, tasteVectors, type SessionState } from './session.ts';

export const DEFAULT_PORT = 47301;
/** Bump when routes change: a running server of another API level is replaced, not reused. */
export const SERVER_API = 3;
const MAX_BODY = 64 * 1024;
const MIME: Record<string, string> = { '.wav': 'audio/wav', '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

export interface ServerInfo { pid: number; port: number; host: string; token: string; projects: string[]; startedAt: string; url: string; api?: number }

export const serverInfoFile = () => join(beepsHome(), 'server.json');

export function readServerInfo(): ServerInfo | null {
  try { return JSON.parse(readFileSync(serverInfoFile(), 'utf8')); } catch { return null; }
}

export function writeServerInfo(info: ServerInfo) {
  mkdirSync(beepsHome(), { recursive: true });
  writeFileSync(serverInfoFile(), JSON.stringify(info, null, 2) + '\n');
}

/** Persistent token: reused across restarts so links the owner bookmarked keep working. */
export function serverToken(): string {
  return readServerInfo()?.token ?? randomBytes(16).toString('hex');
}

export function registerProject(root: string) {
  const info = readServerInfo();
  if (!info) return;
  const abs = resolve(root);
  if (!info.projects.includes(abs)) writeServerInfo({ ...info, projects: [...info.projects, abs] });
}

export const publicHost = () => hostname().toLowerCase();

const VIRTUAL = /vethernet|wsl|hyper-v|docker|vbox|virtualbox|vmware|vmnet|loopback|utun|bridge/i;
const PHYSICAL = /wi-?fi|wlan|ethernet|^en\d|^eth\d|^wl/i;
const isPrivate = (a: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
const isTailscale = (a: string) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a);

/**
 * IPv4 addresses other devices can reach, best first: the physical LAN (Wi-Fi/Ethernet), other
 * private networks, then Tailscale. Virtual adapters (WSL, Hyper-V, Docker) are unreachable from
 * other machines and are left out.
 */
export function rankAddresses(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): { address: string; label: string }[] {
  const out: { address: string; label: string; score: number }[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) for (const a of addrs ?? []) {
    if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.') || VIRTUAL.test(name)) continue;
    if (isTailscale(a.address)) out.push({ address: a.address, label: 'tailscale', score: 2 });
    else if (isPrivate(a.address)) out.push({ address: a.address, label: 'lan', score: PHYSICAL.test(name) ? 0 : 1 });
    else out.push({ address: a.address, label: 'other', score: 3 });
  }
  return out.sort((a, b) => a.score - b.score).map(({ address, label }) => ({ address, label }));
}

/** Best address for devices (phones) that cannot resolve the machine name. */
export function lanAddress(): string | null {
  return rankAddresses()[0]?.address ?? null;
}

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new BeepsError('E_SERVER', 'request body too large'), { status: 413 });
    chunks.push(c as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new BeepsError('E_SCHEMA', 'request body is not JSON'); }
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

/** Relative words from measured features, so the owner reads "darker, shorter" rather than numbers. */
function describe(c: { features: Record<string, any> }, all: { features: Record<string, any> }[]): string[] {
  const med = (k: string) => { const xs = all.map(a => Number(a.features[k])).sort((a, b) => a - b); return xs[xs.length >> 1]; };
  const f = c.features, words: string[] = [];
  if (all.length > 1) {
    if (f.centroidHz > med('centroidHz') * 1.25) words.push('bright'); else if (f.centroidHz < med('centroidHz') / 1.25) words.push('dark');
    if (f.energyLengthSec > med('energyLengthSec') * 1.3) words.push('long'); else if (f.energyLengthSec < med('energyLengthSec') / 1.3) words.push('short');
  }
  if (f.attackSec < 0.004) words.push('punchy'); else if (f.attackSec > 0.03) words.push('soft');
  if (f.flatness > 0.3) words.push('noisy'); else if (f.pitchStrength >= 0.8) words.push('tonal');
  if (f.roughness > 0.4) words.push('gritty');
  if (f.pitchDirection > 3) words.push('rising'); else if (f.pitchDirection < -3) words.push('falling');
  return words;
}

/** Words that tell this candidate apart: a word every candidate in the round shares says nothing. */
function distinctWords(c: { features: Record<string, any> }, round: { features: Record<string, any> }[]): string[] {
  const all = round.map(o => describe(o, round));
  const shared = all.length > 1 ? all.reduce((acc, ws) => acc.filter(w => ws.includes(w))) : [];
  return describe(c, round).filter(w => !shared.includes(w));
}

/** A soft sustained pad the page loops under candidates when "bed" is on. */
export const BED_PATCH = {
  schema: 'beeps/patch@1', name: 'bed', family: 'bed', tags: [], duration: 4,
  layers: [
    { source: { type: 'osc', wave: 'triangle', pitch: 'C3', unison: { voices: 2, detuneCents: 12 } }, start: 0, gainDb: 0, amp: { attack: 0.8, decay: 0, sustain: 1, release: 0.8 }, filter: { type: 'lowpass', cutoff: 900, resonanceDb: 0 } },
    { source: { type: 'osc', wave: 'triangle', pitch: 'G3', unison: { voices: 2, detuneCents: 10 } }, start: 0, gainDb: -3, amp: { attack: 1.2, decay: 0, sustain: 1, release: 0.8 }, filter: { type: 'lowpass', cutoff: 900, resonanceDb: 0 } },
    { source: { type: 'noise', color: 'pink' }, start: 0, gainDb: -26, amp: { attack: 1, decay: 0, sustain: 1, release: 0.8 }, filter: { type: 'lowpass', cutoff: 1500, resonanceDb: 0 } },
  ],
  fx: { reverb: { preset: 'hall', sendDb: -10 } },
};

export interface ServerOptions {
  host?: string; port?: number; token?: string; projects?: string[];
  /** Hand-off mode: breed the next round when the owner asks to refine. */
  onRefine?: (p: OpenProject, sessionId: string, state: SessionState) => Promise<void>;
}

export class AuditionServer {
  server!: Server;
  info!: ServerInfo;
  private projects: string[];
  private opts: ServerOptions;
  constructor(opts: ServerOptions = {}) { this.opts = opts; this.projects = (opts.projects ?? []).map(p => resolve(p)); }

  private knownProjects(): string[] {
    const fromFile = readServerInfo()?.projects ?? [];
    return [...new Set([...this.projects, ...fromFile])];
  }

  findSession(id: string): OpenProject {
    if (!/^[a-z0-9-]+$/.test(id)) throw new BeepsError('E_NOT_FOUND', 'invalid session id');
    for (const root of this.knownProjects()) {
      if (existsSync(join(root, '.agent-beeps', 'sessions', id, 'session.json'))) return openProject(root);
    }
    throw new BeepsError('E_NOT_FOUND', `no session ${id} in registered projects`);
  }

  sessionPayload(p: OpenProject, id: string) {
    const session = readSession(p, id);
    const state = foldSession(session, readEvents(p, id));
    const model = loadModel(p);
    const { x } = tasteVectors(state.candidates.map(c => c.raw));
    const vec = new Map(state.candidates.map((c, i) => [c.index, x[i]]));
    const next = state.stage === 'duel' ? nextDuel(state.shortlist.map(index => ({ index, x: vec.get(index)! })), model, state.duels) : [];
    const kit = session.context.kit ? readKit(p.paths.root).sounds.flatMap(s => {
      const file = join(p.paths.patches, `${s.name}.json`);
      return existsSync(file) ? [{ name: s.name, family: s.family, trimDb: s.trimDb ?? 0, seed: s.seed ?? 1, patch: JSON.parse(readFileSync(file, 'utf8')) }] : [];
    }) : [];
    return {
      session: { id: session.id, prompt: session.prompt, family: session.family, archetype: session.archetype, mode: session.mode, context: session.context, createdAt: session.createdAt },
      state: { ...state, candidates: undefined },
      candidates: state.candidates.map(c => ({
        index: c.index, name: c.name, seed: c.seed, trimDb: c.trimDb, round: c.round,
        words: distinctWords(c, state.candidates.filter(o => o.round === c.round)),
        look: `/api/session/${id}/look/${c.index}`,
        patch: setCandidatePatch(p, c.setId, c.name),
      })),
      next, kit, bed: session.context.bed ? BED_PATCH : null, scale: p.project.scale,
    };
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    let path: string;
    try { path = decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: { code: 'E_USAGE', message: 'malformed URL' } }); }
    const token = url.searchParams.get('t') ?? (req.headers['x-beeps-token'] as string | undefined) ?? '';
    const authed = sameToken(token, this.info.token);

    if (path === '/' || path === '/index.html') return this.file(res, join(RUNTIME_DIR, 'audition', 'queue.html'));
    if (/^\/s\/[a-z0-9-]+$/.test(path)) return this.file(res, join(RUNTIME_DIR, 'audition', 'index.html'));
    if (/^\/a\/[a-z0-9-]+$/.test(path)) return this.file(res, join(RUNTIME_DIR, 'audition', 'album.html'));
    if (path.startsWith('/runtime/')) {
      const file = normalize(join(RUNTIME_DIR, path.slice('/runtime/'.length)));
      if (!file.startsWith(normalize(RUNTIME_DIR) + sep)) return json(res, 404, { error: { code: 'E_NOT_FOUND', message: 'not found' } });
      return this.file(res, file);
    }
    if (!path.startsWith('/api/')) return json(res, 404, { error: { code: 'E_NOT_FOUND', message: 'not found' } });
    if (path === '/api/health') return json(res, 200, { ok: true, authed, pid: process.pid, api: SERVER_API });
    if (!authed) return json(res, 401, { error: { code: 'E_SERVER', message: 'missing or wrong token (the link carries ?t=...)' } });

    if (path === '/api/sessions' && req.method === 'GET') {
      const out = [];
      for (const root of this.knownProjects()) {
        const dir = join(root, '.agent-beeps', 'sessions');
        if (!existsSync(dir)) continue;
        const p = openProject(root);
        for (const id of readdirSync(dir)) {
          try {
            const s = readSession(p, id);
            const st = foldSession(s, readEvents(p, id));
            out.push({ id, project: basename(root), prompt: s.prompt, family: s.family, stage: st.stage, round: st.round, createdAt: s.createdAt });
          } catch { /* skip unreadable sessions */ }
        }
      }
      out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json(res, 200, { sessions: out });
    }
    if (path === '/api/albums' && req.method === 'GET') {
      const out = [];
      for (const root of this.knownProjects()) {
        if (!existsSync(join(root, '.agent-beeps', 'albums'))) continue;
        for (const a of listAlbums(openProject(root))) out.push({ id: a.id, title: a.title, tracks: a.tracks.length, project: basename(root), createdAt: a.createdAt });
      }
      out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json(res, 200, { albums: out });
    }
    const am = /^\/api\/album\/([a-z0-9-]+)(?:\/(event|wav|look)(?:\/(\d+))?)?$/.exec(path);
    if (am) return this.albumRoute(req, res, am[1], am[2], am[3]);
    const m = /^\/api\/session\/([a-z0-9-]+)(?:\/(event|reveal|look)(?:\/(\d+))?)?$/.exec(path);
    if (!m) return json(res, 404, { error: { code: 'E_NOT_FOUND', message: 'unknown endpoint' } });
    const [, id, action, arg] = m;
    const p = this.findSession(id);
    if (!action && req.method === 'GET') return json(res, 200, this.sessionPayload(p, id));
    if (action === 'look' && req.method === 'GET') {
      const state = foldSession(readSession(p, id), readEvents(p, id));
      const c = state.candidates.find(x => x.index === Number(arg));
      const file = c ? resolve(c.look) : '';
      // Only images from this project's render cache, whatever path a session file claims.
      if (!c || !file.startsWith(resolve(p.paths.renders) + sep) || !file.endsWith('look.png') || !existsSync(file)) return json(res, 404, { error: { code: 'E_NOT_FOUND', message: 'no look image' } });
      return this.file(res, file);
    }
    if (action === 'reveal' && req.method === 'GET') {
      const reveal = readReveal(p, id);
      return reveal ? json(res, 200, reveal) : json(res, 404, { error: { code: 'E_NOT_FOUND', message: 'not shipped yet' } });
    }
    if (action === 'event' && req.method === 'POST') {
      const body = await readBody(req) as { type?: unknown };
      if (!CLIENT_EVENTS.has(String(body?.type))) return json(res, 403, { error: { code: 'E_SERVER', message: 'the listening page may only send play, lineup, duel, refine, ship and abandon' } });
      const r = appendEvent(p, id, body);
      if (r.event.type === 'refine' && readSession(p, id).mode === 'handoff' && this.opts.onRefine) {
        this.opts.onRefine(p, id, r.state).catch(e => console.error(JSON.stringify({ error: { code: 'E_SERVER', message: `auto-refine failed: ${(e as Error).message}` } })));
      }
      return json(res, 200, { event: r.event, stage: r.state.stage, verdicts: r.verdicts });
    }
    return json(res, 405, { error: { code: 'E_SERVER', message: 'method not allowed' } });
  }

  findAlbum(id: string): OpenProject {
    if (!/^[a-z0-9-]+$/.test(id)) throw new BeepsError('E_NOT_FOUND', 'invalid album id');
    for (const root of this.knownProjects()) {
      if (existsSync(join(root, '.agent-beeps', 'albums', id, 'album.json'))) return openProject(root);
    }
    throw new BeepsError('E_NOT_FOUND', `no album ${id} in registered projects`);
  }

  private async albumRoute(req: IncomingMessage, res: ServerResponse, id: string, action?: string, arg?: string) {
    const p = this.findAlbum(id);
    const album = readAlbum(p, id);
    if (!action && req.method === 'GET') {
      return json(res, 200, {
        id: album.id, title: album.title, createdAt: album.createdAt, tags: ALBUM_TAGS, state: foldAlbum(album, p),
        tracks: album.tracks.map(t => ({ ...t, wav: t.status === 'ready' ? `/api/album/${id}/wav/${t.index}` : null, look: t.status === 'ready' ? `/api/album/${id}/look/${t.index}` : null })),
      });
    }
    if (action === 'event' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, { event: appendAlbumEvent(p, id, body) });
    }
    const t = album.tracks.find(x => x.index === Number(arg));
    if (!t || t.status !== 'ready' || req.method !== 'GET') return json(res, 404, { error: { code: 'E_NOT_FOUND', message: 'track not available' } });
    // Only files inside this project's render cache, whatever path an album file claims.
    const file = resolve(action === 'wav' ? t.wav : t.look);
    const want = action === 'wav' ? 'delivered.wav' : 'look.png';
    if (!file.startsWith(resolve(p.paths.renders) + sep) || basename(file) !== want || !existsSync(file)) return json(res, 404, { error: { code: 'E_NOT_FOUND', message: 'render missing' } });
    if (action === 'look') return this.file(res, file);
    return this.ranged(req, res, file);
  }

  /** Byte-range file responses, so the page can seek inside a multi-minute WAV. */
  private ranged(req: IncomingMessage, res: ServerResponse, file: string) {
    const size = statSync(file).size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    const head = { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
    if (!range || (!range[1] && !range[2])) {
      res.writeHead(200, { ...head, 'content-length': size });
      createReadStream(file).pipe(res);
      return;
    }
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    end = Math.min(end, size - 1);
    if (start > end || start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }).end(); return; }
    res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
  }

  private file(res: ServerResponse, file: string) {
    if (!existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: { code: 'E_NOT_FOUND', message: 'not found' } });
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  }

  async listen(): Promise<ServerInfo> {
    const host = this.opts.host ?? '0.0.0.0';
    const token = this.opts.token ?? serverToken();
    let port = this.opts.port ?? DEFAULT_PORT;
    this.server = createServer((req, res) => {
      this.route(req, res).catch(e => {
        const err = e instanceof BeepsError ? e : new BeepsError('E_SERVER', (e as Error).message);
        const status = (e as { status?: number }).status ?? (err.code === 'E_NOT_FOUND' ? 404 : err.code === 'E_SCHEMA' ? 400 : err.code === 'E_CONFLICT' ? 409 : 500);
        if (!res.headersSent) json(res, status, { error: err.toJson() });
      });
    });
    for (let attempt = 0; ; attempt++) {
      try {
        await new Promise<void>((ok, fail) => { this.server.once('error', fail); this.server.listen(port, host, () => { this.server.off('error', fail); ok(); }); });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt > 20 || this.opts.port === 0) throw e;
        port++;
      }
    }
    const actual = (this.server.address() as AddressInfo).port;
    this.info = { api: SERVER_API, pid: process.pid, port: actual, host, token, projects: this.knownProjects(), startedAt: new Date().toISOString(), url: `http://${host === '127.0.0.1' ? '127.0.0.1' : publicHost()}:${actual}` };
    return this.info;
  }

  close(): Promise<void> {
    return new Promise(r => this.server.close(() => r()));
  }
}

export const sessionUrl = (info: Pick<ServerInfo, 'url' | 'token'>, id: string) => `${info.url}/s/${id}?t=${info.token}`;
export const albumUrl = (info: Pick<ServerInfo, 'url' | 'token'>, id: string) => `${info.url}/a/${id}?t=${info.token}`;

/** The same link by IP address, when the machine has a LAN address. */
export function sessionIpUrl(info: Pick<ServerInfo, 'port' | 'token' | 'host'>, id: string): string | null {
  const ip = info.host === '127.0.0.1' ? null : lanAddress();
  return ip ? `http://${ip}:${info.port}/s/${id}?t=${info.token}` : null;
}

/** The album link by every reachable address, LAN first (then Tailscale, for off-network devices). */
export function albumIpUrls(info: Pick<ServerInfo, 'port' | 'token' | 'host'>, id: string): { url: string; via: string }[] {
  if (info.host === '127.0.0.1') return [];
  return rankAddresses().map(a => ({ url: `http://${a.address}:${info.port}/a/${id}?t=${info.token}`, via: a.label }));
}

export async function probe(info: ServerInfo | null): Promise<boolean> {
  if (!info) return false;
  try {
    const host = info.host === '0.0.0.0' || info.host === '::' ? '127.0.0.1' : info.host;
    const r = await fetch(`http://${host}:${info.port}/api/health?t=${info.token}`, { signal: AbortSignal.timeout(1500) });
    const body = await r.json() as { ok?: boolean; authed?: boolean; pid?: number };
    return !!(body.ok && body.authed && body.pid === info.pid);
  } catch { return false; }
}
