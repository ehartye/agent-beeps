// The content-addressed audio store: one tar per asset, named by its input hash, immutable, first writer wins.
// Backends: `dir:<path>` (a directory) and `release:<owner/repo>[@tag]` (GitHub release assets). Reads verify sha256; the store is
// never trusted: the lock (or the tar's own manifest) says what every file must hash to.
import { createHash } from 'node:crypto';
import { copyFileSync, constants, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { BeepsError } from '../errors.ts';
import { createTar, readTar, type TarEntry } from './tar.ts';

export const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

export interface OutputRef { file: string; sha256: string; bytes: number }
export interface StoreManifest { schema: 'beeps/store-asset@1'; id: string; inputHash: string; outputs: OutputRef[] }
export const MANIFEST_NAME = 'beeps-asset.json';

export const hexOf = (inputHash: string): string => inputHash.replace(/^sha256:/, '');
export const storeName = (inputHash: string): string => `${hexOf(inputHash)}.tar`;

export interface Store {
  readonly spec: string;
  has(name: string): Promise<boolean>;
  /** The entry's bytes, or undefined when the store has no such entry. */
  get(name: string): Promise<Buffer | undefined>;
  /** Stores an entry unless one with that name exists (first writer wins). */
  put(name: string, data: Buffer): Promise<'stored' | 'exists'>;
}

export function packAsset(id: string, inputHash: string, outputs: OutputRef[], read: (file: string) => Buffer): Buffer {
  const sorted = [...outputs].sort((a, b) => (a.file < b.file ? -1 : 1));
  const manifest: StoreManifest = { schema: 'beeps/store-asset@1', id, inputHash, outputs: sorted };
  const entries: TarEntry[] = [{ name: MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') }];
  for (const o of sorted) entries.push({ name: o.file, data: read(o.file) });
  return createTar(entries);
}

/** Parses a store tar and checks every file against the tar's manifest (and the manifest against `expect`, when given). */
export function unpackAsset(buf: Buffer, expect?: { inputHash: string; outputs?: OutputRef[] }): { manifest: StoreManifest; files: Map<string, Buffer> } {
  const entries = readTar(buf);
  const m = entries.find(e => e.name === MANIFEST_NAME);
  if (!m) throw new BeepsError('E_STORE', `store entry has no ${MANIFEST_NAME}`);
  const manifest = JSON.parse(m.data.toString('utf8')) as StoreManifest;
  if (manifest.schema !== 'beeps/store-asset@1' || !Array.isArray(manifest.outputs)) throw new BeepsError('E_STORE', `${MANIFEST_NAME}: not a beeps/store-asset@1 manifest`);
  if (expect && manifest.inputHash !== expect.inputHash) throw new BeepsError('E_STORE', `store entry is for ${manifest.inputHash}, wanted ${expect.inputHash}`);
  const files = new Map<string, Buffer>();
  for (const o of manifest.outputs) {
    const e = entries.find(x => x.name === o.file);
    if (!e) throw new BeepsError('E_STORE', `store entry ${manifest.id} lacks ${o.file}`);
    const sum = sha256Hex(e.data);
    if (sum !== o.sha256 || e.data.length !== o.bytes) throw new BeepsError('E_STORE', `store entry ${manifest.id}: ${o.file} does not match its manifest (sha256 ${sum.slice(0, 12)}, expected ${o.sha256.slice(0, 12)})`, { hint: 'the entry is corrupt; rebuild the asset and push it again under a new store' });
    files.set(o.file, e.data);
  }
  if (expect?.outputs) {
    for (const want of expect.outputs) {
      const got = manifest.outputs.find(o => o.file === want.file);
      if (!got || got.sha256 !== want.sha256) throw new BeepsError('E_STORE', `store entry ${manifest.id}: ${want.file} is not the file the lock expects (sha256 ${got?.sha256.slice(0, 12) ?? 'missing'} vs ${want.sha256.slice(0, 12)})`, { hint: 'the lock and the store disagree; rebuild the asset or commit the lock that matches the store' });
    }
  }
  return { manifest, files };
}

export class DirStore implements Store {
  readonly spec: string;
  readonly dir: string;
  constructor(dir: string) { this.dir = resolve(dir); this.spec = `dir:${dir}`; }
  async has(name: string) { return existsSync(join(this.dir, name)); }
  async get(name: string) {
    const f = join(this.dir, name);
    return existsSync(f) ? readFileSync(f) : undefined;
  }
  async put(name: string, data: Buffer) {
    mkdirSync(this.dir, { recursive: true });
    const dest = join(this.dir, name);
    if (existsSync(dest)) return 'exists';
    const tmp = join(this.dir, `.${name}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    writeFileSync(tmp, data);
    try {
      // A hard link is atomic and fails when the name exists: of two writers, exactly one wins and nobody sees a half-written entry.
      try { linkSync(tmp, dest); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
        copyFileSync(tmp, dest, constants.COPYFILE_EXCL); // filesystems without hard links
      }
      return 'stored';
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
      throw e;
    } finally { rmSync(tmp, { force: true }); }
  }
  /** Entry names present (for status and tests). */
  names(): string[] { return existsSync(this.dir) ? readdirSync(this.dir).filter(n => n.endsWith('.tar')) : []; }
}

// ---- GitHub release assets ----

export const RELEASE_LIMITS = { maxAssets: 1000, maxBytes: 2 * 1024 ** 3 } as const;

export interface HttpResponse { status: number; ok: boolean; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: Buffer; redirect?: 'follow' }) => Promise<HttpResponse>;

interface ReleaseAsset { id: number; name: string; size: number; browser_download_url: string }
interface TagState { tag: string; id: number; assets: Map<string, ReleaseAsset> }

export interface ReleaseOptions {
  repo: string; tag?: string; token?: string; fetch?: Fetch; maxAssets?: number; maxBytes?: number;
  api?: string; uploads?: string;
}

/** A token for writes: $GITHUB_TOKEN, $GH_TOKEN, or `gh auth token`. */
export function githubToken(): string | undefined {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env;
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

/**
 * Release assets as the store: the first release (`audio-store`, or the tag given) holds up to 1000 assets; when it is full the
 * next tag, `<tag>-1`, `<tag>-2`, ... takes over. An entry is named `<inputHash hex>.tar` and is never overwritten.
 * Reads of a public repo need no token; writes need one (`GITHUB_TOKEN`, or `gh auth token`).
 */
export class ReleaseStore implements Store {
  readonly spec: string;
  private readonly o: Required<Pick<ReleaseOptions, 'repo' | 'maxAssets' | 'maxBytes' | 'api' | 'uploads'>> & { tag: string; token?: string; fetch: Fetch };
  private tags: TagState[] | undefined;
  constructor(opts: ReleaseOptions) {
    this.o = {
      repo: opts.repo, tag: opts.tag ?? 'audio-store', token: opts.token,
      fetch: opts.fetch ?? ((url, init) => fetch(url, init as RequestInit) as unknown as Promise<HttpResponse>),
      maxAssets: opts.maxAssets ?? RELEASE_LIMITS.maxAssets, maxBytes: opts.maxBytes ?? RELEASE_LIMITS.maxBytes,
      api: opts.api ?? 'https://api.github.com', uploads: opts.uploads ?? 'https://uploads.github.com',
    };
    this.spec = `release:${opts.repo}${opts.tag ? `@${opts.tag}` : ''}`;
  }
  private tagName(n: number) { return n === 0 ? this.o.tag : `${this.o.tag}-${n}`; }
  private headers(extra: Record<string, string> = {}) {
    return { accept: 'application/vnd.github+json', 'user-agent': 'agent-beeps', ...(this.o.token ? { authorization: `Bearer ${this.o.token}` } : {}), ...extra };
  }
  private async call(url: string, init: Parameters<Fetch>[1] = {}) {
    const r = await this.o.fetch(url, { ...init, headers: this.headers(init.headers) });
    return r;
  }
  /** Loads every release of the chain (tag, tag-1, ...) until one does not exist. */
  private async load(): Promise<TagState[]> {
    if (this.tags) return this.tags;
    const tags: TagState[] = [];
    for (let n = 0; ; n++) {
      const tag = this.tagName(n);
      const r = await this.call(`${this.o.api}/repos/${this.o.repo}/releases/tags/${tag}`);
      if (r.status === 404) break;
      if (!r.ok) throw new BeepsError('E_STORE', `GitHub ${r.status} reading release ${tag} of ${this.o.repo}`, { hint: 'check the repo name, and a token for a private repo (GITHUB_TOKEN)' });
      const rel = await r.json() as { id: number };
      const assets = new Map<string, ReleaseAsset>();
      for (let page = 1; ; page++) {
        const a = await this.call(`${this.o.api}/repos/${this.o.repo}/releases/${rel.id}/assets?per_page=100&page=${page}`);
        if (!a.ok) throw new BeepsError('E_STORE', `GitHub ${a.status} listing assets of ${tag}`);
        const list = await a.json() as ReleaseAsset[];
        for (const x of list) assets.set(x.name, x);
        if (list.length < 100) break;
      }
      tags.push({ tag, id: rel.id, assets });
    }
    return (this.tags = tags);
  }
  async has(name: string) { return (await this.load()).some(t => t.assets.has(name)); }
  async get(name: string) {
    for (const t of await this.load()) {
      const a = t.assets.get(name);
      if (!a) continue;
      // With a token, the API asset URL (works for private repos); without, the public download URL (no API rate limit).
      const r = this.o.token
        ? await this.call(`${this.o.api}/repos/${this.o.repo}/releases/assets/${a.id}`, { headers: { accept: 'application/octet-stream' }, redirect: 'follow' })
        : await this.o.fetch(a.browser_download_url, { headers: { 'user-agent': 'agent-beeps' }, redirect: 'follow' });
      if (!r.ok) throw new BeepsError('E_STORE', `GitHub ${r.status} downloading ${name} from ${t.tag}`);
      return Buffer.from(await r.arrayBuffer());
    }
    return undefined;
  }
  async put(name: string, data: Buffer, retry = true): Promise<'stored' | 'exists'> {
    if (!this.o.token) throw new BeepsError('E_STORE', 'pushing to a release store needs a GitHub token', { hint: 'set GITHUB_TOKEN (contents: write on the store repo) or run gh auth login' });
    if (data.length > this.o.maxBytes) throw new BeepsError('E_STORE', `${name} is ${data.length} bytes; GitHub release assets are limited to ${this.o.maxBytes}`);
    const tags = await this.load();
    if (tags.some(t => t.assets.has(name))) return 'exists';
    // The first release with room; a new numbered release when every one is full.
    let target = tags.find(t => t.assets.size < this.o.maxAssets);
    if (!target) {
      const tag = this.tagName(tags.length);
      const c = await this.call(`${this.o.api}/repos/${this.o.repo}/releases`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ tag_name: tag, name: tag, body: 'agent-beeps content-addressed audio store: one tar per asset, named by input hash. Do not edit or delete.', make_latest: 'false' })),
      });
      // Another writer created this release since we listed the chain: look again.
      if (c.status === 422 && retry) { this.tags = undefined; return this.put(name, data, false); }
      if (!c.ok) throw new BeepsError('E_STORE', `GitHub ${c.status} creating release ${tag}: ${await c.text()}`);
      target = { tag, id: (await c.json() as { id: number }).id, assets: new Map() };
      tags.push(target);
    }
    const u = await this.call(`${this.o.uploads}/repos/${this.o.repo}/releases/${target.id}/assets?name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'content-type': 'application/x-tar' }, body: data,
    });
    if (u.status === 422) { target.assets.set(name, { id: 0, name, size: data.length, browser_download_url: '' }); return 'exists'; } // lost a race: first writer wins
    if (!u.ok) throw new BeepsError('E_STORE', `GitHub ${u.status} uploading ${name}: ${await u.text()}`);
    const made = await u.json() as ReleaseAsset;
    target.assets.set(name, made);
    return 'stored';
  }
}

/** `dir:<path>` or `release:<owner/repo>[@tag]`. `base` resolves a relative dir. */
export function openStore(spec: string, { base = process.cwd(), fetch: f, token }: { base?: string; fetch?: Fetch; token?: string } = {}): Store {
  if (spec.startsWith('dir:')) return new DirStore(resolve(base, spec.slice(4)));
  const m = spec.match(/^release:([\w.-]+\/[\w.-]+)(?:@([\w./-]+))?$/);
  if (m) return new ReleaseStore({ repo: m[1], tag: m[2], fetch: f, token: token ?? githubToken() });
  throw new BeepsError('E_USAGE', `unknown store "${spec}"`, { hint: 'dir:<path> or release:<owner/repo>[@tag]' });
}

