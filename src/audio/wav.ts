// Minimal RIFF/WAVE: 16-bit PCM or 32-bit float, interleaved.
import { BeepsError } from '../errors.ts';

export interface WavReadLimits { maxFrames?: number; maxChannels?: number; maxSeconds?: number }
/** Only unsupported encodings should fall back to ffmpeg; malformed/bounded inputs must fail directly. */
export class UnsupportedWavError extends Error {}

export function writeWav(channels: Float32Array[], sampleRate: number, { bits = 16 }: { bits?: 16 | 32 } = {}): Buffer {
  const n = channels[0]?.length ?? 0;
  const ch = channels.length;
  const bytes = bits / 8;
  const data = n * ch * bytes;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + data, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(bits === 32 ? 3 : 1, 20); // 3 = IEEE float
  buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * ch * bytes, 28); buf.writeUInt16LE(ch * bytes, 32); buf.writeUInt16LE(bits, 34);
  buf.write('data', 36); buf.writeUInt32LE(data, 40);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const x = channels[c][i];
    if (bits === 32) { buf.writeFloatLE(x, o); o += 4; }
    else { const s = Math.max(-1, Math.min(1, x)); buf.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), o); o += 2; }
  }
  return buf;
}

export function readWav(buf: Buffer, limits: WavReadLimits = {}): { sampleRate: number; channels: Float32Array[] } {
  const bad = (message: string): never => { throw new BeepsError('E_SCHEMA', message); };
  for (const [key, value] of Object.entries(limits)) if (value !== undefined && (!Number.isFinite(value) || value <= 0 || (key !== 'maxSeconds' && !Number.isSafeInteger(value)))) bad(`invalid WAV ${key} bound`);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') bad('not a WAV file');
  if (buf.readUInt32LE(4) > buf.length - 8) bad('truncated WAV RIFF chunk');
  const end = buf.readUInt32LE(4) + 8;
  let o = 12, format = 0, ch = 0, sampleRate = 0, bits = 0, block = 0;
  while (o + 8 <= end) {
    const id = buf.toString('ascii', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    const body = o + 8;
    if (size > end - body) bad(`truncated WAV ${id} chunk`);
    if (id === 'fmt ') {
      if (size < 16) bad('WAV fmt chunk is too short');
      format = buf.readUInt16LE(body); ch = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4); bits = buf.readUInt16LE(body + 14); block = buf.readUInt16LE(body + 12);
      if (format === 0xfffe && size < 40) bad('WAV extensible fmt chunk is too short');
      if (format === 0xfffe && size >= 40) format = buf.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE (ffmpeg's float output): the sub-format GUID starts with the real code
    } else if (id === 'data') {
      if (!ch || !sampleRate) bad('invalid WAV data format');
      if (limits.maxChannels !== undefined && ch > limits.maxChannels) bad(`WAV channels exceed ${limits.maxChannels} bound`);
      // Compressed WAV block alignment and bits do not describe decoded PCM frames.
      // Structural chunk bounds were checked above; ffmpeg applies decoded limits on fallback.
      if (!((format === 3 && bits === 32) || (format === 1 && bits === 16))) throw new UnsupportedWavError(`unsupported WAV format ${format}/${bits}`);
      const bytes = bits / 8;
      if (block !== bytes * ch || size % block !== 0) bad('invalid WAV data format or block alignment');
      const n = size / block;
      if (limits.maxFrames !== undefined && n > limits.maxFrames) bad(`WAV frames exceed ${limits.maxFrames} bound`);
      if (limits.maxSeconds !== undefined && n / sampleRate > limits.maxSeconds) bad(`WAV duration exceeds ${limits.maxSeconds} seconds bound`);
      const channels = Array.from({ length: ch }, () => new Float32Array(n));
      let p = body;
      for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
        if (format === 3 && bits === 32) channels[c][i] = buf.readFloatLE(p);
        else if (format === 1 && bits === 16) channels[c][i] = buf.readInt16LE(p) / 32768;
        p += bytes;
      }
      return { sampleRate, channels };
    }
    o = body + size + (size % 2);
  }
  return bad('WAV has no data chunk');
}
