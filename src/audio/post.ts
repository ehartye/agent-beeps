// Export post-processing on the delivered 16-bit PCM WAV, sample-exact: a mono fold-down and a tail trim.
// Both are opt-in (beeps export --channels 1, --trim-tail <dBFS>); without them the exported file is the render's own WAV.
import { BeepsError } from '../errors.ts';

export interface Pcm16 { sampleRate: number; channels: Int16Array[] }

export interface Pcm16Header { sampleRate: number; channels: number; frames: number; dataBytes: number }

/** Inspect a canonical PCM16 header without allocating sample arrays. `fileBytes` permits a bounded header-only file read. */
export function inspectPcm16(buf: Buffer, fileBytes = buf.length): Pcm16Header {
  const invalid = () => new BeepsError('E_RENDER', 'expected a canonical 44-byte-header 16-bit PCM WAV with consistent sizes and format');
  if (!Number.isSafeInteger(fileBytes) || fileBytes < 44 || buf.length < 44
    || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE'
    || buf.toString('latin1', 12, 16) !== 'fmt ' || buf.toString('latin1', 36, 40) !== 'data'
    || buf.readUInt32LE(16) !== 16 || buf.readUInt16LE(20) !== 1 || buf.readUInt16LE(34) !== 16
    || buf.readUInt32LE(4) !== fileBytes - 8 || buf.readUInt32LE(40) !== fileBytes - 44) {
    throw invalid();
  }
  const channels = buf.readUInt16LE(22), sampleRate = buf.readUInt32LE(24), dataBytes = buf.readUInt32LE(40);
  const blockAlign = channels * 2;
  if (channels < 1 || sampleRate < 1 || buf.readUInt16LE(32) !== blockAlign
    || buf.readUInt32LE(28) !== sampleRate * blockAlign || dataBytes % blockAlign !== 0) throw invalid();
  return { sampleRate, channels, frames: dataBytes / blockAlign, dataBytes };
}

/** Reads the canonical 44-byte-header 16-bit PCM WAV that writeWav and the render pipeline write. */
export function pcm16(buf: Buffer): Pcm16 {
  const { channels: ch, sampleRate, frames: n } = inspectPcm16(buf);
  const channels = Array.from({ length: ch }, () => new Int16Array(n));
  for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < ch; c++, o += 2) channels[c][i] = buf.readInt16LE(o);
  return { sampleRate, channels };
}

export function writePcm16({ sampleRate, channels }: Pcm16): Buffer {
  const ch = channels.length, n = channels[0]?.length ?? 0, data = n * ch * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + data, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * ch * 2, 28); buf.writeUInt16LE(ch * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(data, 40);
  for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < ch; c++, o += 2) buf.writeInt16LE(channels[c][i], o);
  return buf;
}

/**
 * One channel. Identical channels (every patch without pan, and every one a typical game kit exports) keep the left samples
 * exactly, so loudness and peak are unchanged; channels that differ are averaged, which can lower the level.
 */
export function toMono(wav: Buffer): { wav: Buffer; identical: boolean } {
  const p = pcm16(wav);
  if (p.channels.length === 1) return { wav, identical: true };
  const [first, ...rest] = p.channels;
  const identical = rest.every(ch => ch.every((x, i) => x === first[i]));
  if (identical) return { wav: writePcm16({ sampleRate: p.sampleRate, channels: [first] }), identical };
  const mono = new Int16Array(first.length);
  for (let i = 0; i < mono.length; i++) {
    let s = 0;
    for (const ch of p.channels) s += ch[i];
    mono[i] = Math.round(s / p.channels.length);
  }
  return { wav: writePcm16({ sampleRate: p.sampleRate, channels: [mono] }), identical };
}

/** Linear fade over the kept samples after the last one at the threshold: they are all below it, so nothing audible changes. */
export const TRIM_FADE_SEC = 0.01;

/**
 * Drop the end of the file after the last sample (any channel) at or above `dbfs`, keeping up to TRIM_FADE_SEC more
 * faded to zero so the cut cannot click. Effect tails (reverb, delay) otherwise leave long near-silent ends.
 */
export function trimTail(wav: Buffer, dbfs: number): { wav: Buffer; removedSec: number; frames: number } {
  if (!(dbfs < 0 && dbfs >= -120)) throw new BeepsError('E_USAGE', `--trim-tail takes a level in dBFS from -120 to just below 0 (e.g. -60), got ${dbfs}`);
  const p = pcm16(wav);
  const n = p.channels[0]?.length ?? 0;
  const threshold = 32768 * 10 ** (dbfs / 20);
  let last = -1;
  for (let i = n - 1; i >= 0 && last < 0; i--) for (const ch of p.channels) if (Math.abs(ch[i]) >= threshold) { last = i; break; }
  if (last < 0) return { wav, removedSec: 0, frames: n }; // nothing reaches the threshold: not a tail to trim
  const fade = Math.round(TRIM_FADE_SEC * p.sampleRate);
  const keep = Math.max(1, Math.min(n, last + 1 + fade));
  if (keep >= n) return { wav, removedSec: 0, frames: n };
  const channels = p.channels.map(ch => {
    const out = ch.slice(0, keep);
    const from = last + 1, len = keep - from;
    for (let i = from; i < keep; i++) out[i] = Math.round(out[i] * (1 - (i - from + 1) / len));
    return out;
  });
  return { wav: writePcm16({ sampleRate: p.sampleRate, channels }), removedSec: (n - keep) / p.sampleRate, frames: keep };
}
