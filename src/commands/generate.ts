import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { BeepsError } from '../errors.ts';
import { loadArchetypes } from '../archetypes.ts';
import { generate } from '../generate.ts';
import { crossover, DIRECTIONS, mutate } from '../mutate.ts';
import { loadPatch, openProject } from '../project.ts';
import { contactSheet, renderAndMeasure, type Rendered } from '../render/pipeline.ts';
import { lintKit, lintPatch, loadRules } from '../lint.ts';
import { addToKit, readKit, removeFromKit, writeKit } from '../kit.ts';
import { fitLayered } from '../taste/model.ts';
import { globalTasteDir, globalVerdictsFile, readVerdicts } from '../taste/verdicts.ts';
import { summarize } from '../taste/summary.ts';
import { predictionStats } from '../audition/session.ts';
import { candidateFromRendered, newId, setDir, writeSet, type CandidateSet } from '../sets.ts';
import { int, withHost } from './shared.ts';

const setJson = (s: CandidateSet) => ({
  set: s.id, archetype: s.archetype, family: s.family, prompt: s.prompt, parent: s.parent, sheet: s.sheet,
  candidates: s.candidates.map(c => {
    const f = c.features as any;
    return { index: c.index, name: c.name, trimDb: c.trimDb, look: c.look, ...(c.weak ? { weak: true } : {}),
      features: { energyLengthSec: f.energyLengthSec, attackSec: f.attackSec, centroidHz: f.centroidHz, sharpness: f.sharpness, roughness: f.roughness, flatness: f.flatness, pitchHz: f.pitchStrength >= 0.7 ? f.pitchHz : null, pitchDirection: f.pitchDirection } };
  }),
  next: `look at ${s.sheet}, then: beeps predict --set ${s.id} --pick <n> --shortlist <a,b> --why "..." and beeps audition open --set ${s.id}`,
});

