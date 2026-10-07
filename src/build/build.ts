// `beeps build`: render + export + compress + bundle only the assets whose input hash differs from the committed lock, or whose
// outputs are missing or no longer match it. Everything else is left byte for byte alone.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BeepsError } from '../errors.ts';
import { bundleDir, catalogText } from '../bundle.ts';
import { compressBundle, ffmpegFingerprint, findFfmpeg } from '../compress.ts';
import { exportPatchVariants, exportSongAssets } from '../export-assets.ts';
import { ExportManifestSchema } from '../export-manifest.ts';
import { loadPatch, openProject, pathsFor, type OpenProject } from '../project.ts';
import { loadSong } from '../music.ts';
import { openRenderHost, type RenderHost } from '../render/host.ts';
import { parseProject } from '../schema/project.ts';
import { deliveryFor, loadRecipes, type BuildConfig, type Delivery } from './config.ts';
import { atomicWrite, currentToolchain, deliveryRecord, emptyLock, KEY_SCHEME, readLock, writeLock, type Lock, type LockAsset } from './lock.ts';
import { planAsset, type Encoder, type Planned } from './plan.ts';
import { packAsset, sha256Hex, storeName, unpackAsset, type OutputRef, type Store } from './store.ts';
import { sidecarExpectations, staticCheck } from './verify.ts';

export interface BuildOptions {
  only?: string[];
  /** Treat every asset as stale: re-export and re-encode (renders still come from the render cache). */
  all?: boolean;
  /** Render nothing and write nothing: report what is stale (non-zero exit by the caller). */
  check?: boolean;
  /** Fetch stale assets from the store (by input hash) before rendering anything. */
  pull?: boolean;
  /** Publish the assets this run built to the store. */
  push?: boolean;
  store?: Store;
  /** Rewrite a lock another tool wrote (keyScheme other than beeps-input@1) into beeps' scheme, with no rendering, when its outputs verify. */
  adopt?: boolean;
  /** Allow a build when the toolchain or encoder differs from the lock's (this re-renders and re-encodes whatever the store lacks). */
  allowToolchainChange?: boolean;
  jobs?: number;
  log?: (line: string) => void;
  /** Test seams: called around each asset's install. A throw simulates a crash. */
  hooks?: { beforeInstall?(id: string): void; afterInstall?(id: string): void; afterBuild?(id: string): void };
}

export interface StaleAsset { id: string; reasons: string[] }
export interface BuildReport {
  ok: boolean;
  config: string; target: string; lock: string; out: string;
  total: number;
  unchanged: string[]; built: string[]; pulled: string[]; adopted: string[]; removed: string[]; pushed: string[];
  stale: StaleAsset[];
  /** Lock-level or catalog drift that a build would rewrite. */
  drift: string[];
  catalogWritten: boolean;
  estimate: { totalBytes: number; budgetBytes?: number; newAssets: number; basis: string };
  seconds: number;
}

/** A render host that opens Chromium on its first use: an asset whose renders are all in the cache never starts a browser. */
function lazyHost(): { host: RenderHost; close(): Promise<void> } {
  let real: Promise<RenderHost> | undefined;
  const open = () => (real ??= openRenderHost());
  const host = new Proxy({} as RenderHost, {
    get: (_, prop) => (...args: unknown[]) => open().then(h => (h as unknown as Record<string, (...a: unknown[]) => unknown>)[prop as string](...args)),
  });
  return { host, close: async () => { if (real) await (await real).close().catch(() => {}); } };
}

