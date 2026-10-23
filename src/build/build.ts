// `beeps build`: render + export + compress + bundle only the assets whose input hash differs from the committed lock, or whose
// outputs are missing or no longer match it. Everything else is left byte for byte alone.
import { samplePaths } from '../samples/store.ts';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BeepsError } from '../errors.ts';
import { canonicalJson } from '../hash.ts';
import { bundleDir, catalogText } from '../bundle.ts';
import { compressBundle, ffmpegFingerprint, findFfmpeg } from '../compress.ts';
import { CHANNELS_DIFFER, exportPatchVariants, exportSongAssets } from '../export-assets.ts';
import { evaluateExpectations, type ExpectationReport } from '../expect.ts';
import { renderWithExpectations } from '../expect-run.ts';
import { ExportManifestSchema } from '../export-manifest.ts';
import { loadPatch, openProject, pathsFor, type OpenProject } from '../project.ts';
import { loadSong } from '../music.ts';
import { hostScope, type RenderHost } from '../render/host.ts';
import { mapPool } from '../pool.ts';
import { parseProject } from '../schema/project.ts';
import { renderAndMeasure } from '../render/pipeline.ts';
import { makeCue, wantsBaked, wantsRuntime } from '../runtime/cue.ts';
import { cueSources, writeCueDelivery, readDeliveredFile } from '../runtime/delivery.ts';
import { validateDeliveredAsset } from '../runtime/inventory.ts';
import { assertOutputNames, isDeliveredSampleFile, isDeliveredCueFile, sampleFile } from '../runtime/dependencies.ts';
import { deliveryFor, loadRecipes, type BuildConfig, type Delivery } from './config.ts';
import { atomicWrite, currentToolchain, deliveryRecord, emptyLock, KEY_SCHEME, readLock, writeLock, type Lock, type LockAsset } from './lock.ts';
import { planAsset, type Encoder, type Planned } from './plan.ts';
import { packAsset, sha256Hex, storeName, unpackAsset, type OutputRef, type Store } from './store.ts';
import { sidecarExpectations, staticCheck } from './verify.ts';
import { renderOptions } from '../render/options.ts';

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
  /**
   * Rewrite a lock another tool wrote (keyScheme other than beeps-input@1) into beeps' scheme, with no rendering, when its outputs verify.
   * Also re-keys a lock of this scheme whose toolchain (engine, pipelines, Chromium, Playwright) differs: the locked outputs are kept
   * as they are, which is right when the change cannot alter them and a statement of trust when it might (see docs/build-lock-and-store.md).
   */
  adopt?: boolean;
  /** Allow a build when the toolchain or encoder differs from the lock's (this re-renders and re-encodes whatever the store lacks). */
  allowToolchainChange?: boolean;
  /** Render every song twice and fail the asset (E_NONDETERMINISTIC) when the two renders differ in any sample. Doubles song render time; cached renders are not repeated. */
  verifyDeterminism?: boolean;
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
  /** What an export or a post-processing step said while building (a song layer that does not sum, channels that differ). Also logged as they happen. */
  warnings?: string[];
}

