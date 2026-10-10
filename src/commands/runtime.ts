// EXPERIMENTAL (runtime-codegen spike): beeps runtime emit | check | verify | parity | perf | live
// The runtime path of a patch: a generated module (or the interpreter) a game runs in its own AudioContext, with named inputs.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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
import { cuesFor } from '../codegen/cues.ts';
import { emitModule } from '../codegen/emit.ts';
import { exportRuntime, patchHash, type RuntimeManifest } from '../codegen/export.ts';
import { renderKinds, runLive, runParity, runPerf, type EngineName } from '../codegen/parity.ts';
import { diffTap, featuresOf } from '../codegen/compare.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { withHost, int } from './shared.ts';

const list = (v: string) => v.split(',').map(s => s.trim()).filter(Boolean);
const inf = (_k: string, v: unknown) => (v === -Infinity ? '-inf' : v === Infinity ? 'inf' : v);

interface Common { projectFile?: string; kit?: string; seed?: number }

function context(io: Io, refs: string[], o: Common): { project: Project; patches: Patch[]; seeds: Record<string, number> } {
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
  return { project, patches, seeds };
}

export function registerRuntimeCommands(program: Command, io: Io) {
  const rt = program.command('runtime').description('EXPERIMENTAL: play a patch live in a game\'s own AudioContext, with named inputs (speed, size, distance...) bound to its parameters');
  const common = (c: Command) => c
    .option('--project-file <file>', 'a beeps/project@1 file (default: the nearest .agent-beeps project, else the defaults)')
    .option('--kit <file>', 'a beeps/kit@1 file; its seeds are the cues\' seeds')
    .option('--seed <n>', 'seed for every cue (default: the kit\'s, else 1)', int);

  common(rt.command('emit <refs...>'))
    .description('write <out>/beeps-runtime/: the engine files, one generated module per patch (build(ctx, out, params, seed, opts) -> voice), a .d.ts with the input names, and runtime.json. The loudness trim is the one the baked pipeline measures')
    .requiredOption('--out <dir>', 'where beeps-runtime/ goes')
    .option('--interpreter', 'also vendor the interpreter (createVoice) and the patch JSON')
    .option('--no-codegen', 'interpreter only')
    .action(async (refs: string[], o: Common & { out: string; interpreter?: boolean; codegen: boolean }) => {
      const { project, patches, seeds } = context(io, refs, o);
      const cues = await withHost(host => cuesFor(host, patches, project, { seeds }));
      const r = exportRuntime(o.out, cues, { interpreter: o.interpreter, codegen: o.codegen });
      io.emit({ root: r.root, engine: ENGINE_VERSION, cues: r.manifest.cues });
    });

  common(rt.command('check <refs...>'))
    .description('lint the patch where the runtime path can take it: render each patch with every input at its default, at each end alone and with all inputs at min and at max, and run the craft rules on each. Findings the default does not have are the runtime path\'s own')
    .action(async (refs: string[], o: Common) => {
      const { project, patches, seeds } = context(io, refs, o);
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
          const rendered = await renderAndMeasure(host, variants.map(v => ({ patch: v.patch, seed })), { project, rendersDir });
          const baseTrim = rendered[0].ok ? rendered[0].trimDb : 0;
          const fixed = await host.render(variants.map(v => ({ patch: v.patch, opts: { seed, scale: project.scale, trimDb: baseTrim + v.trimDeltaDb } })));
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
    .description('is <dir>/beeps-runtime/ current? Every module\'s recorded patch hash and engine version against the patch and the engine now, and the module text against a fresh emit of it (it must be byte-identical). Exit 1 on any drift')
    .action(async (dir: string, refs: string[], o: Common) => {
      const { patches } = context(io, refs, o);
      const root = join(resolve(dir), 'beeps-runtime');
      const manifest = JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')) as RuntimeManifest;
      const problems: string[] = [];
      if (manifest.engine !== ENGINE_VERSION) problems.push(`engine ${manifest.engine} in the folder, ${ENGINE_VERSION} now`);
      for (const patch of patches) {
        const m = manifest.cues[patch.name];
        if (!m) { problems.push(`${patch.name}: not in the folder`); continue; }
        if (m.patchHash !== patchHash(patch)) problems.push(`${patch.name}: the patch changed since the module was emitted`);
        if (m.module.endsWith('.js')) {
          const fresh = emitModule(patch, { trimDb: m.trimDb, seed: m.seed, patchHash: m.patchHash }).js;
          if (readFileSync(join(root, m.module), 'utf8') !== fresh) problems.push(`${patch.name}: the module differs from a fresh emit (edited, or the emitter changed)`);
        }
      }
      io.emit({ ok: problems.length === 0, checked: patches.length, problems });
      if (problems.length) process.exitCode = 1;
    });

  common(rt.command('parity <refs...>'))
    .description('render every cue baked, through the interpreter and through its generated module, in the same browser and seed, and report sample and feature differences, determinism over --runs fresh pages, and (with --engines) the other browsers against Chromium\'s bake')
    .option('--engines <list>', 'chromium,firefox,webkit', list, ['chromium'])
    .option('--runs <n>', 'fresh-page repeats per path, to count distinct outputs', int, 5)
    .action(async (refs: string[], o: Common & { engines: string[]; runs: number }) => {
      const { project, patches, seeds } = context(io, refs, o);
      const cues = await withHost(host => cuesFor(host, patches, project, { seeds }));
      const reports = await runParity({ cues, scale: project.scale, engines: o.engines as EngineName[], runs: o.runs });
      console.log(JSON.stringify({ reports }, inf, 2));
      const bad = reports.some(r => r.cases.some(c => c.distinct.baked > 1 || c.distinct.interp > 1 || c.distinct.gen > 1 || c.control.bitExact));
      if (bad) process.exitCode = 1;
    });

  common(rt.command('perf <refs...>'))
    .description('time graph builds of each cue (first and warm) through the interpreter and its generated module in Chromium, and count the nodes and buffers created')
    .option('--n <count>', 'builds per measurement', int, 60)
    .option('--realtime', 'build into a running AudioContext instead of an OfflineAudioContext')
    .option('--vary-seed', 'a different seed for every build (what a game does for variation): shows what a per-play seed costs')
    .action(async (refs: string[], o: Common & { n: number; realtime?: boolean; varySeed?: boolean }) => {
      const { project, patches, seeds } = context(io, refs, o);
      const cues = await withHost(host => cuesFor(host, patches, project, { seeds }));
      io.emit({ perf: await runPerf(cues, project.scale, { n: o.n, realtime: o.realtime, varySeed: o.varySeed }) });
    });

  common(rt.command('look <ref>'))
    .description('look images of one cue at chosen inputs: the baked render (the patch with the inputs applied) and the runtime render, from the same seed. The image is the spectrogram and envelope the other look commands draw')
    .option('--set <pairs>', 'inputs, e.g. size=1,distance=0.4', list, [])
    .option('--no-snap', 'render without scale snapping (a live input is continuous; the bake otherwise quantises it)')
    .option('--variant <n>', 'variant', int, 0)
    .requiredOption('--out <dir>', 'where baked.png and runtime.png go')
    .action(async (ref: string, o: Common & { set: string[]; snap: boolean; variant: number; out: string }) => {
      const { project, patches, seeds } = context(io, [ref], o);
      const params = Object.fromEntries(o.set.map(kv => { const [k, v] = kv.split('='); return [k, Number(v)]; }));
      const [cue] = await withHost(host => cuesFor(host, patches, project, { seeds }));
      const r = await renderKinds(cue, project.scale, params, ['baked', 'gen'], { variant: o.variant, noSnap: !o.snap });
      mkdirSync(resolve(o.out), { recursive: true });
      const files: Record<string, string> = {};
      await withHost(async host => {
        for (const [kind, label] of [['baked', 'baked'], ['gen', 'runtime']] as const) {
          const pcm = r[kind];
          const mono = new Float32Array(pcm.authored[0].length);
          for (const ch of pcm.authored) for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / pcm.authored.length;
          const [png] = await host.looks([{ mono, sampleRate: pcm.sampleRate, features: featuresOf(pcm), label: `${cue.patch.name} ${label} ${o.set.join(' ')}` }]);
          files[label] = join(resolve(o.out), `${label}.png`);
          writeFileSync(files[label], png);
        }
      });
      io.emit({ files, diff: diffTap(r.baked.delivered, r.gen.delivered), params });
    });

  common(rt.command('live <ref>'))
    .description('move a live input mid-note and compare the running voice with static bakes of the two input values (Chromium; the patch must declare live bindings)')
    .requiredOption('--input <name>', 'the input to move')
    .requiredOption('--to <value>', 'its new value', Number)
    .option('--at <sec>', 'when it moves', Number, 0.5)
    .option('--tau <sec>', 'smoothing time constant', Number, 0.03)
    .action(async (ref: string, o: Common & { input: string; to: number; at: number; tau: number }) => {
      const { project, patches, seeds } = context(io, [ref], o);
      const [cue] = await withHost(host => cuesFor(host, patches, project, { seeds }));
      io.emit({ live: await runLive(cue, project.scale, { input: o.input, to: o.to, at: o.at, tau: o.tau }) });
    });
}
