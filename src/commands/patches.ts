import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { BeepsError } from '../errors.ts';
import { applyBatch } from '../batch.ts';
import { initProject, listPatches, loadPatch, openProject, parseOrThrow, pathsFor, readJsonFile, savePatch, syncPatches } from '../project.ts';
import { contactSheet, renderAndMeasure, type Rendered } from '../render/pipeline.ts';
import { sha256 } from '../hash.ts';
import { kitSeed, readKit } from '../kit.ts';
import { int, outcomeJson, summary, withHost } from './shared.ts';
import { exportRole } from '../export-manifest.ts';
import { CHANNELS_DIFFER, exportPatchOne, exportPatchVariants, staleVariantFiles } from '../export-assets.ts';
import { renderOptions } from '../render/options.ts';
import { notice, noticeField } from '../notices.ts';
import { renderNotices, requireDeclaredVariant, trimNotices, variantNotices } from '../patch-notices.ts';

export function registerPatchCommands(program: Command, io: Io) {
  program.command('init')
    .description('create .agent-beeps/ (project.json, patches/, kit.json, sets/, sessions/, taste/, renders/)')
    .option('--scale <root:mode>', 'project scale, e.g. C:majorPentatonic or A:minor')
    .option('--target <lufs>', 'max momentary loudness target for one-shots', parseFloat)
    .action((opts: { scale?: string; target?: number }) => {
      const [root, mode] = opts.scale?.split(':') ?? [];
      const existing = existsSync(pathsFor(resolve(io.projectDir())).projectFile);
      const p = initProject(io.projectDir(), {
        ...(opts.target !== undefined ? { targetLoudness: opts.target } : {}),
        scale: { ...(root ? { root } : {}), ...(mode ? { mode: mode as never } : {}) },
      });
      // An existing project.json is never rewritten, so an option given now changed nothing: say so rather than echo the old values as if they were new.
      const ignored = existing ? [...(opts.scale ? ['--scale'] : []), ...(opts.target !== undefined ? ['--target'] : [])] : [];
      const notices = ignored.map(option => notice('N_OPTION_IGNORED', { message: `${option} was ignored: ${p.paths.projectFile} already exists and was not rewritten`, requested: option, applied: 'existing project.json' }));
      io.emit({ root: p.paths.root, dir: p.paths.dir, project: p.project, ...(existing ? { existing: true } : {}), ...(ignored.length ? { ignored } : {}), ...noticeField(notices) });
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
    .option('--seed <n>', 'render seed (default: the seed recorded in the kit, else 1)', int)
    .option('--variants', 'render every declared variant')
    .action(async (refs: string[], opts: { seed?: number; variants?: boolean }) => {
      const p = openProject(io.projectDir());
      const patches = refs.map(r => loadPatch(p, r));
      const kit = readKit(p.paths.root);
      const items = patches.flatMap(patch => {
        const n = opts.variants ? patch.variation?.variants ?? 1 : 1;
        return Array.from({ length: n }, (_, variant) => ({ patch, seed: opts.seed ?? kitSeed(kit, patch.name) ?? 1, variant }));
      });
      const out = await withHost(host => renderAndMeasure(host, items, renderOptions(p)));
      // Scale-snap notices ride on a patch's first render only; the variants share the same pitches.
      const renders = out.map(o => (o.ok ? { ...outcomeJson(o), ...noticeField(o.variant === 0 ? renderNotices(o.patch, o.features, p.project.scale) : trimNotices(o.patch.name, o.features)) } : outcomeJson(o)));
      const variantNote = opts.variants ? patches.flatMap(patch => variantNotices(patch, { requested: true })) : [];
      io.emit({ renders, ...noticeField(variantNote) });
      if (out.some(o => !o.ok)) process.exitCode = 1;
    });

  program.command('measure <ref>')
    .description('full measured features of one patch')
    .option('--seed <n>', 'render seed (default: the seed recorded in the kit, else 1)', int)
    .option('--variant <n>', 'variant index', int, 0)
    .action(async (ref: string, opts: { seed?: number; variant: number }) => {
      const p = openProject(io.projectDir());
      const patch = loadPatch(p, ref);
      requireDeclaredVariant(patch, opts.variant);
      const seed = opts.seed ?? kitSeed(readKit(p.paths.root), patch.name) ?? 1;
      const [o] = await withHost(host => renderAndMeasure(host, [{ patch, seed, variant: opts.variant }], renderOptions(p)));
      if (!o.ok) throw new BeepsError('E_RENDER', o.error);
      io.emit({ name: o.patch.name, key: o.key, trimDb: o.trimDb, features: o.features, ...noticeField(renderNotices(o.patch, o.features, p.project.scale)) });
    });

  program.command('look <refs...>')
    .description('look image (waveform + spectrogram + features); several refs make a contact sheet')
    .option('--out <png>', 'where to write the image: a contact sheet for several refs, a copy of the look image for one')
    .option('--seed <n>', 'render seed (default: the seed recorded in the kit, else 1)', int)
    .action(async (refs: string[], opts: { out?: string; seed?: number }) => {
      const p = openProject(io.projectDir());
      const patches = refs.map(r => loadPatch(p, r));
      await withHost(async host => {
        const kit = readKit(p.paths.root);
        const out = await renderAndMeasure(host, patches.map(patch => ({ patch, seed: opts.seed ?? kitSeed(kit, patch.name) ?? 1 })), renderOptions(p));
        const failed = out.find(o => !o.ok);
        if (failed && !failed.ok) throw new BeepsError('E_RENDER', `${failed.patchName}: ${failed.error}`);
        const rendered = out as Rendered[];
        const snap = (r: Rendered) => noticeField(renderNotices(r.patch, r.features, p.project.scale));
        if (rendered.length === 1) {
          // One ref already has its look image beside the render; --out asked for a copy of it at that path, so write one.
          if (opts.out) { mkdirSync(dirname(resolve(opts.out)), { recursive: true }); copyFileSync(rendered[0].lookPath, resolve(opts.out)); }
          io.emit({ ...summary(rendered[0]), ...(opts.out ? { out: resolve(opts.out) } : {}), ...snap(rendered[0]) });
          return;
        }
        const path = resolve(opts.out ?? join(p.paths.renders, `sheet-${sha256(rendered.map(r => r.key).join()).slice(0, 12)}.png`));
        mkdirSync(dirname(path), { recursive: true });
        await contactSheet(host, rendered, rendered.map((r, i) => `${i + 1} · ${r.patch.name}`), path);
        io.emit({ sheet: path, items: rendered.map((r, i) => ({ index: i + 1, ...summary(r), ...snap(r) })) });
      });
    });

  program.command('export <ref>')
    .description('write the loudness-trimmed WAV of a patch: stereo, full render length, unless --channels 1 or --trim-tail. Seed: --seed, else the seed recorded in the kit (only an audition ship records one; kit add does not), else 1')
    .requiredOption('--wav <path>', 'output WAV path')
    .option('--seed <n>', 'render seed (default: the seed recorded in the kit, else 1)', int)
    .option('--variant <n>', 'variant index', int, 0)
    .option('--variants [n]', 'export variants 0..n-1 (default: every declared variant) as <wav-stem>.<i>.wav; the sidecar lists them')
    .option('--manifest', 'write a portable <wav>.json sidecar for game integration')
    .option('--role <role>', 'manifest role: sfx (default), music or ambience; requires --manifest')
    .option('--channels <n>', 'output channels: 2 (default, as rendered) or 1 (identical channels keep their samples exactly; channels that differ are averaged)', int)
    .option('--trim-tail <dBFS>', 'drop the end after the last sample at or above this level (e.g. -60), with a 10 ms fade over the kept quiet samples; trims long effect tails. Default: off', parseFloat)
    .action(async function (this: Command, ref: string, opts: { wav: string; seed?: number; variant: number; variants?: boolean | string; manifest?: boolean; role?: string; channels?: number; trimTail?: number }) {
      const role = exportRole(opts.role, opts.manifest, 'sfx');
      if (opts.channels !== undefined && opts.channels !== 1 && opts.channels !== 2) throw new BeepsError('E_USAGE', '--channels takes 1 or 2');
      if (opts.trimTail !== undefined && !(opts.trimTail < 0 && opts.trimTail >= -120)) throw new BeepsError('E_USAGE', '--trim-tail takes a level in dBFS from -120 to just below 0, e.g. -60');
      const post = { ...(opts.channels === 1 ? { channels: 1 as const } : {}), ...(opts.trimTail !== undefined ? { trimTailDb: opts.trimTail } : {}) };
      const postJson = (r?: { channels: number; identicalChannels?: boolean; trimmedTailSec?: number }): { channels?: number; trimmedTailSec?: number } => {
        if (!r) return {};
        if (r.identicalChannels === false) warnings.push(CHANNELS_DIFFER);
        return { channels: r.channels, ...(r.trimmedTailSec !== undefined ? { trimmedTailSec: r.trimmedTailSec } : {}) };
      };
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
        const replaced = existsSync(dest.replace(/\.wav$/i, '') + '.0.wav');
        const { first, wavs, manifest, posts } = await withHost(host => exportPatchVariants(host, p, patch, { dest, seed, n, role, manifest: !!opts.manifest, post }));
        const postOut = posts.map(postJson);
        const stale = staleVariantFiles(dest, wavs);
        if (stale.length) warnings.push(`${stale.length} earlier variant file${stale.length === 1 ? '' : 's'} beside this export ${stale.length === 1 ? 'was' : 'were'} not rewritten and ${stale.length === 1 ? 'is' : 'are'} out of date: ${stale.map(f => basename(f)).join(', ')} (beeps bundle would list them)`);
        io.emit({ ...summary(first), wav: wavs[0], wavs, ...(posts[0] ? { channels: posts[0].channels, ...(postOut.some(x => 'trimmedTailSec' in x) ? { trimmedTailSec: postOut.map(x => x.trimmedTailSec ?? 0) } : {}) } : {}), ...(manifest ? { manifest } : {}), ...(replaced ? { replaced: true } : {}), ...(stale.length ? { stale } : {}), ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}), ...noticeField([...renderNotices(patch, first.features, p.project.scale), ...variantNotices(patch, { requested: true })]) });
        return;
      }
      requireDeclaredVariant(patch, opts.variant);
      const dest = resolve(opts.wav);
      const replaced = existsSync(dest);
      const { rendered: o, manifest, post: done } = await withHost(host => exportPatchOne(host, p, patch, { dest, seed, variant: opts.variant, role, manifest: !!opts.manifest, post }));
      const extra = postJson(done);
      const stale = staleVariantFiles(dest, []);
      if (stale.length) warnings.push(`${stale.length} variant file${stale.length === 1 ? '' : 's'} from an earlier export sit beside this one: ${stale.map(f => basename(f)).join(', ')} (beeps bundle would list them)`);
      io.emit({ ...summary(o), wav: dest, renderedWav: o.wavPath, ...extra, ...(manifest ? { manifest } : {}), ...(replaced ? { replaced: true } : {}), ...(stale.length ? { stale } : {}), ...(warnings.length ? { warnings } : {}), ...noticeField(renderNotices(patch, o.features, p.project.scale)) });
    });
}
