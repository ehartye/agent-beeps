// Node authoring boundary: resolve once from an explicit store, deliver exact bytes.
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SampleAssetManifest } from '../../runtime/engine/index.js';
import { sampleIds } from '../../runtime/engine/samples.js';
import type { Patch } from '../schema/patch.ts';
import { resolvePatchSamples } from '../samples/store.ts';
import { atomicWrite } from '../build/lock.ts';
import { BeepsError } from '../errors.ts';
import { sampleFile, assertOutputNames } from './dependencies.ts';
import { cueFile, cueText, type Cue } from './cue.ts';

export interface CueSources { assets?: SampleAssetManifest; files: Map<string, Buffer> }
export function cueSources(patch: Patch, owner: string, objectsDir?: string): CueSources {
  if (!objectsDir && sampleIds(patch).length) throw new BeepsError('E_NOT_FOUND', 'sample sources require an explicit sample objects store context');
  const sources = resolvePatchSamples(patch, objectsDir ?? '');
  const files = new Map<string, Buffer>();
  const assets: SampleAssetManifest = {};
  for (const s of sources) {
    const file = sampleFile(owner, s.id);
    files.set(file, s.wav);
    assets[s.id] = { file, bytes: s.bytes, sampleRate: s.sampleRate, channels: s.channels, frames: s.frames };
  }
  return { ...(sources.length ? { assets } : {}), files };
}

/** Reject output symlinks/directories rather than reading outside the supplied directory. */
export function readDeliveredFile(out: string, file: string): Buffer | undefined {
  assertOutputNames([{ file }]);
  const full = join(out, file);
  let entry;
  try { entry = lstatSync(full); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
  if (!entry.isFile() || entry.isSymbolicLink()) throw new BeepsError('E_VERIFY', `output is not a regular file: ${file}`);
  return readFileSync(full);
}

/** Writes sources before publishing the cue. Standalone cleanup derives only owned names
 * from the old patch, never follows an arbitrary old manifest's file references.
 */
export function writeCueDelivery(out: string, cue: Cue, sources: CueSources, { cleanPrevious = false } = {}): void {
  const file = cueFile(cue.id);
  assertOutputNames([{ file }, ...[...sources.files.keys()].map(file => ({ file }))]);
  let previous: string[] = [];
  if (cleanPrevious && existsSync(join(out, file))) {
    try {
      const old = JSON.parse(readDeliveredFile(out, file)!.toString('utf8')) as Cue;
      if (old.id === cue.id) previous = sampleIds(old.patch).map(id => sampleFile(cue.id, id));
    } catch { /* An unreadable old cue does not authorize deletion. */ }
  }
  for (const [name, bytes] of sources.files) atomicWrite(join(out, name), bytes);
  atomicWrite(join(out, file), cueText(cue));
  for (const name of previous) if (!sources.files.has(name)) rmSync(join(out, name), { force: true });
}
