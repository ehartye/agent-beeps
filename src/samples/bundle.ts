import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { readSampleWav } from '../../runtime/engine/sample-wav.js';
import { BeepsError } from '../errors.ts';
import { canonicalJson } from '../hash.ts';
import { loadPatch, parseOrThrow, type OpenProject, type SyncReport } from '../project.ts';
import type { Patch } from '../schema/patch.ts';
import { parseSamplePreparedReceipt, prepareSampleWav, type SamplePreparedReceipt } from './prepare.ts';
import { patchSampleIds, PREPARED_MAX_FRAMES, readSampleObject, SAMPLE_ID_PATTERN, sampleId, samplePaths, SOURCE_MAX_FRAMES, verifyImmutableFile, writeImmutableFile, type SampleId } from './store.ts';

const Name = z.string().regex(/^[a-z0-9][a-z0-9-]*$/), Id = z.string().regex(SAMPLE_ID_PATTERN);
const ManifestSchema = z.strictObject({
  schema: z.literal('beeps/sample-bundle@1'), includePreparation: z.boolean(),
  patches: z.record(Name, z.strictObject({ file: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
  samples: z.record(Id, z.strictObject({ file: z.string(), sampleRate: z.literal(48000), channels: z.union([z.literal(1), z.literal(2)]), frames: z.number().int().min(1).max(SOURCE_MAX_FRAMES), bytes: z.number().int().min(48).max(44 + SOURCE_MAX_FRAMES * 8) })),
  recipes: z.record(Id, z.strictObject({ file: z.string() })),
});
export type SampleBundleManifest = z.infer<typeof ManifestSchema>;
const jsonBytes = (value: unknown) => Buffer.from(canonicalJson(value) + '\n');
const patchBytes = (patch: Patch) => Buffer.from(JSON.stringify(patch, null, 2) + '\n');
const sameKeys = (a: Iterable<string>, b: Iterable<string>) => canonicalJson([...a].sort()) === canonicalJson([...b].sort());
const fail = (message: string): never => { throw new BeepsError('E_SCHEMA', `invalid sample bundle: ${message}`); };
const objectFile = (id: string) => `samples/${id.slice(7)}.wav`;
const recipeFile = (id: string) => `recipes/${id.slice(7)}.json`;
const patchFile = (name: string) => `patches/${name}.json`;

function parseJson(bytes: Buffer, file: string): unknown {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { return fail(`cannot parse JSON ${file}`); }
}

export function parseSampleBundleManifest(input: unknown): SampleBundleManifest {
  const result = ManifestSchema.safeParse(input);
  if (!result.success) return fail(result.error.issues[0].message);
  const m = result.data;
  if (!Object.keys(m.patches).length) return fail('at least one patch is required');
  for (const [name, entry] of Object.entries(m.patches)) if (entry.file !== patchFile(name)) return fail(`patch file must be ${patchFile(name)}`);
  for (const [id, entry] of Object.entries(m.samples)) {
    if (entry.file !== objectFile(id)) return fail(`sample file must be ${objectFile(id)}`);
    if (entry.bytes !== 44 + entry.frames * entry.channels * 4) return fail(`inconsistent sample metadata for ${id}`);
  }
  for (const [id, entry] of Object.entries(m.recipes)) if (entry.file !== recipeFile(id)) return fail(`recipe file must be ${recipeFile(id)}`);
  if (!m.includePreparation && Object.keys(m.recipes).length) return fail('prepared-only bundles cannot contain recipes');
  return m;
}

/** Inventory without following links; exact files and their parent directories are the whole format. */
function inventory(root: string): { files: string[]; directories: string[] } {
  let info;
  try { info = lstatSync(root); } catch { throw new BeepsError('E_NOT_FOUND', `sample bundle not found: ${root}`); }
  if (!info.isDirectory() || info.isSymbolicLink()) return fail('bundle root must be an ordinary directory');
  const files: string[] = [], directories: string[] = [];
  function walk(relative: string) {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const rel = relative ? `${relative}/${name}` : name, entry = lstatSync(join(root, rel));
      if (entry.isSymbolicLink()) return fail(`symlinks are not allowed: ${rel}`);
      if (entry.isDirectory()) { directories.push(rel); walk(rel); }
      else if (entry.isFile()) files.push(rel);
      else return fail(`nonregular bundle entry: ${rel}`);
    }
  }
  walk(''); return { files, directories };
}

function checkInventory(root: string, expected: Iterable<string>): void {
  const wanted = [...expected], got = inventory(root);
  const directories = new Set(wanted.filter(f => f.includes('/')).map(f => f.split('/')[0]));
  if (!sameKeys(got.files, wanted) || !sameKeys(got.directories, directories)) return fail('file inventory differs from manifest (missing or extra entries)');
}

interface ValidatedBundle { manifest: SampleBundleManifest; files: Map<string, Buffer>; patches: Patch[]; receipts: SamplePreparedReceipt[] }

/** Validates closure and replay identity entirely in memory before destination publication. */
function validateContents(manifest: SampleBundleManifest, files: Map<string, Buffer>): ValidatedBundle {
  const patches = Object.entries(manifest.patches).map(([name, entry]) => {
    const bytes = files.get(entry.file); if (!bytes) return fail(`missing ${entry.file}`);
    if (sampleId(bytes).slice(7) !== entry.sha256) throw new BeepsError('E_VERIFY', `bundle patch hash mismatch: ${name}`);
    const patch = parseOrThrow(parseJson(bytes, entry.file), entry.file);
    if (patch.name !== name) return fail(`patch name does not match manifest: ${name}`);
    return patch;
  });
  const prepared = new Set(patches.flatMap(patchSampleIds)), reachable = new Set<string>(prepared);
  const receipts = Object.entries(manifest.recipes).map(([id, entry]) => {
    const bytes = files.get(entry.file); if (!bytes) return fail(`missing ${entry.file}`);
    const receipt = parseSamplePreparedReceipt(parseJson(bytes, entry.file));
    if (receipt.recipeId !== id) throw new BeepsError('E_VERIFY', `bundle recipe ID mismatch: ${id}`);
    return receipt;
  });
  const reached = new Set<SamplePreparedReceipt>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const receipt of receipts) if (!reached.has(receipt) && reachable.has(receipt.outputId)) {
      reached.add(receipt); reachable.add(receipt.recipe.source); changed = true;
    }
  }
  if (reached.size !== receipts.length) return fail('recipe is outside the selected patch preparation closure');
  if (!sameKeys(reachable, Object.keys(manifest.samples))) return fail('sample dependency closure differs from manifest');
  for (const [id, entry] of Object.entries(manifest.samples)) {
    const bytes = files.get(entry.file); if (!bytes) return fail(`missing ${entry.file}`);
    if (sampleId(bytes) !== id) throw new BeepsError('E_VERIFY', `bundle sample hash mismatch: ${id}`);
    let pcm;
    try { pcm = readSampleWav(bytes, { maxFrames: prepared.has(id as SampleId) ? PREPARED_MAX_FRAMES : SOURCE_MAX_FRAMES }); }
    catch (e) { return fail(`invalid canonical WAV ${id}: ${(e as Error).message}`); }
    if (entry.bytes !== bytes.length || entry.frames !== pcm.frames || entry.channels !== pcm.channels.length || entry.sampleRate !== pcm.sampleRate) return fail(`sample metadata mismatch: ${id}`);
  }
  for (const receipt of receipts) {
    const source = files.get(objectFile(receipt.recipe.source));
    if (!source) return fail(`missing recipe source ${receipt.recipe.source}`);
    const replay = prepareSampleWav(receipt, source);
    const output = files.get(objectFile(receipt.outputId));
    if (!output || !output.equals(replay.wav)) throw new BeepsError('E_VERIFY', `bundle preparation output mismatch: ${receipt.recipeId}`);
  }
  return { manifest, files, patches, receipts };
}

