// beeps runtime export | check | verify | parity | perf | live | look
// The runtime path of a patch: a cue a game plays in its own AudioContext with named inputs (docs/runtime.md). `beeps build` writes
// the same cues for recipes whose delivery is runtime or both; these commands are for authoring and measuring them.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { Io } from '../cli.ts';
import { BeepsError } from '../errors.ts';
import { lintPatch } from '../lint.ts';
import { measure } from '../measure/index.ts';
import { findProjectRoot, loadPatch, openProject, parseOrThrow, readJsonFile } from '../project.ts';
import { renderAndMeasure } from '../render/pipeline.ts';
import { defaultProject, parseProject, type Project } from '../schema/project.ts';
import type { Patch } from '../schema/patch.ts';
import { applyParams } from '../../runtime/engine/params.js';
import { ENGINE_VERSION } from '../../runtime/engine/version.js';
import { canonicalJson } from '../hash.ts';
import { cueFile, cuesFor, cueText, makeCue, type Cue } from '../runtime/cue.ts';
import { diffTap, featuresOf } from '../runtime/compare.ts';
import { renderKinds, runLive, runParity, runPerf, type EngineName } from '../runtime/harness.ts';
import { withHost, int } from './shared.ts';
import { samplePaths } from '../samples/store.ts';
import { createSampleWavSnapshot, resolveSampleWavs, resolveSamplesForPatches } from '../samples/transport.ts';

const list = (v: string) => v.split(',').map(s => s.trim()).filter(Boolean);
const inf = (_k: string, v: unknown) => (v === -Infinity ? '-inf' : v === Infinity ? 'inf' : v);

interface Common { projectFile?: string; kit?: string; seed?: number }

function context(io: Io, refs: string[], o: Common): { project: Project; patches: Patch[]; seeds: Record<string, number>; sampleObjectsDir?: string } {
  const root = findProjectRoot(io.projectDir());
  const open = root ? openProject(root) : undefined;
  const project = o.projectFile ? parseProject(readJsonFile(o.projectFile)) : open?.project ?? defaultProject();
  const patches = refs.map(ref => {
    if (ref.endsWith('.json') && existsSync(ref)) return parseOrThrow(readJsonFile(ref), ref);
    if (!open) throw new BeepsError('E_NOT_FOUND', `no patch "${ref}" and no .agent-beeps project here`, { hint: 'pass paths to patch .json files, or run inside a project' });
    return loadPatch(open, ref);
  });
  const kit = o.kit ? (readJsonFile(o.kit) as { sounds: { name: string; seed: number }[] }).sounds : [];
  const seeds = Object.fromEntries(patches.map(p => [p.name, o.seed ?? kit.find(k => k.name === p.name)?.seed ?? 1]));
  return { project, patches, seeds, sampleObjectsDir: open ? samplePaths(open).objects : undefined };
}

const needsInputs = (patches: Patch[], what: string) => {
  const bare = patches.filter(p => !p.xRuntime);
  if (bare.length) throw new BeepsError('E_USAGE', `${what}: ${bare.map(p => p.name).join(', ')} declare no xRuntime block`, { hint: 'a patch plays at runtime without one (its default inputs), but there is nothing to check across; add inputs and bindings (docs/runtime.md)' });
};