export function registerGenerateCommands(program: Command, io: Io) {
  program.command('archetypes')
    .description('list the SFX archetypes generate can sample')
    .action(() => io.emit({ archetypes: loadArchetypes().map(a => ({ name: a.name, family: a.family, description: a.description, ranges: Object.keys(a.ranges).length })) }));

  program.command('generate <archetype>')
    .description('sample an archetype, render and measure, and keep a diverse, lint-clean candidate set')
    .option('--count <n>', 'candidates to keep (2-8)', int, 6)
    .option('--seed <n>', 'sampling seed', int)
    .option('--prompt <text>', 'what the sound is for; words like soft, warm, dark, bright, short, punchy steer which candidates are kept')
    .action(async (archetype: string, opts: { count: number; seed?: number; prompt?: string }) => {
      if (opts.count < 2 || opts.count > 8) throw new BeepsError('E_USAGE', '--count must be 2 to 8 (auditions stay small to avoid fatigue)');
      const p = openProject(io.projectDir());
      const set = await withHost(host => generate(host, p, { archetype, count: opts.count, seed: opts.seed, prompt: opts.prompt }));
      io.emit({ ...setJson(set), steering: set.steering });
    });

  program.command('mutate <ref>')
    .description('breed variations of a patch toward directions (brighter, darker, punchier, softer, shorter, longer, less-harsh, more-character)')
    .option('--toward <list>', 'comma-separated directions; omit for novelty', '')
    .option('--like <ref>', 'cross toward another patch')
    .option('--count <n>', 'candidates to keep', int, 4)
    .option('--seed <n>', 'seed', int)
    .action(async (ref: string, opts: { toward: string; like?: string; count: number; seed?: number }) => {
      const p = openProject(io.projectDir());
      const toward = opts.toward.split(',').filter(Boolean);
      const bad = toward.filter(d => !(d in DIRECTIONS) && d !== 'surprise');
      if (bad.length) throw new BeepsError('E_USAGE', `unknown direction ${bad.join(', ')}`, { hint: `one of ${Object.keys(DIRECTIONS).join(', ')}` });
      const set = await withHost(host => mutate(host, p, { parent: loadPatch(p, ref), like: opts.like ? loadPatch(p, opts.like) : undefined, toward, count: opts.count, seed: opts.seed }));
      io.emit(setJson(set));
    });

  program.command('crossover <a> <b>')
    .description('blend two patches (structure from a) and save the result as a project patch')
    .option('--t <x>', 'blend amount toward b', parseFloat, 0.5)
    .requiredOption('--name <name>', 'name for the new patch')
    .action(async (a: string, b: string, opts: { t: number; name: string }) => {
      const p = openProject(io.projectDir());
      const child = { ...crossover(loadPatch(p, a), loadPatch(p, b), opts.t), name: opts.name };
      mkdirSync(p.paths.patches, { recursive: true });
      const file = join(p.paths.patches, `${child.name}.json`);
      writeFileSync(file, JSON.stringify(child, null, 2) + '\n');
      io.emit({ saved: file, name: child.name });
    });

  const setCmd = program.command('set').description('candidate sets: create one from patches you already authored');
  setCmd.command('create <refs...>')
    .description('render existing patches (names or .json paths) into a candidate set, so a hand-authored kit can be auditioned (use --flow explore)')
    .option('--prompt <text>', 'what the sounds are for, shown to the owner')
    .option('--name <slug>', 'set id prefix', 'kit')
    .action(async (refs: string[], opts: { prompt?: string; name: string }) => {
      const p = openProject(io.projectDir());
      const patches = refs.map(r => loadPatch(p, r));
      const names = patches.map(x => x.name);
      const dup = names.find((n, i) => names.indexOf(n) !== i);
      if (dup) throw new BeepsError('E_USAGE', `patch name "${dup}" appears twice`, { hint: 'candidate names must be unique within a set' });
      const set = await withHost(async host => {
        const out = await renderAndMeasure(host, patches.map(patch => ({ patch })), { project: p.project, rendersDir: p.paths.renders });
        const failed = out.find(o => !o.ok);
        if (failed && !failed.ok) throw new BeepsError('E_RENDER', `${failed.patchName}: ${failed.error}`);
        const rendered = out.filter((o): o is Extract<typeof o, { ok: true }> => o.ok) as Rendered[];
        const id = newId(opts.name);
        const sheet = join(setDir(p, id), 'sheet.png');
        mkdirSync(setDir(p, id), { recursive: true });
        await contactSheet(host, rendered, rendered.map((r, i) => `${i + 1} · ${r.patch.name}`), sheet);
        return writeSet(p, {
          id, archetype: null, family: rendered[0]?.patch.family ?? 'mixed', prompt: opts.prompt ?? null, parent: null,
          createdAt: new Date().toISOString(), sheet, candidates: rendered.map((r, i) => candidateFromRendered(r, i + 1)),
        }, rendered.map(r => r.patch));
      });
      io.emit({ ...setJson(set), next: `beeps audition open --set ${set.id} --flow explore --prompt "..."` });
    });

  program.command('lint <refs...>')
    .description('check patches against the cited craft rules (renders them to measure)')
    .option('--brief', 'for many patches: list only those with errors or warnings, name the clean ones, and give the judgement rules once')
    .action(async (refs: string[], opts: { brief?: boolean }) => {
      const p = openProject(io.projectDir());
      const out = await withHost(host => renderAndMeasure(host, refs.map(r => ({ patch: loadPatch(p, r) })), { project: p.project, rendersDir: p.paths.renders }));
      const text = new Map(loadRules().map(r => [r.id, r.statement]));
      const withText = (ids: string[]) => ids.map(rule => ({ rule, apply: text.get(rule) ?? '' }));
      const reports = out.map(o => (o.ok ? (r => ({ name: o.patch.name, ...r, judgement: withText(r.judgement) }))(lintPatch(o.patch, o.features, p.project)) : { name: o.patchName, errors: [{ rule: 'render', message: o.error }], warnings: [], judgement: [] }));
      if (opts.brief) {
        const found = reports.filter(r => r.errors.length || r.warnings.length);
        const rules = [...new Set(reports.flatMap(r => r.judgement.map(j => j.rule)))].map(rule => ({ rule, apply: text.get(rule) ?? '' }));
        io.emit({ reports: found.map(({ judgement: _j, ...r }) => r), clean: reports.filter(r => !r.errors.length && !r.warnings.length).map(r => r.name), judgement: rules });
      } else io.emit({ reports });
      if (reports.some(r => r.errors.length)) process.exitCode = 1;
    });

  const kit = program.command('kit').description('the project sound kit: list, add, remove, check');
  kit.command('list').action(() => io.emit(readKit(openProject(io.projectDir()).paths.root)));
  kit.command('add <ref>')
    .option('--priority <n>', 'voice priority 1 (most important) to 5', int)
    .action(async (ref: string, opts: { priority?: number }) => {
      const p = openProject(io.projectDir());
      const patch = loadPatch(p, ref);
      const [o] = await withHost(host => renderAndMeasure(host, [{ patch }], { project: p.project, rendersDir: p.paths.renders }));
      if (!o.ok) throw new BeepsError('E_RENDER', o.error);
      const k = addToKit(readKit(p.paths.root), { name: patch.name, family: patch.family, priority: opts.priority ?? patch.meta?.priority ?? 3, trimDb: o.trimDb });
      writeKit(p.paths.root, k);
      io.emit(k);
    });
  kit.command('remove <name>').action((name: string) => {
    const p = openProject(io.projectDir());
    const k = removeFromKit(readKit(p.paths.root), name);
    writeKit(p.paths.root, k);
    io.emit(k);
  });
  kit.command('check')
    .description('render every kit sound and run patch and kit rules (one "no", priorities, families, key, masking)')
    .action(async () => {
      const p = openProject(io.projectDir());
      const k = readKit(p.paths.root);
      const patches = k.sounds.map(s => loadPatch(p, s.name));
      const out = await withHost(host => renderAndMeasure(host, patches.map(patch => ({ patch })), { project: p.project, rendersDir: p.paths.renders }));
      const members = out.flatMap((o, i) => (o.ok ? [{ patch: o.patch, features: o.features, priority: k.sounds[i].priority }] : []));
      io.emit({ kit: lintKit(members, p.project), sounds: members.map(m => ({ name: m.patch.name, ...lintPatch(m.patch, m.features, p.project) })) });
    });

  const taste = program.command('taste').description('the learned taste profile: show, fit, stats');
  const fitNow = (root?: string) => {
    const global = readVerdicts(globalVerdictsFile());
    const project = root ? readVerdicts(join(root, '.agent-beeps', 'taste', 'verdicts.jsonl')) : { rows: [], malformed: 0 };
    const model = fitLayered(global.rows, project.rows);
    return { model, global, project, summary: summarize(model, model.n) };
  };
  taste.command('show')
    .description('what the owner has preferred so far, in words and weights, with confidence')
    .action(() => {
      let root: string | undefined;
      try { root = openProject(io.projectDir()).paths.root; } catch { root = undefined; }
      const { model, global, project, summary } = fitNow(root);
      io.emit({ verdicts: { global: global.rows.length, project: project.rows.length, malformed: global.malformed + project.malformed }, projectLayer: !!model.projectLayer, preferences: summary.preferences, summary: summary.markdown });
    });
  taste.command('fit')
    .description('refit from the verdict logs and write model.json and summary.md')
    .action(() => {
      let root: string | undefined;
      try { root = openProject(io.projectDir()).paths.root; } catch { root = undefined; }
      const { model, summary } = fitNow(root);
      const dir = root ? join(root, '.agent-beeps', 'taste') : globalTasteDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'model.json'), JSON.stringify(model, null, 2) + '\n');
      writeFileSync(join(dir, 'summary.md'), summary.markdown);
      io.emit({ model: join(dir, 'model.json'), summary: join(dir, 'summary.md'), verdicts: model.n });
    });
  taste.command('stats')
    .description('agent and model prediction hit rates')
    .action(() => {
      let root: string | undefined;
      try { root = openProject(io.projectDir()).paths.root; } catch { root = undefined; }
      io.emit({ project: predictionStats({ project: root }), all: predictionStats() });
    });
}