const prefer = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Where a build's project lives: the config's project file (render cache under workDir), or the nearest .agent-beeps. */
export function openBuildProject(cfg: BuildConfig): OpenProject {
  if (!cfg.project) {
    const p = openProject(cfg.dir);
    return cfg.patches ? { ...p, paths: { ...p.paths, patches: cfg.patches } } : p;
  }
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(cfg.project, 'utf8')); } catch (e) { throw new BeepsError('E_PROJECT', `cannot read ${cfg.project}: ${(e as Error).message}`); }
  let project;
  try { project = parseProject(raw); } catch (e) { throw new BeepsError('E_SCHEMA', `invalid ${cfg.project}: ${(e as Error).message}`); }
  const paths = pathsFor(cfg.workDir);
  return { paths: cfg.patches ? { ...paths, patches: cfg.patches } : paths, project };
}

function sha256File(path: string): { sha256: string; bytes: number } {
  const buf = readFileSync(path);
  return { sha256: sha256Hex(buf), bytes: buf.length };
}

/** Why this asset must be rebuilt, or [] when its inputs and every output match the lock. */
function staleReasons(plan: Planned, entry: LockAsset | undefined, out: string, all: boolean): string[] {
  if (all) return ['forced (--all)'];
  if (!entry) return ['new: not in the lock'];
  const reasons: string[] = [];
  if (entry.inputHash !== plan.inputHash) {
    const changed = entry.parts ? (Object.keys(plan.parts) as (keyof Planned['parts'])[]).filter(k => entry.parts![k] !== plan.parts[k]) : [];
    reasons.push(`inputs changed${changed.length ? ` (${changed.join(', ')})` : ''}: ${entry.inputHash.slice(0, 19)} -> ${plan.inputHash.slice(0, 19)}`);
  }
  for (const o of entry.outputs) {
    const f = join(out, o.file);
    if (!existsSync(f)) { reasons.push(`output missing: ${o.file}`); continue; }
    if (statSync(f).size !== o.bytes || sha256File(f).sha256 !== o.sha256) reasons.push(`output modified: ${o.file}`);
  }
  return reasons;
}

function driftOf(lock: Lock | undefined, toolchain: Record<string, unknown>, delivery: Record<string, unknown>): string[] {
  if (!lock) return [];
  const d: string[] = [];
  for (const k of new Set([...Object.keys(lock.toolchain), ...Object.keys(toolchain)])) {
    if (JSON.stringify(lock.toolchain[k]) !== JSON.stringify(toolchain[k])) d.push(`toolchain.${k}: ${JSON.stringify(lock.toolchain[k])} -> ${JSON.stringify(toolchain[k])}`);
  }
  const flat = (o: Record<string, unknown>, pre = ''): Record<string, string> => Object.fromEntries(Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? Object.entries(flat(v as Record<string, unknown>, `${pre}${k}.`)) : [[`${pre}${k}`, String(v)]])));
  const a = flat(lock.delivery), b = flat(delivery);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) d.push(`delivery.${k}: ${a[k] ?? '(none)'} -> ${b[k] ?? '(none)'}`);
  return d;
}

function listOutputs(dir: string): OutputRef[] {
  return readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name !== 'index.json').map(e => e.name).sort(prefer)
    .map(file => ({ file, ...sha256File(join(dir, file)) }));
}

/** Copies the asset's staged files into the output directory, atomically per file, leaving files whose bytes already match alone. */
function install(out: string, stage: string, outputs: OutputRef[], previous: OutputRef[] | undefined): void {
  mkdirSync(out, { recursive: true });
  for (const o of outputs) {
    const dest = join(out, o.file);
    if (existsSync(dest) && statSync(dest).size === o.bytes && sha256File(dest).sha256 === o.sha256) continue;
    atomicWrite(dest, readFileSync(join(stage, o.file)));
  }
  const keep = new Set(outputs.map(o => o.file));
  for (const o of previous ?? []) if (!keep.has(o.file)) rmSync(join(out, o.file), { force: true });
}

