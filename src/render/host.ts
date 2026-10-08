// Render host: one headless Chromium page serving runtime/, rendering batches offline.
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import { BeepsError } from '../errors.ts';
import type { Patch } from '../schema/patch.ts';
import type { Song } from '../schema/song.ts';
import type { Scale } from '../schema/project.ts';

export const RUNTIME_DIR = join(import.meta.dirname, '..', '..', 'runtime');

const MIME: Record<string, string> = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

export interface RenderOpts { seed?: number; variant?: number; trimDb?: number; scale?: Scale }
export interface RenderItem { patch: Patch; opts: RenderOpts }
export interface Pcm { sampleRate: number; delivered: Float32Array[]; authored: Float32Array[] }
export type RenderResult = ({ ok: true } & Pcm) | { ok: false; error: string };

/** Serve a directory read-only on 127.0.0.1 (or a given host). Paths never escape the root. */
export function serveStatic(root: string, { host = '127.0.0.1', port = 0, extra }: { host?: string; port?: number; extra?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<boolean> | boolean } = {}): Promise<{ server: Server; url: string; port: number }> {
  const server = createServer(async (req, res) => {
    try {
      if (extra && await extra(req, res)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      const file = normalize(join(root, path === '/' ? 'index.html' : path));
      if (!file.startsWith(normalize(root) + sep) || !existsSync(file)) { res.writeHead(404).end('not found'); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(e));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const p = (server.address() as AddressInfo).port;
      resolve({ server, port: p, url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${p}` });
    });
  });
}

const decode = (b64: string): Float32Array => {
  const bytes = Buffer.from(b64, 'base64');
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};

export interface LookItem { mono: Float32Array; sampleRate: number; features: object; label: string }

const encode = (f: Float32Array): string => Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');

export interface RenderHost {
  render(items: RenderItem[]): Promise<RenderResult[]>;
  /** PNG buffers: one per item, or a single contact sheet. */
  looks(items: LookItem[], sheet?: boolean): Promise<Buffer[]>;
  /** Render a song in the page; its PCM stays there until pulled and freed. */
  /** `only`: play just these tracks' notes out of the full song, so every random draw matches the mix. */
  renderSong(song: Song, instruments: Record<string, Patch>, opts?: { only?: string[] }): Promise<{ id: number; sampleRate: number; frames: number; sections: { name: string; start: number; end: number; bars: number }[] }>;
  pullSong(id: number, frames: number): Promise<Float32Array[]>;
  songLook(id: number, features: object, label: string): Promise<Buffer>;
  songPcmLook(channels: Float32Array[], features: object, label: string): Promise<Buffer>;
  freeSong(id: number): Promise<void>;
  page: import('playwright').Page;
  url: string;
  close(): Promise<void>;
}

export async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    return existsSync(chromium.executablePath());
  } catch { return false; }
}

export async function openRenderHost(): Promise<RenderHost> {
  let playwright: typeof import('playwright');
  try { playwright = await import('playwright'); } catch {
    throw new BeepsError('E_RUNTIME_MISSING', 'playwright is not installed', { hint: 'Run the beeps-setup skill' });
  }
  if (!existsSync(playwright.chromium.executablePath())) {
    throw new BeepsError('E_BROWSER_MISSING', 'Chromium for Playwright is not installed', { hint: 'Run the beeps-setup skill' });
  }
  const { server, url } = await serveStatic(RUNTIME_DIR);
  const closeServer = () => new Promise<void>(r => server.close(() => r()));
  // A busy machine (several renders at once) can take a while to bring Chromium up: allow 60 s,
  // retry once, and never leave a browser or server behind when giving up.
  let browser: import('playwright').Browser | undefined;
  let page!: import('playwright').Page;
  const errors: string[] = [];
  for (let attempt = 1; ; attempt++) {
    try {
      browser = await playwright.chromium.launch({ timeout: 60000 });
      page = await browser.newPage();
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(`${url}/render.html`, { timeout: 60000 });
      await page.waitForFunction(() => (window as any).beepsReady === true, null, { timeout: 60000 });
      break;
    } catch (e) {
      await browser?.close().catch(() => {});
      browser = undefined;
      if (attempt >= 2 || errors.length) {
        await closeServer();
        throw new BeepsError('E_RENDER', `render page failed to load: ${errors.join('; ') || (e as Error).message.split('\n')[0]}`, { hint: 'the machine may be overloaded (other renders running); retry, or lower --jobs' });
      }
    }
  }
  const b = browser!;
  return {
    page,
    url,
    async render(items) {
      const out: RenderResult[] = [];
      for (let i = 0; i < items.length; i += 12) { // bounded batches keep page memory flat
        const batch = items.slice(i, i + 12);
        const raw = await page.evaluate(b => (window as any).beepsRender(b), batch) as any[];
        for (const r of raw) {
          if (r.error) out.push({ ok: false, error: r.error });
          else out.push({ ok: true, sampleRate: r.sampleRate, delivered: r.delivered.map(decode), authored: r.authored.map(decode) });
        }
      }
      return out;
    },
    async looks(items, sheet = false) {
      const payload = items.map(i => ({ pcm: encode(i.mono), sr: i.sampleRate, features: i.features, label: i.label }));
      const urls = await page.evaluate(([p, s]) => (window as any).beepsLooks(p, s), [payload, sheet] as const) as string[];
      return urls.map(u => Buffer.from(u.slice(u.indexOf(',') + 1), 'base64'));
    },
    async renderSong(song, instruments, opts = {}) {
      try {
        return await page.evaluate(([s, i, o]) => (window as any).beepsRenderSong(s, i, o), [song, instruments, opts] as const);
      } catch (e) {
        throw new BeepsError('E_RENDER', `song render failed: ${(e as Error).message.slice(0, 400)}`);
      }
    },
    async pullSong(id, frames) {
      const CHUNK = 1 << 21; // 2 M samples (8 MB) per call keeps each transfer small
      const out = [new Float32Array(frames), new Float32Array(frames)];
      for (let ch = 0; ch < 2; ch++) for (let start = 0; start < frames; start += CHUNK) {
        const b64 = await page.evaluate(([i, c, s, n]) => (window as any).beepsSongChunk(i, c, s, n), [id, ch, start, CHUNK] as const) as string;
        out[ch].set(decode(b64), start);
      }
      return out;
    },
    async songLook(id, features, label) {
      const url = await page.evaluate(([i, f, l]) => (window as any).beepsSongLook(i, f, l), [id, features, label] as const) as string;
      return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    },
    async songPcmLook(channels, features, label) {
      const mono = new Float32Array(channels[0].length);
      for (let i = 0; i < mono.length; i++) mono[i] = channels.reduce((sum, ch) => sum + ch[i], 0) / channels.length;
      await page.evaluate(n => { (window as any).beepsPreview = new Float32Array(n); }, mono.length);
      try {
        for (let start = 0; start < mono.length; start += 1 << 21) {
          await page.evaluate(([offset, pcm]) => {
            const bytes = Uint8Array.from(atob(pcm), c => c.charCodeAt(0));
            (window as any).beepsPreview.set(new Float32Array(bytes.buffer), offset);
          }, [start, encode(mono.subarray(start, start + (1 << 21)))] as const);
        }
        const url = await page.evaluate(([f, l]) => (window as any).beepsPreviewLook(f, l), [features, label] as const) as string;
        return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
      } finally { await page.evaluate(() => { delete (window as any).beepsPreview; }); }
    },
    async freeSong(id) { await page.evaluate(i => (window as any).beepsFreeSong(i), id); },
    async close() {
      await b.close();
      await closeServer();
    },
  };
}
