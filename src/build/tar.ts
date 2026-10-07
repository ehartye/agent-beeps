// A minimal deterministic ustar writer and reader for store entries: flat regular files, no compression (audio does not compress),
// zeroed owner and mtime, entries in the order given. The same bytes in give the same tar out, so a store entry is reproducible.
import { BeepsError } from '../errors.ts';

export interface TarEntry { name: string; data: Buffer }

const octal = (n: number, width: number) => n.toString(8).padStart(width - 1, '0') + '\0';

function header(name: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  if (Buffer.byteLength(name) > 100) throw new BeepsError('E_STORE', `tar entry name too long (${name.length} > 100): ${name}`);
  h.write(name, 0, 'utf8');
  h.write(octal(0o644, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(0, 12), 136, 'ascii');
  h.write('        ', 148, 'ascii'); // the checksum is summed with this field as spaces
  h.write('0', 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

export function createTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(header(e.name, e.data.length), e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** Entry names are flat file names: anything with a separator, a drive, or a dot-segment is refused (a hostile store cannot write outside the output directory). */
export function safeEntryName(name: string): boolean {
  return name.length > 0 && !/[\\/:\0]/.test(name) && name !== '.' && name !== '..';
}

export function readTar(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    const field = (a: number, b: number) => h.toString('ascii', a, b).replace(/\0.*$/s, '').trim();
    const name = h.toString('utf8', 0, 100).replace(/\0.*$/s, '');
    const size = parseInt(field(124, 136), 8);
    const type = h.toString('ascii', 156, 157);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (!Number.isFinite(size) || sum !== parseInt(field(148, 156), 8)) throw new BeepsError('E_STORE', 'corrupt tar header');
    if (type !== '0' && type !== '\0') throw new BeepsError('E_STORE', `tar entry ${name}: only regular files are allowed`);
    if (!safeEntryName(name)) throw new BeepsError('E_STORE', `tar entry "${name}" is not a flat file name`);
    off += 512;
    if (off + size > buf.length) throw new BeepsError('E_STORE', `tar entry ${name} is truncated`);
    out.push({ name, data: Buffer.from(buf.subarray(off, off + size)) });
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}
