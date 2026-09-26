// Minimal RIFF/WAVE: 16-bit PCM or 32-bit float, interleaved.

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

export function readWav(buf: Buffer): { sampleRate: number; channels: Float32Array[] } {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let o = 12, format = 0, ch = 0, sampleRate = 0, bits = 0;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    const body = o + 8;
    if (id === 'fmt ') {
      format = buf.readUInt16LE(body); ch = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4); bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      const bytes = bits / 8;
      const n = Math.floor(size / (bytes * ch));
      const channels = Array.from({ length: ch }, () => new Float32Array(n));
      let p = body;
      for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
        if (format === 3 && bits === 32) channels[c][i] = buf.readFloatLE(p);
        else if (format === 1 && bits === 16) channels[c][i] = buf.readInt16LE(p) / 32768;
        else throw new Error(`unsupported WAV format ${format}/${bits}`);
        p += bytes;
      }
      return { sampleRate, channels };
    }
    o = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}
