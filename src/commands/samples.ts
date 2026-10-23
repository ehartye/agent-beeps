import { existsSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { BeepsError } from '../errors.ts';
import { requireSafeOutput } from '../path-safety.ts';
import { openProject, parseOrThrow, readJsonFile, savePatch } from '../project.ts';
import { importSample, parseSamplePrep, parseSamplePreparedReceipt, prepareSample, prepareSampleWav } from '../samples/prepare.ts';
import { readSampleObject, samplePaths, SOURCE_MAX_FRAMES } from '../samples/store.ts';
import { bundleSamples, syncSampleBundle } from '../samples/bundle.ts';
import { runOverview } from '../samples/overview-run.ts';

interface PrepareOptions { recipe?: string; start?: string; end?: string; fadeIn?: string; fadeOut?: string; gain?: string; name?: string; family?: string; force?: boolean }
const number = (text: string, label: string) => {
  if (!text.trim() || !Number.isFinite(Number(text))) throw new BeepsError('E_SCHEMA', `${label} must be a finite number`);
  return Number(text);
};
const frame = (text: string | undefined, label: string, fallback: number) => {
  if (text === undefined) return fallback;
  const seconds = number(text, label);
  if (seconds < 0) throw new BeepsError('E_SCHEMA', `${label} must not be negative`);
  return Math.round(seconds * 48000);
};

function preflightNamedPatch(root: string, directory: string, name: string, force: boolean): void {
  const file = join(directory, `${name}.json`);
  let current = file;
  while (current !== root) {
    let entry;
    try { entry = lstatSync(current); }
    catch (e) { if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
    if (entry?.isSymbolicLink()) throw new BeepsError('E_VERIFY', `named patch destination contains a symlink: ${current}`);
    if (entry && (current === file ? !entry.isFile() : !entry.isDirectory())) throw new BeepsError('E_CONFLICT', `named patch destination has an invalid file type: ${current}`);
    if (current === file && entry && !force) throw new BeepsError('E_CONFLICT', `patch "${name}" already exists`, { hint: 'pass --force to replace it' });
    const parent = dirname(current);
    if (parent === current) throw new BeepsError('E_VERIFY', 'named patch destination escapes project');
    current = parent;
  }
}

export function registerSampleCommands(program: Command, io: Io): void {
  const sample = program.command('sample').description('import, prepare and exchange recorded sources for SFX patches');
  sample.command('import <file>').description('retain exact original and canonical 48 kHz snapshot with provenance')
    .option('--origin <text>', 'declared recording origin').option('--license <text>', 'declared recording license')
    .action((file: string, options: { origin?: string; license?: string }) => {
      io.emit(importSample(openProject(io.projectDir()), file, options));
    });
  sample.command('prepare [source]').description('crop, linear fade and gain; seconds round to nearest 48 kHz frame; --recipe replays a saved frame recipe or receipt')
    .option('--recipe <file>', 'saved beeps/sample-prep@1 recipe or beeps/sample-prepared@1 receipt (exclusive with source and controls)')
    .option('--start <seconds>', 'inclusive crop start (default 0)').option('--end <seconds>', 'exclusive crop end (default full source; at most ten seconds)')
    .option('--fade-in <seconds>', 'linear fade in (default 0)').option('--fade-out <seconds>', 'linear fade out (default 0)').option('--gain <db>', 'gain in dB (default 0)')
    .option('--name <name>', 'create a named sample-only patch with a neutral amplitude envelope').option('--family <family>', 'named patch family (default sfx)')
    .option('--force', 'replace an existing named patch')
    .action((source: string | undefined, options: PrepareOptions) => {
      const p = openProject(io.projectDir());
      if (options.recipe && (source !== undefined || [options.start, options.end, options.fadeIn, options.fadeOut, options.gain].some(x => x !== undefined))) throw new BeepsError('E_USAGE', '--recipe cannot be combined with source or preparation controls');
      if (!options.recipe && !source) throw new BeepsError('E_USAGE', 'provide a source ID or --recipe <file>');
      if (!options.name && (options.family !== undefined || options.force)) throw new BeepsError('E_USAGE', '--family and --force require --name');
      let input: unknown;
      if (options.recipe) input = readJsonFile(options.recipe);
      else {
        const object = readSampleObject(samplePaths(p).objects, source!, { maxFrames: SOURCE_MAX_FRAMES });
        input = { schema: 'beeps/sample-prep@1', source, startFrame: frame(options.start, 'start', 0), endFrame: frame(options.end, 'end', object.frames),
          fadeInFrames: frame(options.fadeIn, 'fade-in', 0), fadeOutFrames: frame(options.fadeOut, 'fade-out', 0), gainDb: options.gain === undefined ? 0 : number(options.gain, 'gain') };
      }
      const recipe = (input as { schema?: unknown } | null)?.schema === 'beeps/sample-prepared@1' ? parseSamplePreparedReceipt(input).recipe : parseSamplePrep(input);
      const object = readSampleObject(samplePaths(p).objects, recipe.source, { maxFrames: SOURCE_MAX_FRAMES });
      const preview = prepareSampleWav(input, object.wav);
      const patch = options.name === undefined ? undefined : parseOrThrow({ schema: 'beeps/patch@1', name: options.name, family: options.family ?? 'sfx', duration: Math.max(.01, preview.receipt.frames / 48000),
        layers: [{ source: { type: 'sample', asset: preview.receipt.outputId }, amp: { attack: 0, decay: 0, sustain: 1, release: 0 } }] }, 'prepared sample patch');
      if (patch) preflightNamedPatch(p.paths.dir, p.paths.patches, patch.name, !!options.force);
      const result = prepareSample(p, preview.receipt);
      io.emit({ ...result, ...(patch ? { patch: { name: patch.name, saved: savePatch(p, patch, { force: !!options.force }) } } : {}) });
    });
  sample.command('overview <source>').description('image a recording of up to 120 s and list its natural segments (each at most ten seconds, with numbers and a ready prepare command); <source> is a sha256 sample ID or an audio file')
    .option('--start <seconds>', 'view range start (default 0)').option('--end <seconds>', 'view range end (default the whole source)')
    .option('--out <png>', 'image path (default .agent-beeps/renders/overviews/<key>.png; required outside a project)')
    .option('--gap-db <dB>', 'a gap is this far under the loudest frame (default 40)').option('--min-gap <ms>', 'shortest gap that splits segments (default 200)')
    .option('--no-image', 'JSON only: skip the browser')
    .action(async (source: string, options: { start?: string; end?: string; out?: string; gapDb?: string; minGap?: string; image: boolean }) => {
      if (options.out) requireSafeOutput(resolve(options.out), { ext: '.png', inputs: existsSync(source) ? [source] : [] }, '--out');
      io.emit(await runOverview({
        source, projectDir: io.projectDir(), image: options.image, out: options.out,
        startSec: options.start === undefined ? undefined : number(options.start, '--start'),
        endSec: options.end === undefined ? undefined : number(options.end, '--end'),
        gapDb: options.gapDb === undefined ? 40 : number(options.gapDb, '--gap-db'),
        minGapMs: options.minGap === undefined ? 200 : number(options.minGap, '--min-gap'),
      }));
    });
  sample.command('bundle <refs...>').description('publish a portable source bundle; default includes only prepared dependencies')
    .requiredOption('--out <directory>', 'fresh output directory (an identical existing bundle is allowed)')
    .option('--include-preparation', 'also include replay recipes and required normalized source recordings, which may contain outtakes')
    .action((refs: string[], options: { out: string; includePreparation?: boolean }) => {
      io.emit(bundleSamples(openProject(io.projectDir()), refs, options.out, { includePreparation: !!options.includePreparation }));
    });
  sample.command('sync <directory>').description('validate an entire source bundle, then add/update project patches and immutable dependencies')
    .option('--dry-run', 'validate and report changes without writing')
    .action((directory: string, options: { dryRun?: boolean }) => {
      io.emit(syncSampleBundle(openProject(io.projectDir()), directory, { dryRun: !!options.dryRun }));
    });
}
