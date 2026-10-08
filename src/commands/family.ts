import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { BeepsError } from '../errors.ts';
import { buildFamily, parseInlineRow, parseTable, type Row } from '../family.ts';
import { openProject, readJsonFile, savePatch } from '../project.ts';
import { createSet, lintPatches, setJson } from './generate.ts';
import { int } from './shared.ts';

const collect = (v: string, prev: string[] = []) => [...prev, v];

function parseJitter(specs: string[] = []): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of specs) {
    const eq = s.lastIndexOf('=');
    const amount = Number(s.slice(eq + 1));
    if (eq < 1 || !s.startsWith('/') || !(amount > 0 && amount <= 1)) throw new BeepsError('E_USAGE', `bad --jitter "${s}": expected <pointer>=<fraction 0..1>, e.g. /layers/0/source/pitch=0.04`);
    out[s.slice(0, eq)] = amount;
  }
  return out;
}

export function registerFamilyCommands(program: Command, io: Io) {
  program.command('family <template>')
    .description('emit N similar patches from one template patch plus a table of rows; {{param}} placeholders and /json/pointer columns override the template, optional seeded ranges and jitter; every row is validated (E_SCHEMA names the row and pointer); deterministic')
    .option('--table <file>', 'rows: a .json array of objects or a .csv with a header row')
    .option('--row <k=v,...>', 'one inline row (repeatable), e.g. "name=step-grass,/layers/0/source/pitch=220"', collect)
    .option('--jitter <ptr=frac>', 'scale the number at a pointer by a seeded +/- fraction per row (repeatable), e.g. /layers/0/source/pitch=0.04', collect)
    .option('--seed <n>', 'seed for ranges ("a..b" cells) and jitter', int, 1)
    .option('--out <dir>', 'write <name>.json files to this folder (e.g. the repo\'s committed patches) instead of the project')
    .option('--save', 'with --out: also save into the project')
    .option('--force', 'replace patches that already exist')
    .option('--dry-run', 'validate and report without writing anything')
    .option('--lint', 'lint every emitted patch (--brief style: findings only, clean ones named); exits 1 on lint errors')
    .option('--set <name>', 'also render the patches into a candidate set with this id prefix, ready for audition')
    .option('--prompt <text>', 'with --set: what the sounds are for')
    .action(async (templateFile: string, opts: { table?: string; row?: string[]; jitter?: string[]; seed: number; out?: string; save?: boolean; force?: boolean; dryRun?: boolean; lint?: boolean; set?: string; prompt?: string }) => {
      if (!opts.table && !opts.row?.length) throw new BeepsError('E_USAGE', 'give the rows with --table <file.json|file.csv> and/or --row "k=v,..."');
      if (opts.set && opts.dryRun) throw new BeepsError('E_USAGE', '--set renders and writes a candidate set; drop --dry-run');
      if (opts.save && !opts.out) throw new BeepsError('E_USAGE', '--save only adds to --out; without --out the patches are saved to the project anyway');
      const rows: Row[] = [];
      if (opts.table) {
        if (!existsSync(opts.table)) throw new BeepsError('E_NOT_FOUND', `no table file ${opts.table}`);
        rows.push(...parseTable(readFileSync(opts.table, 'utf8'), opts.table));
      }
      for (const r of opts.row ?? []) rows.push(parseInlineRow(r));
      const p = openProject(io.projectDir());
      const { patches, unusedParams } = buildFamily(readJsonFile(templateFile), rows, { seed: opts.seed, jitter: parseJitter(opts.jitter) });

      const toProject = !opts.out || !!opts.save;
      const files = (opts.out ? [resolve(opts.out)] : []).flatMap(dir => patches.map(x => join(dir, `${x.name}.json`)));
      if (!opts.force && !opts.dryRun) {
        const clash = patches.find((x, i) => (toProject && existsSync(join(p.paths.patches, `${x.name}.json`))) || (opts.out && existsSync(files[i])));
        if (clash) throw new BeepsError('E_CONFLICT', `patch "${clash.name}" already exists`, { hint: 'pass --force to replace it, or --dry-run to only validate' });
      }
      const written: string[] = [];
      if (!opts.dryRun) {
        if (opts.out) {
          mkdirSync(resolve(opts.out), { recursive: true });
          patches.forEach((x, i) => { writeFileSync(files[i], JSON.stringify(x, null, 2) + '\n'); written.push(files[i]); });
        }
        if (toProject) for (const x of patches) written.push(savePatch(p, x, { force: !!opts.force }));
      }
      const out: Record<string, unknown> = {
        dryRun: !!opts.dryRun, count: patches.length, seed: opts.seed,
        patches: patches.map(x => ({ name: x.name, family: x.family, tags: x.tags })),
        ...(written.length ? { written } : {}),
        ...(unusedParams.length ? { warnings: [`row columns never used by a {{placeholder}}: ${unusedParams.join(', ')}`] } : {}),
      };
      let failed = false;
      if (opts.lint) {
        const l = await lintPatches(p, patches, true);
        out.lint = l.payload; failed = l.failed;
      }
      if (opts.set) {
        const set = await createSet(p, patches, { name: opts.set, prompt: opts.prompt });
        out.set = setJson(set);
      }
      io.emit(out);
      if (failed) process.exitCode = 1;
    });
}
