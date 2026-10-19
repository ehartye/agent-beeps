// Node-side snapshots for explicit browser transports. No source-store inference or global cache.
import { BeepsError } from '../errors.ts';
import { patchSampleIds, readSampleObject, type SamplePatchShape } from './store.ts';

export type EncodedSampleWavs = Readonly<Record<string, string>>;

/** Resolve and verify exact canonical object bytes before render/cache work. Pure patches do no I/O. */
export function resolveSampleWavs(patch: SamplePatchShape, sampleObjectsDir?: string): EncodedSampleWavs {
  return createSampleWavSnapshot(sampleObjectsDir)(patch);
}

/** One operation's verified snapshot, shared by its variants and passes. Never retain across render/build calls. */
export function createSampleWavSnapshot(sampleObjectsDir?: string): (patch: SamplePatchShape) => EncodedSampleWavs {
  const verified = new Map<string, string>();
  return patch => Object.fromEntries(patchSampleIds(patch).map(id => {
    if (!sampleObjectsDir) throw new BeepsError('E_NOT_FOUND', 'sample sources require an explicit sample objects store context');
    if (!verified.has(id)) verified.set(id, readSampleObject(sampleObjectsDir, id).wav.toString('base64'));
    return [id, verified.get(id)!];
  }));
}

/** A harness can receive a union for many cues; each browser job receives only its exact closure. */
export function selectSampleWavs(patch: SamplePatchShape, sampleWavs: EncodedSampleWavs = {}): EncodedSampleWavs {
  return Object.fromEntries(patchSampleIds(patch).map(id => {
    if (!Object.hasOwn(sampleWavs, id)) throw new BeepsError('E_NOT_FOUND', `missing sample WAV transport: ${id}`);
    return [id, sampleWavs[id]];
  }));
}

export function resolveSamplesForPatches(patches: readonly SamplePatchShape[], sampleObjectsDir?: string): EncodedSampleWavs {
  const snapshot = createSampleWavSnapshot(sampleObjectsDir);
  return Object.assign({}, ...patches.map(snapshot));
}