const prefer = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A JSON inventory contains own entries; a valid id such as constructor may name an inherited method. */
function lockedAsset(lock: Lock | undefined, id: string): LockAsset | undefined {
  return lock && Object.hasOwn(lock.assets, id) ? lock.assets[id] : undefined;
}

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
  try { validateDeliveredAsset(plan.recipe.id, { ...entry, delivery: plan.ships }, file => readDeliveredFile(out, file)); }
  catch (e) {
    const message = (e as Error).message;
    const file = entry.outputs.find(o => message === `${o.file} is missing` || message === `${o.file} does not match the lock`)?.file;
    reasons.push(file ? `output ${message.endsWith(' is missing') ? 'missing' : 'modified'}: ${file}` : `output invalid: ${message}`);
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

/** Select only owned reserved sources and canonical owner cues for retirement. */
function retirementFiles(owner: string, previous: readonly OutputRef[], keep: readonly OutputRef[] = []): string[] {
  assertOutputNames(previous);
  const kept = new Set(keep.map(o => o.file));
  // A corrupt/missing old cue cannot authorize deletion. The canonical output byte
  // hash is its source ID, so re-derive the exact owner/content name from the lock.
  return previous.filter(o => {
    if (kept.has(o.file)) return false;
    if (isDeliveredSampleFile(o.file)) return o.file === sampleFile(owner, `sha256:${o.sha256}`);
    if (isDeliveredCueFile(o.file)) return o.file === `${owner}.runtime.json`;
    return true;
  }).map(o => o.file);
}

/** Copies staged outputs atomically per file, then retires previously owned outputs. */
function install(owner: string, out: string, stage: string, outputs: OutputRef[], previous: OutputRef[] | undefined): void {
  assertOutputNames(outputs);
  const retire = retirementFiles(owner, previous ?? [], outputs);
  mkdirSync(out, { recursive: true });
  for (const o of outputs) {
    const dest = join(out, o.file);
    const current = readDeliveredFile(out, o.file);
    if (current && current.length === o.bytes && sha256Hex(current) === o.sha256) continue;
    atomicWrite(dest, readFileSync(join(stage, o.file)));
  }
  for (const file of retire) rmSync(join(out, file), { force: true });
}

export async function runBuild(cfg: BuildConfig, o: BuildOptions = {}): Promise<BuildReport> {
  const t0 = Date.now(), log = o.log ?? (() => {});
  const all = loadRecipes(cfg);
  if (o.only) for (const id of o.only) if (!all.some(r => r.id === id)) throw new BeepsError('E_USAGE', `--only: no recipe "${id}"`, { hint: `recipes: ${all.slice(0, 8).map(r => r.id).join(', ')}${all.length > 8 ? ', ...' : ''}` });
  const recipes = o.only ? all.filter(r => o.only!.includes(r.id)) : all;
  const warnings: string[] = [];
  const warn = (s: string) => { warnings.push(s); log(s); };
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
  } else if (lock && o.adopt) {
    // A lock in beeps' scheme made by an older toolchain: keep its outputs under the new toolchain's hashes, with no rendering.
    const drift = driftOf(lock, toolchain as unknown as Record<string, unknown>, deliveryRec);
    const tool = drift.filter(d => d.startsWith('toolchain.')), other = drift.filter(d => !d.startsWith('toolchain.'));
    if (other.length) throw new BeepsError('E_LOCK', `--adopt keeps the lock's outputs, which were encoded another way:\n  ${other.slice(0, 6).join('\n  ')}`, { hint: "the delivery or encoder differs from the lock's: rebuild instead (--allow-toolchain-change), or restore the settings and the ffmpeg the lock names", details: { drift: other } });
    if (!tool.length) log("--adopt: the lock is already in beeps' scheme and its toolchain matches");
    else {
      log(`--adopt: keeping the locked outputs under the new toolchain (nothing is re-rendered):\n  ${tool.join('\n  ')}`);
      const a = adopt(cfg, lock, plans, toolchain, deliveryRec, o.check ?? false, log);
      lock = a.lock; adopted = a.adopted;
    }
  }

  const drift = driftOf(lock, toolchain as unknown as Record<string, unknown>, deliveryRec);
  const next: Lock = lock ? { ...lock, assets: { ...lock.assets } } : emptyLock(deliveryRec, toolchain);

  // Stale = new, changed inputs, or outputs missing/modified.
  const stale: StaleAsset[] = [];
  const unchanged: string[] = [];
  for (const pl of plans) {
    const reasons = staleReasons(pl, lockedAsset(lock, pl.recipe.id), cfg.out, !!o.all);
    if (reasons.length) stale.push({ id: pl.recipe.id, reasons }); else unchanged.push(pl.recipe.id);
  }
  const removed = !o.only && lock ? Object.keys(lock.assets).filter(id => !recipes.some(r => r.id === id)) : [];
  for (const id of removed) stale.push({ id, reasons: ['removed from the recipes: its outputs and lock entry will be deleted'] });

  const estimate = estimateBytes(plans, lock, delivery, deliveryRec);
  const catalogDrift = catalogDriftOf(cfg.out, unchanged.length === plans.length);
  const driftLines = [...(stale.length ? [] : drift), ...catalogDrift];
  const report = (over: Partial<BuildReport>): BuildReport => ({
    ok: true, config: cfg.file, target: cfg.target, lock: cfg.lock, out: cfg.out, total: plans.length,
    unchanged, built: [], pulled: [], adopted, removed: [], pushed: [], stale: [], drift: driftLines, catalogWritten: false, estimate,
    seconds: Math.round((Date.now() - t0) / 100) / 10, ...(warnings.length ? { warnings } : {}), ...over,
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
      const id = pl.recipe.id, prior = lockedAsset(lock, id);
      const bytes = await o.store.get(storeName(pl.inputHash));
      if (!bytes) continue;
      const expectOutputs = prior && prior.inputHash === pl.inputHash ? prior.outputs : undefined;
      const { manifest, files } = unpackAsset(bytes, { inputHash: pl.inputHash, outputs: expectOutputs });
      if (manifest.id !== id) throw new BeepsError('E_STORE', `store entry owner ${manifest.id} does not match ${id}`);
      validateDeliveredAsset(id, { outputs: manifest.outputs, delivery: pl.ships }, file => files.get(file));
      if (expectOutputs) validateDeliveredAsset(id, { outputs: expectOutputs, delivery: pl.ships }, file => files.get(file));
      const sdir = join(stage, `${id}.pull`);
      rmSync(sdir, { recursive: true, force: true }); mkdirSync(sdir, { recursive: true });
      for (const [f, data] of files) atomicWrite(join(sdir, f), data);
      o.hooks?.beforeInstall?.(id);
      install(id, cfg.out, sdir, manifest.outputs, prior?.outputs);
      rmSync(sdir, { recursive: true, force: true });
      commit(id, { role: pl.recipe.role, source: pl.recipe.sourceRel, inputHash: pl.inputHash, parts: pl.parts, outputs: manifest.outputs, ...(pl.ships !== 'baked' ? { delivery: pl.ships } : {}) });
      o.hooks?.afterInstall?.(id);
      todo.delete(id); pulled.push(id);
      log(`pulled ${id}`);
    }
  }

  // 2. What is left has to be rendered. A toolchain or encoder change re-renders whatever the store lacks: say so first.
  const toBuild = [...todo.values()].filter(pl => !removed.includes(pl.recipe.id));
  // Only the toolchain and the encoder build are guarded: a bitrate, preset or format change is a deliberate edit of beeps.build.json.
  const risky = drift.filter(d => d.startsWith('toolchain.') || /^delivery\.encoder\.(ffmpeg|libavcodec):/.test(d));
  if (toBuild.length && risky.length && lock && !o.allowToolchainChange && !o.all) {
    throw new BeepsError('E_TOOLCHAIN', `the toolchain or encoder differs from the lock's, so ${toBuild.length} asset(s) are stale and would be re-rendered or re-encoded:\n  ${drift.slice(0, 8).join('\n  ')}`, {
      hint: 'pull them from the store (--pull --store ...), or pass --allow-toolchain-change to rebuild on purpose', details: { drift },
    });
  }

  if (toBuild.length) {
    mkdirSync(stage, { recursive: true });
    // One lazily opened browser per worker: an asset whose renders are all cached never starts one. A failure stops the pool claiming
    // assets, lets the ones in flight finish (their installs are already committed), and is thrown after every browser has closed.
    await mapPool(toBuild, o.jobs ?? cfg.jobs, async (pl, _i, host) => {
      const t = Date.now();
      const entry = await buildOne(host, p, cfg, pl, delivery, stage, lockedAsset(lock, pl.recipe.id), o, log, warn);
      commit(pl.recipe.id, entry);
      o.hooks?.afterInstall?.(pl.recipe.id);
      built.push(pl.recipe.id);
      log(`built ${pl.recipe.id} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
      if (o.push && o.store) {
        const name = storeName(pl.inputHash);
        const res = await o.store.put(name, packAsset(pl.recipe.id, pl.inputHash, entry.outputs, f => readFileSync(join(cfg.out, f))));
        if (res === 'stored') pushed.push(pl.recipe.id);
      }
    }, hostScope({ verifyDeterminism: o.verifyDeterminism }));
  }
  // 2b. Expectations are not part of an asset's input hash (editing one must not re-bake it), so an asset that was not rebuilt is judged here,
  // from its cached render when there is one. Without this, tightening a brief on a built sound would pass the build until the sound next changed.
  const rebuilt = new Set(toBuild.map(pl => pl.recipe.id));
  const unbuilt = plans.filter(pl => pl.recipe.kind === 'patch' && !rebuilt.has(pl.recipe.id) && !removed.includes(pl.recipe.id))
    .map(pl => ({ pl, patch: loadPatch(p, pl.recipe.source) })).filter(x => x.patch.xExpect);
  const unmet: BeepsError[] = [];
  if (unbuilt.length) {
    await mapPool(unbuilt, o.jobs ?? cfg.jobs, async ({ pl, patch }, _i, host) => {
      const { expectations } = await renderWithExpectations(host, [{ patch, seed: pl.recipe.seed }], renderOptions(p));
      if (expectations[0] && !expectations[0].passed) unmet.push(expectationFailure(pl.recipe.id, expectations[0]));
    }, hostScope({ verifyDeterminism: false }));
    if (unmet.length) {
      throw new BeepsError('E_VERIFY', `${unmet.length} asset${unmet.length === 1 ? '' : 's'} that did not need rebuilding no longer meet their expectations: ${unmet.map(e => e.message).join(' | ')}`, {
        hint: unmet[0].hint, details: { assets: unmet.map(e => ({ message: e.message, ...e.details })) },
      });
    }
  }
  rmSync(stage, { recursive: true, force: true });

  // 3. Assets removed from the recipes.
  for (const id of removed) {
    for (const file of retirementFiles(id, lock!.assets[id].outputs)) rmSync(join(cfg.out, file), { force: true });
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

function estimateBytes(plans: Planned[], lock: Lock | undefined, delivery: Delivery, deliveryRec: Record<string, unknown>): BuildReport['estimate'] {
  let total = 0, fresh = 0;
  const oldKbps = (lock?.delivery.kbps ?? {}) as Record<string, number>;
  const encodingIdentity = ({ kbps: _rates, preset: _preset, ...encoding }: Record<string, unknown>) => canonicalJson(encoding);
  const sameEncoding = !!lock && encodingIdentity(lock.delivery) === encodingIdentity(deliveryRec);
  for (const pl of plans) {
    const prior = lockedAsset(lock, pl.recipe.id);
    if (!prior) { total += pl.estimateBytes; fresh++; continue; }
    // Locked bytes describe the old content and delivery mode. Source, duration,
    // export or mode changes must budget the current plan before replacing anything.
    const sameContent = prior.parts && (['renders', 'export', 'runtime', 'toolchain'] as const).every(k => prior.parts![k] === pl.parts[k]);
    if (prior.inputHash !== pl.inputHash && !(sameContent && sameEncoding)) { total += pl.estimateBytes; continue; }
    const fixed = prior.outputs.filter(f => !/\.(ogg|mp3)$/.test(f.file)).reduce((s, f) => s + f.bytes, 0);
    const encoded = prior.outputs.filter(f => /\.(ogg|mp3)$/.test(f.file)).reduce((s, f) => s + f.bytes, 0);
    // Only encoded baked audio scales: canonical sources, cues and sidecars stay fixed.
    const was = oldKbps[pl.recipe.role], now = delivery.kbps?.[pl.recipe.role];
    total += fixed + (was && now && was !== now ? Math.ceil(encoded * now / was) : encoded);
  }
  // Assets outside --only still count against the budget at their locked size.
  if (lock) for (const [id, a] of Object.entries(lock.assets)) if (!plans.some(pl => pl.recipe.id === id)) total += a.outputs.reduce((s, f) => s + f.bytes, 0);
  return { totalBytes: total, newAssets: fresh, basis: 'locked bytes for unchanged assets, scaling only encoded audio for bitrate-only changes; current duration x bitrate x 1.1 plus runtime sources and cue bytes for new or changed assets' };
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

/** A patch whose declared expectations fail does not ship: the build is the regression test for its contract. */
function requireExpectations(id: string, report: ExpectationReport): void {
  if (!report.passed) throw expectationFailure(id, report);
}

/** The E_VERIFY for one asset whose expectations are not met: what failed, by how much, and which entry to edit. */
function expectationFailure(id: string, report: ExpectationReport): BeepsError {
  const failing = report.checks.filter(c => c.outcome !== 'pass');
  const unrendered = report.unrendered?.length ? `; variant${report.unrendered.length === 1 ? '' : 's'} ${report.unrendered.join(', ')} did not render` : '';
  return new BeepsError('E_VERIFY', `${id}: ${failing.length} expectation${failing.length === 1 ? '' : 's'} not met (${failing.map(c => `${c.kind}${c.variant !== undefined ? ` on variant ${c.variant}` : ''} ${c.outcome === 'unmeasurable' ? 'unmeasurable' : `${c.actual}${c.unit ? ` ${c.unit}` : ''} vs ${JSON.stringify(c.expected)}`}`).join('; ')}${unrendered})`, {
    ...(failing[0] ? { pointer: failing[0].pointer } : {}), hint: failing[0]?.hint ?? 'run beeps lint on the patch for the full verdict', details: { expectations: report },
  });
}

/** Exports, compresses and verifies one asset into a staging directory, installs it, and returns its lock entry. */
async function buildOne(host: RenderHost, p: OpenProject, cfg: BuildConfig, pl: Planned, delivery: ReturnType<typeof deliveryFor>, stage: string, prior: LockAsset | undefined, o: BuildOptions, log: (s: string) => void, warn: (s: string) => void): Promise<LockAsset> {
  const r = pl.recipe;
  const sdir = join(stage, r.id), wavDir = join(sdir, 'wav'), outDir = join(sdir, 'out');
  rmSync(sdir, { recursive: true, force: true });
  mkdirSync(wavDir, { recursive: true });
  const baked = wantsBaked(pl.ships);
  let from = wavDir;
  let trimDb: number | undefined;
  if (baked) {
    const wav = join(wavDir, `${r.id}.wav`);
    if (r.kind === 'patch') {
      const authored = loadPatch(p, r.source);
      const ex = await exportPatchVariants(host, p, authored, { dest: wav, seed: r.seed, n: pl.variants, role: r.role, manifest: true, manifestId: r.id, post: { channels: r.channels, trimTailDb: r.trimTailDb } });
      trimDb = ex.first.trimDb;
      requireExpectations(r.id, evaluateExpectations(authored, ex.rendered.map(x => x.features)));
      if (ex.posts.some(post => post?.identicalChannels === false)) warn(`${r.id}: ${CHANNELS_DIFFER}`);
    } else {
      const out = await exportSongAssets(host, p, loadSong(p, r.source), { dest: wav, role: r.role, manifest: true, manifestId: r.id, layers: pl.layers });
      for (const w of out.warnings) warn(`${r.id}: ${w}`);
    }
    const side = ExportManifestSchema.parse(JSON.parse(readFileSync(`${wav}.json`, 'utf8')));
    if (side.id !== r.id) throw new BeepsError('E_SCHEMA', `recipe "${r.id}" exported asset id "${side.id}": delivery identity mismatch`, { hint: 'the shared exporter must write the recipe id into the baked sidecar' });

    if (delivery.format !== 'wav') {
      const k = delivery.kbps!;
      const c = compressBundle(wavDir, outDir, { format: delivery.format, kbps: { music: k.music, ambience: k.ambience, sfx: k.sfx, mix: k.mix } });
      if (c.problems.length) throw new BeepsError('E_VERIFY', `${r.id}: encoded audio does not verify: ${c.problems.flatMap(x => x.problems.map(m => `${x.file}: ${m}`)).join('; ')}`, { details: { problems: c.problems } });
      from = outDir;
    }
  } else {
    // Runtime only: nothing is exported or encoded. The one render is the trim measurement (a cache hit when the patch was baked before).
    const patch = loadPatch(p, r.source);
    if (patch.name !== r.id) throw new BeepsError('E_SCHEMA', `recipe "${r.id}" is the patch "${patch.name}": rename the patch "name" to "${r.id}"`, { hint: 'the cue file and the game look the sound up by the patch name' });
    const [m] = await renderAndMeasure(host, [{ patch, seed: r.seed, variant: 0 }], renderOptions(p));
    if (!m.ok) throw new BeepsError('E_RENDER', m.error);
    trimDb = m.trimDb;
    requireExpectations(r.id, evaluateExpectations(patch, [m.features]));
  }
  if (wantsRuntime(pl.ships)) {
    const patch = loadPatch(p, r.source);
    if (patch.name !== r.id) throw new BeepsError('E_SCHEMA', `recipe "${r.id}" is the patch "${patch.name}": rename the patch "name" to "${r.id}"`, { hint: 'the cue file and the game look the sound up by the patch name' });
    mkdirSync(from, { recursive: true });
    const sources = cueSources(patch, r.id, samplePaths(p).objects);
    writeCueDelivery(from, makeCue(patch, p.project, r.seed, trimDb!, sources.assets), sources);
  }
  const outputs = listOutputs(from);
  if (baked) {
    // Cheap static checks of what was just encoded (headers, tag, encoder id, length), over and above compress's decode verification.
    const sidecarOut = outputs.find(f => /.(wav|ogg|mp3).json$/.test(f.file))!;
    const sc = ExportManifestSchema.parse(JSON.parse(readFileSync(join(from, sidecarOut.file), 'utf8')));
    const expects = sidecarExpectations(sidecarOut.file, sc);
    for (const f of outputs.filter(x => /.(ogg|mp3)$/.test(x.file))) {
      const res = staticCheck(join(from, f.file), expects.get(f.file));
      if (res.problems.length) throw new BeepsError('E_VERIFY', `${r.id}: ${f.file}: ${res.problems.join('; ')}`);
    }
  }
  o.hooks?.afterBuild?.(r.id);
  o.hooks?.beforeInstall?.(r.id);
  install(r.id, cfg.out, from, outputs, prior?.outputs);
  rmSync(sdir, { recursive: true, force: true });
  return { role: r.role, source: r.sourceRel, inputHash: pl.inputHash, parts: pl.parts, outputs, ...(pl.ships !== 'baked' ? { delivery: pl.ships } : {}) };
}

/**
 * Takes over a lock written by another tool: every output must still hash to what the lock says; then each asset's hash is rewritten
 * in beeps' scheme, with no rendering. Assets whose outputs differ are dropped from the lock, so the build treats them as new.
 */
function adopt(cfg: BuildConfig, lock: Lock, plans: Planned[], toolchain: ReturnType<typeof currentToolchain>, delivery: Record<string, unknown>, check: boolean, log: (s: string) => void): { lock: Lock; adopted: string[] } {
  const assets: Record<string, LockAsset> = {};
  const adopted: string[] = [];
  for (const pl of plans) {
    const a = lockedAsset(lock, pl.recipe.id);
    if (!a) continue;
    try { validateDeliveredAsset(pl.recipe.id, { ...a, delivery: pl.ships }, file => readDeliveredFile(cfg.out, file)); }
    catch (e) { log(`adopt: ${pl.recipe.id}: ${(e as Error).message}; it will be rebuilt`); continue; }
    assets[pl.recipe.id] = { ...a, role: pl.recipe.role, source: pl.recipe.sourceRel, inputHash: pl.inputHash, parts: pl.parts, ...(pl.ships !== 'baked' ? { delivery: pl.ships } : {}) };
    adopted.push(pl.recipe.id);
  }
  // Assets not in this run's plan (--only) keep the foreign entry untouched.
  for (const [id, a] of Object.entries(lock.assets)) if (!Object.hasOwn(assets, id) && !plans.some(pl => pl.recipe.id === id)) assets[id] = a;
  const next = { ...lock, keyScheme: KEY_SCHEME, delivery, toolchain: { ...toolchain }, assets } as Lock;
  if (!check) writeLock(cfg.lock, next);
  log(`adopted ${adopted.length} of ${plans.length} assets from the ${lock.keyScheme} lock`);
  return { lock: next, adopted };
}