export function readSampleBundle(directory: string): ValidatedBundle {
  const root = resolve(directory), got = inventory(root);
  if (!got.files.includes('samples.json')) return fail('missing samples.json');
  const manifestBytes = readFileSync(join(root, 'samples.json')), manifest = parseSampleBundleManifest(parseJson(manifestBytes, 'samples.json'));
  const expected = ['samples.json', ...Object.values(manifest.patches).map(e => e.file), ...Object.values(manifest.samples).map(e => e.file), ...Object.values(manifest.recipes).map(e => e.file)];
  checkInventory(root, expected);
  const files = new Map<string, Buffer>([['samples.json', manifestBytes]]);
  for (const file of expected) if (file !== 'samples.json') {
    const audio = Object.values(manifest.samples).find(e => e.file === file);
    if (audio && statSync(join(root, file)).size !== audio.bytes) return fail(`sample byte length mismatch: ${file}`);
    files.set(file, readFileSync(join(root, file)));
  }
  return validateContents(manifest, files);
}

export function bundleSamples(project: OpenProject, refs: readonly string[], directory: string, { includePreparation = false } = {}) {
  if (!refs.length) throw new BeepsError('E_USAGE', 'sample bundle requires at least one patch reference');
  const paths = samplePaths(project), patches = refs.map(ref => loadPatch(project, ref)), selected = new Map<string, Patch>();
  for (const patch of patches) {
    if (selected.has(patch.name)) throw new BeepsError('E_CONFLICT', `duplicate bundle patch name: ${patch.name}`);
    selected.set(patch.name, patch);
  }
  const manifest: SampleBundleManifest = { schema: 'beeps/sample-bundle@1', includePreparation, patches: {}, samples: {}, recipes: {} }, files = new Map<string, Buffer>();
  for (const patch of selected.values()) {
    const bytes = patchBytes(patch), file = patchFile(patch.name);
    manifest.patches[patch.name] = { file, sha256: sampleId(bytes).slice(7) }; files.set(file, bytes);
  }
  const prepared = new Set(patches.flatMap(patchSampleIds)), needed = new Set<string>(prepared), allReceipts: SamplePreparedReceipt[] = [];
  if (includePreparation && existsSync(paths.recipes)) for (const name of readdirSync(paths.recipes).sort()) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    const receipt = parseSamplePreparedReceipt(parseJson(readFileSync(join(paths.recipes, name)), name));
    if (`${receipt.recipeId.slice(7)}.json` !== name) throw new BeepsError('E_VERIFY', `stored preparation receipt filename mismatch: ${name}`);
    allReceipts.push(receipt);
  }
  const receipts = new Map<string, SamplePreparedReceipt>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const receipt of allReceipts) if (!receipts.has(receipt.recipeId) && needed.has(receipt.outputId)) {
      receipts.set(receipt.recipeId, receipt); needed.add(receipt.recipe.source); changed = true;
    }
  }
  for (const id of [...needed].sort()) {
    const source = readSampleObject(paths.objects, id, { maxFrames: prepared.has(id as SampleId) ? PREPARED_MAX_FRAMES : SOURCE_MAX_FRAMES });
    const file = objectFile(id); files.set(file, source.wav);
    manifest.samples[id] = { file, sampleRate: source.sampleRate, channels: source.channels, frames: source.frames, bytes: source.bytes };
  }
  for (const [id, receipt] of [...receipts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const file = recipeFile(id); manifest.recipes[id] = { file }; files.set(file, jsonBytes(receipt));
  }
  files.set('samples.json', jsonBytes(manifest));
  validateContents(parseSampleBundleManifest(manifest), files);
  const out = resolve(directory);
  if (existsSync(out)) {
    try {
      checkInventory(out, files.keys());
      for (const [file, bytes] of files) if (!readFileSync(join(out, file)).equals(bytes)) throw new Error('different bytes');
    } catch { throw new BeepsError('E_CONFLICT', `bundle output already exists with different contents: ${out}`, { hint: 'choose a fresh output directory' }); }
    return { out, unchanged: true, manifest };
  }
  mkdirSync(dirname(out), { recursive: true });
  const staged = mkdtempSync(join(dirname(out), '.beeps-sample-bundle-'));
  try {
    for (const [file, bytes] of files) { const target = join(staged, file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes, { flag: 'wx' }); }
    renameSync(staged, out);
  } finally { rmSync(staged, { recursive: true, force: true }); }
  return { out, unchanged: false, manifest };
}

