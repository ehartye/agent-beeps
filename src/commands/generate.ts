import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { BeepsError } from '../errors.ts';
import { loadArchetypes } from '../archetypes.ts';
import { generate } from '../generate.ts';
import { crossover, DIRECTIONS, mutate } from '../mutate.ts';
import { loadPatch, openProject, parseOrThrow, readJsonFile, savePatch, type OpenProject } from '../project.ts';
import type { Patch } from '../schema/patch.ts';
import { contactSheet, renderAndMeasure, type Rendered } from '../render/pipeline.ts';
import { effectTailNotes, kitRuleNotes, lintKit, lintPatch, loadRules, variantSiblings } from '../lint.ts';
import { addToKit, kitSeed, readKit, removeFromKit, writeKit } from '../kit.ts';
import { fitLayered } from '../taste/model.ts';
import { FeedbackSchema, verdictsFromFeedback, type RatedSound } from '../taste/feedback.ts';
import { appendVerdicts, globalTasteDir, globalVerdictsFile, readVerdicts } from '../taste/verdicts.ts';
import { featureVector, type Features } from '../measure/index.ts';
import { summarize } from '../taste/summary.ts';
import { predictionStats } from '../audition/session.ts';
import { candidateFromRendered, newId, setDir, writeSet, type CandidateSet } from '../sets.ts';
import { DeliveryResultsHead, deliveryPrefsFile, foldResults, globalDeliveryPrefsFile, importPreferences, preferencesFromResults, readDelivery, readDeliveryEvents, readDeliveryPrefs, summarizePreferences } from '../audition/delivery.ts';
import { int, pitchOf, withHost } from './shared.ts';
import { renderOptions } from '../render/options.ts';
import { notice, noticeField } from '../notices.ts';
import { reportJson } from '../set-report.ts';
import { renderWithExpectations } from '../expect-run.ts';
import { registerGoldenCommands } from './golden.ts';
import { deriveExpectations } from '../expect.ts';
import { renderNotices, variantNotices } from '../patch-notices.ts';

export const setJson = (s: CandidateSet) => ({
  set: s.id, archetype: s.archetype, family: s.family, prompt: s.prompt, parent: s.parent, sheet: s.sheet,
  candidates: s.candidates.map(c => {
    const f = c.features as any;
    return { index: c.index, name: c.name, trimDb: c.trimDb, look: c.look, ...(c.weak ? { weak: true } : {}),
      features: { energyLengthSec: f.energyLengthSec, attackSec: f.attackSec, centroidHz: f.centroidHz, sharpness: f.sharpness, roughness: f.roughness, flatness: f.flatness, ...pitchOf(f), pitchDirection: f.pitchDirection } };
  }),
  next: `look at ${s.sheet}, then: beeps predict --set ${s.id} --pick <n> --shortlist <a,b> --why "..." and beeps audition open --set ${s.id}`,
});

/** The project's own valid patches. An invalid file is nobody's sibling or family member, so it is left out, and listed (with why) so that is not silent. */
function projectPatches(p: OpenProject): { patches: Patch[]; skipped: { file: string; error: string }[] } {
  const patches: Patch[] = [], skipped: { file: string; error: string }[] = [];
  if (!existsSync(p.paths.patches)) return { patches, skipped };
  for (const f of readdirSync(p.paths.patches).filter(f => f.endsWith('.json'))) {
    try { patches.push(parseOrThrow(readJsonFile(join(p.paths.patches, f)), f)); } catch (e) { skipped.push({ file: f, error: (e as Error).message }); }
  }
  return { patches, skipped };
}

/** Sibling variants of each patch among the project's own patches and the ones being checked (these win on a name clash). */
function siblingsOf(p: OpenProject, checked: Patch[], own = projectPatches(p).patches): Map<string, string[]> {
  const byName = new Map<string, Patch>();
  for (const x of [...own, ...checked]) byName.set(x.name, x);
  return variantSiblings([...byName.values()]);
}

