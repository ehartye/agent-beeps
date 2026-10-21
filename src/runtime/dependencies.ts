import { BeepsError } from '../errors.ts';
// Delivered dependency semantics: no author store, filesystem, graph, or schema parser.
// Keep this entry small enough to bundle into the standalone Node CI fetch script.
import { createHash } from 'node:crypto';
import { readSampleWav } from '../../runtime/engine/sample-wav.js';
import { validateSampleManifest } from '../../runtime/engine/samples.js';
import { canonicalJson, sha256 } from '../hash.ts';
import type { Cue } from './cue.ts';

/** Fixed 75-byte name, including the complete owner/content digest. */
export const sampleFile = (cue: string, asset: string): string => `sample-${sha256(canonicalJson({ cue, asset }))}.wav`;

/** The exact namespace reserved for delivered runtime sources; ordinary baked names
 * such as sample-hit.wav are not reserved. Recognize case aliases too, since they
 * can name the same physical output on a case-insensitive filesystem. */
export const isDeliveredSampleFile = (file: string): boolean => /^sample-[0-9a-f]{64}\.wav$/i.test(file);

/** Cue namespace recognition includes filesystem case aliases; owners still use
 * the exact canonical filename checked by assertCueInventory. */
export const isDeliveredCueFile = (file: string): boolean => /\.runtime\.json$/i.test(file);

/** Build outputs are flat portable files. The tar layer enforces its own name length. */
export function assertOutputNames(outputs: readonly { file: string }[]): void {
  const seen = new Set<string>();
  for (const { file } of outputs) {
    if (typeof file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(file) || file.includes('..') || file.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(file)) throw new BeepsError('E_VERIFY', `unsafe output filename: ${file}`);
    if (seen.has(file)) throw new BeepsError('E_VERIFY', `duplicate output filename: ${file}`);
    seen.add(file);
  }
}

/** Cue ownership applies to every delivered cue. Callers that know runtime/both
 * delivery must also require its cue, including inventories containing no cue at all.
 */
export function assertCueInventory(owner: string, outputs: readonly { file: string }[], { requiresCue = false } = {}): void {
  assertOutputNames(outputs);
  const expected = `${owner}.runtime.json`;
  for (const { file } of outputs) if (isDeliveredCueFile(file) && file !== expected) throw new BeepsError('E_VERIFY', `runtime cue filename ${file} does not match owner ${owner}: expected ${expected}`);
  if (requiresCue && !outputs.some(o => o.file === expected)) throw new BeepsError('E_VERIFY', `required runtime cue ${expected} is missing from this asset's output inventory`);
  if (!outputs.some(o => o.file === expected)) {
    const orphan = outputs.find(o => isDeliveredSampleFile(o.file));
    if (orphan) throw new BeepsError('E_VERIFY', `orphan runtime sample output ${orphan.file} has no runtime cue`);
  }
}

/** Verify a cue's exact closure against this asset's inventory and already supplied bytes.
 * The callback is called only with validated owned names from that inventory. It must
 * return delivered bytes (or undefined), never consult an authoring sample store.
 */
export function validateDeliveredDependencies(
  owner: string,
  cue: Pick<Cue, 'id' | 'patch' | 'assets'>,
  outputs: readonly { file: string }[],
  read: (file: string) => Uint8Array | undefined,
): Record<string, Uint8Array> {
  assertCueInventory(owner, outputs, { requiresCue: true });
  if (cue.id !== owner) throw new BeepsError('E_VERIFY', `cue id "${cue.id}" is not the asset id "${owner}"`);
  const assets = validateSampleManifest(cue.patch, cue.assets), names = new Set(outputs.map(o => o.file));
  const wavs: Record<string, Uint8Array> = {};
  for (const [id, a] of Object.entries(assets)) {
    if (a.file !== sampleFile(owner, id)) throw new BeepsError('E_VERIFY', `sample ${id} file does not match its cue owner/content filename`);
    if (!names.has(a.file)) throw new BeepsError('E_VERIFY', `sample ${id} dependency ${a.file} is missing from this asset's lock outputs`);
    const bytes = read(a.file);
    if (!bytes) throw new BeepsError('E_VERIFY', `missing delivered sample: ${a.file}`);
    if (bytes.byteLength !== a.bytes) throw new BeepsError('E_VERIFY', `sample ${id} metadata bytes mismatch`);
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== id) throw new BeepsError('E_VERIFY', `sample hash mismatch: ${id}`);
    const wav = readSampleWav(bytes);
    if (wav.sampleRate !== a.sampleRate || wav.channels.length !== a.channels || wav.frames !== a.frames) throw new BeepsError('E_VERIFY', `sample ${id} metadata disagrees with canonical WAV`);
    wavs[id] = bytes;
  }
  const requiredFiles = new Set(Object.values(assets).map(a => a.file));
  for (const { file } of outputs) if (isDeliveredSampleFile(file) && !requiredFiles.has(file)) {
    throw new BeepsError('E_VERIFY', `orphan runtime sample output ${file} is not a cue dependency`);
  }
  return wavs;
}