function checkDestinationPath(root: string, path: string): void {
  let current = path;
  while (current !== root) {
    let entry;
    try { entry = lstatSync(current); }
    catch (e) { if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
    if (entry?.isSymbolicLink()) throw new BeepsError('E_VERIFY', `sample sync destination contains a symlink: ${current}`);
    if (entry && (current === path ? !entry.isFile() : !entry.isDirectory())) throw new BeepsError('E_VERIFY', `sample sync destination has an invalid file type: ${current}`);
    const parent = dirname(current); if (parent === current) throw new BeepsError('E_VERIFY', 'sample sync destination escapes project'); current = parent;
  }
}

export function syncSampleBundle(project: OpenProject, directory: string, { dryRun = false } = {}) {
  const bundle = readSampleBundle(directory), paths = samplePaths(project), immutable: { path: string; bytes: Buffer }[] = [];
  for (const [id, entry] of Object.entries(bundle.manifest.samples)) immutable.push({ path: join(paths.objects, `${id.slice(7)}.wav`), bytes: bundle.files.get(entry.file)! });
  for (const receipt of bundle.receipts) immutable.push({ path: join(paths.recipes, `${receipt.recipeId.slice(7)}.json`), bytes: jsonBytes(receipt) });
  const report: SyncReport = { from: resolve(directory), dryRun, added: [], updated: [], unchanged: [] }, patchWrites: { path: string; bytes: Buffer }[] = [];
  for (const file of immutable) { checkDestinationPath(project.paths.dir, file.path); verifyImmutableFile(file.path, file.bytes); }
  for (const patch of bundle.patches) {
    const path = join(project.paths.patches, `${patch.name}.json`), bytes = patchBytes(patch); checkDestinationPath(project.paths.dir, path);
    const previous = existsSync(path) ? readFileSync(path) : undefined;
    (previous === undefined ? report.added : previous.equals(bytes) ? report.unchanged : report.updated).push(patch.name);
    if (!previous?.equals(bytes)) patchWrites.push({ path, bytes });
  }
  if (!dryRun) {
    for (const file of immutable) writeImmutableFile(file.path, file.bytes);
    for (const file of patchWrites) { mkdirSync(dirname(file.path), { recursive: true }); writeFileSync(file.path, file.bytes); }
  }
  for (const key of ['added', 'updated', 'unchanged'] as const) report[key].sort();
  return { ...report, samples: Object.keys(bundle.manifest.samples).sort(), recipes: Object.keys(bundle.manifest.recipes).sort() };
}