/** Render patches into a candidate set (contact sheet included) so a hand-authored kit can be auditioned. */
export async function createSet(p: OpenProject, patches: Patch[], opts: { prompt?: string; name: string }): Promise<CandidateSet> {
  const names = patches.map(x => x.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new BeepsError('E_USAGE', `patch name "${dup}" appears twice`, { hint: 'candidate names must be unique within a set' });
  return withHost(async host => {
    const out = await renderAndMeasure(host, patches.map(patch => ({ patch })), renderOptions(p));
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
}

/** Lint patches (names, files or in-memory): the JSON lint prints, and whether any patch has errors. */
export async function lintPatches(p: OpenProject, patches: Patch[], brief: boolean, { derive = false } = {}): Promise<{ payload: Record<string, unknown>; failed: boolean }> {
  const { patches: own, skipped } = projectPatches(p);
  const siblings = siblingsOf(p, patches, own);
  // Informational lines (never errors or warnings, never the exit code): what lint cannot check on its own.
  const kit = readKit(p.paths.root);
  const notes = kitRuleNotes(patches, own, kit.sounds.map(s => s.name));
  for (const s of skipped) notes.push({ rule: 'invalid-project-patch', name: s.file, message: `${s.file} is not a valid patch, so lint left it out of the sibling and kit checks: ${s.error}` });
  // A kit sound is judged at the seed it ships with (the one the owner auditioned), like render and export; any other patch at seed 1.
  const { outcomes: out, expectations } = await withHost(host => renderWithExpectations(host, patches.map(patch => ({ patch, seed: kitSeed(kit, patch.name) })), renderOptions(p)));
  for (const o of out) if (o.ok) notes.push(...effectTailNotes(o.patch, o.features));
  const text = new Map(loadRules().map(r => [r.id, r.statement]));
  const withText = (ids: string[]) => ids.map(rule => ({ rule, apply: text.get(rule) ?? '' }));
  const reports = out.map((o, i) => (o.ok ? (r => ({ name: o.patch.name, ...r, judgement: withText(r.judgement), ...noticeField([...renderNotices(o.patch, o.features, p.project.scale), ...variantNotices(o.patch)]), ...(expectations[i] ? { expectations: expectations[i] } : {}), ...(derive ? { derived: { xExpect: deriveExpectations(o.features) } } : {}) }))(lintPatch(o.patch, o.features, p.project, undefined, { siblings: siblings.get(o.patch.name) })) : { name: o.patchName, errors: [{ rule: 'render', message: o.error }], warnings: [], judgement: [] }));
  // A failed expectation fails the command like an error does, but it is not an error: it is the author's own contract, with no cited source.
  const failed = reports.some((r, i) => r.errors.length || expectations[i]?.passed === false);
  if (brief) {
    // A patch with a notice is not "clean": a notice is something the render did that the patch did not say.
    const quiet = (r: (typeof reports)[number]) => !r.errors.length && !r.warnings.length && !('notices' in r) && !('derived' in r) && !('expectations' in r && r.expectations?.passed === false);
    const rules = [...new Set(reports.flatMap(r => r.judgement.map(j => j.rule)))].map(rule => ({ rule, apply: text.get(rule) ?? '' }));
    return { failed, payload: { reports: reports.filter(r => !quiet(r)).map(({ judgement: _j, ...r }) => r), clean: reports.filter(quiet).map(r => r.name), judgement: rules, ...(notes.length ? { notes } : {}) } };
  }
  return { failed, payload: { reports, ...(notes.length ? { notes } : {}) } };
}

export function registerGenerateCommands(program: Command, io: Io) {
  program.command('archetypes')
    .description('list the SFX archetypes generate can sample')
    .action(() => io.emit({ archetypes: loadArchetypes().map(a => ({ name: a.name, family: a.family, description: a.description, recipe: a.recipe, ranges: Object.keys(a.ranges).length })) }));

  program.command('generate <archetype>')
    .description('sample an archetype, render and measure, and keep a diverse, lint-clean candidate set')
    .option('--count <n>', 'candidates to keep (2-8)', int, 6)
    .option('--seed <n>', 'sampling seed', int)
    .option('--prompt <text>', 'what the sound is for; words like soft, warm, dark, bright, short, punchy steer which candidates are kept')
    .action(async (archetype: string, opts: { count: number; seed?: number; prompt?: string }) => {
      if (opts.count < 2 || opts.count > 8) throw new BeepsError('E_USAGE', '--count must be 2 to 8 (auditions stay small to avoid fatigue)');
      const p = openProject(io.projectDir());
      const set = await withHost(host => generate(host, p, { archetype, count: opts.count, seed: opts.seed, prompt: opts.prompt }));
      io.emit({ ...setJson(set), seed: set.seed, steering: set.steering, ...reportJson(set) });
    });

  program.command('mutate <ref>')
    .description('breed variations of a patch toward directions (brighter, darker, punchier, softer, shorter, longer, less-harsh, more-character)')
    .option('--toward <list>', 'comma-separated directions; omit for novelty', '')
    .option('--like <ref>', 'cross toward another patch')
    .option('--count <n>', 'candidates to keep', int, 4)
    .option('--seed <n>', 'seed', int)
    .option('--ignore-expect', 'keep children that miss the xExpect block of the patch they were bred from (by default they are dropped, and the report says which checks dropped them)')
    .action(async (ref: string, opts: { toward: string; like?: string; count: number; seed?: number; ignoreExpect?: boolean }) => {
      if (opts.count < 1 || opts.count > 8) throw new BeepsError('E_USAGE', '--count must be 1 to 8 (auditions stay small to avoid fatigue)', { received: opts.count });
      const p = openProject(io.projectDir());
      const toward = opts.toward.split(',').filter(Boolean);
      const bad = toward.filter(d => !(d in DIRECTIONS) && d !== 'surprise');
      if (bad.length) throw new BeepsError('E_USAGE', `unknown direction ${bad.join(', ')}`, { hint: `one of ${Object.keys(DIRECTIONS).join(', ')}` });
      const set = await withHost(host => mutate(host, p, { parent: loadPatch(p, ref), like: opts.like ? loadPatch(p, opts.like) : undefined, toward, count: opts.count, seed: opts.seed, ignoreExpect: !!opts.ignoreExpect }));
      io.emit({ ...setJson(set), seed: set.seed, ...reportJson(set) });
    });

  program.command('crossover <a> <b>')
    .description('blend two patches (structure from a) and save the result as a project patch; a blend that is not a valid patch is an error, and an existing name needs --force')
    .option('--t <x>', 'blend amount toward b, 0 to 1', Number, 0.5)
    .requiredOption('--name <name>', 'name for the new patch')
    .option('--force', 'replace an existing patch of that name')
    .action(async (a: string, b: string, opts: { t: number; name: string; force?: boolean }) => {
      if (!Number.isFinite(opts.t) || opts.t < 0 || opts.t > 1) throw new BeepsError('E_USAGE', `--t takes a number from 0 to 1, got ${opts.t}`, { received: opts.t });
      const p = openProject(io.projectDir());
      const child = { ...crossover(loadPatch(p, a), loadPatch(p, b), opts.t), name: opts.name };
      io.emit({ saved: savePatch(p, child, { force: !!opts.force }), name: child.name, parents: [a, b], t: opts.t });
    });

  const setCmd = program.command('set').description('candidate sets: create one from patches you already authored');
  setCmd.command('create <refs...>')
    .description('render existing patches (names or .json paths) into a candidate set, so a hand-authored kit can be auditioned (use --flow explore)')
    .option('--prompt <text>', 'what the sounds are for, shown to the owner')
    .option('--name <slug>', 'set id prefix', 'kit')
    .action(async (refs: string[], opts: { prompt?: string; name: string }) => {
      const p = openProject(io.projectDir());
      const set = await createSet(p, refs.map(r => loadPatch(p, r)), opts);
      io.emit({ ...setJson(set), next: `beeps audition open --set ${set.id} --flow explore --prompt "..."` });
    });

  program.command('lint <refs...>')
    .description('check patches against the cited craft rules (renders them to measure); exits 1 only when a patch has errors, warnings exit 0; notes (e.g. "kit-level rules run only in kit check") are informational')
    .option('--brief', 'for many patches: list only those with errors or warnings, name the clean ones, and give the judgement rules once')
    .option('--derive-expect', 'also print, per patch, an xExpect block the sound passes as it measures now (with room around each number), to edit and save: pins a sound as it is')
    .action(async (refs: string[], opts: { brief?: boolean; deriveExpect?: boolean }) => {
      const p = openProject(io.projectDir());
      const { payload, failed } = await lintPatches(p, refs.map(r => loadPatch(p, r)), !!opts.brief, { derive: !!opts.deriveExpect });
      io.emit(payload);
      if (failed) process.exitCode = 1;
    });

  const kit = program.command('kit').description('the project sound kit: list, add, remove, check');
  kit.command('list')
    .description('print the project kit: each sound with its family, priority and loudness trim')
    .action(() => io.emit(readKit(openProject(io.projectDir()).paths.root)));
  kit.command('add <ref>')
    .description('render a patch, measure its loudness trim and add it to the project kit')
    .option('--priority <n>', 'voice priority 1 (most important) to 5', int)
    .action(async (ref: string, opts: { priority?: number }) => {
      const p = openProject(io.projectDir());
      const patch = loadPatch(p, ref);
      const before = readKit(p.paths.root);
      const previous = before.sounds.find(s => s.name === patch.name);
      // Re-adding a sound keeps the seed the owner auditioned: it is part of which sound this is, and the trim is measured at it.
      const [o] = await withHost(host => renderAndMeasure(host, [{ patch, seed: previous?.seed }], renderOptions(p)));
      if (!o.ok) throw new BeepsError('E_RENDER', o.error);
      const entry = { name: patch.name, family: patch.family, priority: opts.priority ?? patch.meta?.priority ?? 3, trimDb: o.trimDb, ...(previous?.seed !== undefined ? { seed: previous.seed } : {}) };
      const k = addToKit(before, entry);
      writeKit(p.paths.root, k);
      // The entry it replaced, when something it carried is different now: the old priority is gone unless the caller set it again.
      const lost = previous && (previous.priority !== entry.priority || previous.trimDb !== entry.trimDb);
      io.emit({ ...k, ...(previous ? { replaced: previous } : {}), ...noticeField(lost ? [notice('N_KIT_REPLACED', { message: `${patch.name} was already in the kit and has been replaced: priority ${previous.priority} -> ${entry.priority}, trim ${previous.trimDb ?? 'none'} -> ${entry.trimDb} dB${previous.seed !== undefined ? `; its audition seed ${previous.seed} was kept` : ''}`, requested: previous, applied: entry })] : []) });
    });
  kit.command('remove <name>')
    .description('take a sound out of the project kit (the patch file stays)')
    .action((name: string) => {
      const p = openProject(io.projectDir());
      const k = removeFromKit(readKit(p.paths.root), name);
      writeKit(p.paths.root, k);
      io.emit(k);
    });
  registerGoldenCommands(kit, io);
  kit.command('check')
    .description('render every kit sound and run patch and kit rules (one "no", priorities, families, key, masking)')
    .action(async () => {
      const p = openProject(io.projectDir());
      const k = readKit(p.paths.root);
      const patches = k.sounds.map(s => loadPatch(p, s.name));
      const { outcomes: out, expectations } = await withHost(host => renderWithExpectations(host, patches.map((patch, i) => ({ patch, seed: k.sounds[i].seed })), renderOptions(p)));
      const members = out.flatMap((o, i) => (o.ok ? [{ patch: o.patch, features: o.features, priority: k.sounds[i].priority, seed: k.sounds[i].seed ?? 1, expectations: expectations[i] }] : []));
      const siblings = siblingsOf(p, patches);
      const checked = new Map(members.map(m => [m.patch.name, { name: m.patch.name, ...lintPatch(m.patch, m.features, p.project, undefined, { siblings: siblings.get(m.patch.name) }), seed: m.seed, ...noticeField(renderNotices(m.patch, m.features, p.project.scale)), ...(m.expectations ? { expectations: m.expectations } : {}) }]));
      // A sound that failed to render stays in the list, in kit order, as a failure: the kit rules ran without it and the exit code says so.
      const sounds = out.map((o, i) => (o.ok ? checked.get(o.patch.name)! : { name: o.patchName ?? k.sounds[i].name, ok: false, error: o.error }));
      io.emit({ kit: lintKit(members, p.project), sounds });
      // A failed expectation exits 1 like a sound that would not render: the kit does not meet the contract its sounds declare.
      if (out.some(o => !o.ok) || expectations.some(e => e?.passed === false)) process.exitCode = 1;
    });

  // Outside a project the taste commands read and write the owner's global profile only; say so rather than look like a project's.
  const tasteScope = (root?: string) => (root ? 'project and global' : 'global only (no .agent-beeps project here)');
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
      const delivery = summarizePreferences([...readDeliveryPrefs(globalDeliveryPrefsFile()), ...(root ? readDeliveryPrefs(join(root, '.agent-beeps', 'taste', 'delivery.jsonl')) : [])]);
      io.emit({ scope: tasteScope(root), verdicts: { global: global.rows.length, project: project.rows.length, malformed: global.malformed + project.malformed }, projectLayer: !!model.projectLayer, preferences: summary.preferences, summary: summary.markdown, ...(delivery.length ? { delivery } : {}) });
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
      io.emit({ scope: tasteScope(root), model: join(dir, 'model.json'), summary: join(dir, 'summary.md'), verdicts: model.n });
    });
  taste.command('import <file>')
    .description('log the thumbs from a listening page (a game\'s "click through every sound" export) as taste verdicts: liked beats disliked within a family')
    .option('--patches <dir>', 'folder of the rated patches, <name>.json each (default: the file\'s patchDir, looked for here and in every parent folder)')
    .option('--dry-run', 'say what would be logged and log nothing')
    .action(async (file: string, opts: { patches?: string; dryRun?: boolean }) => {
      const p = openProject(io.projectDir());
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new BeepsError('E_SCHEMA', `${file} is not JSON: ${(e as Error).message}`); }
      // A delivery-format audition's results.json: logged as delivery preferences, apart from the verdicts the taste model fits.
      if (DeliveryResultsHead.safeParse(raw).success) {
        const r = raw as { id: string }, d = readDelivery(p, r.id);
        const rows = preferencesFromResults(foldResults(d, readDeliveryEvents(p, r.id)), d);
        if (!rows.length) throw new BeepsError('E_NOT_FOUND', 'no rated codec presets in these results', { hint: 'rate at least one lettered version on the page first' });
        const fresh = opts.dryRun ? true : importPreferences(p, rows);
        io.emit({ imported: !opts.dryRun && fresh, alreadyImported: !fresh, session: r.id, kind: 'delivery', preferences: rows.length, roles: [...new Set(rows.map(x => x.role))], reliable: rows[0].reliable, next: 'beeps taste show lists delivery preferences; they do not change the sound taste model' });
        return;
      }
      let fb;
      try { fb = FeedbackSchema.parse(raw); }
      catch (e) { throw new BeepsError('E_SCHEMA', `${file} is not a listening-page feedback file: ${(e as Error).message}`, { hint: 'expected { "schema": "...audition-feedback@1", "items": [{ "name", "rating": "up"|"down" }] }' }); }
      const dirs: string[] = [];
      if (opts.patches) dirs.push(resolve(opts.patches));
      else if (fb.patchDir) {
        if (isAbsolute(fb.patchDir)) dirs.push(fb.patchDir);
        else for (let d = resolve(process.cwd()); ; d = dirname(d)) { dirs.push(join(d, fb.patchDir)); if (dirname(d) === d) break; }
      }
      const rated = fb.items.filter(i => i.rating === 'up' || i.rating === 'down');
      const found: { name: string; path: string; rating: 'up' | 'down' }[] = [], missing: string[] = [];
      for (const i of rated) {
        const dir = dirs.find(d => existsSync(join(d, `${i.name}.json`)));
        if (dir) found.push({ name: i.name, path: join(dir, `${i.name}.json`), rating: i.rating as 'up' | 'down' }); else missing.push(i.name);
      }
      if (!found.length) throw new BeepsError('E_NOT_FOUND', 'none of the rated sounds has a patch file', { hint: `pass --patches <dir>; looked in ${dirs.join(', ') || 'nowhere (no patchDir in the file)'}; not found: ${missing.join(', ')}` });
      const outs = await withHost(host => renderAndMeasure(host, found.map(f => ({ patch: loadPatch(p, f.path) })), renderOptions(p)));
      const sounds: RatedSound[] = [];
      outs.forEach((o, i) => { if (o.ok) sounds.push({ name: found[i].name, family: o.patch.family, raw: featureVector(o.features as unknown as Features), rating: found[i].rating }); else missing.push(found[i].name); });
      const session = `import-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
      const { rows, unpaired } = verdictsFromFeedback(sounds, { project: p.paths.root, session, at: new Date().toISOString() });
      if (!opts.dryRun) appendVerdicts([join(p.paths.taste, 'verdicts.jsonl'), globalVerdictsFile()], rows);
      io.emit({ imported: !opts.dryRun, session, rated: sounds.length, verdicts: rows.length, implied: rows.filter(r => r.kind === 'implied').length, bothBad: rows.filter(r => r.kind === 'bothBad').length,
        unpaired, notFound: missing, levelVotes: fb.items.filter(i => i.level && i.level !== 'ok').map(i => ({ name: i.name, level: i.level })), notes: fb.items.filter(i => i.note).length,
        next: rows.length ? 'beeps taste fit' : 'rate at least one sound down (or one up and one down in the same family) to give the model something to learn' });
    });
  taste.command('stats')
    .description('agent and model prediction hit rates')
    .action(() => {
      let root: string | undefined;
      try { root = openProject(io.projectDir()).paths.root; } catch { root = undefined; }
      io.emit({ scope: tasteScope(root), project: predictionStats({ project: root }), all: predictionStats() });
    });
}