export async function runBuild(cfg: BuildConfig, o: BuildOptions = {}): Promise<BuildReport> {
  const t0 = Date.now(), log = o.log ?? (() => {});
  const all = loadRecipes(cfg);
  if (o.only) for (const id of o.only) if (!all.some(r => r.id === id)) throw new BeepsError('E_USAGE', `--only: no recipe "${id}"`, { hint: `recipes: ${all.slice(0, 8).map(r => r.id).join(', ')}${all.length > 8 ? ', ...' : ''}` });
  const recipes = o.only ? all.filter(r => o.only!.includes(r.id)) : all;
  const delivery = deliveryFor(cfg.target, cfg.kbps);
  const toolchain = currentToolchain();
  let lock = readLock(cfg.lock);

  // The encoder fingerprint is part of every hash. A --check on a machine with no ffmpeg (a CI job that only fetches) trusts the lock's.
  let encoder: Encoder | undefined;
  if (delivery.format !== 'wav') {
    try { encoder = ffmpegFingerprint(findFfmpeg()); } catch (e) {
      const recorded = (lock?.delivery.encoder ?? undefined) as { ffmpeg?: string; libavcodec?: string } | undefined;
      if (!o.check || !recorded?.ffmpeg || !recorded.libavcodec) throw e;
      encoder = { ffmpeg: recorded.ffmpeg, libavcodec: recorded.libavcodec };
    }
  }
  const deliveryRec = deliveryRecord(delivery, encoder);

  const p = openBuildProject(cfg);
  const plans = recipes.map(r => planAsset(p, r, delivery, toolchain, encoder));

  let adopted: string[] = [];
  if (lock && lock.keyScheme !== KEY_SCHEME) {
    if (!o.adopt) throw new BeepsError('E_LOCK', `${cfg.lock} was written with key scheme "${lock.keyScheme}", not ${KEY_SCHEME}`, { hint: 'run "beeps build --adopt" to take it over without rendering (every output must still match its sha256)' });
    const a = adopt(cfg, lock, plans, toolchain, deliveryRec, o.check ?? false, log);
    lock = a.lock; adopted = a.adopted;
  } else if (o.adopt) log("--adopt: the lock is already in beeps' scheme");

  const drift = driftOf(lock, toolchain as unknown as Record<string, unknown>, deliveryRec);
  const next: Lock = lock ? { ...lock, assets: { ...lock.assets } } : emptyLock(deliveryRec, toolchain);

  // Stale = new, changed inputs, or outputs missing/modified.
  const stale: StaleAsset[] = [];
  const unchanged: string[] = [];
  for (const pl of plans) {
    const reasons = staleReasons(pl, lock?.assets[pl.recipe.id], cfg.out, !!o.all);
    if (reasons.length) stale.push({ id: pl.recipe.id, reasons }); else unchanged.push(pl.recipe.id);
  }
  const removed = !o.only && lock ? Object.keys(lock.assets).filter(id => !recipes.some(r => r.id === id)) : [];
  for (const id of removed) stale.push({ id, reasons: ['removed from the recipes: its outputs and lock entry will be deleted'] });

  const estimate = estimateBytes(plans, lock, delivery);
  const catalogDrift = catalogDriftOf(cfg.out, unchanged.length === plans.length);
  const driftLines = [...(stale.length ? [] : drift), ...catalogDrift];
  const report = (over: Partial<BuildReport>): BuildReport => ({
    ok: true, config: cfg.file, target: cfg.target, lock: cfg.lock, out: cfg.out, total: plans.length,
    unchanged, built: [], pulled: [], adopted, removed: [], pushed: [], stale: [], drift: driftLines, catalogWritten: false, estimate,
    seconds: Math.round((Date.now() - t0) / 100) / 10, ...over,
  });

  if (o.check) {
    const bad = stale.length > 0 || driftLines.length > 0;
    return report({ ok: !bad, stale, unchanged: stale.length ? unchanged : unchanged });
  }
  if (cfg.budgetBytes && estimate.totalBytes > cfg.budgetBytes) {
    throw new BeepsError('E_BUDGET', `projected ${(estimate.totalBytes / 1e6).toFixed(1)} MB exceeds the budget of ${(cfg.budgetBytes / 1e6).toFixed(1)} MB (${estimate.basis})`, { hint: 'lower the kbps in beeps.build.json or raise budgetBytes; nothing was rendered', details: { estimate } });
  }

  const todo = new Map(plans.filter(pl => stale.some(s => s.id === pl.recipe.id)).map(pl => [pl.recipe.id, pl]));
  const stage = join(cfg.workDir, 'stage');
  const pulled: string[] = [], built: string[] = [], pushed: string[] = [];
  const commit = (id: string, entry: LockAsset) => { next.assets[id] = entry; writeLockNow(); };
  const writeLockNow = () => {
    next.delivery = deliveryRec; next.toolchain = { ...toolchain }; next.keyScheme = KEY_SCHEME;
    writeLock(cfg.lock, next);
  };

  // 1. The store, before any render.
  if (o.pull && o.store) {
    for (const pl of [...todo.values()]) {
      const id = pl.recipe.id, prior = lock?.assets[id];
      const bytes = await o.store.get(storeName(pl.inputHash));
      if (!bytes) continue;
      const expectOutputs = prior && prior.inputHash === pl.inputHash ? prior.outputs : undefined;
      const { manifest, files } = unpackAsset(bytes, { inputHash: pl.inputHash, outputs: expectOutputs });
      const sdir = join(stage, `${id}.pull`);
      rmSync(sdir, { recursive: true, force: true }); mkdirSync(sdir, { recursive: true });
      for (const [f, data] of files) atomicWrite(join(sdir, f), data);
      o.hooks?.beforeInstall?.(id);
      install(cfg.out, sdir, manifest.outputs, prior?.outputs);
      rmSync(sdir, { recursive: true, force: true });
      commit(id, { role: pl.recipe.role, source: pl.recipe.sourceRel, inputHash: pl.inputHash, parts: pl.parts, outputs: manifest.outputs });
      o.hooks?.afterInstall?.(id);
      todo.delete(id); pulled.push(id);
      log(`pulled ${id}`);
    }
  }

  // 2. What is left has to be rendered. A toolchain or encoder change re-renders whatever the store lacks: say so first.
  const toBuild = [...todo.values()].filter(pl => !removed.includes(pl.recipe.id));
  if (toBuild.length && drift.length && lock && !o.allowToolchainChange && !o.all) {
    throw new BeepsError('E_TOOLCHAIN', `the toolchain or encoder differs from the lock's, so ${toBuild.length} asset(s) are stale and would be re-rendered or re-encoded:\n  ${drift.slice(0, 8).join('\n  ')}`, {
      hint: 'pull them from the store (--pull --store ...), or pass --allow-toolchain-change to rebuild on purpose', details: { drift },
    });
  }

  if (toBuild.length) {
    mkdirSync(stage, { recursive: true });
    const queue = [...toBuild];
    let failed: unknown;
    const worker = async () => {
      const { host, close } = lazyHost();
      try {
        while (queue.length && !failed) {
          const pl = queue.shift()!;
          const t = Date.now();
          const entry = await buildOne(host, p, cfg, pl, delivery, stage, lock?.assets[pl.recipe.id], o, log);
          commit(pl.recipe.id, entry);
          o.hooks?.afterInstall?.(pl.recipe.id);
          built.push(pl.recipe.id);
          log(`built ${pl.recipe.id} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
          if (o.push && o.store) {
            const name = storeName(pl.inputHash);
            const res = await o.store.put(name, packAsset(pl.recipe.id, pl.inputHash, entry.outputs, f => readFileSync(join(cfg.out, f))));
            if (res === 'stored') pushed.push(pl.recipe.id);
          }
        }
      } catch (e) { failed ??= e; } finally { await close(); }
    };
    await Promise.all(Array.from({ length: Math.min(o.jobs ?? cfg.jobs, queue.length) }, worker));
    if (failed) throw failed;
  }
  rmSync(stage, { recursive: true, force: true });

  // 3. Assets removed from the recipes.
  for (const id of removed) {
    for (const f of lock!.assets[id].outputs) rmSync(join(cfg.out, f.file), { force: true });
    delete next.assets[id];
  }
  const changed = built.length + pulled.length + removed.length > 0;
  // The lock header (delivery, toolchain) is rewritten when assets changed or adoption happened.
  if (changed || adopted.length || !lock || drift.length) writeLockNow();

  // 4. The catalog, regenerated deterministically, and only when it is not already what the sidecars say.
  let catalogWritten = false;
  if (existsSync(cfg.out) && readdirSync(cfg.out).some(f => /\.(wav|ogg|mp3)\.json$/.test(f))) {
    catalogWritten = bundleDir(cfg.out, { skipUnchanged: true }).written;
  }
  // Push what the store lacks even when this run built nothing new? No: `beeps store push` does that.
  return report({ built, pulled, removed, pushed, catalogWritten, unchanged, stale: [], drift: [], ok: true });
}

function estimateBytes(plans: Planned[], lock: Lock | undefined, delivery: Delivery): BuildReport['estimate'] {
  let total = 0, fresh = 0;
  const oldKbps = (lock?.delivery.kbps ?? {}) as Record<string, number>;
  for (const pl of plans) {
    const prior = lock?.assets[pl.recipe.id];
    if (!prior) { total += pl.estimateBytes; fresh++; continue; }
    const bytes = prior.outputs.reduce((s, f) => s + f.bytes, 0);
    // A bitrate change scales the locked size by the ratio: arithmetic, no rendering.
    const was = oldKbps[pl.recipe.role], now = delivery.kbps?.[pl.recipe.role];
    total += was && now && was !== now ? Math.ceil(bytes * now / was) : bytes;
  }
  // Assets outside --only still count against the budget at their locked size.
  if (lock) for (const [id, a] of Object.entries(lock.assets)) if (!plans.some(pl => pl.recipe.id === id)) total += a.outputs.reduce((s, f) => s + f.bytes, 0);
  return { totalBytes: total, newAssets: fresh, basis: 'locked sizes of existing assets, scaled by any bitrate change; duration x bitrate x 1.1 for new ones' };
}

function catalogDriftOf(out: string, allUnchanged: boolean): string[] {
  if (!allUnchanged || !existsSync(out)) return [];
  if (!readdirSync(out).some(f => /\.(wav|ogg|mp3)\.json$/.test(f))) return [];
  try {
    const { index, text } = catalogText(out);
    if (!existsSync(index)) return ['index.json is missing'];
    return readFileSync(index, 'utf8') === text ? [] : ['index.json differs from what the sidecars produce'];
  } catch (e) { return [`index.json: ${(e as Error).message}`]; }
}

/** Exports, compresses and verifies one asset into a staging directory, installs it, and returns its lock entry. */
async function buildOne(host: RenderHost, p: OpenProject, cfg: BuildConfig, pl: Planned, delivery: ReturnType<typeof deliveryFor>, stage: string, prior: LockAsset | undefined, o: BuildOptions, log: (s: string) => void): Promise<LockAsset> {
  const r = pl.recipe;
  const sdir = join(stage, r.id), wavDir = join(sdir, 'wav'), outDir = join(sdir, 'out');
  rmSync(sdir, { recursive: true, force: true });
  mkdirSync(wavDir, { recursive: true });
  const wav = join(wavDir, `${r.id}.wav`);
  if (r.kind === 'patch') {
    await exportPatchVariants(host, p, loadPatch(p, r.source), { dest: wav, seed: r.seed, n: pl.variants, role: r.role, manifest: true });
  } else {
    const out = await exportSongAssets(host, p, loadSong(p, r.source), { dest: wav, role: r.role, manifest: true, layers: pl.layers });
    for (const w of out.warnings) log(`${r.id}: ${w}`);
  }
  const side = ExportManifestSchema.parse(JSON.parse(readFileSync(`${wav}.json`, 'utf8')));
  if (side.id !== r.id) throw new BeepsError('E_SCHEMA', `recipe "${r.id}" exported asset id "${side.id}": rename the ${r.kind} "name" to "${r.id}"`, { hint: 'the catalog keys assets by the patch or song name, so the recipe id must match it' });

  let from = wavDir;
  if (delivery.format !== 'wav') {
    const k = delivery.kbps!;
    const c = compressBundle(wavDir, outDir, { format: delivery.format, kbps: { music: k.music, ambience: k.ambience, sfx: k.sfx, mix: k.mix } });
    if (c.problems.length) throw new BeepsError('E_VERIFY', `${r.id}: encoded audio does not verify: ${c.problems.flatMap(x => x.problems.map(m => `${x.file}: ${m}`)).join('; ')}`, { details: { problems: c.problems } });
    from = outDir;
  }
  const outputs = listOutputs(from);
  // Cheap static checks of what was just encoded (headers, tag, encoder id, length), over and above compress's decode verification.
  const sidecarOut = outputs.find(f => /\.(wav|ogg|mp3)\.json$/.test(f.file))!;
  const sc = ExportManifestSchema.parse(JSON.parse(readFileSync(join(from, sidecarOut.file), 'utf8')));
  const expects = sidecarExpectations(sidecarOut.file, sc);
  for (const f of outputs.filter(x => /\.(ogg|mp3)$/.test(x.file))) {
    const res = staticCheck(join(from, f.file), expects.get(f.file));
    if (res.problems.length) throw new BeepsError('E_VERIFY', `${r.id}: ${f.file}: ${res.problems.join('; ')}`);
  }
  o.hooks?.afterBuild?.(r.id);
  o.hooks?.beforeInstall?.(r.id);
  install(cfg.out, from, outputs, prior?.outputs);
  rmSync(sdir, { recursive: true, force: true });
  return { role: r.role, source: r.sourceRel, inputHash: pl.inputHash, parts: pl.parts, outputs };
}

/**
 * Takes over a lock written by another tool: every output must still hash to what the lock says; then each asset's hash is rewritten
 * in beeps' scheme, with no rendering. Assets whose outputs differ are dropped from the lock, so the build treats them as new.
 */
function adopt(cfg: BuildConfig, lock: Lock, plans: Planned[], toolchain: ReturnType<typeof currentToolchain>, delivery: Record<string, unknown>, check: boolean, log: (s: string) => void): { lock: Lock; adopted: string[] } {
  const assets: Record<string, LockAsset> = {};
  const adopted: string[] = [];
  for (const pl of plans) {
    const a = lock.assets[pl.recipe.id];
    if (!a) continue;
    const bad = a.outputs.filter(f => !existsSync(join(cfg.out, f.file)) || sha256File(join(cfg.out, f.file)).sha256 !== f.sha256);
    if (bad.length) { log(`adopt: ${pl.recipe.id}: ${bad[0].file} does not match the lock; it will be rebuilt`); continue; }
    assets[pl.recipe.id] = { ...a, role: pl.recipe.role, source: pl.recipe.sourceRel, inputHash: pl.inputHash, parts: pl.parts };
    adopted.push(pl.recipe.id);
  }
  // Assets not in this run's plan (--only) keep the foreign entry untouched.
  for (const [id, a] of Object.entries(lock.assets)) if (!(id in assets) && !plans.some(pl => pl.recipe.id === id)) assets[id] = a;
  const next = { ...lock, keyScheme: KEY_SCHEME, delivery, toolchain: { ...toolchain }, assets } as Lock;
  if (!check) writeLock(cfg.lock, next);
  log(`adopted ${adopted.length} of ${plans.length} assets from the ${lock.keyScheme} lock`);
  return { lock: next, adopted };
}
