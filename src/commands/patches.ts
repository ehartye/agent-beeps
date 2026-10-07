import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { BeepsError } from '../errors.ts';
import { applyBatch } from '../batch.ts';
import { initProject, listPatches, loadPatch, openProject, parseOrThrow, readJsonFile, savePatch, syncPatches } from '../project.ts';
import { contactSheet, renderAndMeasure, type Rendered } from '../render/pipeline.ts';
import { sha256 } from '../hash.ts';
import { readKit } from '../kit.ts';
import { int, outcomeJson, summary, withHost } from './shared.ts';
import { exportRole } from '../export-manifest.ts';
import { exportPatchOne, exportPatchVariants } from '../export-assets.ts';

export function registerPatchCommands(program: Command, io: Io) {
  program.command('init')
    .description('create .agent-beeps/ (project.json, patches/, kit.json, sets/, sessions/, taste/, renders/)')
    .option('--scale <root:mode>', 'project scale, e.g. C:majorPentatonic or A:minor')
    .option('--target <lufs>', 'max momentary loudness target for one-shots', parseFloat)
    .action((opts: { scale?: string; target?: number }) => {
      const [root, mode] = opts.scale?.split(':') ?? [];
      const p = initProject(io.projectDir(), {
        ...(opts.target !== undefined ? { targetLoudness: opts.target } : {}),
        scale: { ...(root ? { root } : {}), ...(mode ? { mode: mode as never } : {}) },
      });
      io.emit({ root: p.paths.root, dir: p.paths.dir, project: p.project });
    });

  program.command('list')
    .description('list project patches')
    .action(() => {
      const p = openProject(io.projectDir());
      io.emit({ patches: listPatches(p).map(x => ({ name: x.name, family: x.family, archetype: x.archetype ?? null, tags: x.tags, layers: x.layers.length })) });
    });

  program.command('new <file>')
    .description('validate a patch JSON file and save it to .agent-beeps/patches/<name>.json (to mirror a whole directory of committed patches, use sync)')
    .option('--force', 'replace an existing patch of the same name')
    .action((file: string, opts: { force?: boolean }) => {
      const p = openProject(io.projectDir());
      const patch = parseOrThrow(readJsonFile(file), file);
      io.emit({ saved: savePatch(p, patch, { force: !!opts.force }), name: patch.name });
    });

  program.command('sync <dir>')
    .description('mirror a directory of patch .json files (e.g. the ones your repo commits) into .agent-beeps/patches/: adds new names, replaces changed ones, validates every file before writing any; kit add, kit check and lint then take the names')
    .option('--dry-run', 'report what would be added or updated without writing')
    .action((dir: string, opts: { dryRun?: boolean }) => {
      io.emit(syncPatches(openProject(io.projectDir()), dir, { dryRun: !!opts.dryRun }));
    });

  program.command('batch <opsFile>')
    .description('apply create/set/remove/delete operations to project patches atomically')
    .option('--dry-run', 'validate every operation without writing')
    .action((opsFile: string, opts: { dryRun?: boolean }) => {
      const p = openProject(io.projectDir());
      io.emit(applyBatch(p, readJsonFile(opsFile), { dryRun: !!opts.dryRun }));
    });

  program.command('render <refs...>')
    .description('render, loudness-trim and measure patches (names, set candidate names, or .json paths)')
    .option('--seed <n>', 'render seed', int, 1)
    .option('--variants', 'render every declared variant')
    .action(async (refs: string[], opts: { seed: number; variants?: boolean }) => {
      const p = openProject(io.projectDir());
      const patches = refs.map(r => loadPatch(p, r));
      const items = patches.flatMap(patch => {
        const n = opts.variants ? patch.variation?.variants ?? 1 : 1;
        return Array.from({ length: n }, (_, variant) => ({ patch, seed: opts.seed, variant }));
      });
      const out = await withHost(host => renderAndMeasure(host, items, { project: p.project, rendersDir: p.paths.renders }));
      io.emit({ renders: out.map(outcomeJson) });
      if (out.some(o => !o.ok)) process.exitCode = 1;
    });

  program.command('measure <ref>')
    .description('full measured features of one patch')
    .option('--seed <n>', 'render seed', int, 1)
    .option('--variant <n>', 'variant index', int, 0)
    .action(async (ref: string, opts: { seed: number; variant: number }) => {
      const p = openProject(io.projectDir());
      const [o] = await withHost(host => renderAndMeasure(host, [{ patch: loadPatch(p, ref), seed: opts.seed, variant: opts.variant }], { project: p.project, rendersDir: p.paths.renders }));
      if (!o.ok) throw new BeepsError('E_RENDER', o.error);
      io.emit({ name: o.patch.name, key: o.key, trimDb: o.trimDb, features: o.features });
    });

  program.command('look <refs...>')
    .description('look image (waveform + spectrogram + features); several refs make a contact sheet')
    .option('--out <png>', 'where to write a contact sheet')
    .option('--seed <n>', 'render seed', int, 1)
    .action(async (refs: string[], opts: { out?: string; seed: number }) => {
      const p = openProject(io.projectDir());
      const patches = refs.map(r => loadPatch(p, r));
      await withHost(async host => {
        const out = await renderAndMeasure(host, patches.map(patch => ({ patch, seed: opts.seed })), { project: p.project, rendersDir: p.paths.renders });
        const failed = out.find(o => !o.ok);
        if (failed && !failed.ok) throw new BeepsError('E_RENDER', `${failed.patchName}: ${failed.error}`);
        const rendered = out as Rendered[];
        if (rendered.length === 1) { io.emit(summary(rendered[0])); return; }
        const path = resolve(opts.out ?? join(p.paths.renders, `sheet-${sha256(rendered.map(r => r.key).join()).slice(0, 12)}.png`));
        mkdirSync(dirname(path), { recursive: true });
        await contactSheet(host, rendered, rendered.map((r, i) => `${i + 1} · ${r.patch.name}`), path);
        io.emit({ sheet: path, items: rendered.map((r, i) => ({ index: i + 1, ...summary(r) })) });
      });
    });

  program.command('export <ref>')
    .description('write the loudness-trimmed WAV of a patch (kit sounds default to the seed the owner auditioned)')
    .requiredOption('--wav <path>', 'output WAV path')
    .option('--seed <n>', 'render seed (default: the seed recorded in the kit, else 1)', int)
    .option('--variant <n>', 'variant index', int, 0)
    .option('--variants [n]', 'export variants 0..n-1 (default: every declared variant) as <wav-stem>.<i>.wav; the sidecar lists them')
    .option('--manifest', 'write a portable <wav>.json sidecar for game integration')
    .option('--role <role>', 'manifest role: sfx (default), music or ambience; requires --manifest')
    .action(async function (this: Command, ref: string, opts: { wav: string; seed?: number; variant: number; variants?: boolean | string; manifest?: boolean; role?: string }) {
      const role = exportRole(opts.role, opts.manifest, 'sfx');
      const p = openProject(io.projectDir());
      const patch = loadPatch(p, ref);
      const kitEntry = readKit(p.paths.root).sounds.find(s => s.name === ref);
      const seed = opts.seed ?? kitEntry?.seed ?? 1;
      const warnings: string[] = [];
      const metaPriority = patch.meta?.priority ?? 3;
      if (kitEntry && kitEntry.priority !== metaPriority) {
        warnings.push(`kit priority (${kitEntry.priority}) differs from meta.priority (${metaPriority}); the sidecar uses meta.priority`);
      }
      if (opts.variants !== undefined) {
        if (this.getOptionValueSource('variant') === 'cli') throw new BeepsError('E_USAGE', '--variant and --variants cannot be combined');
        const n = opts.variants === true ? (patch.variation?.variants ?? 1) : Number(opts.variants);
        if (!Number.isInteger(n) || n < 1 || n > 16) throw new BeepsError('E_USAGE', '--variants takes a count from 1 to 16');
        const declared = patch.variation?.variants ?? 1;
        if (n > declared) warnings.push(`--variants ${n} exceeds the patch's declared ${declared} variant(s)`);
        const dest = resolve(opts.wav);
        const { first, wavs, manifest } = await withHost(host => exportPatchVariants(host, p, patch, { dest, seed, n, role, manifest: !!opts.manifest }));
        io.emit({ ...summary(first), wav: wavs[0], wavs, ...(manifest ? { manifest } : {}), ...(warnings.length ? { warnings } : {}) });
        return;
      }
      const dest = resolve(opts.wav);
      const { rendered: o, manifest } = await withHost(host => exportPatchOne(host, p, patch, { dest, seed, variant: opts.variant, role, manifest: !!opts.manifest }));
      io.emit({ ...summary(o), wav: dest, renderedWav: o.wavPath, ...(manifest ? { manifest } : {}), ...(warnings.length ? { warnings } : {}) });
    });
}
