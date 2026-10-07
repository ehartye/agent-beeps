// `beeps store push|pull|status` and `beeps ci export`: the lock's assets against a store.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { BeepsError } from '../errors.ts';
import { bundleDir } from '../bundle.ts';
import { RUNTIME_DIR } from '../render/host.ts';
import { atomicWrite, readLock, type Lock, type LockAsset } from './lock.ts';
import type { BuildConfig } from './config.ts';
import { packAsset, sha256Hex, storeName, unpackAsset, type Store } from './store.ts';

const outputsOk = (out: string, a: LockAsset): { ok: boolean; problem?: string } => {
  for (const f of a.outputs) {
    const p = join(out, f.file);
    if (!existsSync(p)) return { ok: false, problem: `${f.file} is missing` };
    const b = readFileSync(p);
    if (b.length !== f.bytes || sha256Hex(b) !== f.sha256) return { ok: false, problem: `${f.file} does not match the lock` };
  }
  return { ok: true };
};

function requireLock(cfg: BuildConfig): Lock {
  const lock = readLock(cfg.lock);
  if (!lock) throw new BeepsError('E_NOT_FOUND', `no lock at ${cfg.lock}`, { hint: 'run "beeps build" first' });
  return lock;
}

const pick = (lock: Lock, only?: string[]) => {
  for (const id of only ?? []) if (!lock.assets[id]) throw new BeepsError('E_USAGE', `--only: no asset "${id}" in the lock`);
  return Object.entries(lock.assets).filter(([id]) => !only || only.includes(id)).sort(([a], [b]) => (a < b ? -1 : 1));
};

/** Publishes every asset of the lock whose outputs verify locally and that the store lacks. Immutable: an existing entry is never replaced. */
export async function storePush(cfg: BuildConfig, store: Store, only?: string[]) {
  const lock = requireLock(cfg);
  const pushed: string[] = [], existing: string[] = [], skipped: { id: string; problem: string }[] = [];
  for (const [id, a] of pick(lock, only)) {
    const name = storeName(a.inputHash);
    if (await store.has(name)) { existing.push(id); continue; }
    const v = outputsOk(cfg.out, a);
    if (!v.ok) { skipped.push({ id, problem: `${v.problem}: build it first` }); continue; }
    if (await store.put(name, packAsset(id, a.inputHash, a.outputs, f => readFileSync(join(cfg.out, f)))) === 'stored') pushed.push(id); else existing.push(id);
  }
  return { store: store.spec, pushed, existing, skipped, ok: skipped.length === 0 };
}

/** Writes the lock's assets from the store into the output directory, checking every file against the lock; then the catalog. */
export async function storePull(cfg: BuildConfig, store: Store, only?: string[]) {
  const lock = requireLock(cfg);
  const pulled: string[] = [], present: string[] = [], missing: string[] = [], problems: { id: string; problem: string }[] = [];
  for (const [id, a] of pick(lock, only)) {
    if (outputsOk(cfg.out, a).ok) { present.push(id); continue; }
    const bytes = await store.get(storeName(a.inputHash));
    if (!bytes) { missing.push(id); continue; }
    try {
      const { files } = unpackAsset(bytes, { inputHash: a.inputHash, outputs: a.outputs });
      for (const f of a.outputs) {
        const d = files.get(f.file)!;
        if (d.length !== f.bytes || sha256Hex(d) !== f.sha256) throw new BeepsError('E_STORE', `${f.file} does not match the lock`);
      }
      for (const f of a.outputs) atomicWrite(join(cfg.out, f.file), files.get(f.file)!);
      pulled.push(id);
    } catch (e) { problems.push({ id, problem: (e as Error).message }); }
  }
  if (!only && !missing.length && !problems.length && existsSync(cfg.out)) bundleDir(cfg.out, { skipUnchanged: true });
  return { store: store.spec, pulled, present, missing, problems, ok: !missing.length && !problems.length };
}

export async function storeStatus(cfg: BuildConfig, store: Store | undefined, only?: string[]) {
  const lock = requireLock(cfg);
  const rows: { id: string; inputHash: string; local: string | undefined; store?: string }[] = [];
  for (const [id, a] of pick(lock, only)) {
    const v = outputsOk(cfg.out, a);
    rows.push({ id, inputHash: a.inputHash.slice(0, 19), local: v.ok ? 'ok' : v.problem, ...(store ? { store: (await store.has(storeName(a.inputHash))) ? 'present' : 'missing' } : {}) });
  }
  const count = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;
  return {
    ...(store ? { store: store.spec } : {}), assets: rows.length, localOk: count(r => r.local === 'ok'), ...(store ? { inStore: count(r => r.store === 'present'), missingFromStore: rows.filter(r => r.store === 'missing').map(r => r.id) } : {}),
    notBuilt: rows.filter(r => r.local !== 'ok').map(r => r.id),
  };
}

/** Writes the zero-dependency fetch script with this project's lock, output and store baked in as defaults (relative to the script). */
export function ciExport(cfg: BuildConfig, dir: string, store?: string) {
  const script = readFileSync(join(RUNTIME_DIR, 'ci', 'fetch.mjs'), 'utf8');
  const rel = (p: string) => relative(dir, p).split('\\').join('/');
  const defaults = { lock: rel(cfg.lock), out: rel(cfg.out), ...(store ?? cfg.store ? { store: store ?? cfg.store } : {}) };
  const marker = '/*beeps:defaults*/ {}';
  if (!script.includes(marker)) throw new BeepsError('E_RUNTIME_MISSING', 'runtime/ci/fetch.mjs lost its defaults marker');
  const file = join(dir, 'fetch.mjs');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, script.replace(marker, `${JSON.stringify(defaults)}`));
  try { chmodSync(file, 0o755); } catch { /* not on Windows */ }
  return { file, defaults, usage: `node ${rel(file) === 'fetch.mjs' ? 'fetch.mjs' : file}` };
}
