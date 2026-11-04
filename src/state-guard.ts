// A persistent SQLite file supplies OS-managed cross-process exclusion. Never unlink this file:
// replacing its inode would let two writers hold locks on different files. JSON remains canonical.
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { BeepsError } from './errors.ts';
const require = createRequire(import.meta.url);

export function acquireStateGuard(path: string): () => void {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  const guard = join(realpathSync(dirname(absolute)), `.${basename(absolute)}.guard.sqlite`);
  let db: DatabaseSync | undefined;
  try {
    // Read-only CLI commands need neither a SQLite connection nor its experimental-module warning.
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    db = new DatabaseSync(guard, { timeout: 0 });
    db.exec('BEGIN IMMEDIATE');
  } catch (error) {
    db?.close();
    throw new BeepsError('E_LOCK', `cannot acquire state guard for ${path}: ${(error as Error).message}`, {
      hint: 'Retry after the other writer finishes. Do not delete guard files; only cooperating writers on a local filesystem are supported.',
    });
  }
  const owned = db;
  let closed = false;
  return () => { if (!closed) { closed = true; owned.close(); } };
}

export function withStateGuard<T>(path: string, fn: () => T): T {
  const release = acquireStateGuard(path);
  try { return fn(); } finally { release(); }
}
