// audio.lock.json: per recipe, the input hash that produced its files and the sha256 of every file. Committed; sorted keys, LF,
// two-space indent, trailing newline, no timestamps, so an unchanged build rewrites the same bytes and one change is a small diff.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { BeepsError } from '../errors.ts';
import { sortKeys } from '../hash.ts';
import { ENGINE_VERSION } from '../../runtime/engine/version.js';
import { PIPELINE_VERSION } from '../render/pipeline.ts';
import { SONG_PIPELINE_VERSION } from '../render/song-pipeline.ts';
import { EXPORT_PIPELINE_VERSION } from '../export-manifest.ts';
import { SAMPLE_RATE } from '../hash.ts';
import type { Delivery } from './config.ts';
import type { OutputRef } from './store.ts';

export const LOCK_SCHEMA = 'beeps/build-lock@1';
/** The hashing scheme of `inputHash`. A lock written by another tool (a game's own wrapper) says so and is adopted, not trusted. */
export const KEY_SCHEME = 'beeps-input@1';

export interface LockAsset {
  role: string;
  source?: string;
  inputHash: string;
  /** 12-hex prefixes of the four hashes `inputHash` is made of, so a stale asset can say which part changed. */
  parts?: { delivery: string; export: string; renders: string; toolchain: string };
  outputs: OutputRef[];
  [extra: string]: unknown;
}
export interface Lock {
  schema: typeof LOCK_SCHEMA;
  keyScheme: string;
  delivery: Record<string, unknown>;
  toolchain: Record<string, unknown>;
  assets: Record<string, LockAsset>;
  [extra: string]: unknown;
}

export interface Toolchain { engine: number | string; pipeline: number; songPipeline: number; exportPipeline: number; chromium: string; playwright: string; sampleRate: number }

/** The audio-affecting versions (not the package version: a release that does not change sound changes no hash). */
export function currentToolchain(): Toolchain {
  const require = createRequire(import.meta.url);
  let chromium = 'unknown', playwright = 'unknown';
  try {
    // playwright-core's package exports hide browsers.json, so find the package directory from its main entry.
    const dir = dirname(require.resolve('playwright-core'));
    const browsers = JSON.parse(readFileSync(join(dir, 'browsers.json'), 'utf8')) as { browsers: { name: string; revision: string; browserVersion?: string }[] };
    const c = browsers.browsers.find(b => b.name === 'chromium');
    if (c) chromium = `${c.browserVersion ?? 'unknown'}@${c.revision}`;
    playwright = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }).version;
  } catch { /* keep unknown: the hash then still differs from a build that knew */ }
  return { engine: ENGINE_VERSION, pipeline: PIPELINE_VERSION, songPipeline: SONG_PIPELINE_VERSION, exportPipeline: EXPORT_PIPELINE_VERSION, chromium, playwright, sampleRate: SAMPLE_RATE };
}

export function emptyLock(delivery: Record<string, unknown>, toolchain: Toolchain): Lock {
  return { schema: LOCK_SCHEMA, keyScheme: KEY_SCHEME, delivery, toolchain: { ...toolchain }, assets: {} };
}

export function lockText(lock: Lock): string {
  const sorted = sortKeys({ ...lock, assets: Object.fromEntries(Object.entries(lock.assets).map(([id, a]) => [id, { ...a, outputs: [...a.outputs].sort((x, y) => (x.file < y.file ? -1 : 1)) }])) });
  return JSON.stringify(sorted, null, 2) + '\n';
}

/** Writes through a temp file and a rename, so a reader (or a crash) sees the old file or the new one, never half of one. */
export function atomicWrite(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try { renameSync(tmp, path); return; } catch (e) {
      // Windows: a virus scanner or indexer can hold the destination for a moment.
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) { rmSync(tmp, { force: true }); throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

export function writeLock(path: string, lock: Lock): void {
  const text = lockText(lock);
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return; // unchanged: not touched
  atomicWrite(path, text);
}

export function readLock(path: string): Lock | undefined {
  if (!existsSync(path)) return undefined;
  let raw: any;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new BeepsError('E_LOCK', `${path}: ${(e as Error).message}`); }
  if (raw?.schema !== LOCK_SCHEMA || typeof raw.assets !== 'object' || raw.assets === null) throw new BeepsError('E_LOCK', `${path} is not a ${LOCK_SCHEMA} lock`);
  for (const [id, a] of Object.entries<any>(raw.assets)) {
    if (typeof a?.inputHash !== 'string' || !Array.isArray(a.outputs) || a.outputs.some((o: any) => typeof o?.file !== 'string' || !/^[0-9a-f]{64}$/.test(o?.sha256 ?? '') || typeof o?.bytes !== 'number')) {
      throw new BeepsError('E_LOCK', `${path}: asset "${id}" needs inputHash and outputs [{file, sha256 (64 hex), bytes}]`, { pointer: `/assets/${id}` });
    }
  }
  return { keyScheme: KEY_SCHEME, delivery: {}, toolchain: {}, ...raw } as Lock;
}

export function deliveryRecord(d: Delivery, encoder?: { ffmpeg: string; libavcodec: string }): Record<string, unknown> {
  if (d.format === 'wav') return { preset: d.preset, format: 'wav' };
  return { preset: d.preset, format: d.format, container: d.format === 'opus' ? 'ogg' : 'mp3', kbps: d.kbps, encoder: { ...(encoder ?? {}), flags: d.flags } };
}
