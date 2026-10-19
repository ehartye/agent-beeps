// Portable validation of one delivered asset. No authoring stores or filesystem access.
import { createHash } from 'node:crypto';
import { parseCue } from '../../runtime/engine/voice.js';
import { assertCueInventory, validateDeliveredDependencies } from './dependencies.ts';

export interface DeliveredOutput { file: string; bytes: number; sha256: string }
export interface DeliveredAsset { outputs: readonly DeliveredOutput[]; delivery?: unknown }

/** Guard the complete output inventory before any read callback or installation write. */
export function assertDeliveredInventory(owner: string, asset: DeliveredAsset): void {
  if (!Array.isArray(asset.outputs)) throw new Error('asset needs an output inventory');
  assertCueInventory(owner, asset.outputs, { requiresCue: asset.delivery === 'runtime' || asset.delivery === 'both' });
  for (const o of asset.outputs) {
    if (!Number.isSafeInteger(o.bytes) || o.bytes < 0 || !/^[0-9a-f]{64}$/.test(o.sha256)) throw new Error(`invalid output metadata: ${o.file}`);
  }
}

/** Verify full output hashes, runtime cue headers and the exact canonical source closure.
 * read supplies only delivered bytes; a caller must reject nonregular local files.
 */
export function validateDeliveredAsset(owner: string, asset: DeliveredAsset, read: (file: string) => Uint8Array | undefined): void {
  assertDeliveredInventory(owner, asset);
  const files = new Map<string, Uint8Array>();
  for (const o of asset.outputs) {
    const bytes = read(o.file);
    if (!bytes) throw new Error(`${o.file} is missing`);
    if (bytes.byteLength !== o.bytes || createHash('sha256').update(bytes).digest('hex') !== o.sha256) throw new Error(`${o.file} does not match the lock`);
    files.set(o.file, bytes);
  }
  for (const o of asset.outputs) if (o.file.endsWith('.runtime.json')) {
    const cue = parseCue(JSON.parse(new TextDecoder().decode(files.get(o.file))));
    validateDeliveredDependencies(owner, cue, asset.outputs, file => files.get(file));
  }
}
