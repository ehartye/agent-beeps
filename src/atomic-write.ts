// Atomic file writes, shared by the build lock, delivery output and the render cache.
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Writes through a temp file and a rename, so a reader (or a crash) sees the old file or the new one, never half of one. */
export function atomicWrite(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try { renameSync(tmp, path); return; } catch (e) {
      // Windows: a virus scanner or indexer can hold the destination for a moment.
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) { rmSync(tmp, { force: true }); throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}
