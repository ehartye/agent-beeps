import { createHash, randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readSampleWav } from '../../runtime/engine/sample-wav.js';
import { BeepsError } from '../errors.ts';

export type SampleId = `sha256:${string}`;
export const SAMPLE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const SOURCE_MAX_FRAMES = 48000 * 120;
export const PREPARED_MAX_FRAMES = 48000 * 10;
type ProjectLocation = string | { paths: { dir: string } };

/** String locations are project roots; project objects already carry the .agent-beeps directory. */
export function samplePaths(projectOrDir: ProjectLocation) {
  const dir = join(typeof projectOrDir === 'string' ? join(projectOrDir, '.agent-beeps') : projectOrDir.paths.dir, 'samples');
  return { dir, objects: join(dir, 'objects'), originals: join(dir, 'originals'), imports: join(dir, 'imports'), recipes: join(dir, 'recipes') };
}

export const sampleId = (bytes: Uint8Array): SampleId => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export function assertSampleId(id: string): asserts id is SampleId {
  if (!SAMPLE_ID_PATTERN.test(id)) throw new BeepsError('E_SCHEMA', 'sample asset must be sha256:<64 lowercase hex digits>');
}

export interface ResolvedSample {
  id: SampleId; path: string; wav: Buffer; sampleRate: 48000; channels: 1 | 2; frames: number; bytes: number;
}

function inspect(wav: Buffer, options: { maxFrames?: number } = {}) {
  try {
    const d = readSampleWav(wav, options);
    return { sampleRate: d.sampleRate, channels: d.channels.length as 1 | 2, frames: d.frames, bytes: wav.length };
  } catch (e) { throw new BeepsError('E_SCHEMA', `invalid canonical sample WAV: ${(e as Error).message}`); }
}

export function readSampleObject(objectsDir: string, id: string, options: { maxFrames?: number } = {}): ResolvedSample {
  assertSampleId(id);
  const path = join(objectsDir, `${id.slice(7)}.wav`);
  let wav: Buffer;
  try {
    // Canonical byte count is bounded before reading as well as before PCM allocation.
    const max = options.maxFrames ?? PREPARED_MAX_FRAMES;
    const size = statSync(path).size;
    if (size > 44 + max * 2 * 4) throw new BeepsError('E_SCHEMA', `sample object exceeds ${max} frame byte bound: ${path}`);
    wav = readFileSync(path);
  } catch (e) {
    if (e instanceof BeepsError) throw e;
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new BeepsError('E_NOT_FOUND', `sample object not found: ${id}`, { details: { path } });
    throw new BeepsError('E_SCHEMA', `cannot read sample object ${id}: ${(e as Error).message}`);
  }
  if (sampleId(wav) !== id) throw new BeepsError('E_VERIFY', `sample object hash mismatch: ${id}`, { details: { path } });
  return { id, path, wav, ...inspect(wav, options) };
}

export interface SamplePatchShape { layers: readonly { source: { type: string; asset?: string } }[] }
export function patchSampleIds(patch: SamplePatchShape): SampleId[] {
  const ids = new Set<SampleId>();
  for (const { source } of patch.layers) if (source.type === 'sample') {
    if (typeof source.asset !== 'string') throw new BeepsError('E_SCHEMA', 'sample source requires an asset ID');
    assertSampleId(source.asset); ids.add(source.asset);
  }
  return [...ids].sort();
}

/** Always verify actual bytes before callers consult render/build caches. No references means no I/O. */
export function resolvePatchSamples(patch: SamplePatchShape, objectsDir: string): ResolvedSample[] {
  return patchSampleIds(patch).map(id => readSampleObject(objectsDir, id));
}

/** Preflight all immutable destinations before a multi-file operation writes anything. */
export function verifyImmutableFile(path: string, bytes: Uint8Array): void {
  matchesImmutableFile(path, bytes);
}

function matchesImmutableFile(path: string, bytes: Uint8Array, required = false): boolean {
  let entry;
  try { entry = lstatSync(path); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !required) return false;
    throw new BeepsError('E_VERIFY', `cannot verify immutable sample store file: ${path}`);
  }
  // lstat sees occupied names even when they are dangling links. Never follow a link as a winner.
  if (!entry.isFile() || entry.isSymbolicLink()) throw new BeepsError('E_VERIFY', `immutable sample store destination is not a regular file: ${path}`);
  let actual;
  try { actual = entry.size === bytes.byteLength ? readFileSync(path) : undefined; }
  catch { throw new BeepsError('E_VERIFY', `cannot read immutable sample store file: ${path}`); }
  if (!actual?.equals(bytes)) throw new BeepsError('E_VERIFY', `immutable sample store file differs: ${path}`);
  return true;
}

export function writeImmutableFile(path: string, bytes: Uint8Array): void {
  if (matchesImmutableFile(path, bytes)) return;
  mkdirSync(dirname(path), { recursive: true });
  const staged = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(staged, bytes, { flag: 'wx' });
    // Same-filesystem hard links publish complete bytes atomically and never replace a winner.
    // Copying to the destination is not a safe fallback: a failed copy could expose partial bytes.
    try { linkSync(staged, path); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') { matchesImmutableFile(path, bytes, true); return; }
      throw new BeepsError('E_STORE', `cannot atomically publish immutable sample file ${path}: ${(e as Error).message}`, { hint: 'the sample store filesystem must support hard links' });
    }
  } finally { rmSync(staged, { force: true }); }
}

/** Validate first, then create or verify a content-addressed object without overwriting it. */
export function writeSampleObject(objectsDir: string, wav: Buffer, options: { maxFrames?: number } = {}): ResolvedSample {
  const metadata = inspect(wav, options), id = sampleId(wav), path = join(objectsDir, `${id.slice(7)}.wav`);
  writeImmutableFile(path, wav);
  return { id, path, wav, ...metadata };
}
