// Run the real CLI against a throwaway project: the end-to-end shape the honest-feedback tests share.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';

const bin = join(import.meta.dirname, '..', '..', 'scripts', 'beeps.mjs');

export function beeps(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  const parse = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };
  return { status: r.status, out: parse(r.stdout), err: parse(r.stderr)?.error };
}

/** A fresh project directory with `beeps init` already run. */
export function project(scale?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'beeps-honest-'));
  expect(beeps(dir, 'init', ...(scale ? ['--scale', scale] : [])).status).toBe(0);
  return dir;
}

/** Save patches into the project through `beeps new`. */
export function add(dir: string, ...patches: object[]) {
  for (const p of patches) {
    const file = join(dir, `${(p as { name: string }).name}.src.json`);
    writeFileSync(file, JSON.stringify(p));
    expect(beeps(dir, 'new', file, '--force').status).toBe(0);
  }
}
