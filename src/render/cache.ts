// The render cache: one directory per render key, holding its data files and a meta.json that is the commit marker.
// A directory is a cache hit only when meta.json and every data file are present, and meta.json is written last (atomically),
// so a render that died half way leaves a miss, never a hit with missing files.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '../atomic-write.ts';

export const CACHE_META = 'meta.json';

/** The trim the pipelines will apply at most, in dB: a sound further from its target than this is left short of it. */
export const TRIM_MIN_DB = -36;
export const TRIM_MAX_DB = 24;

export const clampTrimDb = (x: number): number => Math.max(TRIM_MIN_DB, Math.min(TRIM_MAX_DB, x));

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * The trim for one sound: loudness first, held under the true-peak ceiling, then inside the range above. `clamped` is present only
 * when that range, not the sound, set the trim, so the sound sits further from its target than the output would otherwise say.
 */
export function chooseTrim(loudDb: number, ceilingDb: number): { trimDb: number; clamped?: { requestedDb: number; appliedDb: number } } {
  const requested = Math.min(loudDb, ceilingDb);
  const trimDb = round2(clampTrimDb(requested));
  return { trimDb, ...(trimDb !== round2(requested) ? { clamped: { requestedDb: round2(requested), appliedDb: trimDb } } : {}) };
}

/** The parsed meta.json of a cached render when it and every one of `files` exist in `dir`; otherwise undefined (a miss). */
export function lookup<M = Record<string, any>>(dir: string, files: readonly string[]): M | undefined {
  const meta = join(dir, CACHE_META);
  if (!existsSync(meta) || !files.every(f => existsSync(join(dir, f)))) return undefined;
  try { return JSON.parse(readFileSync(meta, 'utf8')) as M; } catch { return undefined; }
}

/** Write a render into the cache: the data files first, in the order given, then meta.json last. Each file lands atomically. */
export function commit(dir: string, { files, meta }: { files: Record<string, string | Uint8Array>; meta: unknown }): void {
  for (const [name, data] of Object.entries(files)) atomicWrite(join(dir, name), data);
  atomicWrite(join(dir, CACHE_META), JSON.stringify(meta, null, 2));
}