export function registerRuntimeCommands(program: Command, io: Io) {
  const rt = program.command('runtime').description('the runtime path: play a patch live in a game\'s own AudioContext with named inputs (speed, size, distance...) bound to its parameters; export its cue, lint and measure it');
  const common = (c: Command) => c
    .option('--project-file <file>', 'a beeps/project@1 file (default: the nearest .agent-beeps project, else the defaults)')
    .option('--kit <file>', 'a beeps/kit@1 file; its seeds are the cues\' seeds')
    .option('--seed <n>', 'seed for every cue (default: the kit\'s, else 1)', int);

  common(rt.command('export <refs...>'))
    .description('write <out>/<id>.runtime.json for each patch: the parsed patch, its seed, the project scale and the loudness trim the baked pipeline measures, which is what a game loads with parseCue (beeps build writes the same files)')
    .requiredOption('--out <dir>', 'where the cue files go')
    .action(async (refs: string[], o: Common & { out: string }) => {
      const { project, patches, seeds, sampleObjectsDir } = context(io, refs, o);
      const cues = await withHost(host => cuesFor(host, patches, project, { seeds, sampleObjectsDir }));
      mkdirSync(resolve(o.out), { recursive: true });
      for (const cue of cues) writeFileSync(join(resolve(o.out), cueFile(cue.id)), cueText(cue));
      io.emit({ out: resolve(o.out), engine: ENGINE_VERSION, cues: cues.map(c => ({ id: c.id, file: cueFile(c.id), seed: c.seed, trimDb: c.trimDb, inputs: Object.keys(c.patch.xRuntime?.inputs ?? {}) })) });
    });

  common(rt.command('check <refs...>'))
    .description('lint the patch where the runtime path can take it: render each patch with every input at its default, at each end alone and with all inputs at min and at max, and run the craft rules on each. Findings the default does not have are the runtime path\'s own')
    .action(async (refs: string[], o: Common) => {
      const { project, patches, seeds, sampleObjectsDir } = context(io, refs, o);
      needsInputs(patches, 'runtime check');
      const rendersDir = join(mkdtempSync(join(tmpdir(), 'beeps-rt-check-')), 'renders');
      // The baked pipeline re-trims every render to the project's loudness target, which would hide the one thing a runtime input
      // legitimately changes: level. So each corner is rendered twice. Normalised, for the spectral rules (sharpness, roughness, tail...).
      // And at the default's fixed trim plus the input's own gain delta, which is what the game will play: that one is checked for
      // peaks and clipping, and its loudness is reported against the default's.
      const LEVEL_RULES = new Set(['true-peak-ceiling', 'no-clipping', 'loudness-target']);
      const reports = await withHost(async host => {
        const out = [];
        for (const patch of patches) {
          const decl = patch.xRuntime?.inputs ?? {};
          const names = Object.keys(decl);
          const corners: { label: string; params: Record<string, number> }[] = [
            { label: 'default', params: {} },
            ...names.flatMap(k => [{ label: `${k}=min`, params: { [k]: decl[k].min } }, { label: `${k}=max`, params: { [k]: decl[k].max } }]),
            ...(names.length > 1 ? [{ label: 'all=min', params: Object.fromEntries(names.map(k => [k, decl[k].min])) }, { label: 'all=max', params: Object.fromEntries(names.map(k => [k, decl[k].max])) }] : []),
          ];
          const variants = corners.map((c, i) => {
            const { patch: applied, trimDeltaDb } = applyParams(patch, c.params, true);
            const { xRuntime: _, ...bare } = applied as Patch;
            return { c, trimDeltaDb, patch: { ...bare, name: i === 0 ? patch.name : `${patch.name}-c${i}` } as Patch };
          });
          const seed = seeds[patch.name];
          const rendered = await renderAndMeasure(host, variants.map(v => ({ patch: v.patch, seed })), { project, rendersDir, sampleObjectsDir });
          const baseTrim = rendered[0].ok ? rendered[0].trimDb : 0;
          const samples = createSampleWavSnapshot(sampleObjectsDir);
          const fixed = await host.render(variants.map(v => ({ patch: v.patch, opts: { seed, scale: project.scale, trimDb: baseTrim + v.trimDeltaDb, sampleWavs: samples(v.patch) } })));
          const levels = fixed.map(r => {
            if (!r.ok) return undefined;
            const m = measure({ sampleRate: r.sampleRate, authored: r.delivered, delivered: r.delivered });
            return { momentaryMaxLufs: m.momentaryMaxLufs, truePeakDb: m.truePeakDb, samplePeakDb: m.samplePeakDb, clippedSamples: m.clippedSamples };
          });
          const lintAt = (i: number) => {
            const r = rendered[i];
            if (!r.ok) return undefined;
            const spectral = lintPatch(variants[i].patch, r.features, project);
            const lv = levels[i];
            const atRuntimeLevel = lv ? lintPatch(variants[i].patch, { ...r.features, delivered: { ...lv } }, project) : undefined;
            const level = (atRuntimeLevel ? [...atRuntimeLevel.errors, ...atRuntimeLevel.warnings] : []).filter(x => x.rule === 'true-peak-ceiling' || x.rule === 'no-clipping');
            return {
              errors: [...spectral.errors.filter(x => !LEVEL_RULES.has(x.rule)), ...level.filter(x => x.rule === 'no-clipping' || x.rule === 'true-peak-ceiling')],
              warnings: spectral.warnings.filter(x => !LEVEL_RULES.has(x.rule)),
            };
          };
          const base = lintAt(0);
          const known = new Set([...(base?.errors ?? []), ...(base?.warnings ?? [])].map(f => f.rule));
          out.push({
            patch: patch.name, delivery: patch.xRuntime?.delivery ?? 'baked', trimDb: baseTrim,
            corners: rendered.map((r, i) => {
              if (!r.ok) return { corner: variants[i].c.label, error: r.error, errors: [] as string[] };
              const rep = lintAt(i)!;
              const f = r.features, lv = levels[i], l0 = levels[0];
              return {
                corner: variants[i].c.label,
                features: { centroidHz: f.centroidHz, sharpness: f.sharpness, roughness: f.roughness, energyLengthSec: f.energyLengthSec, tailSec: f.tailSec },
                runtime: lv && l0 ? { loudnessLufs: lv.momentaryMaxLufs, vsDefaultLu: Math.round((lv.momentaryMaxLufs - l0.momentaryMaxLufs) * 100) / 100, truePeakDb: lv.truePeakDb, clippedSamples: lv.clippedSamples } : undefined,
                errors: rep.errors.map(x => x.rule), warnings: rep.warnings.map(x => x.rule),
                newAtCorner: [...rep.errors, ...rep.warnings].filter(x => i > 0 && !known.has(x.rule)).map(x => `${x.rule}: ${x.message}`),
              };
            }),
          });
        }
        return out;
      });
      io.emit({ reports });
      if (reports.some(r => r.corners.some(c => ('errors' in c ? c.errors : []).length))) process.exitCode = 1;
    });

  common(rt.command('verify <dir> <refs...>'))
    .description('are the cues in <dir> current? Each cue\'s engine version, seed, scale and patch against the patch and the engine now, and its loudness trim against a fresh measurement (--no-trim skips the render). Exit 1 on any drift')
    .option('--no-trim', 'do not re-measure the loudness trim')
    .action(async (dir: string, refs: string[], o: Common & { trim: boolean }) => {
      const { project, patches, seeds, sampleObjectsDir } = context(io, refs, o);
      const problems: string[] = [];
      const fresh = o.trim ? await withHost(host => cuesFor(host, patches, project, { seeds, sampleObjectsDir })) : undefined;
      for (const [i, patch] of patches.entries()) {
        const file = join(resolve(dir), cueFile(patch.name));
        if (!existsSync(file)) { problems.push(`${patch.name}: ${cueFile(patch.name)} is not in the folder`); continue; }
        const cue = readJsonFile(file) as Cue;
        if (cue.engine !== ENGINE_VERSION) problems.push(`${patch.name}: engine ${cue.engine} in the cue, ${ENGINE_VERSION} now`);
        if (canonicalJson(cue.patch) !== canonicalJson(patch)) problems.push(`${patch.name}: the patch changed since the cue was written`);
        if (cue.seed !== seeds[patch.name]) problems.push(`${patch.name}: seed ${cue.seed} in the cue, ${seeds[patch.name]} now`);
        if (canonicalJson(cue.scale) !== canonicalJson(project.scale)) problems.push(`${patch.name}: the project scale changed`);
        if (fresh && Math.abs(cue.trimDb - fresh[i].trimDb) > 0.005) problems.push(`${patch.name}: trim ${cue.trimDb} dB in the cue, ${fresh[i].trimDb} dB measured now`);
        if (readFileSync(file, 'utf8') !== cueText(makeCue(patch, project, cue.seed, cue.trimDb))) problems.push(`${patch.name}: the file is not what beeps writes for this cue (edited by hand?)`);
      }
      io.emit({ ok: problems.length === 0, checked: patches.length, problems });
      if (problems.length) process.exitCode = 1;
    });

  common(rt.command('parity <refs...>'))
    .description('render every cue baked and through the runtime voice, in the same browser and seed, and report sample and feature differences against what each case owes (exact, near, bus, by-design), determinism over --runs fresh pages, and (with --engines) the other browsers against Chromium\'s bake. Exit 1 if a case misses its expectation')
    .option('--engines <list>', 'chromium,firefox,webkit', list, ['chromium'])
    .option('--runs <n>', 'fresh-page repeats per path, to count distinct outputs', int, 3)
    .action(async (refs: string[], o: Common & { engines: string[]; runs: number }) => {
      const { project, patches, seeds, sampleObjectsDir } = context(io, refs, o);
      const cues = await withHost(host => cuesFor(host, patches, project, { seeds, sampleObjectsDir }));
      const reports = await runParity({ cues, engines: o.engines as EngineName[], runs: o.runs, sampleWavs: resolveSamplesForPatches(patches, sampleObjectsDir) });
      console.log(JSON.stringify({ reports }, inf, 2));
      const bad = reports.some(r => r.cases.some(c => c.distinct.baked > 1 || c.distinct.runtime > 1 || c.control.bitExact || !c.pass || c.hostEqualsHarness === false));
      if (bad) process.exitCode = 1;
    });

  common(rt.command('perf <refs...>'))
    .description('time voice builds (first and warm) in Chromium and count the nodes and buffers they create; --vary-seed, --bus and --plays measure what a per-play seed, a shared reverb bus and a long session cost')
    .option('--n <count>', 'builds per measurement', int, 60)
    .option('--realtime', 'build into a running AudioContext instead of an OfflineAudioContext')
    .option('--vary-seed', 'a different seed for every build (what a game does for variation): shows what a per-play seed costs')
    .option('--bus', 'send reverb to one shared bus instead of building a convolver per voice')
    .option('--plays <count>', 'shorthand for --n <count> --vary-seed with every voice disposed at once: a long session of fresh seeds, with the noise cache\'s state at the end', int)
    .option('--unbounded', 'lift the noise cache bound (the behaviour before it existed), to measure what it saves')
    .action(async (refs: string[], o: Common & { n: number; realtime?: boolean; varySeed?: boolean; bus?: boolean; plays?: number; unbounded?: boolean }) => {
      const { project, patches, seeds, sampleObjectsDir } = context(io, refs, o);
      const cues = await withHost(host => cuesFor(host, patches, project, { seeds, sampleObjectsDir }));
      io.emit({ perf: await runPerf(cues, { sampleWavs: resolveSamplesForPatches(patches, sampleObjectsDir), n: o.plays ?? o.n, realtime: o.realtime || o.plays !== undefined, varySeed: o.varySeed || o.plays !== undefined, bus: o.bus, dispose: o.plays !== undefined, noiseLimit: o.unbounded ? 'inf' : undefined, memory: o.plays !== undefined }) });
    });

  common(rt.command('look <ref>'))
    .description('look images of one cue at chosen inputs: the baked render (the patch with the inputs applied) and the runtime render, from the same seed. The image is the spectrogram and envelope the other look commands draw')
    .option('--set <pairs>', 'inputs, e.g. size=1,distance=0.4', list, [])
    .option('--no-snap', 'render without scale snapping (a live input is continuous; the bake otherwise quantises it)')
    .option('--variant <n>', 'variant', int, 0)
    .requiredOption('--out <dir>', 'where baked.png and runtime.png go')
    .action(async (ref: string, o: Common & { set: string[]; snap: boolean; variant: number; out: string }) => {
      const { project, patches, seeds, sampleObjectsDir } = context(io, [ref], o);
      const params = Object.fromEntries(o.set.map(kv => { const [k, v] = kv.split('='); return [k, Number(v)]; }));
      const [cue] = await withHost(host => cuesFor(host, patches, project, { seeds, sampleObjectsDir }));
      const r = await renderKinds(cue, params, { variant: o.variant, noSnap: !o.snap, sampleWavs: resolveSampleWavs(cue.patch, sampleObjectsDir) });
      mkdirSync(resolve(o.out), { recursive: true });
      const files: Record<string, string> = {};
      await withHost(async host => {
        for (const kind of ['baked', 'runtime'] as const) {
          const pcm = r[kind];
          const mono = new Float32Array(pcm.authored[0].length);
          for (const ch of pcm.authored) for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / pcm.authored.length;
          const [png] = await host.looks([{ mono, sampleRate: pcm.sampleRate, features: featuresOf(pcm), label: `${cue.id} ${kind} ${o.set.join(' ')}` }]);
          files[kind] = join(resolve(o.out), `${kind}.png`);
          writeFileSync(files[kind], png);
        }
      });
      io.emit({ files, diff: diffTap(r.baked.delivered, r.runtime.delivered), features: { baked: featuresOf(r.baked), runtime: featuresOf(r.runtime) }, params });
    });

  common(rt.command('live <ref>'))
    .description('move a live input mid-note and compare the running voice with static bakes of the two input values (Chromium; the patch must declare live bindings)')
    .requiredOption('--input <name>', 'the input to move')
    .requiredOption('--to <value>', 'its new value', Number)
    .option('--at <sec>', 'when it moves', Number, 0.5)
    .option('--tau <sec>', 'smoothing time constant', Number, 0.03)
    .action(async (ref: string, o: Common & { input: string; to: number; at: number; tau: number }) => {
      const { project, patches, seeds, sampleObjectsDir } = context(io, [ref], o);
      const [cue] = await withHost(host => cuesFor(host, patches, project, { seeds, sampleObjectsDir }));
      if (!cue.patch.xRuntime) throw new BeepsError('E_USAGE', `${cue.id} declares no xRuntime inputs`);
      io.emit({ live: await runLive(cue, { input: o.input, to: o.to, at: o.at, tau: o.tau }, { sampleWavs: resolveSampleWavs(cue.patch, sampleObjectsDir) }) });
    });
}
