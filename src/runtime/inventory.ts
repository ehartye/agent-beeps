import { BeepsError } from '../errors.ts';
// Portable validation of one delivered asset. No authoring stores or filesystem access.
import { createHash } from 'node:crypto';
import { parseCue } from '../../runtime/engine/voice.js';
import { assertCueInventory, validateDeliveredDependencies } from './dependencies.ts';
import { validateAudioSpriteMap, type AudioSpriteMap } from '../audio-sprite-map.ts';
import { inspectPcm16 } from '../audio/post.ts';

export interface DeliveredOutput { file: string; bytes: number; sha256: string }
export interface DeliveredAsset { outputs: readonly DeliveredOutput[]; delivery?: unknown; kind?: unknown }

/** Guard the complete output inventory before any read callback or installation write. */
export function assertDeliveredInventory(owner: string, asset: DeliveredAsset): void {
  if (!Array.isArray(asset.outputs)) throw new BeepsError('E_VERIFY', 'asset needs an output inventory');
  assertCueInventory(owner, asset.outputs, { requiresCue: asset.delivery === 'runtime' || asset.delivery === 'both' });
  const sprites = asset.outputs.filter(o => /\.sprite\.json$/i.test(o.file));
  if (asset.kind === 'sprite' || sprites.length) {
    if (asset.delivery === 'runtime' || asset.delivery === 'both' || asset.outputs.length !== 2
      || sprites.length !== 1 || sprites[0].file !== `${owner}.sprite.json`
      || !asset.outputs.some(o => o.file === `${owner}.wav`)) {
      throw new BeepsError('E_VERIFY', `sprite ${owner} requires exactly ${owner}.wav and ${owner}.sprite.json`);
    }
  }
  for (const o of asset.outputs) {
    if (!Number.isSafeInteger(o.bytes) || o.bytes < 0 || !/^[0-9a-f]{64}$/.test(o.sha256)) throw new BeepsError('E_VERIFY', `invalid output metadata: ${o.file}`);
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
    if (!bytes) throw new BeepsError('E_VERIFY', `${o.file} is missing`);
    if (bytes.byteLength !== o.bytes || createHash('sha256').update(bytes).digest('hex') !== o.sha256) throw new BeepsError('E_VERIFY', `${o.file} does not match the lock`);
    files.set(o.file, bytes);
  }
  for (const o of asset.outputs) if (o.file.endsWith('.runtime.json')) {
    const cue = parseCue(JSON.parse(new TextDecoder().decode(files.get(o.file))));
    validateDeliveredDependencies(owner, cue, asset.outputs, file => files.get(file));
  }
  for (const o of asset.outputs) if (o.file.endsWith('.sprite.json')) {
    const map = validateAudioSpriteMap(JSON.parse(new TextDecoder().decode(files.get(o.file))));
    if (map.audio.file !== `${owner}.wav`) throw new BeepsError('E_VERIFY', `sprite ${owner} audio filename does not match its owner`);
    validateAudioSpriteBytes(map, files.get(map.audio.file)!);
  }
}

/** Authenticate the packed WAV, its canonical source ranges and silent gaps without decoding samples. */
export function validateAudioSpriteBytes(map: AudioSpriteMap, bytes: Uint8Array): void {
  const wav = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
  if (hash(wav) !== map.audio.sha256) throw new BeepsError('E_VERIFY', 'sprite WAV does not match audio.sha256');
  const header = inspectPcm16(wav);
  if (header.sampleRate !== map.sampleRate || header.channels !== map.channels || header.frames !== map.frames) {
    throw new BeepsError('E_VERIFY', 'sprite map disagrees with canonical WAV format or frames');
  }
  const stride = map.channels * 2;
  for (let i = 0; i < map.entries.length; i++) {
    const entry = map.entries[i], start = 44 + entry.startFrame * stride, end = 44 + entry.endFrame * stride;
    const sourceHeader = Buffer.from(wav.subarray(0, 44));
    sourceHeader.writeUInt32LE(36 + entry.sourceFrames * stride, 4);
    sourceHeader.writeUInt32LE(entry.sourceFrames * stride, 40);
    const sourceHash = createHash('sha256').update(sourceHeader).update(wav.subarray(start, end)).digest('hex');
    if (sourceHash !== entry.sourceSha256) throw new BeepsError('E_VERIFY', `sprite entry ${entry.id} does not match sourceSha256`);
    const next = map.entries[i + 1];
    if (next && wav.subarray(end, 44 + next.startFrame * stride).some(value => value !== 0)) {
      throw new BeepsError('E_VERIFY', `sprite gap after ${entry.id} is not silent`);
    }
  }
}
