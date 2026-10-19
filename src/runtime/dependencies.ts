// Delivered dependency semantics: no author store, filesystem, graph, or schema parser.
// Keep this entry small enough to bundle into the standalone Node CI fetch script.
import { createHash } from 'node:crypto';
import { readSampleWav } from '../../runtime/engine/sample-wav.js';
import { validateSampleManifest } from '../../runtime/engine/samples.js';
import { canonicalJson, sha256 } from '../hash.ts';
import type { Cue } from './cue.ts';

/** Fixed 75-byte name, including the complete owner/content digest. */
export const sampleFile = (cue: string, asset: string): string => `sample-${sha256(canonicalJson({ cue, asset }))}.wav`;

/** Build outputs are flat portable files. The tar layer enforces its own name length. */
export function assertOutputNames(outputs: readonly { file: string }[]): void {
  const seen = new Set<string>();
  for (const { file } of outputs) {
    if (typeof file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(file) || file.includes('..') || file.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(file)) throw new Error(`unsafe output filename: ${file}`);
    if (seen.has(file)) throw new Error(`duplicate output filename: ${file}`);
    seen.add(file);
  }
}

/** Cue ownership applies to every delivered cue. Callers that know runtime/both
 * delivery must also require its cue, including inventories containing no cue at all.
 */
export function assertCueInventory(owner: string, outputs: readonly { file: string }[], { requiresCue = false } = {}): void {
  assertOutputNames(outputs);
  const expected = `${owner}.runtime.json`;
  for (const { file } of outputs) if (/\.runtime\.json$/.test(file) && file !== expected) throw new Error(`runtime cue filename ${file} does not match owner ${owner}: expected ${expected}`);
  if (requiresCue && !outputs.some(o => o.file === expected)) throw new Error(`required runtime cue ${expected} is missing from this asset's output inventory`);
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
  if (cue.id !== owner) throw new Error(`cue id "${cue.id}" is not the asset id "${owner}"`);
  const assets = validateSampleManifest(cue.patch, cue.assets), names = new Set(outputs.map(o => o.file));
  const wavs: Record<string, Uint8Array> = {};
  for (const [id, a] of Object.entries(assets)) {
    if (a.file !== sampleFile(owner, id)) throw new Error(`sample ${id} file does not match its cue owner/content filename`);
    if (!names.has(a.file)) throw new Error(`sample ${id} dependency ${a.file} is missing from this asset's lock outputs`);
    const bytes = read(a.file);
    if (!bytes) throw new Error(`missing delivered sample: ${a.file}`);
    if (bytes.byteLength !== a.bytes) throw new Error(`sample ${id} metadata bytes mismatch`);
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== id) throw new Error(`sample hash mismatch: ${id}`);
    const wav = readSampleWav(bytes);
    if (wav.sampleRate !== a.sampleRate || wav.channels.length !== a.channels || wav.frames !== a.frames) throw new Error(`sample ${id} metadata disagrees with canonical WAV`);
    wavs[id] = bytes;
  }
  return wavs;
}
