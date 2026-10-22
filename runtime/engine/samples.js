// Browser-safe, explicit sample preparation. Graph construction never performs I/O.
import { readSampleWav } from './sample-wav.js';
import { sampleHash } from './sample-hash.js';
import { MAX_SAMPLE_FRAMES, MAX_SAMPLE_WAV_BYTES, SAMPLE_RATE_HZ } from './limits.js';

/** @typedef {import('../../src/schema/patch.ts').Patch} Patch */
/** @typedef {{file: string, bytes: number, sampleRate: 48000, channels: 1 | 2, frames: number}} SampleAsset */
/** @typedef {Record<string, SampleAsset>} SampleAssetManifest */
/** @typedef {{patch: Patch, assets?: SampleAssetManifest}} SampleAssetSource */
/** @typedef {Readonly<Record<string, AudioBuffer>>} SampleBuffers */

const ID = /^sha256:[0-9a-f]{64}$/;
// Flat portable names only. Percent escapes, URL syntax and separators are not filenames.
const FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.wav$/;
const object = (/** @type {unknown} */ x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Distinct dependency IDs in deterministic order. @param {Patch} patch */
export function sampleIds(patch) {
  if (!Array.isArray(patch?.layers)) throw new TypeError('sample assets require a patch with layers');
  const ids = new Set();
  for (const { source } of patch.layers) if (source?.type === 'sample') {
    if (typeof source.asset !== 'string' || !ID.test(source.asset)) throw new TypeError('sample asset must be sha256:<64 lowercase hex digits>');
    ids.add(source.asset);
  }
  return [...ids].sort();
}

/** @param {string[]} required @param {object | undefined} supplied */
function exactClosure(required, supplied) {
  if (supplied !== undefined && !object(supplied)) throw new TypeError('sample assets must be a record');
  const keys = Object.keys(supplied ?? {}).sort();
  for (const key of keys) if (!ID.test(key)) throw new TypeError(`invalid sample asset ID: ${key}`);
  const missing = required.filter(id => !keys.includes(id)), extra = keys.filter(id => !required.includes(id));
  if (missing.length || extra.length) throw new TypeError(`sample dependency closure mismatch: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`);
}

/** Validate the manifest and exact patch dependency closure, without graph or network effects.
 * @param {Patch} patch @param {SampleAssetManifest} [assets]
 * @returns {SampleAssetManifest}
 */
export function validateSampleManifest(patch, assets) {
  exactClosure(sampleIds(patch), assets);
  const files = new Set();
  for (const [id, a] of Object.entries(assets ?? {})) {
    if (!object(a)) throw new TypeError(`sample ${id} requires metadata`);
    if (typeof a.file !== 'string' || !FILE.test(a.file) || a.file.includes('..')) throw new TypeError(`sample ${id} file must be a safe flat relative .wav filename`);
    if (files.has(a.file)) throw new TypeError(`duplicate sample file: ${a.file}; files must be unique`);
    files.add(a.file);
    if (a.sampleRate !== SAMPLE_RATE_HZ || (a.channels !== 1 && a.channels !== 2) || !Number.isSafeInteger(a.frames) || a.frames < 1 || a.frames > MAX_SAMPLE_FRAMES || !Number.isSafeInteger(a.bytes) || a.bytes !== 44 + a.frames * a.channels * 4) throw new TypeError(`sample ${id} metadata requires 48 kHz, 1..2 channels, 1..${MAX_SAMPLE_FRAMES} integer frames and matching canonical bytes`);
  }
  return assets ?? {};
}

/** Hash exact bytes before canonical parsing or allocating an AudioBuffer.
 * @param {string} id @param {Uint8Array} bytes
 */
function verifiedWav(id, bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError(`sample ${id} requires WAV bytes`);
  if (bytes.byteLength > MAX_SAMPLE_WAV_BYTES) throw new RangeError(`sample ${id} exceeds the prepared WAV byte bound`);
  if (`sha256:${sampleHash(bytes)}` !== id) throw new Error(`sample hash mismatch: ${id}`);
  return readSampleWav(bytes);
}

/** @param {BaseAudioContext} ctx @param {ReturnType<typeof readSampleWav>} wav */
function audioBuffer(ctx, wav) {
  const b = ctx.createBuffer(wav.channels.length, wav.frames, wav.sampleRate);
  for (const [c, data] of wav.channels.entries()) b.getChannelData(c).set(data);
  return b;
}

/** Prepare exact hash-keyed canonical WAV bytes (native fixtures / internal transports).
 * The caller decodes any transport encoding before calling. Returned buffers must remain immutable.
 * @param {BaseAudioContext} ctx @param {Patch} patch
 * @param {Readonly<Record<string, Uint8Array>>} wavs
 * @returns {Record<string, AudioBuffer>}
 */
export function prepareSampleWavs(ctx, patch, wavs) {
  const ids = sampleIds(patch);
  exactClosure(ids, wavs);
  // Verify the entire dependency set before allocating the first AudioBuffer.
  const decoded = ids.map(id => [id, verifiedWav(id, wavs[id])]);
  return Object.fromEntries(decoded.map(([id, wav]) => [id, audioBuffer(ctx, /** @type {ReturnType<typeof readSampleWav>} */ (wav))]));
}

/** Read only the manifest's bounded byte count; cancel excess or aborted response bodies.
 * @param {Response} response @param {number} expected @param {AbortSignal} [signal]
 */
async function responseBytes(response, expected, signal) {
  if (!response.body) throw new Error('sample metadata bytes mismatch: empty response body');
  const reader = response.body.getReader();
  const bytes = new Uint8Array(expected);
  let offset = 0, complete = false;
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (value.byteLength > expected - offset) throw new Error(`sample response bytes exceed manifest byte bound (${expected})`);
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== expected) throw new Error('sample metadata bytes mismatch: incomplete response body');
    complete = true;
    return bytes;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Fetch and verify the exact cue dependency closure, including content hash and canonical metadata.
 * `baseURL` is explicit (normally the URL the cue was fetched from); files resolve relative to it.
 * Works on HTTP LAN origins without WebCrypto. Returned shared buffers must remain immutable.
 * @param {BaseAudioContext} ctx @param {SampleAssetSource} source
 * @param {{baseURL: string | URL, fetcher?: typeof fetch, signal?: AbortSignal}} options
 * @returns {Promise<Record<string, AudioBuffer>>}
 */
export async function loadCueAssets(ctx, source, { baseURL, fetcher = globalThis.fetch, signal }) {
  const assets = validateSampleManifest(source.patch, source.assets);
  const base = new URL(baseURL);
  /** @type {Record<string, AudioBuffer>} */
  const buffers = {};
  for (const [id, a] of Object.entries(assets)) {
    signal?.throwIfAborted();
    const response = await fetcher(new URL(a.file, base).href, { signal });
    if (!response?.ok) throw new Error(`sample fetch failed: ${a.file} (${response?.status ?? 'no response'})`);
    const bytes = await responseBytes(response, a.bytes, signal);
    signal?.throwIfAborted();
    if (bytes.byteLength !== a.bytes) throw new Error(`sample ${id} metadata bytes mismatch`);
    const wav = verifiedWav(id, bytes);
    if (wav.sampleRate !== a.sampleRate || wav.channels.length !== a.channels || wav.frames !== a.frames) throw new Error(`sample ${id} metadata disagrees with canonical WAV`);
    buffers[id] = audioBuffer(ctx, wav);
  }
  return buffers;
}
