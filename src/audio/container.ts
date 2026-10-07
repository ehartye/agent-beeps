// Headers of delivered audio containers, read without decoding: Ogg Opus (OpusHead pre-skip, last granule position) and MP3 (the
// Xing/Info frame and its LAME tag: frame count, encoder id, delay and padding).
import { readFileSync } from 'node:fs';

export function parseOgg(buf: Buffer): { preskip: number; channels: number; granule: bigint; eos: boolean; sawTags: boolean } | string {
  let off = 0, head: { preskip: number; channels: number } | undefined, granule = 0n, eos = false, sawTags = false;
  while (off + 27 <= buf.length) {
    if (buf.toString('latin1', off, off + 4) !== 'OggS') return `bad Ogg page header at byte ${off}`;
    const type = buf[off + 5], nseg = buf[off + 26];
    const segs = buf.subarray(off + 27, off + 27 + nseg);
    const size = segs.reduce((s, b) => s + b, 0);
    const body = off + 27 + nseg;
    if (body + size > buf.length) return 'truncated Ogg page';
    if (!head && body + 19 <= buf.length && buf.toString('latin1', body, body + 8) === 'OpusHead') {
      head = { channels: buf[body + 9], preskip: buf.readUInt16LE(body + 10) };
      if (buf[body + 8] !== 1) return `OpusHead version ${buf[body + 8]}`;
    }
    if (buf.toString('latin1', body, body + 8) === 'OpusTags') sawTags = true;
    granule = buf.readBigInt64LE(off + 6);
    eos = (type & 4) !== 0;
    off = body + size;
  }
  if (!head) return 'no OpusHead packet (not Ogg Opus)';
  return { ...head, granule, eos, sawTags };
}

/** The Xing/Info frame of an MP3 and the LAME tag in it: frame count, encoder id, delay and padding. */
export function parseMp3(buf: Buffer): { frames?: number; encoder?: string; delay?: number; padding?: number; samplesPerFrame: number; sampleRate: number; channels: number; tag: 'Xing' | 'Info' | undefined } | string {
  let off = 0;
  if (buf.toString('latin1', 0, 3) === 'ID3') off = 10 + ((buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9]);
  while (off + 4 < buf.length && !(buf[off] === 0xff && (buf[off + 1] & 0xe0) === 0xe0)) off++;
  if (off + 4 >= buf.length) return 'no MPEG frame found';
  const version = (buf[off + 1] >> 3) & 3, layer = (buf[off + 1] >> 1) & 3, crc = (buf[off + 1] & 1) === 0;
  if (layer !== 1) return 'not MPEG layer III';
  const mono = ((buf[off + 3] >> 6) & 3) === 3, mpeg1 = version === 3;
  const srIndex = (buf[off + 2] >> 2) & 3;
  const sampleRate = ([44100, 48000, 32000][srIndex] ?? 0) / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const samplesPerFrame = mpeg1 ? 1152 : 576;
  const tagAt = off + 4 + (crc ? 2 : 0) + (mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17));
  const name = buf.toString('latin1', tagAt, tagAt + 4);
  if (name !== 'Xing' && name !== 'Info') return { samplesPerFrame, sampleRate, channels: mono ? 1 : 2, tag: undefined };
  const flags = buf.readUInt32BE(tagAt + 4);
  let p = tagAt + 8, frames: number | undefined;
  if (flags & 1) { frames = buf.readUInt32BE(p); p += 4; }
  if (flags & 2) p += 4;
  if (flags & 4) p += 100;
  if (flags & 8) p += 4;
  const encoder = buf.toString('latin1', p, p + 9).replace(/\0.*$/s, '');
  // The LAME extension: revision/lowpass, replay gain (8), flags, bitrate, then 12 bits of encoder delay and 12 of padding.
  const d = buf.subarray(p + 21, p + 24);
  const delay = (d[0] << 4) | (d[1] >> 4), padding = ((d[1] & 0xf) << 8) | d[2];
  return { frames, encoder, delay, padding, samplesPerFrame, sampleRate, channels: mono ? 1 : 2, tag: name };
}


/** Samples a decoder must drop from the start of the file: Opus pre-skip, or the MP3 encoder delay. Undefined when the headers do not say. */
export function encoderLead(path: string): number | undefined {
  const buf = readFileSync(path);
  if (/\.(ogg|opus)$/i.test(path)) { const r = parseOgg(buf); return typeof r === 'string' ? undefined : r.preskip; }
  if (/\.mp3$/i.test(path)) { const r = parseMp3(buf); return typeof r === 'string' ? undefined : r.delay; }
  return undefined;
}
