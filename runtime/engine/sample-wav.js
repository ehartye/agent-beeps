// Canonical prepared sample codec. Browser-safe; no platform decoder or Node dependencies.

/**
 * Read the exact 44-byte IEEE float32 LE WAV format used for immutable samples.
 * Header, lengths and bounds are checked before allocating channel arrays.
 * @param {Uint8Array | ArrayBuffer} bytes
 * @param {{maxFrames?: number}} [options] defaults to ten seconds; retained source snapshots may explicitly allow 120 seconds
 * @returns {{sampleRate: 48000, frames: number, channels: Float32Array[]}}
 */
export function readSampleWav(bytes, { maxFrames = 480000 } = {}) {
  if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 5760000) throw new RangeError('sample maxFrames must be an integer in 1..5760000');
  const u8 = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : undefined;
  if (!u8 || u8.byteLength < 44) throw new TypeError('sample WAV requires a complete canonical 44-byte header');
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  /** @param {number} at @param {string} text */
  const tag = (at, text) => [...text].every((c, i) => u8[at + i] === c.charCodeAt(0));
  const channels = view.getUint16(22, true);
  const size = view.getUint32(40, true);
  if (!tag(0, 'RIFF') || !tag(8, 'WAVE') || !tag(12, 'fmt ') || !tag(36, 'data') ||
      view.getUint32(4, true) !== u8.byteLength - 8 || view.getUint32(16, true) !== 16 ||
      view.getUint16(20, true) !== 3 || (channels !== 1 && channels !== 2) ||
      view.getUint32(24, true) !== 48000 || view.getUint32(28, true) !== 48000 * channels * 4 ||
      view.getUint16(32, true) !== channels * 4 || view.getUint16(34, true) !== 32 ||
      size !== u8.byteLength - 44 || size % (channels * 4) !== 0) {
    throw new TypeError('sample WAV must have the exact canonical 48 kHz mono/stereo float32 header and data length');
  }
  const frames = size / (channels * 4);
  if (frames < 1 || frames > maxFrames) throw new RangeError(`sample frames must be in 1..${maxFrames}`);
  // Scan first so invalid PCM does not allocate even bounded output arrays.
  for (let p = 44; p < u8.byteLength; p += 4) if (!Number.isFinite(view.getFloat32(p, true))) throw new TypeError('sample PCM must be finite');
  const pcm = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0, p = 44; i < frames; i++) for (let c = 0; c < channels; c++, p += 4) pcm[c][i] = view.getFloat32(p, true);
  return { sampleRate: 48000, frames, channels: pcm };
}
