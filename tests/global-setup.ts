// Every test that calls mkdtempSync(join(tmpdir(), ...)) (and every CLI process those tests spawn) now creates its
// directories under one root that this setup removes when the run ends. Before this, about 175 call sites left their
// directories behind: thousands of them, gigabytes on a developer machine.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PREFIX = 'beeps-test-run-';
const STALE_MS = 24 * 3600 * 1000;

export function setup() {
  const base = tmpdir();
  // A run that was killed never reaches teardown: sweep roots a day old before making a new one.
  for (const name of readdirSync(base)) {
    if (!name.startsWith(PREFIX)) continue;
    try { if (Date.now() - statSync(join(base, name)).mtimeMs > STALE_MS) rmSync(join(base, name), { recursive: true, force: true }); } catch { /* in use */ }
  }
  const root = mkdtempSync(join(base, PREFIX));
  mkdirSync(root, { recursive: true });
  // os.tmpdir() reads these on every call (and child processes inherit them), so set all three platforms' names.
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = root;
  return () => {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (e) { console.warn(`could not remove ${root}: ${(e as Error).message}`); }
  };
}
